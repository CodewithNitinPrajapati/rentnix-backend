const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// GET /groups — get all groups for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.query.user_id; // Supabase UUID of user
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const memberRows = await query(
      `SELECT group_id FROM group_members WHERE user_id = $1`, [userId]
    );
    if (!memberRows.length) return res.json({ groups: [] });

    const groupIds  = memberRows.map(r => r.group_id);
    const placeholders = groupIds.map((_, i) => `$${i + 1}`).join(',');
    const groupRows = await query(
      `SELECT * FROM groups WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
      groupIds
    );

    // Fetch members + expenses for each group
    const groups = await Promise.all(groupRows.map(async (g) => {
      const members = await query(
        `SELECT * FROM group_members WHERE group_id = $1`, [g.id]
      );
      const expSplits = await query(
        `SELECT paid_by, paid_by_name, splits FROM expenses WHERE group_id = $1`, [g.id]
      );

      // Rebuild missing members from expense splits
      const memberMap = {};
      for (const m of members) memberMap[m.user_id] = m;

      for (const exp of expSplits) {
        const splits = Array.isArray(exp.splits) ? exp.splits : [];
        for (const s of splits) {
          const uid = s.user_id || s.userId || '';
          if (uid && !memberMap[uid] && !uid.startsWith('member_')) {
            memberMap[uid] = {
              user_id: uid, name: s.name || 'Member',
              phone: '', role: 'member', joined_at: new Date(),
            };
          }
        }
        if (exp.paid_by && !memberMap[exp.paid_by]) {
          memberMap[exp.paid_by] = {
            user_id: exp.paid_by, name: exp.paid_by_name || 'Member',
            phone: '', role: 'member', joined_at: new Date(),
          };
        }
      }

      return { ...g, members: Object.values(memberMap) };
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
        [group.id, created_by, member_name || 'Me', member_phone || '']
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

// DELETE /groups/:id — delete group + all related data
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
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

// PATCH /groups/:id — update group name
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    await query(`UPDATE groups SET name = $1 WHERE id = $2`, [name, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /groups/invite/:code — join by invite code
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
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const groupId = req.params.id;
    const { name, phone, user_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    let resolvedUserId = user_id;
    let resolvedName   = name;

    // If no user_id provided, try to find real user by phone
    if (!resolvedUserId && phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      const userRows = await query(
        `SELECT id, name FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
        [digits, `+91${digits}`]
      );
      if (userRows.length) {
        resolvedUserId = userRows[0].id;
        if (!resolvedName && userRows[0].name) resolvedName = userRows[0].name;
      }
    }

    const uid = resolvedUserId || `member_${Date.now()}`;

    // Check if already member
    const existing = await query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, uid]
    );
    if (existing.length) return res.status(409).json({ error: `${resolvedName} is already in this group` });

    const digits2  = (phone || '').replace(/\D/g, '').slice(-10);
    const normPhone = digits2 ? `+91${digits2}` : (phone || '');

    const rows = await query(
      `INSERT INTO group_members (group_id, user_id, name, phone, role)
       VALUES ($1, $2, $3, $4, 'member')
       RETURNING *`,
      [groupId, uid, resolvedName, normPhone]
    );
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

// POST /groups/:id/merge — merge placeholder members after login
router.post('/:id/merge', requireAuth, async (req, res) => {
  try {
    const { real_user_id, phone } = req.body;
    if (!real_user_id || !phone) return res.status(400).json({ error: 'real_user_id and phone required' });

    const digits = phone.replace(/\D/g, '').slice(-10);
    const rows = await query(
      `SELECT id, user_id, group_id FROM group_members WHERE user_id LIKE 'member_%'`
    );

    // Filter by phone matching
    const phoneRows = await query(
      `SELECT gm.id, gm.group_id FROM group_members gm
       WHERE gm.user_id LIKE 'member_%'
         AND (gm.phone LIKE $1 OR gm.phone LIKE $2)`,
      [`%${digits}`, `+91${digits}`]
    );

    let merged = 0;
    for (const row of phoneRows) {
      const existing = await query(
        `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [row.group_id, real_user_id]
      );
      if (existing.length) {
        await query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
      } else {
        await query(
          `UPDATE group_members SET user_id = $1 WHERE id = $2`,
          [real_user_id, row.id]
        );
        merged++;
      }
    }
    res.json({ merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /groups/merge-all — merge all placeholder members for a user across all groups
router.post('/merge-all', requireAuth, async (req, res) => {
  try {
    const { real_user_id, phone } = req.body;
    if (!real_user_id || !phone) return res.status(400).json({ error: 'real_user_id and phone required' });

    const digits = phone.replace(/\D/g, '').slice(-10);
    const phoneRows = await query(
      `SELECT gm.id, gm.group_id FROM group_members gm
       WHERE gm.user_id LIKE 'member_%'
         AND (gm.phone LIKE $1 OR gm.phone LIKE $2)`,
      [`%${digits}`, `+91${digits}`]
    );

    let merged = 0;
    for (const row of phoneRows) {
      const existing = await query(
        `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [row.group_id, real_user_id]
      );
      if (existing.length) {
        await query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
      } else {
        await query(`UPDATE group_members SET user_id = $1 WHERE id = $2`, [real_user_id, row.id]);
        merged++;
      }
    }
    res.json({ merged });
  } catch (err) {
    console.error('[merge-all]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
