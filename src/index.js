require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

const usersRouter      = require('./routes/users');
const groupsRouter     = require('./routes/groups');
const expensesRouter   = require('./routes/expenses');
const propertiesRouter = require('./routes/properties');
const { router: notifRouter } = require('./routes/notifications');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' })); // restrict in production if needed
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max:      500,
  message:  { error: 'Too many requests, slow down.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

app.use('/users',      usersRouter);
app.use('/groups',     groupsRouter);
app.use('/expenses',   expensesRouter);
app.use('/properties', propertiesRouter);
app.use('/users',      notifRouter);   // POST /users/fcm-token, DELETE /users/fcm-token

// App config (version check)
const { query } = require('./db');
app.get('/config/:key', async (req, res) => {
  try {
    const rows = await query(`SELECT value FROM app_config WHERE key = $1`, [req.params.key]);
    res.json({ value: rows[0]?.value || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Rentnix API running on port ${PORT}`);
  console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '✅ set' : '❌ MISSING'}`);
  console.log(`   FIREBASE_PROJECT_ID: ${process.env.FIREBASE_PROJECT_ID ? '✅ set' : '⚠️  not set (auth will skip aud check)'}`);
});



app.get('/test-fcm', async (req, res) => {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const parsed = JSON.parse(raw);
    res.json({ 
      ok: true,
      project_id: parsed.project_id,
      has_private_key: !!parsed.private_key,
      key_starts: parsed.private_key?.substring(0, 30)
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});