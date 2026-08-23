const crypto = require('crypto');

// Opaque, high-entropy session token. Not a JWT — see README for why.
function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bits of randomness
}

// We only ever store this hash in the DB. The raw token is shown to the
// client once (at login) and never persisted anywhere in plaintext, so a
// database read (backup, dump, injection, etc.) can't be used to forge or
// replay a live session.
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = { generateToken, hashToken };
