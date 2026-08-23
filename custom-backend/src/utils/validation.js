// Deliberately simple, dependency-free validation. Good enough to reject
// obviously-bad input; not a full RFC 5322 email validator (not needed here).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function isValidPassword(password) {
  // Minimum length only — we intentionally don't impose complexity rules
  // (uppercase/symbol requirements) since those are more UX friction than
  // security value; length is what matters most against brute force.
  return typeof password === 'string' && password.length >= 8 && password.length <= 512;
}

module.exports = { isValidEmail, isValidPassword };
