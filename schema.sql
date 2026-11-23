-- Cleone database (Cloudflare D1, which is SQLite). Safe to run more than once.
-- Paste this whole file into the D1 console once, after creating the database.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  prefs       TEXT NOT NULL DEFAULT '{}',      -- JSON: theme, weekly alerts
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                -- SHA-256 of the cookie value (the cookie itself is never stored)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  agent       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL DEFAULT 'paystack',
  customer_code      TEXT,
  subscription_code  TEXT,
  status             TEXT NOT NULL,            -- active | cancelled | past_due
  current_period_end INTEGER,                  -- Pro lasts until this time
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,                   -- owner/name
  status      TEXT NOT NULL,                   -- running | done | failed
  stage       TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT '{}',      -- JSON progress, cleared when the scan finishes
  error       TEXT,
  scorer      TEXT,                            -- rules | claude
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id, created_at);

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  k           TEXT NOT NULL,                   -- stable key, e.g. company:acme or person:alice
  lane        TEXT NOT NULL,                   -- strategic | joiners | investors
  source      TEXT NOT NULL DEFAULT '',        -- star | fork | similar (what the evidence is)
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  sig_text    TEXT NOT NULL,                   -- the blue "public signal" line
  url         TEXT NOT NULL,
  score       REAL NOT NULL,
  sig         INTEGER NOT NULL,
  res         INTEGER NOT NULL,
  tim         INTEGER NOT NULL,
  why         TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',        -- public contact details only
  meta        TEXT NOT NULL DEFAULT '{}',
  scan_id     TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, repo, k)
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  k           TEXT NOT NULL,
  lane        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,                   -- like | dismiss
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, repo);

CREATE TABLE IF NOT EXISTS outreach (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  k           TEXT NOT NULL,
  name        TEXT NOT NULL,
  lane        TEXT NOT NULL,
  score       REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  replied     INTEGER NOT NULL DEFAULT 0,      -- the user marks this; it is how scores get checked against reality
  replied_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outreach_user ON outreach(user_id, created_at);

CREATE TABLE IF NOT EXISTS usage (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,                   -- 2026-11
  scans       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS throttle (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  email       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
