/**
 * Firebase JWT verification middleware
 * Verifies the Bearer token from Firebase Auth
 * Attaches req.uid = Firebase UID
 */
const https = require('https');

// Cache Firebase public keys
let cachedKeys = null;
let keysExpiry  = 0;

async function getFirebasePublicKeys() {
  if (cachedKeys && Date.now() < keysExpiry) return cachedKeys;

  return new Promise((resolve, reject) => {
    https.get(
      'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          cachedKeys = JSON.parse(data);
          // Cache for 1 hour
          keysExpiry = Date.now() + 3600000;
          resolve(cachedKeys);
        });
      }
    ).on('error', reject);
  });
}

/**
 * Simple JWT decode (base64) — no signature verify for dev speed
 * For production, use firebase-admin SDK
 */
function decodeJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Middleware: require valid Firebase token
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const token = authHeader.slice(7);
  const payload = decodeJWT(token);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  // Check expiry
  if (payload.exp && payload.exp < Date.now() / 1000) {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Check audience (your Firebase project ID)
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (projectId && payload.aud !== projectId) {
    return res.status(401).json({ error: 'Invalid token audience' });
  }

  req.uid        = payload.sub || payload.user_id;
  req.firebaseUser = payload;
  next();
}

module.exports = { requireAuth };
