const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── PROPERTIES ────────────────────────────────────────────────────────────────

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

router.post('/', requireAuth, async (req, res) => {
  try {
    const { owner_id, name, address, city, total_rooms, property_type, unit_names } = req.body;
    if (!owner_id || !name) return res.status(400).json({ error: 'owner_id and name required' });
    const rows = await query(
      `INSERT INTO properties (owner_id, name, address, city, total_rooms, property_type, unit_names)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
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
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ property: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
      const tenants = await client.query(
        `SELECT id FROM tenants WHERE property_id = $1`, [req.params.id]
      );
      for (const t of tenants.rows) {
        await client.query(`DELETE FROM payment_allocations WHERE rent_entry_id IN
          (SELECT id FROM rent_entries WHERE tenant_id = $1)`, [t.id]);
        await client.query(`DELETE FROM payments     WHERE tenant_id   = $1`, [t.id]);
        await client.query(`DELETE FROM rent_entries WHERE tenant_id   = $1`, [t.id]);
      }
      await client.query(`DELETE FROM tenants    WHERE property_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM properties WHERE id          = $1`, [req.params.id]);
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TENANTS ───────────────────────────────────────────────────────────────────

router.get('/:id/tenants', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT * FROM tenants WHERE property_id = $1`;
    if (!status || status === 'active') sql += ` AND status = 'active'`;
    if (status === 'vacated')           sql += ` AND status = 'vacated'`;
    sql += ` ORDER BY created_at DESC`;
    const rows = await query(sql, [req.params.id]);
    res.json({ tenants: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/tenants', requireAuth, async (req, res) => {
  try {
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
      [req.params.id, t.name, t.phone||'', t.email||null, t.upi_id||null,
       t.rent_amount, t.security_deposit||0, t.rent_due_day||5,
       t.move_in_date, t.status||'active', t.room_number||null,
       JSON.stringify(t.allocated_units||[]), t.unit_count||0, t.note||null,
       t.move_in_meter_reading||null, t.electricity_rate_per_unit||null,
       t.current_meter_reading||null]
    );
    res.status(201).json({ tenant: rows[0] });
  } catch (err) {
    console.error('[POST tenants]', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
      [t.name, t.phone, t.upi_id, t.rent_amount, t.security_deposit, t.rent_due_day,
       t.room_number, t.allocated_units ? JSON.stringify(t.allocated_units) : null,
       t.unit_count, t.note, t.move_out_date||null, t.status,
       t.electricity_rate_per_unit, t.current_meter_reading, req.params.tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/tenants/:tenantId', requireAuth, async (req, res) => {
  try {
    await transaction(async (client) => {
      await client.query(`DELETE FROM payment_allocations WHERE rent_entry_id IN
        (SELECT id FROM rent_entries WHERE tenant_id = $1)`, [req.params.tenantId]);
      await client.query(`DELETE FROM payments     WHERE tenant_id = $1`, [req.params.tenantId]);
      await client.query(`DELETE FROM rent_entries WHERE tenant_id = $1`, [req.params.tenantId]);
      await client.query(`DELETE FROM tenants      WHERE id        = $1`, [req.params.tenantId]);
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RENT ENTRIES (charges per month) ─────────────────────────────────────────

// GET rent entries enriched with allocation totals
router.get('/:id/tenants/:tenantId/rent', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT re.*,
              COALESCE(SUM(pa.amount_applied), 0) AS paid_via_allocations
       FROM rent_entries re
       LEFT JOIN payment_allocations pa ON pa.rent_entry_id = re.id
       WHERE re.tenant_id = $1
       GROUP BY re.id
       ORDER BY re.year DESC, re.month DESC`,
      [req.params.tenantId]
    );
    res.json({ rent_entries: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — add/update charge for a month, optionally record payment too
router.post('/:id/tenants/:tenantId/rent', requireAuth, async (req, res) => {
  try {
    const propertyId = req.params.id;
    const tenantId   = req.params.tenantId;
    const e          = req.body;

    // Check existing entry
    const existing = await query(
      `SELECT * FROM rent_entries WHERE tenant_id=$1 AND month=$2 AND year=$3`,
      [tenantId, e.month, e.year]
    );

    let entryRow;
    if (existing.length > 0) {
      const prev = existing[0];
      // ADD new charges on top of existing — never overwrite previous bills
      entryRow = (await query(
        `UPDATE rent_entries SET
           rent_amount        = $1,
           water_bill         = water_bill         + COALESCE($2, 0),
           electricity_bill   = electricity_bill   + COALESCE($3, 0),
           maintenance_charge = maintenance_charge + COALESCE($4, 0),
           other_charges      = other_charges      + COALESCE($5, 0),
           note               = COALESCE($6, note),
           prev_units         = COALESCE($7, prev_units),
           curr_units         = COALESCE($8, curr_units),
           rate_per_unit      = COALESCE($9, rate_per_unit),
           payment_batch_id   = COALESCE($10, payment_batch_id)
         WHERE id = $11 RETURNING *`,
        [e.rent_amount,
         (+e.water_bill        || 0) > 0 ? +e.water_bill         : null,
         (+e.electricity_bill  || 0) > 0 ? +e.electricity_bill   : null,
         (+e.maintenance_charge|| 0) > 0 ? +e.maintenance_charge : null,
         (+e.other_charges     || 0) > 0 ? +e.other_charges      : null,
         e.note||null, e.prev_units||null, e.curr_units||null,
         e.rate_per_unit||null, e.payment_batch_id||null, prev.id]
      ))[0];
    } else {
      entryRow = (await query(
        `INSERT INTO rent_entries
           (tenant_id, property_id, month, year, rent_amount,
            water_bill, electricity_bill, maintenance_charge, other_charges,
            amount_paid, status, note, prev_units, curr_units, rate_per_unit,
            payment_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'unpaid',$10,$11,$12,$13,$14)
         RETURNING *`,
        [tenantId, propertyId, e.month, e.year, e.rent_amount,
         e.water_bill||0, e.electricity_bill||0,
         e.maintenance_charge||0, e.other_charges||0,
         e.note||null, e.prev_units||null, e.curr_units||null,
         e.rate_per_unit||null, e.payment_batch_id||null]
      ))[0];
    }

    // If amount_paid > 0 → also run FIFO payment
    const paidNow = +(e.amount_paid || 0);
    let paymentResult = null;
    if (paidNow > 0) {
      paymentResult = await _recordPayment(
        tenantId, propertyId, paidNow, e.note||null, e.payment_mode||'cash'
      );
    }

    // Re-fetch entry with updated amount_paid
    const updated = (await query(
      `SELECT re.*, COALESCE(SUM(pa.amount_applied),0) AS paid_via_allocations
       FROM rent_entries re
       LEFT JOIN payment_allocations pa ON pa.rent_entry_id = re.id
       WHERE re.id = $1 GROUP BY re.id`, [entryRow.id]
    ))[0];

    res.status(201).json({ rent_entry: updated || entryRow, payment: paymentResult });
  } catch (err) {
    console.error('[POST rent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PAYMENTS API ──────────────────────────────────────────────────────────────

// POST — record standalone payment (FIFO)
router.post('/:id/tenants/:tenantId/payments', requireAuth, async (req, res) => {
  try {
    const { amount, note, payment_mode } = req.body;
    if (!amount || +amount <= 0)
      return res.status(400).json({ error: 'amount > 0 required' });
    const payment = await _recordPayment(
      req.params.tenantId, req.params.id,
      +amount, note||null, payment_mode||'cash'
    );
    res.status(201).json({ payment });
  } catch (err) {
    console.error('[POST payments]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET — payment history with FIFO breakdown
router.get('/:id/tenants/:tenantId/payments', requireAuth, async (req, res) => {
  try {
    const payments = await query(
      `SELECT p.*,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'allocation_id',    pa.id,
             'rent_entry_id',    pa.rent_entry_id,
             'amount_applied',   pa.amount_applied,
             'month',            re.month,
             'year',             re.year,
             'total_due',        (re.rent_amount + re.water_bill + re.electricity_bill
                                  + re.maintenance_charge + re.other_charges),
             'current_balance',  GREATEST(
               (re.rent_amount + re.water_bill + re.electricity_bill
                + re.maintenance_charge + re.other_charges)
               - GREATEST(re.amount_paid,
                 (SELECT COALESCE(SUM(pa2.amount_applied),0)
                  FROM payment_allocations pa2
                  WHERE pa2.rent_entry_id = re.id)),
               0
             ),
             'rent_amount',      re.rent_amount,
             'water_bill',       re.water_bill,
             'electricity_bill', re.electricity_bill,
             'maintenance_charge', re.maintenance_charge,
             'other_charges',    re.other_charges,
             'prev_units',       re.prev_units,
             'curr_units',       re.curr_units,
             'rate_per_unit',    re.rate_per_unit
           ) ORDER BY re.year * 12 + re.month ASC
         ) FILTER (WHERE pa.id IS NOT NULL) AS allocations
       FROM payments p
       LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
       LEFT JOIN rent_entries re        ON re.id = pa.rent_entry_id
       WHERE p.tenant_id = $1
       GROUP BY p.id
       ORDER BY p.payment_date DESC, p.created_at DESC`,
      [req.params.tenantId]
    );
    res.json({ payments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FIFO ALGORITHM ────────────────────────────────────────────────────────────
async function _recordPayment(tenantId, propertyId, totalAmount, note, paymentMode) {
  return await transaction(async (client) => {

    // 1. Insert payment record
    const pmtRes = await client.query(
      `INSERT INTO payments (tenant_id, property_id, total_amount, payment_mode, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, propertyId, totalAmount, paymentMode||'cash', note||null]
    );
    const payment = pmtRes.rows[0];

    // 2. Get all open entries (balance > 0), oldest first (FIFO)
    const openRes = await client.query(
      `SELECT re.id, re.month, re.year,
              (re.rent_amount + re.water_bill + re.electricity_bill
               + re.maintenance_charge + re.other_charges) AS total_due,
              GREATEST(
                COALESCE(SUM(pa.amount_applied), 0),
                re.amount_paid
              ) AS already_paid
       FROM rent_entries re
       LEFT JOIN payment_allocations pa ON pa.rent_entry_id = re.id
       WHERE re.tenant_id = $1
       GROUP BY re.id
       HAVING (re.rent_amount + re.water_bill + re.electricity_bill
               + re.maintenance_charge + re.other_charges)
              > GREATEST(COALESCE(SUM(pa.amount_applied), 0), re.amount_paid)
       ORDER BY re.year * 12 + re.month ASC`,
      [tenantId]
    );

    // 3. FIFO — walk through open entries
    let remaining  = totalAmount;
    const allocations = [];

    for (const entry of openRes.rows) {
      if (remaining <= 0.001) break;

      const balance     = +entry.total_due - +entry.already_paid;
      const applyAmount = Math.min(remaining, balance);
      remaining -= applyAmount;

      await client.query(
        `INSERT INTO payment_allocations (payment_id, rent_entry_id, amount_applied)
         VALUES ($1,$2,$3)`,
        [payment.id, entry.id, applyAmount]
      );

      // Keep amount_paid + status in sync (Flutter still reads these)
      const newPaid   = +entry.already_paid + applyAmount;
      const newStatus = newPaid >= +entry.total_due ? 'paid'
                      : newPaid > 0                 ? 'partial'
                                                    : 'unpaid';
      await client.query(
        `UPDATE rent_entries SET
           amount_paid = $1, status = $2,
           paid_on = CASE WHEN $3 > 0 THEN NOW() ELSE paid_on END
         WHERE id = $4`,
        [newPaid, newStatus, applyAmount, entry.id]
      );

      allocations.push({
        rent_entry_id:  entry.id,
        month:          entry.month,
        year:           entry.year,
        amount_applied: applyAmount,
        total_due:      +entry.total_due,
      });
    }

    // 4. Overpay → tag it in note
    const credit = remaining;
    if (credit > 0.01) {
      await client.query(
        `UPDATE payments SET note = COALESCE(note || ' | ', '') || $1 WHERE id = $2`,
        [`CREDIT:${credit.toFixed(2)}`, payment.id]
      );
    }

    return { ...payment, allocations, credit: +credit.toFixed(2) };
  });
}

// ── FLAT MEMBER DETAILS ───────────────────────────────────────────────────────

router.get('/flat-details', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    const rows = await query(`SELECT * FROM flat_member_details WHERE group_id = $1`, [group_id]);
    res.json({ details: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/flat-details', requireAuth, async (req, res) => {
  try {
    const { group_id, user_id, security_deposit, move_in_date, move_out_date, note } = req.body;
    const rows = await query(
      `INSERT INTO flat_member_details (group_id, user_id, security_deposit, move_in_date, move_out_date, note)
       VALUES ($1,$2,$3,$4::date,$5::date,$6)
       ON CONFLICT (group_id, user_id) DO UPDATE SET
         security_deposit = EXCLUDED.security_deposit,
         move_in_date     = EXCLUDED.move_in_date,
         move_out_date    = EXCLUDED.move_out_date,
         note             = EXCLUDED.note
       RETURNING *`,
      [group_id, user_id, security_deposit||0, move_in_date||null, move_out_date||null, note||null]
    );
    res.json({ detail: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
