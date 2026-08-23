const pool = require('../config/db');
const { hashToken } = require('../utils/tokens');

// Applied to every protected route. The authenticated user's identity comes
// ONLY from this middleware — route handlers never trust a client-supplied
// id (query param, body field, etc.) to decide whose data to return.
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const rawToken = match[1];
  const tokenHash = hashToken(rawToken);

  try {
    const result = await pool.query(
      `SELECT s.user_id, s.expires_at, u.id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = result.rows[0];
    if (new Date(session.expires_at) < new Date()) {
      // Expired session — clean it up and reject. Logged-out sessions are
      // deleted immediately by /logout; this handles natural expiry too.
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Attach the authenticated user id (and the raw token, for /logout) to
    // the request. Every downstream handler uses req.userId, never a
    // client-supplied id.
    req.userId = session.user_id;
    req.tokenHash = tokenHash;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = requireAuth;
