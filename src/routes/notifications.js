// routes/notifications.js
// FCM push notifications — group events (expense add/edit, member add, settlement)
//
// SETUP:
//   1. Firebase Admin SDK install karo:  npm install firebase-admin
//   2. Firebase Console → Project Settings → Service Accounts → Generate new private key
//   3. Save as: serviceAccountKey.json  (project root mein, .gitignore mein add karo!)
//   4. .env mein add karo: FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json

const express      = require('express');
const router       = express.Router();
const { pool }     = require('../db');
const { requireAuth } = require('../middleware/auth'); // tumhara existing neon db pool

// ── Firebase Admin init ──────────────────────────────────────────────────────
let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    // Supports: FIREBASE_SERVICE_ACCOUNT (JSON string) or FIREBASE_SERVICE_ACCOUNT_PATH (file path)
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    } else {
      throw new Error('No Firebase service account configured');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[FCM] Firebase Admin initialized');
  }
} catch (e) {
  console.warn('[FCM] Firebase Admin not configured:', e.message);
}

// ── Helper: group ke sab members ke FCM tokens laao ─────────────────────────
async function getGroupMemberTokens(groupId, excludeUserId = null) {
  const query = `
    SELECT u.fcm_token
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = $1
      AND u.fcm_token IS NOT NULL
      AND u.fcm_token != ''
      ${excludeUserId ? "AND u.id != $2" : ""}
  `;
  const params = excludeUserId ? [groupId, excludeUserId] : [groupId];
  const { rows } = await pool.query(query, params);
  return rows.map(r => r.fcm_token).filter(Boolean);
}

// ── Helper: specific users ke tokens laao ───────────────────────────────────
async function getUserTokens(userIds) {
  if (!userIds.length) return [];
  const { rows } = await pool.query(
    `SELECT fcm_token FROM users WHERE id = ANY($1) AND fcm_token IS NOT NULL`,
    [userIds]
  );
  return rows.map(r => r.fcm_token).filter(Boolean);
}

// ── Helper: FCM send karo (multiple tokens) ──────────────────────────────────
async function sendToTokens(tokens, notification, data = {}) {
  if (!admin || !tokens.length) return;
  try {
    // FCM v1 API — sendEachForMulticast use karo
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: notification.title,
        body:  notification.body,
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'rentnix_main',
          sound:     'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });

    console.log(`[FCM] Sent: ${response.successCount} ok, ${response.failureCount} failed`);

    // Failed tokens cleanup
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered') {
          // Token invalid — DB se delete karo
          pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [tokens[idx]])
            .catch(() => {});
        }
      }
    });
  } catch (e) {
    console.error('[FCM] Send error:', e.message);
  }
}

// ── GROUP NOTIFICATIONS ──────────────────────────────────────────────────────

// Expense add hua → group ke sab members ko notify karo (except jo add kiya)
async function notifyExpenseAdded({ groupId, groupName, addedByName, addedByUserId, expenseTitle, amount }) {
  const tokens = await getGroupMemberTokens(groupId, addedByUserId);
  await sendToTokens(tokens,
    {
      title: `💸 New expense in ${groupName}`,
      body:  `${addedByName} added "${expenseTitle}" ₹${Math.round(amount)}`,
    },
    { route: `/group/${groupId}`, type: 'expense' }
  );
}

// Expense edit/delete hua
async function notifyExpenseUpdated({ groupId, groupName, updatedByName, updatedByUserId, expenseTitle, action = 'updated' }) {
  const tokens = await getGroupMemberTokens(groupId, updatedByUserId);
  const emoji  = action === 'deleted' ? '🗑️' : '✏️';
  await sendToTokens(tokens,
    {
      title: `${emoji} Expense ${action} in ${groupName}`,
      body:  `${updatedByName} ${action} "${expenseTitle}"`,
    },
    { route: `/group/${groupId}`, type: 'expense_edit' }
  );
}

// Member add hua group mein
async function notifyMemberAdded({ groupId, groupName, addedByName, newMemberUserId, newMemberName }) {
  // 1. Existing members ko batao (new member ko nahi)
  const existingTokens = await getGroupMemberTokens(groupId, newMemberUserId);
  await sendToTokens(existingTokens,
    {
      title: `👤 New member in ${groupName}`,
      body:  `${addedByName} added ${newMemberName} to the group`,
    },
    { route: `/group/${groupId}`, type: 'member_add' }
  );

  // 2. New member ko invite notification bhejo
  if (newMemberUserId) {
    const newMemberTokens = await getUserTokens([newMemberUserId]);
    await sendToTokens(newMemberTokens,
      {
        title: `🎉 You were added to ${groupName}!`,
        body:  `${addedByName} added you. Open to see expenses.`,
      },
      { route: `/group/${groupId}`, type: 'group_invite' }
    );
  }
}

// Settlement record hua
async function notifySettlement({ groupId, groupName, paidByName, paidByUserId, paidToUserId, amount }) {
  const tokens = await getUserTokens([paidToUserId]);
  await sendToTokens(tokens,
    {
      title: `✅ Payment received in ${groupName}`,
      body:  `${paidByName} paid you ₹${Math.round(amount)}`,
    },
    { route: `/group/${groupId}`, type: 'settlement' }
  );
}

// ── REST ENDPOINTS ────────────────────────────────────────────────────────────

// Save/update FCM token (Flutter app calls this on login)
router.post('/fcm-token', requireAuth, async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) return res.status(400).json({ error: 'Missing fcm_token' });

    // req.uid = Firebase UID (set by requireAuth middleware)
    // Look up internal user id from firebase_uid
    const userRows = await pool.query(
      'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1',
      [req.uid]
    );
    if (!userRows.rows.length) return res.status(404).json({ error: 'User not found' });
    const userId = userRows.rows[0].id;

    await pool.query(
      'UPDATE users SET fcm_token = $1 WHERE id = $2',
      [fcm_token, userId]
    );
    console.log('[FCM] Token saved for user:', userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('/fcm-token error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete FCM token on logout
router.delete('/fcm-token', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET fcm_token = NULL WHERE id = (SELECT id FROM users WHERE firebase_uid = $1)',
      [req.uid]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export notification functions for use in other routes
module.exports = {
  router,
  notifyExpenseAdded,
  notifyExpenseUpdated,
  notifyMemberAdded,
  notifySettlement,
};