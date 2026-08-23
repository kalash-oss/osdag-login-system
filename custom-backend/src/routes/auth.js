const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { generateToken, hashToken } = require('../utils/tokens');
const { isValidEmail, isValidPassword } = require('../utils/validation');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS) || 12;
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 12;
const MAX_FAILED_ATTEMPTS = Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES) || 1;

const GENERIC_LOGIN_ERROR = { error: 'Invalid email or password' };

// POST /register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email) || !isValidPassword(password)) {
      return res.status(400).json({ error: 'A valid email and a password (min 8 characters) are required' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email`,
      [email, passwordHash, email.split('@')[0]]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    // Postgres unique_violation on the citext email column = duplicate registration.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // --- lockout check (per-email, independent of whether the email exists) ---
    const lockResult = await pool.query(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email = $1',
      [email]
    );
    const lock = lockResult.rows[0];
    if (lock && lock.locked_until && new Date(lock.locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many failed attempts. Please try again shortly.' });
    }

    const userResult = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = userResult.rows[0];

    // bcrypt.compare against a real hash if the user exists; against a dummy
    // hash if not, so the response time doesn't leak whether the email is
    // registered (a timing side-channel on top of the generic error message).
    const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7dPU4V0lzHM.2mYq1r.8N9fRZfvJmXO';
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCheck);
    const valid = Boolean(user) && passwordMatches;

    if (!valid) {
      const newCount = (lock ? lock.failed_count : 0) + 1;
      if (newCount >= MAX_FAILED_ATTEMPTS) {
        await pool.query(
          `INSERT INTO login_attempts (email, failed_count, locked_until)
           VALUES ($1, 0, $2)
           ON CONFLICT (email) DO UPDATE SET failed_count = 0, locked_until = $2`,
          [email, new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)]
        );
      } else {
        await pool.query(
          `INSERT INTO login_attempts (email, failed_count, locked_until)
           VALUES ($1, $2, NULL)
           ON CONFLICT (email) DO UPDATE SET failed_count = $2, locked_until = NULL`,
          [email, newCount]
        );
      }
      // Same generic message whether the email doesn't exist or the password
      // is wrong — never reveal which one it was.
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    // Successful login clears any failed-attempt counter for this email.
    await pool.query('DELETE FROM login_attempts WHERE email = $1', [email]);

    const rawToken = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hashToken(rawToken), expiresAt]
    );

    return res.status(200).json({ token: rawToken, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /logout — deletes the session row so the token is immediately unusable
// on every subsequent request, from any client, not just this browser tab.
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.tokenHash]);
    return res.status(200).json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
