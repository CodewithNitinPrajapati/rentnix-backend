const express = require('express');
const router  = express.Router();
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
//  HELPER: Calculate equal splits for a group expense
//  Returns array of { user_id, name, amount }
// ─────────────────────────────────────────────────────────────
function calculateEqualSplits(members, totalAmount) {
  const share = totalAmount / members.length;
  const perPerson = Math.round(share * 100) / 100; // round to 2 decimal
  return members.map(m => ({
    user_id: m.user_id,
    name:    m.name,
    amount:  perPerson,
  }));
}

// ─────────────────────────────────────────────────────────────
//  HELPER: Update pairwise_balances table after an expense
//  Rule: Only create debts between members of the SAME group.
//  Never create indirect/transitive debts.
//
//  pairwise_balances table schema expected:
//    user_a_id   TEXT   (alphabetically smaller of the two)
//    user_b_id   TEXT   (alphabetically larger of the two)
//    amount      NUMERIC (positive = user_a owes user_b)
//    updated_at  TIMESTAMPTZ
//    PRIMARY KEY (user_a_id, user_b_id)
// ─────────────────────────────────────────────────────────────
async function updatePairwiseBalances(client, splits, paidById, groupId, multiplier = 1) {
  // multiplier = +1 for adding expense, -1 for deleting/reversing expense

  for (const split of splits) {
    if (split.user_id === paidById) continue; // payer doesn't owe themselves

    const debtor   = split.user_id;
    const creditor = paidById;
    const amount   = split.amount * multiplier;

    // Canonical ordering: smaller id is user_a
    const [userA, userB] = debtor < creditor
        ? [debtor, creditor]
        : [creditor, debtor];

    // If debtor < creditor → debtor is userA → positive means debtor owes creditor → delta = +amount
    // If debtor > creditor → debtor is userB → positive means userA(creditor) owes userB(debtor)
    //   which is WRONG — creditor is owed, so delta = -amount
    const delta = debtor < creditor ? amount : -amount;

    await client.query(
      `INSERT INTO pairwise_balances (user_a_id, user_b_id, amount, group_context, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_a_id, user_b_id)
       DO UPDATE SET
         amount     = pairwise_balances.amount + $3,
         updated_at = now()`,
      [userA, userB, delta, groupId]
    );
  }
}

// ─────────────────────────────────────────────────────────────
//  GET /expenses?group_id=xxx
// ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });

    const rows = await query(
      `SELECT * FROM expenses WHERE group_id = $1 ORDER BY created_at DESC`,
      [group_id]
    );
    res.json({ expenses: rows });
  } catch (err) {
    console.error('[GET /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /expenses — add expense
//
//  BUG FIXED 1: splits were accepted blindly from client.
//    Client could send wrong amounts or wrong user list.
//    Now: if split_type = 'equal', splits are recalculated
//    server-side from actual group members.
//
//  BUG FIXED 2: pairwise_balances were never updated.
//    The old code only inserted into `expenses` table but
//    never touched balance state — so the Flutter app had to
//    re-derive everything from scratch on every screen load,
//    and any transitive-debt bug in the client crept in.
//    Now: pairwise_balances are updated atomically.
// ─────────────────────────────────────────────────────────────
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

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // ── Determine final splits ──────────────────────────────
    let finalSplits = splits || [];

    if (!split_type || split_type === 'equal') {
      // BUG FIX 1: Always recalculate equal splits server-side
      // so client can never send mismatched amounts or wrong members
      const memberRows = await query(
        `SELECT user_id, name FROM group_members WHERE group_id = $1`,
        [group_id]
      );
      if (!memberRows.length) {
        return res.status(400).json({ error: 'Group has no members' });
      }
      finalSplits = calculateEqualSplits(memberRows, numericAmount);
    }

    // ── Validate: sum of splits must equal total amount ─────
    const splitsSum = finalSplits.reduce((s, sp) => s + parseFloat(sp.amount), 0);
    const diff = Math.abs(splitsSum - numericAmount);
    if (diff > 0.10) {
      // Allow up to ₹0.10 rounding tolerance
      return res.status(400).json({
        error: `Splits sum (${splitsSum}) does not match total amount (${numericAmount})`,
      });
    }

    let newExpense;

    await transaction(async (client) => {
      // Insert expense
      const rows = await client.query(
        `INSERT INTO expenses
           (group_id, title, amount, paid_by, paid_by_name, category,
            split_type, splits, note, date, is_recurring, recurring_day, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          group_id, title, numericAmount, paid_by, paid_by_name || '',
          category || 'other', split_type || 'equal',
          JSON.stringify(finalSplits), note || null,
          date || new Date().toISOString(),
          is_recurring || false, recurring_day || null,
          created_by || paid_by,
        ]
      );
      newExpense = rows.rows[0];

      // BUG FIX 2: Update pairwise balances atomically
      // Only between members of THIS group — no transitive debts
      await updatePairwiseBalances(client, finalSplits, paid_by, group_id, +1);
    });

    res.status(201).json({ expense: newExpense });
  } catch (err) {
    console.error('[POST /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  PUT /expenses/:id — edit expense + log history
//
//  BUG FIXED 3: Old code updated title/amount in expenses table
//    but NEVER reversed the old balance and applied the new one.
//    So pairwise_balances would drift out of sync on every edit.
//    Now: old splits are reversed, new splits are applied — all
//    inside one transaction.
// ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { title, amount, category, note, splits, split_type, edited_by_id, edited_by_name } = req.body;
    const expId = req.params.id;

    const original = await query(`SELECT * FROM expenses WHERE id = $1`, [expId]);
    if (!original.length) return res.status(404).json({ error: 'Expense not found' });

    const old = original[0];
    const numericAmount = parseFloat(amount ?? old.amount);

    // Determine new splits
    let newSplits = splits || old.splits;
    if (!split_type || split_type === 'equal' || old.split_type === 'equal') {
      const memberRows = await query(
        `SELECT user_id, name FROM group_members WHERE group_id = $1`,
        [old.group_id]
      );
      newSplits = calculateEqualSplits(memberRows, numericAmount);
    }

    const changes = [];
    const previous = {};

    if (old.title    !== title)         { changes.push(`title: "${old.title}" → "${title}"`);                previous.title    = old.title; }
    if (+old.amount  !== numericAmount) { changes.push(`amount: ₹${old.amount} → ₹${numericAmount}`);       previous.amount   = old.amount; }
    if (old.category !== category)      { changes.push(`category: ${old.category} → ${category}`);          previous.category = old.category; }
    if (old.note     !== note)          { changes.push('note updated');                                       previous.note     = old.note; }

    let updatedExpense;

    await transaction(async (client) => {
      // BUG FIX 3a: Reverse OLD splits from pairwise_balances
      const oldSplits = Array.isArray(old.splits) ? old.splits : JSON.parse(old.splits || '[]');
      await updatePairwiseBalances(client, oldSplits, old.paid_by, old.group_id, -1);

      // Update the expense row
      await client.query(
        `UPDATE expenses
         SET title=$1, amount=$2, category=$3, note=$4, splits=$5::jsonb, split_type=$6
         WHERE id=$7`,
        [
          title    ?? old.title,
          numericAmount,
          category ?? old.category,
          note     ?? old.note,
          JSON.stringify(newSplits),
          split_type ?? old.split_type,
          expId,
        ]
      );

      // BUG FIX 3b: Apply NEW splits to pairwise_balances
      await updatePairwiseBalances(client, newSplits, old.paid_by, old.group_id, +1);

      // Log edit history
      if (changes.length) {
        await client.query(
          `INSERT INTO expense_edits
             (expense_id, edited_by_id, edited_by_name, change_description, previous_values)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [expId, edited_by_id, edited_by_name, changes.join(', '), JSON.stringify(previous)]
        );
      }

      const rows = await client.query(`SELECT * FROM expenses WHERE id = $1`, [expId]);
      updatedExpense = rows.rows[0];
    });

    res.json({ expense: updatedExpense });
  } catch (err) {
    console.error('[PUT /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /expenses/:id
//
//  BUG FIXED 4: Old delete never reversed pairwise_balances.
//    Deleting an expense would leave ghost balances forever.
//    Now: splits are reversed before deleting.
// ─────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const original = await query(`SELECT * FROM expenses WHERE id = $1`, [req.params.id]);
    if (!original.length) return res.status(404).json({ error: 'Expense not found' });

    const exp = original[0];
    const splits = Array.isArray(exp.splits) ? exp.splits : JSON.parse(exp.splits || '[]');

    await transaction(async (client) => {
      // BUG FIX 4: Reverse pairwise_balances before deleting
      await updatePairwiseBalances(client, splits, exp.paid_by, exp.group_id, -1);
      await client.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /expenses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /expenses/:id/history — edit history
// ─────────────────────────────────────────────────────────────
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM expense_edits WHERE expense_id = $1 ORDER BY edited_at DESC`,
      [req.params.id]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('[GET /expenses/history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /expenses/settlements?group_id=xxx
// ─────────────────────────────────────────────────────────────
router.get('/settlements', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    const rows = await query(
      `SELECT * FROM settlements WHERE group_id = $1 ORDER BY created_at DESC`,
      [group_id]
    );
    res.json({ settlements: rows });
  } catch (err) {
    console.error('[GET /settlements]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /expenses/settlements
//
//  BUG FIXED 5: Settlement completion never updated
//    pairwise_balances. Marking a settlement as "completed"
//    had zero effect on the balance state.
//    Now: on insert with status='completed', or on a separate
//    PATCH to mark complete, pairwise balance is reduced.
// ─────────────────────────────────────────────────────────────
router.post('/settlements', requireAuth, async (req, res) => {
  try {
    const {
      group_id, from_user_id, to_user_id,
      from_user_name, to_user_name, amount, status,
    } = req.body;

    if (!from_user_id || !to_user_id || !amount) {
      return res.status(400).json({ error: 'from_user_id, to_user_id, amount required' });
    }

    const numericAmount = parseFloat(amount);
    let newSettlement;

    await transaction(async (client) => {
      const rows = await client.query(
        `INSERT INTO settlements
           (group_id, from_user_id, to_user_id, from_user_name, to_user_name, amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          group_id, from_user_id, to_user_id,
          from_user_name, to_user_name,
          numericAmount, status || 'pending',
        ]
      );
      newSettlement = rows.rows[0];

      // BUG FIX 5: If already completed on insert, update pairwise balance now
      if (status === 'completed') {
        await _applySettlementToBalances(client, from_user_id, to_user_id, numericAmount);
      }
    });

    res.status(201).json({ settlement: newSettlement });
  } catch (err) {
    console.error('[POST /settlements]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  PATCH /expenses/settlements/:id/complete
//  Marks a pending settlement as completed and updates balances.
// ─────────────────────────────────────────────────────────────
router.patch('/settlements/:id/complete', requireAuth, async (req, res) => {
  try {
    const original = await query(
      `SELECT * FROM settlements WHERE id = $1`, [req.params.id]
    );
    if (!original.length) return res.status(404).json({ error: 'Settlement not found' });

    const s = original[0];
    if (s.status === 'completed') {
      return res.status(400).json({ error: 'Settlement already completed' });
    }

    let updated;
    await transaction(async (client) => {
      const rows = await client.query(
        `UPDATE settlements SET status='completed', settled_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      updated = rows.rows[0];

      // Reduce pairwise balance since debt is now paid
      await _applySettlementToBalances(
        client, s.from_user_id, s.to_user_id, parseFloat(s.amount)
      );
    });

    res.json({ settlement: updated });
  } catch (err) {
    console.error('[PATCH /settlements/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /expenses/balances?user_id=xxx
//
//  NEW ENDPOINT: Returns pairwise balances for a user.
//  Only returns pairs where both users share at least one group.
//  This is the CORRECT source of truth — never derives balances
//  from raw expenses on the fly (which caused transitive bugs).
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  GET /expenses/balances/group-view?user_id=xxx
//
//  Single endpoint that returns EVERYTHING the balance screen
//  needs in ONE query:
//    - my_balances: viewer's own balances with each peer
//    - third_party: balances between peers (not involving viewer)
//
//  No N+1 calls. No local calculation in Flutter.
//  This is the single source of truth.
// ─────────────────────────────────────────────────────────────
router.get('/balances/group-view', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // ── 1. Get all users visible to viewer (share ≥1 group) ──────────────────
    const visibleUsers = await query(
      `SELECT DISTINCT gm2.user_id, gm2.name
       FROM group_members gm1
       JOIN group_members gm2
         ON gm1.group_id = gm2.group_id
        AND gm2.user_id != $1
       WHERE gm1.user_id = $1`,
      [user_id]
    );

    if (!visibleUsers.length) {
      return res.json({ my_balances: [], third_party: [] });
    }

    const visibleIds = visibleUsers.map(u => u.user_id);
    const nameMap    = Object.fromEntries(visibleUsers.map(u => [u.user_id, u.name]));

    // ── 2. Fetch ALL pairwise_balances among viewer + visible peers ───────────
    // Single query: get every pair where BOTH users are in {viewer} ∪ {visibleIds}
    const allIds = [user_id, ...visibleIds];
    const rows = await query(
      `SELECT user_a_id, user_b_id, amount
       FROM pairwise_balances
       WHERE user_a_id = ANY($1::text[])
         AND user_b_id = ANY($1::text[])
         AND ABS(amount) >= 0.01`,
      [allIds]
    );

    // ── 3. Split into my_balances vs third_party ──────────────────────────────
    const my_balances  = [];
    const third_party  = [];

    for (const row of rows) {
      const isViewerA = row.user_a_id === user_id;
      const isViewerB = row.user_b_id === user_id;
      const amount    = parseFloat(row.amount);

      if (isViewerA || isViewerB) {
        // Viewer is involved → my_balances
        const otherId = isViewerA ? row.user_b_id : row.user_a_id;
        // positive amount = user_a owes user_b
        // if viewer is A: viewer owes other → negative from viewer perspective
        // if viewer is B: other (A) owes viewer → positive from viewer perspective
        const net = isViewerA ? -amount : amount;

        my_balances.push({
          other_user_id:   otherId,
          other_user_name: nameMap[otherId] || otherId,
          net_amount:      Math.round(net * 100) / 100,
          // positive = they owe viewer, negative = viewer owes them
        });
      } else {
        // Neither is viewer → third_party
        // positive amount = user_a owes user_b
        const fromId = amount > 0 ? row.user_a_id : row.user_b_id;
        const toId   = amount > 0 ? row.user_b_id : row.user_a_id;

        third_party.push({
          from_user_id:   fromId,
          from_user_name: nameMap[fromId] || fromId,
          to_user_id:     toId,
          to_user_name:   nameMap[toId]   || toId,
          amount:         Math.abs(Math.round(amount * 100) / 100),
        });
      }
    }

    // Sort: largest first
    my_balances.sort((a, b) => Math.abs(b.net_amount) - Math.abs(a.net_amount));
    third_party.sort((a, b) => b.amount - a.amount);

    res.json({ my_balances, third_party });
  } catch (err) {
    console.error('[GET /balances/group-view]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/balances', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // Get all users who share at least one group with this user
    const visibleUsers = await query(
      `SELECT DISTINCT gm2.user_id, gm2.name
       FROM group_members gm1
       JOIN group_members gm2
         ON gm1.group_id = gm2.group_id
        AND gm2.user_id != $1
       WHERE gm1.user_id = $1`,
      [user_id]
    );
    const visibleIds = visibleUsers.map(u => u.user_id);

    if (!visibleIds.length) return res.json({ balances: [] });

    // Fetch pairwise balances involving this user AND only visible peers
    const rows = await query(
      `SELECT * FROM pairwise_balances
       WHERE (user_a_id = $1 AND user_b_id = ANY($2::text[]))
          OR (user_b_id = $1 AND user_a_id = ANY($2::text[]))`,
      [user_id, visibleIds]
    );

    // Convert to viewer-relative format
    // positive netAmount = other person owes viewer
    // negative netAmount = viewer owes other person
    const nameMap = Object.fromEntries(visibleUsers.map(u => [u.user_id, u.name]));

    const balances = rows
      .map(row => {
        const viewerIsA = row.user_a_id === user_id;
        const otherId   = viewerIsA ? row.user_b_id : row.user_a_id;
        // amount positive = user_a owes user_b
        // if viewer is user_a: positive amount means viewer owes other → negative for viewer
        // if viewer is user_b: positive amount means user_a(other) owes viewer → positive for viewer
        const net = viewerIsA ? -parseFloat(row.amount) : parseFloat(row.amount);

        return {
          other_user_id:   otherId,
          other_user_name: nameMap[otherId] || otherId,
          net_amount:      Math.round(net * 100) / 100,
          // positive = they owe you, negative = you owe them
        };
      })
      .filter(b => Math.abs(b.net_amount) >= 0.01); // skip truly zero

    res.json({ balances });
  } catch (err) {
    console.error('[GET /balances]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Internal helper: apply a completed settlement to balances
// ─────────────────────────────────────────────────────────────
async function _applySettlementToBalances(client, fromUserId, toUserId, amount) {
  // from_user_id PAID to_user_id → reduces what from owes to
  const [userA, userB] = fromUserId < toUserId
      ? [fromUserId, toUserId]
      : [toUserId,   fromUserId];

  // If fromUser is userA: fromUser was owing toUser (positive = userA owes userB)
  //   Payment reduces the debt → delta = -amount
  // If fromUser is userB: amount stored is negative (userA is owed by userB)
  //   Payment reduces magnitude → delta = +amount
  const delta = fromUserId < toUserId ? -amount : +amount;

  await client.query(
    `UPDATE pairwise_balances
     SET amount = amount + $3, updated_at = now()
     WHERE user_a_id = $1 AND user_b_id = $2`,
    [userA, userB, delta]
  );
}

module.exports = router;
