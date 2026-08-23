# Secure Login System — User Details & File Access

FOSSEE/Osdag Autumn 2026 Software Development screening task. Implemented
twice, against the same provided web client (`web/index.html`):

1. **`custom-backend/`** — Node.js + Express + PostgreSQL
2. **`appwrite-backend/`** — Appwrite (managed backend)

---

## 1. Project overview

Both implementations let a user register (email + password), log in, log
out, view their own profile (`GET /me`), and list/download files that
belong only to them (`GET /files`, `GET /files/:id`, `GET /files/:id/download`).
The UI is intentionally unstyled — the task said not to build a new
frontend, so `web/index.html` (as provided) is the only client, and it's
used unmodified against both backends.

## 2. Features

- Register / login / logout
- Server-side session invalidation on logout (not just a client-side clear)
- `GET /me` scoped strictly to the authenticated user
- `GET /files`, `GET /files/:id`, `GET /files/:id/download` scoped strictly
  to the authenticated user's own files, with a 403 (belongs to someone
  else) vs 404 (doesn't exist) distinction
- Password hashing (bcrypt / Appwrite's own hashing)
- Generic, identical error for "wrong password" and "email not registered"
- Per-email lockout after repeated failed logins, plus IP-based rate
  limiting on `/login` in the custom backend
- Parameterized SQL everywhere (no string-built queries)
- 3 seeded test users, each with 2 files

## 3. Architecture

```
project-root/
├── custom-backend/       Node/Express/PostgreSQL implementation
│   ├── src/
│   │   ├── server.js         Express app, middleware wiring
│   │   ├── config/db.js      pg Pool
│   │   ├── middleware/requireAuth.js   session validation, used on every protected route
│   │   ├── routes/auth.js    register / login / logout
│   │   ├── routes/me.js      GET /me
│   │   ├── routes/files.js   GET /files, /files/:id, /files/:id/download
│   │   ├── db/schema.sql     table definitions
│   │   ├── db/migrate.js     applies schema.sql
│   │   ├── db/seed.js        loads web/seed-data.json into Postgres
│   │   └── test/run.js       automated test suite (npm test)
│   ├── storage/               seeded file bytes live here (gitignored)
│   └── .env.example
├── appwrite-backend/      Appwrite setup/seed scripts (admin-side)
│   ├── scripts/setup.js      creates DB, collection, bucket, permissions
│   ├── scripts/seed.js       creates the 3 users + their files
│   ├── functions/files-access/   Appwrite Function — gives GET /files/:id a
│   │   ├── src/main.js           real 403 vs. 404 distinction, server-side
│   │   └── package.json          (see §16 for why this has to be a Function)
│   └── .env.example
├── web/
│   ├── index.html            provided test client — NOT modified except
│   │                          uncommenting the Appwrite <script> tags (the
│   │                          file's own comment invited that) and adding
│   │                          one input field for the files-access Function
│   │                          ID (same fieldset as the other Appwrite IDs)
│   ├── mock-api.js            provided — untouched, used only for "mock" mode
│   ├── seed-data.json         provided — single source of truth both
│   │                          backends' seed scripts read from
│   └── appwrite-adapter.js    NEW — translates the client's fetch calls into
│                               real Appwrite Web SDK calls (see §16)
├── README.md
└── .gitignore
```

## 4. Custom backend — setup

**Requirements:** Node.js 18+, PostgreSQL 14+ (developed/tested against
Node 22 and PostgreSQL 16).

```bash
cd custom-backend
npm install
cp .env.example .env        # edit PGPASSWORD etc. to match your local Postgres
createdb secure_login_dev   # or: psql -c "CREATE DATABASE secure_login_dev;"
npm run migrate             # applies db/schema.sql
npm run seed                # creates alice/bob/carol + their files, reading web/seed-data.json
npm run dev                 # starts the API on http://localhost:3000
```

Then open `web/index.html` in a browser (or serve it, e.g. `npx serve web`),
select **"Custom REST backend"**, leave Base URL as `http://localhost:3000`,
and use the quick-fill buttons to log in as alice/bob/carol.

## 5. PostgreSQL setup

See `custom-backend/src/db/schema.sql` for the full DDL. Summary:

```
users            id, email (unique, case-insensitive), password_hash, full_name,
                 display_name, bio, role, created_at
sessions         id, user_id -> users, token_hash (sha256 of the raw bearer
                 token, never the token itself), expires_at
files            id, owner_id -> users, file_name, mime_type, size_bytes,
                 storage_path, uploaded_at
login_attempts   email, failed_count, locked_until
```

Relationships: `users (1) ──< files`, `users (1) ──< sessions`,
`users (1) ── login_attempts` (by email).

## 6. Environment variables

See `custom-backend/.env.example` and `appwrite-backend/.env.example`.
Nothing with a real secret is committed anywhere in this repo — both
`.env` files are gitignored, only the `.env.example` templates are tracked.

## 7. How to run — custom backend

```bash
cd custom-backend && npm install && npm run migrate && npm run seed && npm run dev
```

## 8. How to run — Appwrite implementation

```bash
cd appwrite-backend
npm install
cp .env.example .env   # fill in your Appwrite endpoint/project id/API key
npm run setup           # creates DB, collection (document security ON), bucket (file security ON)
npm run seed             # creates alice/bob/carol as real Appwrite accounts + their files
```

**Deploy the `files-access` Function** (needed for `GET /files/:id` to give a
real 403, not just 404 for everything — see §16 for why this exists):

```bash
cd appwrite-backend/functions/files-access
npm install                 # installs node-appwrite for local packaging only
```

Then, either with the [Appwrite CLI](https://appwrite.io/docs/tooling/command-line/installation)
(`appwrite login` once, then from `appwrite-backend/functions/files-access/`):

```bash
appwrite init function       # if you haven't already linked this folder to a function
appwrite push function       # deploys src/main.js as the function's entrypoint
```

or by creating the function manually in the Appwrite console: **Functions →
Create function**, runtime **Node.js 18.0+**, entrypoint `src/main.js`,
upload/connect this folder. Either way, then in the console under that
function's **Settings**:

- **Variables**: add `APPWRITE_API_KEY` (a server API key scoped to
  `databases.read` only — this function never writes anything),
  `APPWRITE_DATABASE_ID`, `APPWRITE_FILES_COLLECTION_ID` (same values as
  your `.env`). `APPWRITE_FUNCTION_API_ENDPOINT` and
  `APPWRITE_FUNCTION_PROJECT_ID` are injected automatically — don't set
  those yourself.
- **Execute access**: grant execute permission to `users` (any authenticated
  account), and make sure **guests are not granted execute** — the function
  itself re-checks the caller's JWT, but there's no reason to let an
  unauthenticated request invoke it at all.

Copy the deployed function's ID and paste it into the **"Files access
function ID"** field in `web/index.html`'s Appwrite settings panel, along
with the endpoint/project/database/collection/bucket IDs from your `.env`.
Then select **"Appwrite"** mode.

**Honesty note on testing:** I don't have network access to any Appwrite
instance (cloud or self-hosted) from the environment I built this in — the
sandbox's egress is restricted to package registries (npm/pip/etc.), not
`cloud.appwrite.io`. I verified the code against the real `node-appwrite`
and `appwrite` (Web) SDK packages — every method name, argument order, and
permission constant used in `setup.js`, `seed.js`,
`functions/files-access/src/main.js`, and `web/appwrite-adapter.js` was
checked against the actual installed SDK source, not written from memory —
but I could not run `npm run setup` / `npm run seed`, deploy the Function,
or click through the Appwrite-mode flow in a browser, end-to-end against a
live project. **Please run both scripts, deploy the Function, and exercise
the Appwrite mode in `index.html` yourself before the interview**; I'd
rather tell you this plainly than claim a test I didn't actually run. The
custom Node/Express/PostgreSQL backend, by contrast, I did run and test
end-to-end myself (§14).

## 9. Test users

Seeded in both backends from the single `web/seed-data.json`:

| Email | Password |
|---|---|
| alice@example.com | Password123! |
| bob@example.com | Password123! |
| carol@example.com | Password123! |

Each has 2 files. These are test-only credentials that exist purely for
local/demo databases — nothing production-relevant.

## 10. API endpoints (custom backend)

| Method | Path | Auth required | Notes |
|---|---|---|---|
| POST | `/register` | no | `{email, password}` -> 201 `{id, email}`; 409 on duplicate |
| POST | `/login` | no | `{email, password}` -> 200 `{token, user}`; 401 generic on failure; 429 if locked out |
| POST | `/logout` | yes | deletes the session server-side |
| GET | `/me` | yes | own profile only |
| GET | `/files` | yes | own files only |
| GET | `/files/:id` | yes | 404 if it doesn't exist, 403 if it exists but isn't yours |
| GET | `/files/:id/download` | yes | streams the actual file bytes |

## 11. Authentication approach

**Bearer token, backed by a server-side session table — not a JWT.**

## 12. JWT vs. session reasoning

The task's core logout requirement is: *"Logout must invalidate the
session server-side... a stateless JWT that remains valid until expiration
does NOT satisfy this."* That statement basically settles the choice.

A plain JWT is self-verifying (signature check only) and stateless by
design — actually revoking one before its expiry means bolting on a
denylist/allowlist store anyway, which is extra machinery to achieve
exactly what a server-side session already gives you for free.

So I used an **opaque, high-entropy random token** (`crypto.randomBytes(32)`)
returned to the client at login, with only its **SHA-256 hash** stored
server-side in a `sessions` row (`token_hash`, `user_id`, `expires_at`).
Every protected route hashes the incoming bearer token and looks up that
row. Benefits for this task specifically:

- **Logout is a one-line `DELETE FROM sessions WHERE token_hash = $1`.**
  The token is unusable on the very next request, from any client.
- The DB never stores the raw token — a dump/leak/injection can't be used
  to replay a live session, only its hash (useless without the original).
- It's trivial to explain and to demo in an interview: "here's the row,
  watch it disappear on logout, watch the next request 401."

The client (`index.html`) already expects exactly this shape — a `token`
field in the login response, sent back as `Authorization: Bearer <token>`
— so no client changes were needed.

## 13. How logout works internally

1. Client calls `POST /logout` with `Authorization: Bearer <token>`.
2. `requireAuth` middleware runs first (logout is itself a protected
   route), hashes the token, and looks up the session — if the token isn't
   valid, `logout` never even runs; you can't invalidate a session that
   doesn't exist.
3. If valid, the handler does `DELETE FROM sessions WHERE token_hash = $1`.
4. That row is gone. Any subsequent request — from the same tab, another
   tab, curl, anything — presenting that same token now fails the
   `requireAuth` lookup and gets `401`, immediately, with no wait for
   expiry. Verified directly in `src/test/run.js` (`old session rejected
   after logout -> 401`) and manually (§19).

## 14. How user-data isolation is enforced

- The authenticated identity is derived **exclusively** from the validated
  session (`requireAuth` sets `req.userId` from the DB row matched by
  token hash). No route ever reads a user id from a query param, body
  field, or header to decide whose data to return.
- `GET /me` queries `WHERE id = $1` using `req.userId` — there is no
  alternate code path that accepts a client-supplied id.
- `GET /files` queries `WHERE owner_id = $1` using `req.userId` — ownership
  is part of the SQL, not a post-hoc filter on an unrestricted result set.
- `GET /files/:id` does two queries deliberately: fetch by id, then compare
  `file.ownerId === req.userId`. This keeps the 403-vs-404 distinction
  explicit and auditable, rather than folding ownership into one WHERE
  clause that would silently collapse "not yours" into "doesn't exist".

## 15. How file ownership is enforced

Every file row has a mandatory `owner_id` foreign key. `findFileOrRespondError`
(`custom-backend/src/routes/files.js`) is the single chokepoint both
`/files/:id` and `/files/:id/download` go through: fetch → not found? 404
→ found but `ownerId !== req.userId`? 403, no metadata leaked → otherwise
200/stream. The download route additionally checks the resolved storage
path stays inside the `storage/` directory (defense in depth against path
traversal, even though `storage_path` is server-generated and never
client-influenced).

## 16. What Appwrite handled automatically vs. what I configured myself

**Automatic:**
- Password hashing and storage (`Users.create` / `Account.create` — I never
  see or store a password hash myself)
- Session creation/validation/expiry (`Account.createEmailPasswordSession`,
  cookie-based, managed entirely by the Appwrite Web SDK)
- Server-side logout invalidation (`Account.deleteSession('current')`
  actually deletes the session server-side — same guarantee as my custom
  backend's session table, just implemented by Appwrite itself)
- Generic auth failure responses and Appwrite's own platform-level rate
  limiting on auth endpoints

**I had to configure myself — this is the part the task explicitly warns
about ("do not assume isolation happens everywhere"):**
- **Document security** on the `files` collection and **file security** on
  the `user-files` bucket (`appwrite-backend/scripts/setup.js`), both
  created with an **empty collection/bucket-level permission list**. Without
  turning these on, permissions are only checked at the collection/bucket
  level — meaning any permission granted there applies to *every*
  document/file, and there is no way to say "user A can read this specific
  document but not that one."
- **Per-document / per-file owner permissions**, set explicitly at creation
  time in `seed.js`: `Permission.read(Role.user(ownerId))`. This one line,
  repeated per file, is what actually stops User B from reading User A's
  file — Appwrite does not infer "you created it, therefore only you can
  read it" on its own.
- Profile data (`fullName`, `bio`, `role`) is stored in each **Account's own
  `prefs`** rather than a separate database collection, specifically because
  `account.getPrefs()`/`account.get()` is scoped to the caller's own account
  by the platform — there's no API to read another account's prefs, so this
  gets profile isolation without me having to configure any permissions for
  it at all (as opposed to files, where I do have to configure permissions).
- An explicit `ownerId` query filter on `GET /files` (`Query.equal('ownerId',
  userId)`) even though document security alone would already exclude other
  users' documents — same "ownership is part of the query, not just a
  permission check" principle as the custom backend.

**`/files/:id` 403 vs. 404 — fixed via an Appwrite Function:** Appwrite's
permission model returns **404 for both** "document doesn't exist" and
"exists but you have no read permission on it" *when the check is done with
the caller's own session* — that's deliberate on Appwrite's part, to avoid
letting one user discover that a given document ID exists at all. It's a
reasonable default in general, but it doesn't satisfy this task's explicit
ask to distinguish the two cases, and the fix can't be "grant everyone read
on every file" — that would satisfy the status codes while destroying the
actual isolation the task also requires.

The fix is `appwrite-backend/functions/files-access/` (full comments in its
`src/main.js`): a small Appwrite Function that runs with a server API key,
so it isn't subject to the caller's own document permissions. It:

1. Takes a JWT for the caller's own session (minted client-side via
   `account.createJWT()`) and verifies it server-side with `Account.get()`
   — this, not anything in the request body, is the only source of truth
   for who's calling.
2. Looks up the document **as an admin**, purely to check *existence* and
   its `ownerId` — the admin-fetched document is never handed back to a
   caller who isn't its owner.
3. Returns 404 if the document doesn't exist, 403 if it exists but
   `ownerId` doesn't match the caller, 200 with the file metadata otherwise.

`web/appwrite-adapter.js`'s `handleFileById` now calls this Function
instead of querying the database with the caller's own session, so the
adapter itself never sees a false-404. Nothing about `GET /files` or file
security/document security changes — `GET /files` still uses the caller's
own session and an explicit `ownerId` filter exactly as before, and the
per-document `Permission.read(Role.user(ownerId))` grants from `seed.js`
are untouched, so cross-user access is still refused, not opened up.

This is genuinely a small, additive change: one new Function, one new field
in `handleFileById`/`index.html`, nothing else in the architecture moves.
Deployment steps are in §8; I could not execute-test it myself for the same
sandbox-networking reason noted there.

## 17. Security considerations

- Passwords: bcrypt, 12 salt rounds, never logged or returned in any response.
- Timing side-channel: login always runs `bcrypt.compare` against either the
  real hash or a fixed dummy hash, so response time doesn't reveal whether
  an email is registered on top of the identical error message.
- Lockout: 5 failed attempts per email -> 60s lock (both configurable via
  `.env`), plus a 30-req/15-min IP-based limiter on `/login` via
  `express-rate-limit`, so the lockout can't be trivially routed around by
  targeting many different unregistered/registered emails from one IP.
- All SQL is parameterized (`pg` `$1`/`$2` placeholders) — no string
  concatenation anywhere a request value reaches a query.
- Session tokens: 256 bits of randomness, only their SHA-256 hash is ever
  persisted.
- File download path is validated to stay inside the storage directory.
- Malformed JSON bodies return `400`, not a stack trace or `500`.
- Every protected route goes through the same `requireAuth` middleware —
  there's exactly one auth code path, not one per route.

## 18. Testing performed

**Custom backend — actually run, not just written** (`custom-backend/src/test/run.js`,
`npm test`, 24/24 passing at time of writing — full manual walk-through in §19 too):
register valid + duplicate; login valid/wrong-password/nonexistent-email
with identical generic error; logout; reuse of the old token after logout;
`/me` and `/files` isolation between alice and bob; `/files/:id` 403 vs 404
distinction; unauthenticated access to `/me`/`/files`/`/files/:id`; a real
file download; a SQL-injection-shaped login payload; malformed JSON.
Passwords confirmed as bcrypt hashes directly in Postgres (`\d` + `SELECT`,
not just "should be hashed" — I actually queried the table).

**Appwrite backend — written and SDK-verified, not execution-tested,** for
the reasons in §8. Every SDK call — including the `files-access` Function's
use of `Account.get()` (JWT verification) and `Databases.getDocument()`
(admin lookup) — was checked against the real installed `node-appwrite`/
`appwrite` package source (method names, argument order, permission
constants) so it should run correctly against a live project, but "should"
is not the same as "did" and I'm not going to claim otherwise. I traced the
8-case matrix below against the code path by hand (§16); I have not clicked
through it in a browser against a live Appwrite project.

| # | Case | Traced result | Where enforced |
|---|---|---|---|
| 1 | Alice → Alice's file | 200 | `files-access`: JWT→callerId matches `doc.ownerId` |
| 2 | Bob → Bob's file | 200 | same path |
| 3 | Bob → Alice's file | 403 | `files-access`: doc exists, `ownerId` ≠ callerId |
| 4 | Alice → Bob's file | 403 | same, roles reversed |
| 5 | Bob → nonexistent file id | 404 | `files-access`: admin `getDocument` throws code 404 |
| 6 | No session → `/files/:id` | 401 | `handleFileById`: `account.createJWT()` throws before the Function is even called |
| 7 | `GET /files` for Alice | only Alice's files | `Query.equal('ownerId', userId)` + document security (both, defense in depth) — unchanged by this fix |
| 8 | `GET /files` for Bob | only Bob's files | same |

## 19. Final security review (hostile-evaluator pass, custom backend)

All of the following were attempted against the running server, not just
reasoned about:

| Attack | Result |
|---|---|
| `/me` with no auth header | 401 |
| `/files` with no auth header | 401 |
| Read another user's profile | Not possible — no endpoint accepts a client-supplied user id at all |
| Read another user's file by id | 403, distinct from 404 |
| Reuse token after logout | 401 (verified immediately after logout, not just "should expire") |
| Brute-force login | 429 after 5 failed attempts on one email |
| Duplicate registration | 409, doesn't leak whether it's the email vs. something else |
| Malformed JSON | 400, not a 500 or stack trace |
| SQL-injection-shaped login payload (`' OR '1'='1`) | 401 — parameterized queries mean the string is just a string |
| File id manipulation | UUIDs, not sequential ints; a non-UUID or garbage id resolves to 404 before touching the DB |
| Guessing file ids | 404 for anything not a real UUID, 403 for a real-but-not-yours UUID; no metadata leaked either way |
| Password storage | Confirmed bcrypt (`$2b$12$...`) via direct Postgres query, not plaintext or reversible encryption |

I didn't find anything I fixed after the fact and then re-tested — this is
the state the suite in §18 already reflects. No known gaps in the custom
backend at the time of writing.

## 20. What I would improve with more time

- Actually run the Appwrite implementation end-to-end against a live
  project — deploy `files-access` for real and click through all 8 cases in
  §18 in a browser, not just trace the code path by hand. This is the
  single biggest honesty gap left in this submission.
- Apply the same `files-access`-style Function to `GET /files/:id/download`,
  which currently has the identical caller-session-sees-404-for-both
  characteristic as `/files/:id` did — out of scope for what was asked, but
  the same gap in principle.
- Real file uploads (currently both backends seed placeholder text files;
  a genuine multipart upload endpoint would be a natural extension of the
  existing ownership-enforcement pattern).
- Refresh-token rotation / shorter-lived sessions with silent renewal,
  instead of one 12-hour token.
- Structured logging and basic request tracing, useful for debugging
  lockouts/rate-limit hits in a real deployment.
- A shared integration test that runs against *both* backends with the same
  assertions, to mechanically guarantee behavioral parity rather than
  relying on me keeping the two READMEs describing them in sync by hand.

---

# For the reviewer: final checklist

## A. Requirements table

| Requirement | Status | Evidence |
|---|---|---|
| Register (email + password) | Done, both backends | §18/19; `npm test` |
| Login returns valid session | Done, both backends | token in login response (custom); Appwrite session cookie |
| Logout invalidates server-side | Done, both backends | §13, §16; `sessions` row deleted; `deleteSession('current')` |
| `GET /me` — own profile only | Done, both backends | §14; tested |
| `GET /files` — own files only | Done, both backends | §14; tested |
| `GET /files/:id` — 403 vs 404 | Done, both backends (Appwrite via the `files-access` Function) | §16, §18, §19 |
| 3+ seeded users, own profile+files | Done, both backends | §9 |
| Passwords hashed, not plaintext | Done, both backends | §17, §19 (queried DB directly) |
| Generic failed-login error | Done, both backends | §12/§19 |
| Rate limiting / lockout | Done, both backends (custom: DB+IP; Appwrite: platform-level) | §17 |
| Consistent auth across protected routes | Done, both backends | single `requireAuth` middleware / `account.get()` gate |
| Custom backend: Node/Express/Postgres | Done | run + tested, §18 |
| Appwrite backend: real, runnable | Code complete, SDK-verified; **not execution-tested** by me | §8, §18 |
| `.env.example` provided, no real secrets committed | Done | both backends |
| README covers all required topics | Done | this file |

## B. Commands to start the custom backend

```bash
cd custom-backend
npm install
cp .env.example .env   # edit PGPASSWORD to match your Postgres
npm run migrate
npm run seed
npm run dev             # http://localhost:3000
npm test                 # optional: run the automated suite against it
```

## C. Commands/setup for Appwrite

```bash
cd appwrite-backend
npm install
cp .env.example .env   # fill in endpoint / project id / API key
npm run setup
npm run seed
```
Then deploy `appwrite-backend/functions/files-access/` (Appwrite CLI or
console — exact steps and required env vars/permissions in §8) and pick
"Appwrite" mode in `web/index.html`, filling in the same IDs plus the
deployed Function's ID.

## D. Test credentials

alice@example.com / bob@example.com / carol@example.com — all `Password123!` (see §9).

## E. Files to commit

Everything except what's listed in F. In particular: `.env.example` (both
backends), all source under `custom-backend/src/`, `appwrite-backend/scripts/`,
`appwrite-backend/functions/files-access/` (including its own
`node_modules`-free `package.json`), `web/` (including `appwrite-adapter.js`),
`README.md`, `.gitignore`.

## F. Files to NOT commit

`custom-backend/.env`, `appwrite-backend/.env`, `custom-backend/storage/*`
(seeded file bytes — regenerated by `npm run seed`), `node_modules/` in
either backend. All already covered by `.gitignore`.

## G. Final GitHub submission checklist

- [x] `.env` is gitignored in both backends, `.env.example` is tracked
- [x] No hardcoded secrets in source (checked `custom-backend/src` and
      `appwrite-backend/scripts` by hand — the only "secrets" anywhere are
      the intentionally-public seed test passwords, documented as test-only)
- [x] `node_modules/` gitignored
- [x] Both implementations clearly separated by folder
- [x] README present at repo root

## H. Known limitations

1. Appwrite implementation (including the `files-access` Function) is
   code-complete and SDK-verified but I could not run it end-to-end myself
   (§8) — please test it before the interview.
2. `GET /files/:id/download` on the Appwrite side still has the same
   caller-session-sees-404-for-both characteristic that `/files/:id` used
   to have — only `/files/:id` was in scope for the fix (§20).
3. Files are seeded placeholder text, not real uploaded documents, in both
   backends (§20).

## I. Technical interview questions to prepare for

- Walk through exactly what happens, server-side, between `POST /logout`
  and the next `GET /me` with the same (now-dead) token.
- Why an opaque DB-backed token instead of a JWT, specifically for the
  logout requirement — and what you'd have to add to a JWT to get the same
  guarantee.
- Why `/files/:id` does two separate checks (existence, then ownership)
  instead of one combined query — what would go wrong if you combined them?
- What exactly stops SQL injection here — walk through a query with `$1`.
- In Appwrite: what's the actual difference between "the collection has a
  read permission" and "document security is on with per-document
  permissions" — what would break if document security were off?
- What's stored in the `sessions` table, and specifically why the hash and
  not the raw token.
- How the per-email lockout and the per-IP rate limiter interact — what
  does each one stop that the other doesn't?
