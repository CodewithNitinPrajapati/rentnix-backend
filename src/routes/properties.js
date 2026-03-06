const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── PROPERTIES ────────────────────────────────────────────────────────────────

// GET /properties?owner_id=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    const { owner_id } = req.query;
    if (!owner_id) return res.status(400).json({ error: 'owner_id required' });

    const props = await query(
      `SELECT * FROM properties WHERE owner_id = $1 ORDER BY created_at DESC`, [owner_id]
    );

    const result = await Promise.all(props.map(async (p) => {
      const tenants = await query(
        `SELECT * FROM tenants WHERE property_id = $1 AND status = 'active'`, [p.id]
      );
      return { ...p, tenants };
    }));

    res.json({ properties: result });
  } catch (err) {
    console.error('[GET /properties]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /properties — add property
router.post('/', requireAuth, async (req, res) => {
  try {
    const { owner_id, name, address, city, total_rooms, property_type, unit_names } = req.body;
    if (!owner_id || !name) return res.status(400).json({ error: 'owner_id and name required' });

    const rows = await query(
      `INSERT INTO properties (owner_id, name, address, city, total_rooms, property_type, unit_names)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING *`,
      [owner_id, name, address || '', city || null,
       total_rooms || 1, property_type || '1 BHK',
       JSON.stringify(unit_names || [])]
    );
    res.status(201).json({ property: { ...rows[0], tenants: [] } });
  } catch (err) {
    console.error('[POST /properties]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /properties/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, address, city, total_rooms, property_type, unit_names } = req.body;
    const rows = await query(
      `UPDATE properties SET
         name          = COALESCE($1, name),
         address       = COALESCE($2, address),
         city          = COALESCE($3, city),
         total_rooms   = COALESCE($4, total_rooms),
         property_type = COALESCE($5, property_type),
         unit_names    = COALESCE($6::jsonb, unit_names)
       WHERE id = $7 RETURNING *`,
      [name, address, city, total_rooms, property_type,
       unit_names ? JSON.stringify(unit_names) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Property not found' });
    res.json({ property: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /properties/:id — cascade delete tenants + rent entries
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
      const tenants = await client.query(
        `SELECT id FROM tenants WHERE property_id = $1`, [req.params.id]
      );
      for (const t of tenants.rows) {
        await client.query(`DELETE FROM rent_entries WHERE tenant_id = $1`, [t.id]);
      }
      await client.query(`DELETE FROM tenants    WHERE property_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM properties WHERE id = $1`,          [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TENANTS ───────────────────────────────────────────────────────────────────

// GET /properties/:id/tenants — get tenants (optionally include vacated)
router.get('/:id/tenants', requireAuth, async (req, res) => {
  try {
    const { status } = req.query; // 'active' | 'vacated' | 'all'
    let sql = `SELECT * FROM tenants WHERE property_id = $1`;
    if (!status || status === 'active')  sql += ` AND status = 'active'`;
    if (status === 'vacated')            sql += ` AND status = 'vacated'`;
    sql += ` ORDER BY created_at DESC`;

    const rows = await query(sql, [req.params.id]);
    res.json({ tenants: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /properties/:id/tenants — add tenant
router.post('/:id/tenants', requireAuth, async (req, res) => {
  try {
    const propertyId = req.params.id;
    const t = req.body;

    const rows = await query(
      `INSERT INTO tenants
         (property_id, name, phone, email, upi_id,
          rent_amount, security_deposit, rent_due_day,
          move_in_date, status, room_number,
          allocated_units, unit_count, note,
          move_in_meter_reading, electricity_rate_per_unit, current_meter_reading)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        propertyId, t.name, t.phone || '', t.email || null, t.upi_id || null,
        t.rent_amount, t.security_deposit || 0, t.rent_due_day || 5,
        t.move_in_date, t.status || 'active', t.room_number || null,
        JSON.stringify(t.allocated_units || []), t.unit_count || 0,
        t.note || null,
        t.move_in_meter_reading || null,
        t.electricity_rate_per_unit || null,
        t.current_meter_reading || null,
      ]
    );
    res.status(201).json({ tenant: rows[0] });
  } catch (err) {
    console.error('[POST tenants]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /properties/:id/tenants/:tenantId — update tenant
router.patch('/:id/tenants/:tenantId', requireAuth, async (req, res) => {
  try {
    const t = req.body;
    const rows = await query(
      `UPDATE tenants SET
         name                      = COALESCE($1,  name),
         phone                     = COALESCE($2,  phone),
         upi_id                    = COALESCE($3,  upi_id),
         rent_amount               = COALESCE($4,  rent_amount),
         security_deposit          = COALESCE($5,  security_deposit),
         rent_due_day              = COALESCE($6,  rent_due_day),
         room_number               = COALESCE($7,  room_number),
         allocated_units           = COALESCE($8::jsonb, allocated_units),
         unit_count                = COALESCE($9,  unit_count),
         note                      = COALESCE($10, note),
         move_out_date             = COALESCE($11::date, move_out_date),
         status                    = COALESCE($12, status),
         electricity_rate_per_unit = COALESCE($13, electricity_rate_per_unit),
         current_meter_reading     = COALESCE($14, current_meter_reading)
       WHERE id = $15 RETURNING *`,
      [
        t.name, t.phone, t.upi_id,
        t.rent_amount, t.security_deposit, t.rent_due_day,
        t.room_number,
        t.allocated_units ? JSON.stringify(t.allocated_units) : null,
        t.unit_count, t.note,
        t.move_out_date || null, t.status,
        t.electricity_rate_per_unit, t.current_meter_reading,
        req.params.tenantId,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /properties/:id/tenants/:tenantId
router.delete('/:id/tenants/:tenantId', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
      await client.query(`DELETE FROM rent_entries WHERE tenant_id = $1`, [req.params.tenantId]);
      await client.query(`DELETE FROM tenants      WHERE id        = $1`, [req.params.tenantId]);
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RENT ENTRIES ──────────────────────────────────────────────────────────────

// GET /properties/:id/tenants/:tenantId/rent
router.get('/:id/tenants/:tenantId/rent', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM rent_entries WHERE tenant_id = $1 ORDER BY year DESC, month DESC`,
      [req.params.tenantId]
    );
    res.json({ rent_entries: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /properties/:id/tenants/:tenantId/rent — add rent entry
router.post('/:id/tenants/:tenantId/rent', requireAuth, async (req, res) => {
  try {
    const propertyId = req.params.id;
    const tenantId   = req.params.tenantId;
    const e = req.body;

    const total = (+e.rent_amount||0) + (+e.water_bill||0) +
                  (+e.electricity_bill||0) + (+e.maintenance_charge||0) + (+e.other_charges||0);
    const paid   = +e.amount_paid || 0;
    const status = paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

    // Check if entry already exists for this month/year
    const existing = await query(
      `SELECT * FROM rent_entries WHERE tenant_id=$1 AND month=$2 AND year=$3`,
      [tenantId, e.month, e.year]
    );

    let rows;
    if (existing.length > 0) {
      // UPDATE: add to existing payment — use EXISTING totalDue for correct status
      const prev = existing[0];
      const existingTotal = +prev.rent_amount + +prev.water_bill + +prev.electricity_bill +
                            +prev.maintenance_charge + +prev.other_charges;
      const newPaid = +prev.amount_paid + paid;
      const newStatus = newPaid >= existingTotal ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';
      rows = await query(
        `UPDATE rent_entries SET
           amount_paid=$1, status=$2,
           paid_on = CASE WHEN $3 > 0 THEN NOW() ELSE paid_on END,
           note=COALESCE($4, note),
           payment_batch_id=COALESCE($5, payment_batch_id)
         WHERE id=$6 RETURNING *`,
        [newPaid, newStatus, paid, e.note||null,
         e.payment_batch_id||null, prev.id]
      );
    } else {
      // INSERT new entry
      rows = await query(
        `INSERT INTO rent_entries
           (tenant_id, property_id, month, year, rent_amount,
            water_bill, electricity_bill, maintenance_charge, other_charges,
            amount_paid, status, paid_on, note, prev_units, curr_units, rate_per_unit,
            payment_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          tenantId, propertyId, e.month, e.year, e.rent_amount,
          e.water_bill||0, e.electricity_bill||0,
          e.maintenance_charge||0, e.other_charges||0,
          paid, status,
          paid > 0 ? new Date().toISOString() : null,
          e.note||null, e.prev_units||null,
          e.curr_units||null, e.rate_per_unit||null,
          e.payment_batch_id||null,
        ]
      );
    }
    res.status(201).json({ rent_entry: rows[0] });
  } catch (err) {
    console.error('[POST rent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FLAT MEMBER DETAILS ───────────────────────────────────────────────────────

// GET /properties/flat-details?group_id=xxx
router.get('/flat-details', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    const rows = await query(
      `SELECT * FROM flat_member_details WHERE group_id = $1`, [group_id]
    );
    res.json({ details: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /properties/flat-details — upsert flat member detail
router.put('/flat-details', requireAuth, async (req, res) => {
  try {
    const { group_id, user_id, security_deposit, move_in_date, move_out_date, note } = req.body;
    const rows = await query(
      `INSERT INTO flat_member_details
         (group_id, user_id, security_deposit, move_in_date, move_out_date, note)
       VALUES ($1,$2,$3,$4::date,$5::date,$6)
       ON CONFLICT (group_id, user_id) DO UPDATE SET
         security_deposit = EXCLUDED.security_deposit,
         move_in_date     = EXCLUDED.move_in_date,
         move_out_date    = EXCLUDED.move_out_date,
         note             = EXCLUDED.note
       RETURNING *`,
      [group_id, user_id, security_deposit || 0,
       move_in_date || null, move_out_date || null, note || null]
    );
    res.json({ detail: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
