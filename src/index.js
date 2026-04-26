require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');

const usersRouter = require('./routes/users');
const groupsRouter = require('./routes/groups');
const expensesRouter = require('./routes/expenses');
const propertiesRouter = require('./routes/properties');
const marketplaceRouter = require('./routes/marketplace');
const flatmatesRouter = require('./routes/flatmates');
const { router: safetyRouter } = require('./routes/safety');
const { router: notifRouter } = require('./routes/notifications');
const { query } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, slow down.' },
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: new Date(),
  });
});

app.use('/users', usersRouter);
app.use('/groups', groupsRouter);
app.use('/expenses', expensesRouter);
app.use('/properties', propertiesRouter);
app.use('/users', notifRouter);
app.use('/marketplace', marketplaceRouter);
app.use('/flatmates', flatmatesRouter);
app.use('/safety', safetyRouter);

app.get('/config/:key', async (req, res) => {
  try {
    const rows = await query(
      `SELECT value FROM app_config WHERE key = $1`,
      [req.params.key]
    );

    res.json({
      value: rows[0]?.value || null,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

app.get('/check-phone', async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({
        error: 'phone required',
      });
    }

    const rows = await query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [phone]
    );

    res.json({
      exists: rows.length > 0,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);

  res.status(500).json({
    error: 'Internal server error',
  });
});


// IMPORTANT PART → Socket.io attach here

const httpServer = http.createServer(app);

require('./routes/chat_server')(httpServer);

httpServer.listen(PORT, () => {
  console.log(`✅ Rentnix API + Chat running on port ${PORT}`);
  console.log(
    `DATABASE_URL: ${
      process.env.DATABASE_URL ? '✅ set' : '❌ MISSING'
    }`
  );
  console.log(
    `FIREBASE_PROJECT_ID: ${
      process.env.FIREBASE_PROJECT_ID ? '✅ set' : '⚠️ not set'
    }`
  );
});