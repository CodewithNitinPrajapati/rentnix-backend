// backend/routes/marketplace.js
//
// Mount in your Express app:  app.use('/marketplace', require('./routes/marketplace'))
//
// Env vars needed:
//   DATABASE_URL              — Neon connection string (postgres://user:pass@host/db?sslmode=require)
//   CLOUDINARY_CLOUD_NAME     — Cloudinary cloud name
//   CLOUDINARY_API_KEY        — Cloudinary API key
//   CLOUDINARY_API_SECRET     — Cloudinary API secret
//
// Auth middleware (verifyFirebaseToken) must attach req.uid to every request.

'use strict';
const express    = require('express');
const { Pool }   = require('pg');
const cloudinary = require('cloudinary').v2;
const router     = express.Router();
const { requireAuth }           = require('../middleware/auth');
const { checkAndConsumeUnlock } = require('./safety'); // Feature 6 rate-limit

// ── DB pool ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
  max: 10,
});

// ── Cloudinary config ─────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Helper ─────────────────────────────────────────────────────────────────────

const row2prop = (r) => ({
  id:                 r.id,
  owner_id:           r.owner_id,
  owner_name:         r.owner_name,
  owner_phone:        r.owner_phone,
  title:              r.title,
  description:        r.description,
  property_type:      r.property_type,
  rent:               parseFloat(r.rent),
  deposit:            parseFloat(r.deposit),
  location:           r.location,
  amenities:          r.amenities,
  available_for:      r.available_for,
  rules:              r.rules,
  images:             r.images,
  is_verified:        r.is_verified,
  contact_preference: r.contact_preference,
  created_at:         r.created_at,
});

// ── GET /marketplace/properties ───────────────────────────────────────────────
// Query params: sort_by, property_type, available_for, min_budget, max_budget,
//               location, amenities (comma-separated)

router.get('/properties', async (req, res) => {
  try {
    const {
      sort_by = 'latest',
      property_type,
      available_for,
      min_budget,
      max_budget,
      location,
      amenities,
    } = req.query;

    const conditions = ['is_verified = TRUE'];
    const values     = [];
    let   idx        = 1;

    if (property_type) {
      conditions.push(`property_type = $${idx++}`);
      values.push(property_type);
    }
    if (available_for) {
      conditions.push(`available_for = $${idx++}`);
      values.push(available_for);
    }
    if (min_budget) {
      conditions.push(`rent >= $${idx++}`);
      values.push(parseFloat(min_budget));
    }
    if (max_budget) {
      conditions.push(`rent <= $${idx++}`);
      values.push(parseFloat(max_budget));
    }
    if (location) {
      conditions.push(
        `to_tsvector('english', title || ' ' || (location->>'address')) @@ plainto_tsquery('english', $${idx++})`
      );
      values.push(location);
    }
    if (amenities) {
      const list = amenities.split(',').map((a) => a.trim()).filter(Boolean);
      if (list.length > 0) {
        conditions.push(`amenities @> $${idx++}::text[]`);
        values.push(list);
      }
    }

    const orderBy = sort_by === 'price_asc' ? 'rent ASC' : 'created_at DESC';
    const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM marketplace_properties ${where} ORDER BY ${orderBy} LIMIT 50`,
      values
    );

    res.json({ properties: rows.map(row2prop) });
  } catch (err) {
    console.error('[marketplace] GET /properties', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /marketplace/properties/mine ─────────────────────────────────────────

router.get('/properties/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM marketplace_properties WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.uid]
    );
    res.json({ properties: rows.map(row2prop) });
  } catch (err) {
    console.error('[marketplace] GET /properties/mine', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /marketplace/properties ──────────────────────────────────────────────

router.post('/properties', requireAuth, async (req, res) => {
  try {
    const {
      owner_name, owner_phone, title, description,
      property_type, rent, deposit, location, amenities,
      available_for, rules, images, is_verified, contact_preference,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO marketplace_properties
         (owner_id, owner_name, owner_phone, title, description,
          property_type, rent, deposit, location, amenities,
          available_for, rules, images, is_verified, contact_preference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.uid, owner_name, owner_phone, title, description,
        property_type, rent, deposit,
        JSON.stringify(location),
        amenities,
        available_for,
        JSON.stringify(rules),
        images,
        is_verified ?? true,
        contact_preference,
      ]
    );
    res.status(201).json({ property: row2prop(rows[0]) });
  } catch (err) {
    console.error('[marketplace] POST /properties', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /marketplace/properties/:id  (edit listing) ────────────────────────
// Only the owner may edit. Ownership is verified server-side.

router.patch('/properties/:id', requireAuth, async (req, res) => {
  try {
    const { id }  = req.params;
    const uid     = req.uid;
    const {
      title, description, property_type, rent, deposit,
      location, amenities, available_for, rules, images,
      contact_preference, owner_name, owner_phone,
    } = req.body;

    // Ownership check
    const { rows: check } = await pool.query(
      `SELECT owner_id FROM marketplace_properties WHERE id = $1`,
      [id]
    );
    if (check.length === 0) return res.status(404).json({ error: 'Listing not found' });
    if (check[0].owner_id !== uid) {
      return res.status(403).json({ error: 'Not authorised to edit this listing' });
    }

    const { rows } = await pool.query(
      `UPDATE marketplace_properties
       SET title=$2, description=$3, property_type=$4, rent=$5, deposit=$6,
           location=$7, amenities=$8, available_for=$9, rules=$10, images=$11,
           contact_preference=$12, owner_name=$13, owner_phone=$14
       WHERE id=$1
       RETURNING *`,
      [
        id, title, description, property_type, rent, deposit,
        JSON.stringify(location),
        amenities,
        available_for,
        JSON.stringify(rules),
        images,
        contact_preference,
        owner_name,
        owner_phone,
      ]
    );
    res.json({ property: row2prop(rows[0]) });
  } catch (err) {
    console.error('[marketplace] PATCH /properties/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /marketplace/properties/:id ────────────────────────────────────────

router.delete('/properties/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM marketplace_properties WHERE id = $1 AND owner_id = $2`,
      [req.params.id, req.uid]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Not found or not your listing' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[marketplace] DELETE /properties/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /marketplace/unlocks  (rate-limited — max 5/day) ─────────────────────

router.post('/unlocks', requireAuth, async (req, res) => {
  try {
    const uid         = req.uid;
    const { property_id } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id required' });

    // Server-side rate-limit: 5 unlocks per user per calendar day
    const allowed = await checkAndConsumeUnlock(uid, 5);
    if (!allowed) {
      return res.status(429).json({
        error: 'Daily unlock limit reached. You can unlock up to 5 contacts per day.',
        code:  'UNLOCK_LIMIT_REACHED',
      });
    }

    await pool.query(
      `INSERT INTO contact_unlocks (user_id, property_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, property_id) DO NOTHING`,
      [uid, property_id]
    );
    res.json({ unlocked: true });
  } catch (err) {
    console.error('[marketplace] POST /unlocks', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /marketplace/unlocks ──────────────────────────────────────────────────

router.get('/unlocks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT property_id FROM contact_unlocks WHERE user_id = $1`,
      [req.uid]
    );
    res.json({ unlocked_property_ids: rows.map((r) => r.property_id) });
  } catch (err) {
    console.error('[marketplace] GET /unlocks', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /marketplace/upload  (Cloudinary) ────────────────────────────────────
// Flutter sends base64-encoded image data.
// Returns the Cloudinary secure_url stored in the DB.

router.post('/upload', requireAuth, async (req, res) => {
  try {
    const { file_name, data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'No file data provided' });
    }

    const result = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${data}`,
      {
        folder:    `marketplace/${req.uid}`,
        public_id: `${Date.now()}_${file_name}`,
      }
    );

    return res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[marketplace] POST /upload', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;