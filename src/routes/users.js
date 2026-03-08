const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
//  HELPER: Merge all placeholder members for a real user
//  (same logic as groups.js mergePlaceholderMembers but
//   without transaction client — uses query directly)
// ─────────────────────────────────────────────────────────────
async function mergeAllPlaceholders(client, realUserId, phone) {
  if (!phone) return;
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (!digits) return;

  const placeholders = await client.query(
    `SELECT id, group_id, user_id FROM group_members
     WHERE user_id LIKE 'member_%'
       AND (phone LIKE $1 OR phone = $2)`,
    [`%${digits}`, `+91${digits}`]
  );

  for (const row of placeholders.rows) {
    const existing = await client.query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [row.group_id, realUserId]
    );

    if (existing.rows.length) {
      await client.query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
    } else {
      await client.query(
        `UPDATE group_members SET user_id = $1 WHERE id = $2`,
        [realUserId, row.id]
      );
    }

    // Fix expense splits
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
      if (exp.paid_by === row.user_id) {
        await client.query(`UPDATE expenses SET paid_by = $1 WHERE id = $2`, [realUserId, exp.id]);
      }
    }

    // Fix pairwise_balances
    const oldId = row.user_id;
    const pbRows = await client.query(
      `SELECT * FROM pairwise_balances WHERE user_a_id = $1 OR user_b_id = $1`, [oldId]
    );
    for (const pb of pbRows.rows) {
      const otherA   = pb.user_a_id === oldId ? realUserId : pb.user_a_id;
      const otherB   = pb.user_b_id === oldId ? realUserId : pb.user_b_id;
      const [newA, newB] = otherA < otherB ? [otherA, otherB] : [otherB, otherA];
      const flipped  = (pb.user_a_id === oldId) !== (newA === realUserId);
      const newAmount = flipped ? -parseFloat(pb.amount) : parseFloat(pb.amount);

      await client.query(
        `DELETE FROM pairwise_balances WHERE user_a_id = $1 AND user_b_id = $2`,
        [pb.user_a_id, pb.user_b_id]
      );
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
}

// GET /users/me — get or create profile, then auto-merge placeholders
router.get('/me', requireAuth, async (req, res) => {
  try {
    const uid   = req.uid;
    const phone = req.firebaseUser.phone_number || '';
    const email = req.firebaseUser.email        || '';

    let rows = await query(
      `SELECT * FROM users WHERE firebase_uid = $1 LIMIT 1`, [uid]
    );

    if (!rows.length && phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      rows = await query(
        `SELECT * FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
        [`+91${digits}`, digits]
      );
    }

    if (!rows.length && email) {
      rows = await query(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [email]);
    }

    if (rows.length) {
      if (!rows[0].firebase_uid) {
        await query(`UPDATE users SET firebase_uid = $1 WHERE id = $2`, [uid, rows[0].id]);
        rows[0].firebase_uid = uid;
      }
      // Auto-merge ALL placeholders on every login
      if (phone) {
        await transaction(async (client) => {
          await mergeAllPlaceholders(client, rows[0].id, phone);
        });
      }
      return res.json({ user: rows[0], isNew: false });
    }

    // Create new user
    const digits   = phone ? phone.replace(/\D/g, '').slice(-10) : '';
    const normPhone = digits ? `+91${digits}` : phone;

    const inserted = await query(
      `INSERT INTO users (phone, email, name, firebase_uid)
       VALUES ($1, $2, '', $3)
       RETURNING *`,
      [normPhone, email, uid]
    );
    const newUser = inserted[0];

    // Auto-merge placeholders for new user too
    if (phone) {
      await transaction(async (client) => {
        await mergeAllPlaceholders(client, newUser.id, phone);
      });
    }

    res.status(201).json({ user: newUser, isNew: true });
  } catch (err) {
    console.error('[users/me]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /users/me
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, phone, email, upi_id, avatar_url } = req.body;
    const uid = req.uid;

    const rows = await query(
      `UPDATE users SET
         name       = COALESCE($1, name),
         phone      = COALESCE(NULLIF($2,''), phone),
         email      = COALESCE(NULLIF($3,''), email),
         upi_id     = COALESCE($4, upi_id),
         avatar_url = COALESCE($5, avatar_url)
       WHERE firebase_uid = $6
       RETURNING *`,
      [name, phone || '', email || '', upi_id, avatar_url, uid]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[users/me PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /users/lookup?phone=XXXXXXXXXX
router.get('/lookup', requireAuth, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ user: null });

    const digits = phone.replace(/\D/g, '').slice(-10);
    const rows = await query(
      `SELECT id, name, phone FROM users
       WHERE phone = $1 OR phone = $2 LIMIT 1`,
      [digits, `+91${digits}`]
    );
    res.json({ user: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
