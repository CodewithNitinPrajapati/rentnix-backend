const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /expenses?group_id=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });

    const rows = await query(
      `SELECT * FROM expenses WHERE group_id = $1 ORDER BY created_at DESC`, [group_id]
    );
    res.json({ expenses: rows });
  } catch (err) {
    console.error('[GET /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /expenses — add expense
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      group_id, title, amount, paid_by, paid_by_name,
      category, split_type, splits, note,
      is_recurring, recurring_day, date, created_by,
    } = req.body;

    if (!group_id || !title || !amount || !paid_by) {
      return res.status(400).json({ error: 'group_id, title, amount, paid_by required' });
    }

    const rows = await query(
      `INSERT INTO expenses
         (group_id, title, amount, paid_by, paid_by_name, category,
          split_type, splits, note, date, is_recurring, recurring_day, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        group_id, title, amount, paid_by, paid_by_name || '',
        category || 'other', split_type || 'equal',
        JSON.stringify(splits || []), note || null,
        date || new Date().toISOString(),
        is_recurring || false, recurring_day || null,
        created_by || paid_by,
      ]
    );
    res.status(201).json({ expense: rows[0] });
  } catch (err) {
    console.error('[POST /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /expenses/:id — edit expense + log history
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { title, amount, category, note, edited_by_id, edited_by_name } = req.body;
    const expId = req.params.id;

    const original = await query(`SELECT * FROM expenses WHERE id = $1`, [expId]);
    if (!original.length) return res.status(404).json({ error: 'Expense not found' });

    const old = original[0];
    const changes = [];
    const previous = {};

    if (old.title    !== title)    { changes.push(`title: "${old.title}" → "${title}"`);     previous.title    = old.title; }
    if (+old.amount  !== +amount)  { changes.push(`amount: ₹${old.amount} → ₹${amount}`);   previous.amount   = old.amount; }
    if (old.category !== category) { changes.push(`category: ${old.category} → ${category}`); previous.category = old.category; }
    if (old.note     !== note)     { changes.push('note updated');                             previous.note     = old.note; }

    await transaction(async (client) => {
      await client.query(
        `UPDATE expenses SET title=$1, amount=$2, category=$3, note=$4 WHERE id=$5`,
        [title, amount, category, note, expId]
      );
      if (changes.length) {
        await client.query(
          `INSERT INTO expense_edits
             (expense_id, edited_by_id, edited_by_name, change_description, previous_values)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [expId, edited_by_id, edited_by_name, changes.join(', '), JSON.stringify(previous)]
        );
      }
    });

    const updated = await query(`SELECT * FROM expenses WHERE id = $1`, [expId]);
    res.json({ expense: updated[0] });
  } catch (err) {
    console.error('[PUT /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /expenses/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /expenses/:id/history — edit history
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM expense_edits WHERE expense_id = $1 ORDER BY edited_at DESC`,
      [req.params.id]
    );
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /expenses/settlements?group_id=xxx
router.get('/settlements', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    const rows = await query(
      `SELECT * FROM settlements WHERE group_id = $1 ORDER BY created_at DESC`, [group_id]
    );
    res.json({ settlements: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /expenses/settlements
router.post('/settlements', requireAuth, async (req, res) => {
  try {
    const { group_id, from_user_id, to_user_id, from_user_name, to_user_name, amount } = req.body;
    const rows = await query(
      `INSERT INTO settlements
         (group_id, from_user_id, to_user_id, from_user_name, to_user_name, amount)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [group_id, from_user_id, to_user_id, from_user_name, to_user_name, amount]
    );
    res.status(201).json({ settlement: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
