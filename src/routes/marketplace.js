// backend/routes/marketplace.js
//
// Mount in your Express app:  app.use('/marketplace', require('./routes/marketplace'))
//
// Env vars needed:
//   DATABASE_URL   — Neon connection string (postgres://user:pass@host/db?sslmode=require)
//
// Auth middleware (verifyFirebaseToken) should already exist in your app and
// attach  req.uid  (the Firebase UID) to every request.

const express  = require('express');
const { Pool } = require('pg');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // required for Neon
  max: 10,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const row2prop = (r) => ({
  id:                r.id,
  owner_id:          r.owner_id,
  owner_name:        r.owner_name,
  owner_phone:       r.owner_phone,
  title:             r.title,
  description:       r.description,
  property_type:     r.property_type,
  rent:              parseFloat(r.rent),
  deposit:           parseFloat(r.deposit),
  location:          r.location,
  amenities:         r.amenities,
  available_for:     r.available_for,
  rules:             r.rules,
  images:            r.images,
  is_verified:       r.is_verified,
  contact_preference: r.contact_preference,
  created_at:        r.created_at,
});

// ── GET /marketplace/properties ───────────────────────────────────────────────
// Query params: sort_by, property_type, available_for, min_budget, max_budget,
//               location, amenities (comma-separated)

router.get('/properties',async (req, res) => {
  try {
    const {
      sort_by       = 'latest',
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
      // Full-text search across title and address
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
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

    const { rows } = await pool.query(
      `SELECT * FROM marketplace_properties WHERE owner_id = $1 ORDER BY created_at DESC`,
      [uid]
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
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

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
        uid, owner_name, owner_phone, title, description,
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

// ── DELETE /marketplace/properties/:id ────────────────────────────────────────

router.delete('/properties/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

    const { rowCount } = await pool.query(
      `DELETE FROM marketplace_properties WHERE id = $1 AND owner_id = $2`,
      [req.params.id, uid]
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

// ── POST /marketplace/unlocks ─────────────────────────────────────────────────

router.post('/unlocks', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

    const { property_id } = req.body;
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
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

    const { rows } = await pool.query(
      `SELECT property_id FROM contact_unlocks WHERE user_id = $1`,
      [uid]
    );
    res.json({ unlocked_property_ids: rows.map((r) => r.property_id) });
  } catch (err) {
    console.error('[marketplace] GET /unlocks', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /marketplace/upload ──────────────────────────────────────────────────
// Decodes a base-64 file sent by the Flutter client and stores it.
// Swap the storage section for S3, Supabase Storage, Cloudinary, etc.

router.post('/upload', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

    const { file_name, data } = req.body;
    if (!data) return res.status(400).json({ error: 'No file data provided' });

    const buffer = Buffer.from(data, 'base64');

    // ── Replace the block below with your preferred storage provider ──────────
    // Example: AWS S3
    //   const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    //   const s3  = new S3Client({ region: process.env.AWS_REGION });
    //   const key = `marketplace/${uid}/${Date.now()}_${file_name}`;
    //   await s3.send(new PutObjectCommand({
    //     Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: 'image/jpeg',
    //   }));
    //   const url = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${key}`;
    // ── End storage block ──────────────────────────────────────────────────────

    // Placeholder — returns a data URL so the app works without extra storage setup.
    const url = `data:image/jpeg;base64,${data.substring(0, 30)}...`;

    res.json({ url });
  } catch (err) {
    console.error('[marketplace] POST /upload', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
