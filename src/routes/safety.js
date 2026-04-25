// backend/routes/safety.js
//
// Mount: app.use('/safety', require('./routes/safety'))
//
// Covers:
//   Feature 5 — Verification status, ID upload notification
//   Feature 6 — Reports, block/unblock, unlock rate-limit
//
// ENV: DATABASE_URL

'use strict';
const express         = require('express');
const { Pool }        = require('pg');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const pool   = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ═════════════════════════════════════════════════════════════════════════════
//  Feature 5 — Verification
// ═════════════════════════════════════════════════════════════════════════════

// GET /safety/status  — load full safety context for the current user

router.get('/status', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;

    // Verification row (upsert-read)
    const { rows: vRows } = await pool.query(
      `SELECT * FROM user_verifications WHERE user_id = $1`,
      [uid]
    );
    const v = vRows[0] ?? {};

    // Blocks the user has placed
    const { rows: bRows } = await pool.query(
      `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1`,
      [uid]
    );

    // Unlocks today
    const { rows: uRows } = await pool.query(
      `SELECT COALESCE(cnt,0) AS cnt
       FROM contact_unlock_daily
       WHERE user_id = $1 AND day = CURRENT_DATE`,
      [uid]
    );

    res.json({
      phone_verified:    v.phone_verified    ?? false,
      id_uploaded:       v.id_uploaded       ?? false,
      id_doc_url:        v.id_doc_url        ?? null,
      is_verified:       v.is_verified       ?? false,
      blocked_user_ids:  bRows.map((r) => r.blocked_id),
      unlocks_today:     parseInt(uRows[0]?.cnt ?? '0', 10),
    });
  } catch (err) {
    console.error('[safety] GET /status', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /safety/id-upload  — record that a user uploaded their ID document

router.post('/id-upload', requireAuth, async (req, res) => {
  try {
    const { id_doc_url } = req.body;
    if (!id_doc_url) return res.status(400).json({ error: 'id_doc_url required' });

    await pool.query(
      `INSERT INTO user_verifications (user_id, id_doc_url, id_uploaded)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET id_doc_url = EXCLUDED.id_doc_url,
           id_uploaded = TRUE,
           updated_at  = NOW()`,
      [req.uid, id_doc_url]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[safety] POST /id-upload', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Feature 6 — Reports
// ═════════════════════════════════════════════════════════════════════════════

// POST /safety/reports

router.post('/reports', requireAuth, async (req, res) => {
  try {
    const { target_id, target_type, reason, description } = req.body;
    if (!target_id || !target_type || !reason) {
      return res.status(400).json({ error: 'target_id, target_type, reason required' });
    }

    await pool.query(
      `INSERT INTO reports (reporter_id, target_id, target_type, reason, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.uid, target_id, target_type, reason, description ?? '']
    );
    res.status(201).json({ reported: true });
  } catch (err) {
    console.error('[safety] POST /reports', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Feature 6 — Block / Unblock
// ═════════════════════════════════════════════════════════════════════════════

// POST /safety/blocks  { blocked_id: "..." }

router.post('/blocks', requireAuth, async (req, res) => {
  try {
    const { blocked_id } = req.body;
    if (!blocked_id) return res.status(400).json({ error: 'blocked_id required' });
    if (blocked_id === req.uid) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.uid, blocked_id]
    );
    res.status(201).json({ blocked: true });
  } catch (err) {
    console.error('[safety] POST /blocks', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /safety/blocks/:blocked_id

router.delete('/blocks/:blocked_id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.uid, req.params.blocked_id]
    );
    res.json({ unblocked: true });
  } catch (err) {
    console.error('[safety] DELETE /blocks/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Feature 6 — Unlock rate-limit (server-side enforcement)
//  Called inside the existing marketplace /unlocks POST before recording unlock.
// ═════════════════════════════════════════════════════════════════════════════

// Exported as a helper so marketplace.js can call it directly.
async function checkAndConsumeUnlock(uid, limit = 5) {
  const { rows } = await pool.query(
    `SELECT try_consume_unlock($1, $2) AS allowed`,
    [uid, limit]
  );
  return rows[0]?.allowed === true;
}

module.exports = { router, checkAndConsumeUnlock };