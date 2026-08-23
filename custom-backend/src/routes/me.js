const express = require('express');
const pool = require('../config/db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// GET /me — returns ONLY the authenticated user's own profile.
// The user id comes exclusively from req.userId, set by requireAuth from the
// validated session. No client-supplied id (query param, body, header) is
// ever consulted here — that's the whole point of this endpoint.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name AS "fullName", display_name AS "displayName",
              bio, role, created_at AS "createdAt"
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = result.rows[0];
    return res.status(200).json({
      id: user.id,
      email: user.email,
      profile: {
        fullName: user.fullName,
        displayName: user.displayName,
        bio: user.bio,
        createdAt: user.createdAt,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
