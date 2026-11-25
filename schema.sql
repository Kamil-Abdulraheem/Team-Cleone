-- Cleone database (PostgreSQL, hosted on Neon). Safe to run more than once.
-- The app runs this by itself the first time it starts, so you normally never touch this file.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  prefs       TEXT NOT NULL DEFAULT '{}',      -- JSON: theme, weekly alerts
  created_at  BIGINT NOT NULL                  -- seconds since 1970
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                -- SHA-256 of the cookie value (the cookie itself is never stored)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
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
  current_period_end BIGINT,                   -- Pro lasts until this time
  updated_at         BIGINT NOT NULL
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
  created_at  BIGINT NOT NULL,                 -- seconds
  finished_at BIGINT                           -- milliseconds, so two scans finishing in one second still sort correctly
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
  score       DOUBLE PRECISION NOT NULL,
  sig         INTEGER NOT NULL,
  res         INTEGER NOT NULL,
  tim         INTEGER NOT NULL,
  why         TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',        -- public contact details only
  meta        TEXT NOT NULL DEFAULT '{}',
  scan_id     TEXT,
  updated_at  BIGINT NOT NULL,
  UNIQUE (user_id, repo, k)
);

CREATE TABLE IF NOT EXISTS feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  k           TEXT NOT NULL,
  lane        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,                   -- like | dismiss
  reason      TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, repo);

CREATE TABLE IF NOT EXISTS outreach (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  k           TEXT NOT NULL,
  name        TEXT NOT NULL,
  lane        TEXT NOT NULL,
  score       DOUBLE PRECISION NOT NULL,
  created_at  BIGINT NOT NULL,
  replied     INTEGER NOT NULL DEFAULT 0,      -- the user marks this; it is how scores get checked against reality
  replied_at  BIGINT
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
  expires_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS throttle (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  email       TEXT PRIMARY KEY,
  created_at  BIGINT NOT NULL
);

-- ---------------------------------------------------------------- Job Radar (feature module)

ALTER TABLE usage ADD COLUMN IF NOT EXISTS job_scans INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS job_profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  roles       TEXT NOT NULL DEFAULT '',         -- comma separated target roles
  skills      TEXT NOT NULL DEFAULT '',         -- comma separated, extracted from the CV and edited by the person
  years       INTEGER NOT NULL DEFAULT 0,
  location    TEXT NOT NULL DEFAULT '',
  remote_only INTEGER NOT NULL DEFAULT 0,
  min_salary  INTEGER NOT NULL DEFAULT 0,       -- USD per year, 0 = no floor
  paused_until BIGINT NOT NULL DEFAULT 0,       -- seconds; alerts and scans pause until then
  cv_enc      TEXT,                             -- the CV text, AES-GCM encrypted. Null when no encryption key is set
  updated_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  fp          TEXT NOT NULL UNIQUE,             -- fingerprint of company + title + place: the same job on two boards is one row
  title       TEXT NOT NULL,
  company     TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  remote      INTEGER NOT NULL DEFAULT 0,
  salary_min  INTEGER,
  salary_max  INTEGER,
  currency    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',         -- plain text, trimmed
  tags        TEXT NOT NULL DEFAULT '',
  posted_at   BIGINT,
  first_seen  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL,
  reposts     INTEGER NOT NULL DEFAULT 0,       -- how many times the board showed it as new again
  sources     TEXT NOT NULL DEFAULT '[]',       -- JSON [{source, url}]
  apply_url   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unverified', -- open | closed | unverified
  verified_at BIGINT,
  verify_note TEXT NOT NULL DEFAULT '',
  scam_score  INTEGER NOT NULL DEFAULT 0,       -- 0 to 100
  scam_flags  TEXT NOT NULL DEFAULT '[]',       -- JSON list of plain-language reasons
  ghost_flags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, last_seen);

CREATE TABLE IF NOT EXISTS job_matches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL,
  why         TEXT NOT NULL DEFAULT '[]',       -- JSON list: reasons it fits
  gaps        TEXT NOT NULL DEFAULT '[]',       -- JSON list: what the job asks for that the CV lacks
  state       TEXT NOT NULL DEFAULT 'new',      -- new | saved | applied | replied | interview | offer | rejected | dismissed
  note        TEXT NOT NULL DEFAULT '',
  follow_up   BIGINT,                           -- seconds; when to remind
  alerted_at  BIGINT,
  closed_alerted_at BIGINT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_jobmatches_user ON job_matches(user_id, state);

CREATE TABLE IF NOT EXISTS job_reports (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- was_closed | looks_scam | useful
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
  source      TEXT PRIMARY KEY,
  last_ok     BIGINT,
  last_fail   BIGINT,
  fails_in_row INTEGER NOT NULL DEFAULT 0,
  last_count  INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT ''
);
