require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const fileRoutes = require('./routes/files');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// IP-based rate limit on login, on top of the per-email lockout implemented
// inside routes/auth.js. This stops a single IP from hammering many
// different email addresses even though no single account is locked out yet.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP. Please try again later.' },
});
app.use('/login', loginLimiter);

app.use(authRoutes);
app.use(meRoutes);
app.use(fileRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Malformed JSON bodies, etc.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Custom backend listening on http://localhost:${PORT}`);
});

module.exports = app;
