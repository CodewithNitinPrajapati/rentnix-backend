// backend/chat_server.js
//
// Socket.io chat server — persists everything to Neon (PostgreSQL).
// Can run as a standalone process on a separate port, OR be integrated
// into your existing Express app by passing the http.Server instance.
//
// ── Standalone usage ──────────────────────────────────────────────────────────
//   node backend/chat_server.js
//   PORT defaults to 4001  (set env PORT to override)
//
// ── Integrated usage (recommended) ───────────────────────────────────────────
//   In your main server.js / app.js:
//     const httpServer = require('http').createServer(app);
//     require('./backend/chat_server')(httpServer);          // pass server
//     httpServer.listen(process.env.PORT || 3000);
//
// ── Env vars ──────────────────────────────────────────────────────────────────
//   DATABASE_URL          — Neon connection string
//   FIREBASE_PROJECT_ID   — used to verify Firebase ID tokens
//   CHAT_PORT             — standalone port (default 4001)
//
// ── Socket events (client → server) ──────────────────────────────────────────
//   authenticate   { token }                   verify Firebase token
//   join_room      { room_id }                 subscribe to a room's events
//   leave_room     { room_id }                 unsubscribe
//   open_room      { other_user_id, other_user_name, other_user_avatar?,
//                    context_type?, context_id?, context_title? }
//                  → emits  room_opened { room }
//   send_message   { room_id, text }
//                  → emits  new_message { message }  to both participants
//   mark_read      { room_id }
//   delete_message { room_id, message_id }
//                  → emits  message_deleted { message_id }  to room
//   get_rooms      {}
//                  → emits  rooms_list { rooms }
//   get_messages   { room_id, before_id? }     paginated (50/page)
//                  → emits  messages_history { messages }
//
// ── Socket events (server → client) ──────────────────────────────────────────
//   authenticated      { uid, name, avatar }
//   auth_error         { error }
//   room_opened        { room }
//   rooms_list         { rooms }
//   messages_history   { messages }
//   new_message        { message }
//   message_deleted    { message_id, room_id }
//   rooms_updated      { room }   — after send_message (updates last_msg, unread)
//   error              { error }

'use strict';
const { Pool }       = require('pg');
const admin          = require('firebase-admin');

// ── DB pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Firebase Admin (token verification) ──────────────────────────────────────
// Init only once. If firebase-admin is already initialised in the parent
// process, this is a no-op.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId:  process.env.FIREBASE_PROJECT_ID,
  });
}

// ── Helper: sort two UIDs to build deterministic room ID ─────────────────────
function buildRoomId(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToRoom(r, myUid) {
  const isA      = r.participant_a_id === myUid;
  const unread   = isA ? Number(r.unread_a) : Number(r.unread_b);
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
    text:          r.text,
    type:          r.type,
    is_read:       r.is_read,
    created_at:    r.created_at,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
// Accepts an existing http.Server (integrated mode) or creates one (standalone).

module.exports = function attachChatServer(httpServer) {
  const { Server } = require('socket.io');

  const io = new Server(httpServer, {
    cors: {
      origin:  '*',       // tighten in production
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // uid → socket mapping (one socket per user for simplicity)
  const onlineUsers = new Map(); // uid → socket.id

  // ── Middleware: verify Firebase token before connection ───────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token provided'));
    try {
      const decoded    = await admin.auth().verifyIdToken(token);
      socket.uid       = decoded.uid;
      socket.userName  = decoded.name   || 'User';
      socket.userAvatar = decoded.picture || null;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.uid;
    onlineUsers.set(uid, socket.id);

    socket.emit('authenticated', {
      uid,
      name:   socket.userName,
      avatar: socket.userAvatar,
    });

    // ── get_rooms ───────────────────────────────────────────────────────────
    socket.on('get_rooms', async () => {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM chat_rooms
           WHERE participant_a_id = $1 OR participant_b_id = $1
           ORDER BY last_message_at DESC NULLS LAST`,
          [uid]
        );
        socket.emit('rooms_list', { rooms: rows.map(r => rowToRoom(r, uid)) });
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── open_room ────────────────────────────────────────────────────────────
    socket.on('open_room', async ({
      other_user_id, other_user_name, other_user_avatar,
      context_type, context_id, context_title,
    }) => {
      try {
        const roomId = buildRoomId(uid, other_user_id);

        // Upsert room — idempotent
        const { rows } = await pool.query(
          `INSERT INTO chat_rooms
             (id, participant_a_id, participant_a_name, participant_a_avatar,
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
            uid,             socket.userName, socket.userAvatar,
            other_user_id,   other_user_name, other_user_avatar || null,
            context_type || null, context_id || null, context_title || null,
          ]
        );

        const room = rowToRoom(rows[0], uid);
        socket.join(roomId);
        socket.emit('room_opened', { room });
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── join_room ─────────────────────────────────────────────────────────────
    socket.on('join_room', ({ room_id }) => {
      socket.join(room_id);
    });

    // ── leave_room ────────────────────────────────────────────────────────────
    socket.on('leave_room', ({ room_id }) => {
      socket.leave(room_id);
    });

    // ── get_messages (paginated, 50/page) ──────────────────────────────────
    socket.on('get_messages', async ({ room_id, before_id }) => {
      try {
        let query, values;
        if (before_id) {
          // Cursor pagination — load older messages
          query = `
            SELECT * FROM chat_messages
            WHERE room_id = $1 AND deleted = FALSE
              AND created_at < (SELECT created_at FROM chat_messages WHERE id = $2)
            ORDER BY created_at DESC LIMIT 50`;
          values = [room_id, before_id];
        } else {
          // Latest 50
          query = `
            SELECT * FROM (
              SELECT * FROM chat_messages
              WHERE room_id = $1 AND deleted = FALSE
              ORDER BY created_at DESC LIMIT 50
            ) sub ORDER BY created_at ASC`;
          values = [room_id];
        }
        const { rows } = await pool.query(query, values);
        socket.emit('messages_history', { messages: rows.map(rowToMessage) });
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── send_message ──────────────────────────────────────────────────────────
    socket.on('send_message', async ({ room_id, text }) => {
      if (!text || !text.trim()) return;
      try {
        // Verify user is participant
        const { rows: roomRows } = await pool.query(
          `SELECT * FROM chat_rooms WHERE id = $1
           AND (participant_a_id = $2 OR participant_b_id = $2)`,
          [room_id, uid]
        );
        if (!roomRows.length) {
          return socket.emit('error', { error: 'Not a participant of this room' });
        }
        const room   = roomRows[0];
        const isA    = room.participant_a_id === uid;
        const otherId = isA ? room.participant_b_id : room.participant_a_id;

        // Insert message
        const { rows: msgRows } = await pool.query(
          `INSERT INTO chat_messages
             (room_id, sender_id, sender_name, sender_avatar, text, type)
           VALUES ($1, $2, $3, $4, $5, 'text')
           RETURNING *`,
          [room_id, uid, socket.userName, socket.userAvatar, text.trim()]
        );
        const message = rowToMessage(msgRows[0]);

        // Update room last_message + increment OTHER user's unread
        const unreadCol = isA ? 'unread_b' : 'unread_a';
        const { rows: updatedRoom } = await pool.query(
          `UPDATE chat_rooms
           SET last_message    = $2,
               last_message_at = NOW(),
               ${unreadCol}    = ${unreadCol} + 1
           WHERE id = $1
           RETURNING *`,
          [room_id, text.trim()]
        );

        // Emit to everyone in the room (sender + receiver if online)
        io.to(room_id).emit('new_message', { message });

        // Push room update to both users' sockets
        const roomForMe    = rowToRoom(updatedRoom[0], uid);
        const roomForOther = rowToRoom(updatedRoom[0], otherId);
        socket.emit('rooms_updated', { room: roomForMe });

        const otherSocketId = onlineUsers.get(otherId);
        if (otherSocketId) {
          io.to(otherSocketId).emit('new_message', { message });
          io.to(otherSocketId).emit('rooms_updated', { room: roomForOther });
        }
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── mark_read ─────────────────────────────────────────────────────────────
    socket.on('mark_read', async ({ room_id }) => {
      try {
        // Mark all messages in room as read for this user
        await pool.query(
          `UPDATE chat_messages
           SET is_read = TRUE
           WHERE room_id = $1 AND sender_id <> $2 AND is_read = FALSE`,
          [room_id, uid]
        );
        // Reset this user's unread counter
        const { rows: roomRows } = await pool.query(
          `SELECT participant_a_id FROM chat_rooms WHERE id = $1`, [room_id]
        );
        if (roomRows.length) {
          const isA    = roomRows[0].participant_a_id === uid;
          const col    = isA ? 'unread_a' : 'unread_b';
          const { rows: updated } = await pool.query(
            `UPDATE chat_rooms SET ${col} = 0 WHERE id = $1 RETURNING *`,
            [room_id]
          );
          socket.emit('rooms_updated', { room: rowToRoom(updated[0], uid) });
        }
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── delete_message ────────────────────────────────────────────────────────
    socket.on('delete_message', async ({ room_id, message_id }) => {
      try {
        const { rowCount } = await pool.query(
          `UPDATE chat_messages SET deleted = TRUE
           WHERE id = $1 AND sender_id = $2`,
          [message_id, uid]
        );
        if (rowCount > 0) {
          io.to(room_id).emit('message_deleted', { message_id, room_id });
        }
      } catch (err) {
        socket.emit('error', { error: err.message });
      }
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      onlineUsers.delete(uid);
    });
  });

  return io;
};

// ── Standalone mode ───────────────────────────────────────────────────────────
if (require.main === module) {
  const http = require('http');
  const httpServer = http.createServer();
  module.exports(httpServer);
  const port = process.env.CHAT_PORT || 4001;
  httpServer.listen(port, () => {
    console.log(`[chat] Socket.io server listening on port ${port}`);
  });
}