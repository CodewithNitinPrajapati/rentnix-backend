// backend/chat_server.js
//
// Socket.io chat server — persists everything to Neon (PostgreSQL).
//
// ── Integrated usage (recommended) ───────────────────────────────────────────
//   In your main server.js / app.js:
//     const httpServer = require('http').createServer(app);
//     require('./chat_server')(httpServer);
//     httpServer.listen(process.env.PORT || 3000);
//
// ── Standalone usage ──────────────────────────────────────────────────────────
//   node backend/chat_server.js
//
// ── Env vars ──────────────────────────────────────────────────────────────────
//   DATABASE_URL          — Neon connection string
//   FIREBASE_PROJECT_ID   — used to verify Firebase ID tokens
//   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON
//
// ── Client → Server events ────────────────────────────────────────────────────
//   get_rooms      {}
//   open_room      { other_user_id, other_user_name, other_user_avatar?,
//                    context_type?, context_id?, context_title? }
//   join_room      { room_id }
//   leave_room     { room_id }
//   get_messages   { room_id, before_id? }
//   send_message   { room_id, text }
//   mark_read      { room_id }
//   delete_message { room_id, message_id }
//
// ── Server → Client events ────────────────────────────────────────────────────
//   authenticated      { uid, name, avatar }
//   rooms_list         { rooms }
//   room_opened        { room }
//   messages_history   { messages }
//   new_message        { message }
//   message_deleted    { message_id, room_id }
//   rooms_updated      { room }
//   chat_error         { error }   ← custom name, NOT 'error' (reserved in socket.io)

'use strict';
const { Pool }  = require('pg');
const admin     = require('firebase-admin');

// ── DB pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Firebase Admin init (idempotent) ──────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId:  process.env.FIREBASE_PROJECT_ID,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRoomId(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

// Safely extract object from socket.io data
// socket_io_client can send data as [payload] array or plain object
function unwrap(data) {
  if (Array.isArray(data)) return data[0] ?? {};
  return data ?? {};
}

function rowToRoom(r, myUid) {
  const isA    = r.participant_a_id === myUid;
  const unread = isA ? Number(r.unread_a) : Number(r.unread_b);
  return {
    id:                   r.id,
    participant_a_id:     r.participant_a_id,
    participant_a_name:   r.participant_a_name,
    participant_a_avatar: r.participant_a_avatar,
    participant_b_id:     r.participant_b_id,
    participant_b_name:   r.participant_b_name,
    participant_b_avatar: r.participant_b_avatar,
    last_message:         r.last_message,
    last_message_at:      r.last_message_at,
    context_type:         r.context_type,
    context_id:           r.context_id,
    context_title:        r.context_title,
    unread_count:         unread,
    created_at:           r.created_at,
  };
}

function rowToMessage(r) {
  return {
    id:            r.id,
    room_id:       r.room_id,
    sender_id:     r.sender_id,
    sender_name:   r.sender_name,
    sender_avatar: r.sender_avatar,
    text:          r.deleted ? '' : r.text,
    type:          r.type,
    is_read:       r.is_read,
    deleted:       r.deleted,
    created_at:    r.created_at,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

module.exports = function attachChatServer(httpServer) {
  const { Server } = require('socket.io');

  const io = new Server(httpServer, {
    // Default namespace '/' — client must NOT set a namespace
    cors: {
      origin:  '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout:  60000,
    pingInterval: 25000,
  });

  // uid → Set<socket.id>  (allow multiple devices)
  const userSockets = new Map();

  // ── Auth middleware ───────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('NO_TOKEN'));
    try {
      const decoded       = await admin.auth().verifyIdToken(token);
      socket.uid          = decoded.uid;
      socket.userName     = decoded.name    || 'User';
      socket.userAvatar   = decoded.picture  || null;
      next();
    } catch (err) {
      console.error('[chat] token verify failed:', err.message);
      next(new Error('INVALID_TOKEN'));
    }
  });

  // ── Connection ────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const uid = socket.uid;
    console.log(`[chat] connected uid=${uid} socket=${socket.id}`);

    // Track socket per user
    if (!userSockets.has(uid)) userSockets.set(uid, new Set());
    userSockets.get(uid).add(socket.id);

    // Tell client auth succeeded
    socket.emit('authenticated', {
      uid,
      name:   socket.userName,
      avatar: socket.userAvatar,
    });

    // Helper: emit chat_error (NOT 'error' — that's reserved)
    function chatErr(msg) {
      console.error(`[chat] error uid=${uid}: ${msg}`);
      socket.emit('chat_error', { error: msg });
    }

    // Helper: emit to all sockets of a user
    function emitToUser(targetUid, event, data) {
      const sids = userSockets.get(targetUid);
      if (!sids) return;
      for (const sid of sids) io.to(sid).emit(event, data);
    }

    // ── get_rooms ─────────────────────────────────────────────────────────
    socket.on('get_rooms', async () => {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM chat_rooms
           WHERE participant_a_id = $1 OR participant_b_id = $1
           ORDER BY last_message_at DESC NULLS LAST`,
          [uid]
        );
        socket.emit('rooms_list', { rooms: rows.map(r => rowToRoom(r, uid)) });
      } catch (err) { chatErr(err.message); }
    });

    // ── open_room ──────────────────────────────────────────────────────────
    socket.on('open_room', async (data) => {
      const {
        other_user_id, other_user_name, other_user_avatar,
        context_type, context_id, context_title,
      } = unwrap(data);

      if (!other_user_id) return chatErr('other_user_id required');

      try {
        const roomId = buildRoomId(uid, other_user_id);

        // Upsert — idempotent, updates names/avatars each time
        const { rows } = await pool.query(
          `INSERT INTO chat_rooms
             (id,
              participant_a_id, participant_a_name, participant_a_avatar,
              participant_b_id, participant_b_name, participant_b_avatar,
              context_type, context_id, context_title)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE
             SET participant_a_name   = EXCLUDED.participant_a_name,
                 participant_a_avatar = EXCLUDED.participant_a_avatar,
                 participant_b_name   = EXCLUDED.participant_b_name,
                 participant_b_avatar = EXCLUDED.participant_b_avatar
           RETURNING *`,
          [
            roomId,
            uid,           socket.userName,    socket.userAvatar || null,
            other_user_id, other_user_name,    other_user_avatar || null,
            context_type || null, context_id || null, context_title || null,
          ]
        );

        socket.join(roomId);
        socket.emit('room_opened', { room: rowToRoom(rows[0], uid) });
      } catch (err) { chatErr(err.message); }
    });

    // ── join_room ──────────────────────────────────────────────────────────
    socket.on('join_room', (data) => {
      const { room_id } = unwrap(data);
      if (room_id) socket.join(room_id);
    });

    // ── leave_room ─────────────────────────────────────────────────────────
    socket.on('leave_room', (data) => {
      const { room_id } = unwrap(data);
      if (room_id) socket.leave(room_id);
    });

    // ── get_messages ───────────────────────────────────────────────────────
    socket.on('get_messages', async (data) => {
      const { room_id, before_id } = unwrap(data);
      if (!room_id) return chatErr('room_id required');

      // Verify user is participant before returning messages
      try {
        const { rows: check } = await pool.query(
          `SELECT id FROM chat_rooms WHERE id=$1
           AND (participant_a_id=$2 OR participant_b_id=$2)`,
          [room_id, uid]
        );
        if (!check.length) return chatErr('Not a participant');

        let rows;
        if (before_id) {
          ({ rows } = await pool.query(
            `SELECT * FROM (
               SELECT * FROM chat_messages
               WHERE room_id=$1 AND deleted=FALSE
                 AND created_at < (
                   SELECT created_at FROM chat_messages WHERE id=$2
                 )
               ORDER BY created_at DESC LIMIT 50
             ) sub ORDER BY created_at ASC`,
            [room_id, before_id]
          ));
        } else {
          ({ rows } = await pool.query(
            `SELECT * FROM (
               SELECT * FROM chat_messages
               WHERE room_id=$1 AND deleted=FALSE
               ORDER BY created_at DESC LIMIT 50
             ) sub ORDER BY created_at ASC`,
            [room_id]
          ));
        }
        socket.emit('messages_history', { messages: rows.map(rowToMessage) });
      } catch (err) { chatErr(err.message); }
    });

    // ── send_message ───────────────────────────────────────────────────────
    socket.on('send_message', async (data) => {
      const { room_id, text } = unwrap(data);
      if (!room_id || !text?.trim()) return chatErr('room_id and text required');

      try {
        // Verify participant
        const { rows: roomRows } = await pool.query(
          `SELECT * FROM chat_rooms WHERE id=$1
           AND (participant_a_id=$2 OR participant_b_id=$2)`,
          [room_id, uid]
        );
        if (!roomRows.length) return chatErr('Not a participant');

        const room    = roomRows[0];
        const isA     = room.participant_a_id === uid;
        const otherId = isA ? room.participant_b_id : room.participant_a_id;

        // Insert message
        const { rows: msgRows } = await pool.query(
          `INSERT INTO chat_messages
             (room_id, sender_id, sender_name, sender_avatar, text, type)
           VALUES ($1,$2,$3,$4,$5,'text')
           RETURNING *`,
          [room_id, uid, socket.userName, socket.userAvatar || null, text.trim()]
        );
        const message = rowToMessage(msgRows[0]);

        // Update room last_message + increment other user's unread
        const unreadCol = isA ? 'unread_b' : 'unread_a';
        const { rows: updatedRoom } = await pool.query(
          `UPDATE chat_rooms
           SET last_message=$2, last_message_at=NOW(),
               ${unreadCol}=${unreadCol}+1
           WHERE id=$1 RETURNING *`,
          [room_id, text.trim()]
        );

        const roomForMe    = rowToRoom(updatedRoom[0], uid);
        const roomForOther = rowToRoom(updatedRoom[0], otherId);

        // ── Emit over Socket.io ──────────────────────────────────────────
        // To everyone in the socket room (both participants if both online)
        io.to(room_id).emit('new_message', { message });
        socket.emit('rooms_updated', { room: roomForMe });
        emitToUser(otherId, 'rooms_updated', { room: roomForOther });
        // Push to other user even if they haven't joined the room socket
        emitToUser(otherId, 'new_message', { message });

        // ── FCM push notification for offline receiver ───────────────────
        // Only send if the other user has NO active socket connection
        const isOtherOnline = userSockets.has(otherId) &&
                              userSockets.get(otherId).size > 0;

        if (!isOtherOnline) {
          try {
            // Look up FCM token from users table
            const { rows: tokenRows } = await pool.query(
              `SELECT fcm_token FROM users WHERE id=$1 AND fcm_token IS NOT NULL`,
              [otherId]
            );
            if (tokenRows.length > 0 && tokenRows[0].fcm_token) {
              const fcmToken = tokenRows[0].fcm_token;
              const senderDisplay = socket.userName || 'Someone';
              const msgPreview = text.trim().length > 80
                ? text.trim().substring(0, 80) + '…'
                : text.trim();

              await admin.messaging().send({
                token: fcmToken,
                notification: {
                  title: senderDisplay,
                  body:  msgPreview,
                },
                data: {
                  route:      `/chat/${room_id}`,
                  room_id:    room_id,
                  sender_id:  uid,
                  sender_name: senderDisplay,
                  type:       'chat_message',
                },
                android: {
                  notification: {
                    channelId:    'chat_messages',
                    priority:     'high',
                    defaultSound: true,
                    clickAction:  'FLUTTER_NOTIFICATION_CLICK',
                  },
                  priority: 'high',
                },
                apns: {
                  payload: {
                    aps: {
                      alert: { title: senderDisplay, body: msgPreview },
                      badge: roomForOther.unread_count,
                      sound: 'default',
                    },
                  },
                },
              });
              console.log(`[chat] FCM sent to uid=${otherId}`);
            }
          } catch (fcmErr) {
            // FCM failure must never break the chat flow
            console.error('[chat] FCM push error:', fcmErr.message);
          }
        }

      } catch (err) { chatErr(err.message); }
    });

    // ── mark_read ──────────────────────────────────────────────────────────
    socket.on('mark_read', async (data) => {
      const { room_id } = unwrap(data);
      if (!room_id) return;
      try {
        await pool.query(
          `UPDATE chat_messages
           SET is_read=TRUE
           WHERE room_id=$1 AND sender_id<>$2 AND is_read=FALSE`,
          [room_id, uid]
        );
        const { rows: check } = await pool.query(
          `SELECT participant_a_id FROM chat_rooms WHERE id=$1`, [room_id]
        );
        if (!check.length) return;
        const col = check[0].participant_a_id === uid ? 'unread_a' : 'unread_b';
        const { rows: updated } = await pool.query(
          `UPDATE chat_rooms SET ${col}=0 WHERE id=$1 RETURNING *`, [room_id]
        );
        socket.emit('rooms_updated', { room: rowToRoom(updated[0], uid) });
      } catch (err) { chatErr(err.message); }
    });

    // ── delete_message ─────────────────────────────────────────────────────
    socket.on('delete_message', async (data) => {
      const { room_id, message_id } = unwrap(data);
      if (!room_id || !message_id) return chatErr('room_id and message_id required');
      try {
        const { rowCount } = await pool.query(
          `UPDATE chat_messages SET deleted=TRUE
           WHERE id=$1 AND sender_id=$2`,
          [message_id, uid]
        );
        if (rowCount > 0) {
          io.to(room_id).emit('message_deleted', { message_id, room_id });
        }
      } catch (err) { chatErr(err.message); }
    });

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[chat] disconnected uid=${uid} reason=${reason}`);
      const sids = userSockets.get(uid);
      if (sids) {
        sids.delete(socket.id);
        if (sids.size === 0) userSockets.delete(uid);
      }
    });
  });

  return io;
};

// ── Standalone mode ───────────────────────────────────────────────────────────
if (require.main === module) {
  const http       = require('http');
  const httpServer = http.createServer();
  module.exports(httpServer);
  const port = process.env.CHAT_PORT || 4001;
  httpServer.listen(port, () =>
    console.log(`[chat] Socket.io server listening on :${port}`)
  );
}