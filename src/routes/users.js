const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /users/me — get or create profile for current Firebase user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const uid   = req.uid;
    const phone = req.firebaseUser.phone_number || '';
    const email = req.firebaseUser.email        || '';

    // Try saved Supabase-style UUID by firebase_uid
    let rows = await query(
      `SELECT * FROM users WHERE firebase_uid = $1 LIMIT 1`, [uid]
    );

    // Fallback: phone lookup
    if (!rows.length && phone) {
      rows = await query(
        `SELECT * FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
        [phone, phone.replace(/^\+91/, '').replace(/\D/g, '').slice(-10)]
      );
    }

    // Fallback: email lookup
    if (!rows.length && email) {
      rows = await query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`, [email]
      );
    }

    if (rows.length) {
      // Backfill firebase_uid if missing
      if (!rows[0].firebase_uid) {
        await query(`UPDATE users SET firebase_uid = $1 WHERE id = $2`, [uid, rows[0].id]);
        rows[0].firebase_uid = uid;
      }
      // Auto-merge placeholder members by phone
      if (phone) {
        const digits = phone.replace(/\D/g, '').slice(-10);
        if (digits) {
          const placeholders = await query(
            `SELECT id, group_id FROM group_members WHERE user_id LIKE 'member_%' AND (phone LIKE $1 OR phone LIKE $2)`,
            [`%${digits}`, `+91${digits}`]
          );
          for (const row of placeholders) {
            const exists = await query(
              `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
              [row.group_id, rows[0].id]
            );
            if (exists.length) {
              await query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
            } else {
              await query(`UPDATE group_members SET user_id = $1 WHERE id = $2`, [rows[0].id, row.id]);
            }
          }
        }
      }
      return res.json({ user: rows[0], isNew: false });
    }

    // Create new user
    const inserted = await query(
      `INSERT INTO users (phone, email, name, firebase_uid)
       VALUES ($1, $2, '', $3)
       RETURNING *`,
      [phone, email, uid]
    );
    const newUser = inserted[0];

    // Auto-merge placeholder members for this new user
    if (phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      if (digits) {
        const placeholders = await query(
          `SELECT id, group_id FROM group_members WHERE user_id LIKE 'member_%' AND (phone LIKE $1 OR phone LIKE $2)`,
          [`%${digits}`, `+91${digits}`]
        );
        for (const row of placeholders) {
          const exists = await query(
            `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
            [row.group_id, newUser.id]
          );
          if (exists.length) {
            await query(`DELETE FROM group_members WHERE id = $1`, [row.id]);
          } else {
            await query(`UPDATE group_members SET user_id = $1 WHERE id = $2`, [newUser.id, row.id]);
          }
        }
      }
    }

    res.status(201).json({ user: newUser, isNew: true });
  } catch (err) {
    console.error('[users/me]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /users/me — update profile
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

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[users/me PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /users/lookup?phone=XXXXXXXXXX — find user by phone
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
