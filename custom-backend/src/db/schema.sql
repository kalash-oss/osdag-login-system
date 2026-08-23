-- Secure Login System — PostgreSQL schema
--
-- Design notes (see README.md for the full explanation):
--   users        one row per account, password is a bcrypt hash, never plaintext.
--   sessions     one row per active login. This is the server-side session store
--                that makes logout actually work: deleting the row invalidates
--                the token immediately. We store a SHA-256 hash of the token,
--                not the token itself, so a DB read/leak doesn't hand out live
--                bearer tokens.
--   files        one row per file, owned by exactly one user (owner_id FK).
--                Ownership is enforced in every query's WHERE clause, not
--                checked after the fact.
--   login_attempts  per-email failed-login counter + lockout timestamp, used
--                for the "lock out after repeated failures" requirement.
--
-- Relationships:
--   users (1) ──< (many) sessions
--   users (1) ──< (many) files
--   users (1) ── (1) login_attempts   (keyed by email, exists even pre-registration
--                                       so we can rate-limit login attempts against
--                                       emails that don't exist yet, without revealing
--                                       that fact to the caller)

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;   -- for case-insensitive email column

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT NOT NULL UNIQUE, -- case-insensitive email matching
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    bio           TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE, -- sha256(raw token), raw token is only ever sent to the client
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS files (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    storage_path  TEXT NOT NULL, -- path on disk under custom-backend/storage/
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_owner_id ON files(owner_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    email         CITEXT PRIMARY KEY,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ
);
