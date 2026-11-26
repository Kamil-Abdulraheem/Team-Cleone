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

-- ---------------------------------------------------------------- Job acquisition infrastructure

-- One row per configured job source. Built-in public feeds are added on first start; admins add employer boards.
CREATE TABLE IF NOT EXISTS source_configs (
  id            TEXT PRIMARY KEY,               -- e.g. remotive, greenhouse:acme
  adapter       TEXT NOT NULL,                  -- greenhouse | lever | ashby | rss | careerpage | remotive | arbeitnow | remoteok | jobberman | myjobmag
  label         TEXT NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',     -- JSON, adapter specific (board token, feed url, ...). No secrets.
  enabled       INTEGER NOT NULL DEFAULT 1,
  builtin       INTEGER NOT NULL DEFAULT 0,
  interval_min  INTEGER NOT NULL DEFAULT 360,   -- how often the scheduler should sync it
  last_attempt  BIGINT,
  last_ok       BIGINT,                         -- last successful synchronization
  last_fail     BIGINT,
  fails_in_row  INTEGER NOT NULL DEFAULT 0,
  last_status   INTEGER,                        -- HTTP status of the last request
  last_count    INTEGER NOT NULL DEFAULT 0,     -- jobs retrieved by the last successful request
  last_ms       INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL
);

-- Every request we make to a source, kept for 14 days: this is the error log.
CREATE TABLE IF NOT EXISTS source_runs (
  id          BIGSERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- sync | diagnostic
  at          BIGINT NOT NULL,
  ok          INTEGER NOT NULL,
  http_status INTEGER,
  jobs        INTEGER NOT NULL DEFAULT 0,
  new_jobs    INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  ms          INTEGER,
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_source_runs_at ON source_runs(at);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS valid_through BIGINT;       -- the employer's stated closing date, if any
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_at BIGINT;           -- when we found it expired or removed
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_reason TEXT NOT NULL DEFAULT '';  -- expired | removed | page | reported
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS verified_via TEXT NOT NULL DEFAULT '';   -- feed (the employer's own board lists it right now) | page | report
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS synthetic INTEGER NOT NULL DEFAULT 0;   -- 1 = sandbox sample data. Never mixed with real vacancies.
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen);

ALTER TABLE job_matches ADD COLUMN IF NOT EXISTS detail TEXT NOT NULL DEFAULT '{}';  -- JSON: component scores, unknowns, confidence

ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS education INTEGER NOT NULL DEFAULT 0;  -- 0 unknown, 1 secondary/OND, 2 HND/bachelor, 3 master, 4 doctorate
ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS employment TEXT NOT NULL DEFAULT '';   -- full-time,contract,...
ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';       -- one line about the person, from the CV
ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS monitor INTEGER NOT NULL DEFAULT 1;     -- Pro: keep watching for new vacancies
ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS alert_min INTEGER NOT NULL DEFAULT 70;  -- Pro: only alert at or above this match score
ALTER TABLE usage ADD COLUMN IF NOT EXISTS ai_calls INTEGER NOT NULL DEFAULT 0;

-- Independent second checks of our "open" verdicts. This is how the accuracy of "open" is measured.
CREATE TABLE IF NOT EXISTS verdict_audits (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL,
  first_via   TEXT NOT NULL,
  first_at    BIGINT NOT NULL,
  second_status TEXT NOT NULL,
  agree       INTEGER NOT NULL,
  at          BIGINT NOT NULL
);

-- Cached AI answers, so the same job or CV is never paid for twice.
CREATE TABLE IF NOT EXISTS ai_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

-- A person's own history (what they asked, scanned, saved, applied to, and what we alerted them about).
CREATE TABLE IF NOT EXISTS activity (
  id        BIGSERIAL PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,       -- job_scan | job_state | job_alert | job_closed | command
  ref       TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, at);

-- Unexpected server errors (message only, scrubbed), so a problem on a live site can be seen at /api/health.
CREATE TABLE IF NOT EXISTS error_log (
  id      BIGSERIAL PRIMARY KEY,
  at      BIGINT NOT NULL,
  route   TEXT NOT NULL,
  message TEXT NOT NULL
);
