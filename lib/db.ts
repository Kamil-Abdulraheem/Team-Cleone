import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Lane = "strategic" | "joiners" | "investors";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_url   TEXT NOT NULL UNIQUE,
  owner      TEXT NOT NULL,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL,              -- JSON: description, topics, language, stars, readme excerpt
  last_scan  TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lane           TEXT NOT NULL CHECK (lane IN ('strategic','joiners','investors')),
  source         TEXT NOT NULL CHECK (source IN ('star','fork','similar')),
  dedupe_key     TEXT NOT NULL,            -- stable identity across rescans, e.g. company:acme or person:alice
  handle         TEXT NOT NULL,
  name           TEXT NOT NULL,
  artifact_title TEXT NOT NULL,
  artifact_url   TEXT NOT NULL,
  facts          TEXT NOT NULL,
  contact        TEXT NOT NULL DEFAULT '', -- public contact details only
  signal         REAL NOT NULL DEFAULT 0,  -- deterministic evidence strength, 0-100
  meta           TEXT NOT NULL DEFAULT '{}', -- JSON facts used by the rule-based scorer
  UNIQUE (project_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  significance INTEGER NOT NULL,
  resonance    INTEGER NOT NULL,
  timing       INTEGER NOT NULL,
  score        REAL NOT NULL,
  why          TEXT NOT NULL,
  signal_at_score REAL NOT NULL DEFAULT 0, -- candidate signal when last scored; drives rescoring
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','dismissed')),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('like','dismiss')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_candidates_project ON candidates(project_id);
CREATE INDEX IF NOT EXISTS idx_feedback_match ON feedback(match_id);
`;

const file = process.env.DB_PATH || path.join(process.cwd(), "data", "cleone.db");
const g = globalThis as unknown as { __cleoneDb?: Database.Database };

function open(): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  const cols = d.prepare("PRAGMA table_info(candidates)").all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === "meta")) {
    throw new Error(`The database at ${file} uses an older schema. Delete it (it only holds scan results) and run again.`);
  }
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA);
  return d;
}

// Reuse one connection across hot reloads in dev.
export const db: Database.Database = g.__cleoneDb ?? (g.__cleoneDb = open());
