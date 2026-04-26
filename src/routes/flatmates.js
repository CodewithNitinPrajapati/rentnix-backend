// backend/routes/flatmates.js
//
// Mount: app.use('/flatmates', require('./routes/flatmates'))
//
// ENV: DATABASE_URL (Neon postgres connection string)
// Auth middleware attaches req.uid from Firebase token.

'use strict';
const express        = require('express');
const { Pool }       = require('pg');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const pool   = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const row2profile = (r) => ({
  id:                r.id,
  user_id:           r.user_id,
  name:              r.name,
  age:               r.age,
  profession:        r.profession,
  budget:            parseFloat(r.budget),
  preferred_location: r.preferred_location,
  habits:            r.habits,
  gender_preference: r.gender_preference,
  move_in_date:      r.move_in_date
    ? new Date(r.move_in_date).toISOString().split('T')[0]
    : null,
  is_verified:       r.is_verified,
  avatar_url:        r.avatar_url,
  bio:               r.bio,
  created_at:        r.created_at,
});

// ── GET /flatmates  (search + filter) ─────────────────────────────────────────
// Query params: location, min_budget, max_budget, gender_preference, sort_by

router.get('/', async (req, res) => {
  try {
    const {
      location,
      min_budget,
      max_budget,
      gender_preference,
      sort_by = 'latest',
    } = req.query;

    const conditions = [];
    const values     = [];
    let   idx        = 1;

    if (location) {
      conditions.push(
        `to_tsvector('english', preferred_location) @@ plainto_tsquery('english', $${idx++})`
      );
      values.push(location);
    }
    if (min_budget) {
      conditions.push(`budget >= $${idx++}`);
      values.push(parseFloat(min_budget));
    }
    if (max_budget) {
      conditions.push(`budget <= $${idx++}`);
      values.push(parseFloat(max_budget));
    }
    if (gender_preference) {
      conditions.push(`gender_preference = $${idx++}`);
      values.push(gender_preference);
    }

    const orderBy = sort_by === 'budget_asc' ? 'budget ASC' : 'created_at DESC';
    const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM flatmates ${where} ORDER BY ${orderBy} LIMIT 50`,
      values
    );
    res.json({ flatmates: rows.map(row2profile) });
  } catch (err) {
    console.error('[flatmates] GET /', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /flatmates/me ─────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM flatmates WHERE user_id = $1',
      [req.uid]
    );
    if (rows.length === 0) return res.status(404).json({ flatmate: null });
    res.json({ flatmate: row2profile(rows[0]) });
  } catch (err) {
    console.error('[flatmates] GET /me', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /flatmates  (create) ─────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const {
      name, age, profession, budget, preferred_location,
      habits, gender_preference, move_in_date, avatar_url, bio,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO flatmates
         (user_id, name, age, profession, budget, preferred_location,
          habits, gender_preference, move_in_date, avatar_url, bio,
          phone, contact_preference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        uid, name, age, profession, budget, preferred_location,
        JSON.stringify(habits ?? { smoking: false, drinking: false }),
        gender_preference ?? 'any',
        move_in_date,
        avatar_url ?? null,
        bio ?? null,
        req.body.phone ?? '',
        req.body.contact_preference ?? 'inApp',
      ]
    );
    res.status(201).json({ flatmate: row2profile(rows[0]) });
  } catch (err) {
    // Duplicate key = profile already exists; treat as update
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Profile already exists. Use PUT /flatmates/me' });
    }
    console.error('[flatmates] POST /', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /flatmates/me  (update) ───────────────────────────────────────────────

router.put('/me', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const {
      name, age, profession, budget, preferred_location,
      habits, gender_preference, move_in_date, avatar_url, bio,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE flatmates
       SET name=$2, age=$3, profession=$4, budget=$5,
           preferred_location=$6, habits=$7, gender_preference=$8,
           move_in_date=$9, avatar_url=$10, bio=$11,
           phone=$12, contact_preference=$13
       WHERE user_id=$1
       RETURNING *`,
      [
        uid, name, age, profession, budget, preferred_location,
        JSON.stringify(habits ?? { smoking: false, drinking: false }),
        gender_preference ?? 'any',
        move_in_date,
        avatar_url ?? null,
        bio ?? null,
        req.body.phone ?? '',
        req.body.contact_preference ?? 'inApp',
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    res.json({ flatmate: row2profile(rows[0]) });
  } catch (err) {
    console.error('[flatmates] PUT /me', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /flatmates/me ──────────────────────────────────────────────────────

router.delete('/me', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM flatmates WHERE user_id = $1', [req.uid]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[flatmates] DELETE /me', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;