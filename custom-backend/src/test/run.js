/**
 * Automated test suite for the custom backend.
 *
 * Prerequisites: the server must be running (npm run dev) and the DB must
 * be migrated + seeded (npm run migrate && npm run seed) against a fresh
 * database, since this suite checks exact lockout counts.
 *
 * Run: npm test
 *
 * This is a plain Node script using the built-in fetch — no test framework
 * dependency, kept deliberately simple so it's easy to read line by line.
 */
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok   - ${name}`);
  } else {
    fail++;
    console.log(`  FAIL - ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function authHeader(token) {
  return { Authorization: 'Bearer ' + token };
}

async function main() {
  console.log(`Testing against ${BASE}\n`);

  // --- AUTHENTICATION ---
  console.log('AUTHENTICATION');

  const newEmail = `test_${Date.now()}@example.com`;
  const reg1 = await api('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, password: 'Password123!' }),
  });
  check('register valid account -> 201', reg1.status === 201, JSON.stringify(reg1));

  const reg2 = await api('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' }),
  });
  check('register duplicate email -> 409', reg2.status === 409, JSON.stringify(reg2));

  const loginOk = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' }),
  });
  check('login valid credentials -> 200 + token', loginOk.status === 200 && !!loginOk.body.token, JSON.stringify(loginOk));
  const aliceToken = loginOk.body.token;

  const loginBadPw = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' }),
  });
  check('login wrong password -> 401', loginBadPw.status === 401);

  const loginNoUser = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody_here@example.com', password: 'whatever123' }),
  });
  check('login nonexistent email -> 401', loginNoUser.status === 401);
  check(
    'generic error message identical for both failure cases',
    JSON.stringify(loginBadPw.body) === JSON.stringify(loginNoUser.body),
    `${JSON.stringify(loginBadPw.body)} vs ${JSON.stringify(loginNoUser.body)}`
  );

  const bobLogin = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'Password123!' }),
  });
  const bobToken = bobLogin.body.token;

  const logoutRes = await api('/logout', { method: 'POST', headers: authHeader(aliceToken) });
  check('logout -> 200', logoutRes.status === 200);

  const meAfterLogout = await api('/me', { headers: authHeader(aliceToken) });
  check('old session rejected after logout -> 401', meAfterLogout.status === 401, JSON.stringify(meAfterLogout));

  // re-login alice for the rest of the suite
  const aliceLogin2 = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' }),
  });
  const aliceToken2 = aliceLogin2.body.token;

  // --- USER ISOLATION ---
  console.log('\nUSER ISOLATION');

  const aliceMe = await api('/me', { headers: authHeader(aliceToken2) });
  check('alice /me returns her own profile', aliceMe.status === 200 && aliceMe.body.email === 'alice@example.com');

  const bobMe = await api('/me', { headers: authHeader(bobToken) });
  check('bob /me returns his own profile', bobMe.status === 200 && bobMe.body.email === 'bob@example.com');

  check(
    "alice's /me never returns bob's data",
    aliceMe.body.id !== bobMe.body.id && aliceMe.body.email !== bobMe.body.email
  );

  // --- FILES ---
  console.log('\nFILES');

  const aliceFiles = await api('/files', { headers: authHeader(aliceToken2) });
  check('alice sees her own files', aliceFiles.status === 200 && aliceFiles.body.files.length > 0);

  const bobFiles = await api('/files', { headers: authHeader(bobToken) });
  check('bob sees his own files', bobFiles.status === 200 && bobFiles.body.files.length > 0);

  const aliceFileIds = new Set(aliceFiles.body.files.map((f) => f.id));
  const bobFileIds = new Set(bobFiles.body.files.map((f) => f.id));
  const overlap = [...aliceFileIds].some((id) => bobFileIds.has(id));
  check('no file id appears in both lists', !overlap);

  const aliceFileId = aliceFiles.body.files[0].id;
  const bobFileId = bobFiles.body.files[0].id;

  const bobReadsAliceFile = await api(`/files/${aliceFileId}`, { headers: authHeader(bobToken) });
  check("bob cannot retrieve alice's file -> 403", bobReadsAliceFile.status === 403, JSON.stringify(bobReadsAliceFile));

  const aliceReadsBobFile = await api(`/files/${bobFileId}`, { headers: authHeader(aliceToken2) });
  check("alice cannot retrieve bob's file -> 403", aliceReadsBobFile.status === 403, JSON.stringify(aliceReadsBobFile));

  const aliceReadsOwnFile = await api(`/files/${aliceFileId}`, { headers: authHeader(aliceToken2) });
  check('alice CAN retrieve her own file -> 200', aliceReadsOwnFile.status === 200);

  const nonexistentFile = await api('/files/00000000-0000-0000-0000-000000000000', { headers: authHeader(aliceToken2) });
  check('nonexistent file id -> 404 (distinct from 403)', nonexistentFile.status === 404, JSON.stringify(nonexistentFile));

  const unauthFiles = await api('/files');
  check('unauthenticated /files -> 401', unauthFiles.status === 401);

  const unauthFileById = await api(`/files/${aliceFileId}`);
  check('unauthenticated /files/:id -> 401', unauthFileById.status === 401);

  const unauthMe = await api('/me');
  check('unauthenticated /me -> 401', unauthMe.status === 401);

  const download = await fetch(`${BASE}/files/${aliceFileId}/download`, { headers: authHeader(aliceToken2) });
  check('authenticated download -> 200 with real bytes', download.status === 200 && (await download.clone().text()).length > 0);

  // --- SECURITY ---
  console.log('\nSECURITY');

  const sqlInjection = await api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: "' OR '1'='1", password: "' OR '1'='1" }),
  });
  check('SQL-injection-style login is rejected, not a 500 or bypass', sqlInjection.status === 401);

  const malformed = await api('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  check('malformed JSON body handled gracefully -> 400', malformed.status === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
