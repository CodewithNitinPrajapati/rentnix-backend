// routes/notifications.js
const express        = require('express');
const router         = express.Router();
const { pool }       = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── Firebase Admin init ──────────────────────────────────────────────────────
let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
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
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('[FCM] Firebase Admin initialized');
  }
} catch (e) {
  console.warn('[FCM] Firebase Admin not configured:', e.message);
}

// pool.query use karo — automatic type coercion hoti hai
async function getGroupMemberTokens(groupId, excludeUserId = null) {
  let sql, params;
  if (excludeUserId) {
    sql = `SELECT u.fcm_token FROM group_members gm
           JOIN users u ON u.id::text = gm.user_id
           WHERE gm.group_id::text = $1
             AND u.fcm_token IS NOT NULL AND u.fcm_token != ''
             AND u.id::text != $2`;
    params = [groupId, excludeUserId];
  } else {
    sql = `SELECT u.fcm_token FROM group_members gm
           JOIN users u ON u.id::text = gm.user_id
           WHERE gm.group_id::text = $1
             AND u.fcm_token IS NOT NULL AND u.fcm_token != ''`;
    params = [groupId];
  }
  const result = await pool.query(sql, params);
  return result.rows.map(r => r.fcm_token).filter(Boolean);
}

async function getUserTokens(userIds) {
  if (!userIds.length) return [];
  const result = await pool.query(
    `SELECT fcm_token FROM users WHERE id::text = ANY($1) AND fcm_token IS NOT NULL`,
    [userIds]
  );
  return result.rows.map(r => r.fcm_token).filter(Boolean);
}

async function sendToTokens(tokens, notification, data = {}) {
  if (!admin || !tokens.length) {
    console.log('[FCM] No tokens, skipping. Count:', tokens.length);
    return;
  }
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: notification.title, body: notification.body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      android: {
        priority: 'high',
        notification: { channelId: 'rentnix_main', sound: 'default' },
      },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    console.log(`[FCM] Sent: ${response.successCount} ok, ${response.failureCount} failed`);
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error('[FCM] Token failed:', resp.error?.code);
        const code = resp.error?.code;
        if (code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered') {
          pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [tokens[idx]]).catch(() => {});
        }
      }
    });
  } catch (e) {
    console.error('[FCM] Send error:', e.message);
  }
}

async function notifyExpenseAdded({ groupId, groupName, addedByName, addedByUserId, expenseTitle, amount }) {
  console.log('[FCM] notifyExpenseAdded, groupId:', groupId, 'excludeUser:', addedByUserId);
  const tokens = await getGroupMemberTokens(groupId, addedByUserId);
  console.log('[FCM] tokens found:', tokens.length);
  await sendToTokens(tokens,
    { title: `New expense in ${groupName}`, body: `${addedByName} added "${expenseTitle}" Rs.${Math.round(amount)}` },
    { route: `/group/${groupId}`, type: 'expense' }
  );
}

async function notifyExpenseUpdated({ groupId, groupName, updatedByName, updatedByUserId, expenseTitle, action = 'updated' }) {
  const tokens = await getGroupMemberTokens(groupId, updatedByUserId);
  await sendToTokens(tokens,
    { title: `Expense ${action} in ${groupName}`, body: `${updatedByName} ${action} "${expenseTitle}"` },
    { route: `/group/${groupId}`, type: 'expense_edit' }
  );
}

async function notifyMemberAdded({ groupId, groupName, addedByName, newMemberUserId, newMemberName }) {
  const existingTokens = await getGroupMemberTokens(groupId, newMemberUserId);
  await sendToTokens(existingTokens,
    { title: `New member in ${groupName}`, body: `${addedByName} added ${newMemberName} to the group` },
    { route: `/group/${groupId}`, type: 'member_add' }
  );
  if (newMemberUserId) {
    const newMemberTokens = await getUserTokens([newMemberUserId]);
    await sendToTokens(newMemberTokens,
      { title: `You were added to ${groupName}!`, body: `${addedByName} added you. Open to see expenses.` },
      { route: `/group/${groupId}`, type: 'group_invite' }
    );
  }
}

async function notifySettlement({ groupId, groupName, paidByName, paidByUserId, paidToUserId, amount }) {
  const tokens = await getUserTokens([paidToUserId]);
  await sendToTokens(tokens,
    { title: `Payment received in ${groupName}`, body: `${paidByName} paid you Rs.${Math.round(amount)}` },
    { route: `/group/${groupId}`, type: 'settlement' }
  );
}

// ── REST ENDPOINTS ────────────────────────────────────────────────────────────

router.post('/fcm-token', requireAuth, async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) return res.status(400).json({ error: 'Missing fcm_token' });

    const userResult = await pool.query(
      'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1', [req.uid]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const userId = userResult.rows[0].id;

    await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcm_token, userId]);
    console.log('[FCM] Token saved for user:', userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('/fcm-token error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

module.exports = { router, notifyExpenseAdded, notifyExpenseUpdated, notifyMemberAdded, notifySettlement };