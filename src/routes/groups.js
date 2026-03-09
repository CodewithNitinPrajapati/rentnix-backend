const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { notifyMemberAdded } = require('./notifications');

// ─────────────────────────────────────────────────────────────
//  HELPER: Normalize phone → +91XXXXXXXXXX
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits ? `+91${digits}` : '';
}

// ─────────────────────────────────────────────────────────────
//  HELPER: Merge placeholder members → real user (in transaction)
//  Called after every member add and on login.
//
//  FIX: When a real user registers/logs in, any `member_XXXXX`
//  entry with matching phone gets upgraded to the real user_id.
//  Also updates expense splits so balances stay correct.
// ─────────────────────────────────────────────────────────────
async function mergePlaceholderMembers(client, realUserId, phone) {
  if (!phone) return 0;
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (!digits) return 0;

  // Find all placeholder group_members with matching phone
  const placeholders = await client.query(
    `SELECT id, group_id, user_id FROM group_members
     WHERE user_id LIKE 'member_%'
       AND (phone LIKE $1 OR phone = $2)`,
    [`%${digits}`, `+91${digits}`]
  );

  let merged = 0;
  for (const row of placeholders.rows) {
    // Check if real user already exists in this group
    const existing = await client.query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [row.group_id, realUserId]
    );

    if (existing.rows.length) {
      // Real user already in group → just delete the placeholder
      await client.query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
    } else {
      // Upgrade placeholder → real user
      await client.query(
        `UPDATE group_members SET user_id = $1 WHERE id = $2`,
        [realUserId, row.id]
      );
      merged++;
    }

    // FIX: Also update expense splits so balance calculation uses real user_id
    // Get all expenses in this group
    const expenses = await client.query(
      `SELECT id, splits, paid_by FROM expenses WHERE group_id = $1`,
      [row.group_id]
    );
    for (const exp of expenses.rows) {
      const splits = Array.isArray(exp.splits) ? exp.splits : JSON.parse(exp.splits || '[]');
      let changed = false;
      const newSplits = splits.map(s => {
        if (s.user_id === row.user_id) { changed = true; return { ...s, user_id: realUserId }; }
        return s;
      });
      if (changed) {
        await client.query(
          `UPDATE expenses SET splits = $1::jsonb WHERE id = $2`,
          [JSON.stringify(newSplits), exp.id]
        );
      }
      // Also fix paid_by if placeholder was the payer
      if (exp.paid_by === row.user_id) {
        await client.query(
          `UPDATE expenses SET paid_by = $1 WHERE id = $2`,
          [realUserId, exp.id]
        );
      }
    }

    // FIX: Update pairwise_balances to use real user_id
    // Replace old placeholder id in user_a_id or user_b_id
    const oldId = row.user_id;
    // user_a_id is always alphabetically smaller — recalculate canonical pair
    const pbRows = await client.query(
      `SELECT * FROM pairwise_balances WHERE user_a_id = $1 OR user_b_id = $1`,
      [oldId]
    );
    for (const pb of pbRows.rows) {
      const otherA = pb.user_a_id === oldId ? realUserId : pb.user_a_id;
      const otherB = pb.user_b_id === oldId ? realUserId : pb.user_b_id;
      const [newA, newB] = otherA < otherB ? [otherA, otherB] : [otherB, otherA];
      // Amount sign may need flipping if canonical order changed
      const flipped = (pb.user_a_id === oldId) !== (newA === realUserId);
      const newAmount = flipped ? -parseFloat(pb.amount) : parseFloat(pb.amount);

      // Delete old row, upsert with new ids
      await client.query(
        `DELETE FROM pairwise_balances WHERE user_a_id = $1 AND user_b_id = $2`,
        [pb.user_a_id, pb.user_b_id]
      );
      // Check if pair already exists (could happen if real user had existing balance with other)
      const existingPb = await client.query(
        `SELECT amount FROM pairwise_balances WHERE user_a_id = $1 AND user_b_id = $2`,
        [newA, newB]
      );
      if (existingPb.rows.length) {
        await client.query(
          `UPDATE pairwise_balances SET amount = amount + $3, updated_at = now()
           WHERE user_a_id = $1 AND user_b_id = $2`,
          [newA, newB, newAmount]
        );
      } else {
        await client.query(
          `INSERT INTO pairwise_balances (user_a_id, user_b_id, amount, updated_at)
           VALUES ($1, $2, $3, now())`,
          [newA, newB, newAmount]
        );
      }
    }
  }

  return merged;
}

// GET /groups
router.get('/', requireAuth, async (req, res) => {
  try {
    let userId = req.query.user_id;
    if (!userId) {
      const uRows = await query(`SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`, [req.uid]);
      if (uRows.length) userId = uRows[0].id;
    }
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const memberRows = await query(
      `SELECT group_id FROM group_members WHERE user_id = $1`, [userId]
    );
    if (!memberRows.length) return res.json({ groups: [] });

    const groupIds     = memberRows.map(r => r.group_id);
    const placeholders = groupIds.map((_, i) => `$${i + 1}`).join(',');
    const groupRows    = await query(
      `SELECT * FROM groups WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
      groupIds
    );

    const groups = await Promise.all(groupRows.map(async (g) => {
      const members = await query(
        `SELECT * FROM group_members WHERE group_id = $1`, [g.id]
      );
      return { ...g, members: members };
    }));

    res.json({ groups });
  } catch (err) {
    console.error('[GET /groups]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /groups — create group
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, type, created_by, member_name, member_phone } = req.body;
    if (!name || !created_by) return res.status(400).json({ error: 'name and created_by required' });

    const result = await transaction(async (client) => {
      const gRows = await client.query(
        `INSERT INTO groups (name, type, invite_code, created_by)
         VALUES ($1, $2, UPPER(SUBSTRING(gen_random_uuid()::text, 1, 8)), $3)
         RETURNING *`,
        [name, type || 'flat', created_by]
      );
      const group = gRows.rows[0];

      await client.query(
        `INSERT INTO group_members (group_id, user_id, name, phone, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [group.id, created_by, member_name || 'Me', normalizePhone(member_phone)]
      );

      const members = await client.query(
        `SELECT * FROM group_members WHERE group_id = $1`, [group.id]
      );
      return { ...group, members: members.rows };
    });

    res.status(201).json({ group: result });
  } catch (err) {
    console.error('[POST /groups]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /groups/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
      // Reverse all pairwise balances for this group's expenses first
      const expenses = await client.query(
        `SELECT paid_by, splits FROM expenses WHERE group_id = $1`, [req.params.id]
      );
      for (const exp of expenses.rows) {
        const splits = Array.isArray(exp.splits) ? exp.splits : JSON.parse(exp.splits || '[]');
        for (const split of splits) {
          if (split.user_id === exp.paid_by) continue;
          const debtor   = split.user_id;
          const creditor = exp.paid_by;
          const [userA, userB] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
          const delta = debtor < creditor ? -split.amount : split.amount;
          await client.query(
            `UPDATE pairwise_balances SET amount = amount + $3, updated_at = now()
             WHERE user_a_id = $1 AND user_b_id = $2`,
            [userA, userB, delta]
          );
        }
      }
      await client.query(`DELETE FROM group_members WHERE group_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM expenses      WHERE group_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM settlements   WHERE group_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM groups        WHERE id       = $1`, [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /groups]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /groups/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    await query(`UPDATE groups SET name = $1 WHERE id = $2`, [name, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /groups/invite/:code
router.get('/invite/:code', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM groups WHERE UPPER(invite_code) = UPPER($1) LIMIT 1`,
      [req.params.code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid invite code' });
    const members = await query(
      `SELECT * FROM group_members WHERE group_id = $1`, [rows[0].id]
    );
    res.json({ group: { ...rows[0], members } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MEMBERS ──────────────────────────────────────────────────────────────────

// POST /groups/:id/members — add member
// FIX: Always lookup real user by phone first. If found, use real user_id.
// Only fall back to member_XXXXX if user is not registered yet.
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const groupId = req.params.id;
    const { name, phone, user_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    let resolvedUserId = user_id;
    let resolvedName   = name;

    // Always try phone lookup first — even if user_id is provided
    // This prevents duplicate placeholder + registered user situation
    if (phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      const userRows = await query(
        `SELECT id, name FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
        [digits, `+91${digits}`]
      );
      if (userRows.length) {
        resolvedUserId = userRows[0].id;
        resolvedName   = userRows[0].name || name;
      }
    }

    // If still no user_id, generate placeholder
    const uid       = resolvedUserId || `member_${Date.now()}`;
    const normPhone = normalizePhone(phone);

    // Check duplicate
    const existing = await query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, uid]
    );
    if (existing.length) {
      return res.status(409).json({ error: `${resolvedName} is already in this group` });
    }

    // Also check by phone to avoid adding same person with different id
    if (normPhone) {
      const phoneExisting = await query(
        `SELECT id FROM group_members WHERE group_id = $1 AND phone = $2`,
        [groupId, normPhone]
      );
      if (phoneExisting.length) {
        return res.status(409).json({ error: `${resolvedName} is already in this group` });
      }
    }

    const rows = await query(
      `INSERT INTO group_members (group_id, user_id, name, phone, role)
       VALUES ($1, $2, $3, $4, 'member')
       RETURNING *`,
      [groupId, uid, resolvedName, normPhone]
    );

    // Notify group members about new member (fire-and-forget)
    try {
      const groupRows = await query(`SELECT name FROM groups WHERE id = $1`, [groupId]);
      const groupName = groupRows[0]?.name || 'Group';
      const adderRows = await query(`SELECT name FROM users WHERE firebase_uid = $1 LIMIT 1`, [req.uid]);
      const adderName = adderRows[0]?.name || 'Someone';
      notifyMemberAdded({
        groupId,
        groupName,
        addedByName:      adderName,
        newMemberUserId:  uid.startsWith('member_') ? null : uid,
        newMemberName:    resolvedName,
      }).catch(() => {});
    } catch (_) {}

    res.status(201).json({ member: rows[0] });
  } catch (err) {
    console.error('[POST members]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /groups/:id/members/:userId
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    await query(
      `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /groups/:id/merge — merge placeholder after login (called from Flutter on login)
router.post('/:id/merge', requireAuth, async (req, res) => {
  try {
    const { real_user_id, phone } = req.body;
    if (!real_user_id || !phone) return res.status(400).json({ error: 'real_user_id and phone required' });
    const result = await transaction(async (client) => {
      return await mergePlaceholderMembers(client, real_user_id, phone);
    });
    res.json({ merged: result });
  } catch (err) {
    console.error('[merge]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /groups/merge-all — merge all placeholders on login
router.post('/merge-all', requireAuth, async (req, res) => {
  try {
    const { real_user_id, phone } = req.body;
    if (!real_user_id || !phone) return res.status(400).json({ error: 'real_user_id and phone required' });
    const result = await transaction(async (client) => {
      return await mergePlaceholderMembers(client, real_user_id, phone);
    });
    res.json({ merged: result });
  } catch (err) {
    console.error('[merge-all]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
