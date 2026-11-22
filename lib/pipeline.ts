import { db, type Lane } from "./db";
import { collect, fetchProject, parseRepo, type ProjectSummary } from "./github";
import { draftOutreach, scoreBatch, type ScoreInput } from "./claude";

export const CUTOFF = 75;
const BATCH = 10;
const RESCORE_DELTA = 15;

export type MatchRow = {
  id: number;
  lane: Lane;
  source: string;
  signal: number;
  contact: string;
  handle: string;
  name: string;
  artifact_title: string;
  artifact_url: string;
  significance: number;
  resonance: number;
  timing: number;
  score: number;
  why: string;
};

type ProjectRow = { id: number; repo_url: string; owner: string; name: string; summary: string };

const toSummary = (r: ProjectRow): ProjectSummary => JSON.parse(r.summary) as ProjectSummary;

export function getProjectByUrl(repoUrl: string): ProjectRow | undefined {
  const { owner, name } = parseRepo(repoUrl);
  return db
    .prepare("SELECT * FROM projects WHERE lower(repo_url) = lower(?)")
    .get(`https://github.com/${owner}/${name}`) as ProjectRow | undefined;
}

export async function runScan(repoUrl: string) {
  const { owner, name } = parseRepo(repoUrl);
  const summary = await fetchProject(owner, name);

  const project = db
    .prepare(
      `INSERT INTO projects (repo_url, owner, name, summary, last_scan)
       VALUES (@repo_url, @owner, @name, @summary, CURRENT_TIMESTAMP)
       ON CONFLICT(repo_url) DO UPDATE SET summary = excluded.summary, last_scan = CURRENT_TIMESTAMP
       RETURNING id`
    )
    .get({
      repo_url: summary.url,
      owner: summary.owner,
      name: summary.name,
      summary: JSON.stringify(summary),
    }) as { id: number };

  const { candidates, stats } = await collect(summary);
  const insert = db.prepare(
    `INSERT INTO candidates
       (project_id, lane, source, dedupe_key, handle, name, artifact_title, artifact_url, facts, contact, signal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
       lane = excluded.lane, source = excluded.source, name = excluded.name,
       artifact_title = excluded.artifact_title, artifact_url = excluded.artifact_url,
       facts = excluded.facts, contact = excluded.contact, signal = excluded.signal`
  );
  db.transaction(() => {
    for (const c of candidates) {
      insert.run(project.id, c.lane, c.source, c.dedupe_key, c.handle, c.name, c.artifact_title, c.artifact_url, c.facts, c.contact, c.signal);
    }
  })();

  // Score candidates that are new, or whose evidence grew materially since they were last scored
  // (for example a third engineer from the same company starred the repo). Everything else is skipped
  // to control cost on rescans.
  const unscored = db
    .prepare(
      `SELECT c.id, c.lane, c.source, c.signal, c.handle, c.name, c.artifact_title, c.artifact_url, c.facts
       FROM candidates c LEFT JOIN matches m ON m.candidate_id = c.id
       WHERE c.project_id = ? AND (m.id IS NULL OR c.signal - m.signal_at_score >= ?)`
    )
    .all(project.id, RESCORE_DELTA) as ScoreInput[];
  const signalOf = new Map(unscored.map((c) => [c.id, c.signal]));

  const save = db.prepare(
    `INSERT INTO matches (candidate_id, significance, resonance, timing, score, why, signal_at_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(candidate_id) DO UPDATE SET
       significance = excluded.significance, resonance = excluded.resonance, timing = excluded.timing,
       score = excluded.score, why = excluded.why, signal_at_score = excluded.signal_at_score`
  );
  let scored = 0;
  for (let i = 0; i < unscored.length; i += BATCH) {
    const scores = await scoreBatch(summary, unscored.slice(i, i + BATCH));
    db.transaction(() => {
      for (const s of scores) save.run(s.id, s.significance, s.resonance, s.timing, s.score, s.why, signalOf.get(s.id) ?? 0);
    })();
    scored += scores.length;
  }

  return { projectId: project.id, collected: candidates.length, scored, stats, ...listMatches(project.id) };
}

function laneBias(projectId: number): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT c.lane AS lane,
              SUM(CASE f.action WHEN 'like' THEN 2 ELSE -2 END) AS bias
       FROM feedback f
       JOIN matches m ON m.id = f.match_id
       JOIN candidates c ON c.id = m.candidate_id
       WHERE c.project_id = ?
       GROUP BY c.lane`
    )
    .all(projectId) as { lane: string; bias: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.lane] = Math.max(-10, Math.min(10, r.bias));
  return out;
}

export function listMatches(projectId: number) {
  const rows = db
    .prepare(
      `SELECT m.id, c.lane, c.source, c.signal, c.contact, c.handle, c.name, c.artifact_title, c.artifact_url,
              m.significance, m.resonance, m.timing, m.score, m.why
       FROM matches m JOIN candidates c ON c.id = m.candidate_id
       WHERE c.project_id = ? AND m.status = 'new' AND m.score >= ?`
    )
    .all(projectId, CUTOFF) as MatchRow[];
  const bias = laneBias(projectId);
  rows.sort((a, b) => b.score + (bias[b.lane] ?? 0) - (a.score + (bias[a.lane] ?? 0)));

  const hidden = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM matches m JOIN candidates c ON c.id = m.candidate_id
         WHERE c.project_id = ? AND m.status = 'new' AND m.score < ?`
      )
      .get(projectId, CUTOFF) as { n: number }
  ).n;

  return { matches: rows, hiddenBelowCutoff: hidden };
}

export async function outreachFor(matchId: number): Promise<string> {
  const row = db
    .prepare(
      `SELECT m.why, c.id, c.lane, c.source, c.signal, c.handle, c.name, c.artifact_title, c.artifact_url, c.facts, p.summary
       FROM matches m
       JOIN candidates c ON c.id = m.candidate_id
       JOIN projects p ON p.id = c.project_id
       WHERE m.id = ?`
    )
    .get(matchId) as (ScoreInput & { why: string; summary: string }) | undefined;
  if (!row) throw new Error("Match not found.");
  return draftOutreach(JSON.parse(row.summary) as ProjectSummary, row, row.why);
}

export function recordFeedback(matchId: number, action: "like" | "dismiss", reason?: string) {
  const exists = db.prepare("SELECT 1 FROM matches WHERE id = ?").get(matchId);
  if (!exists) throw new Error("Match not found.");
  db.transaction(() => {
    db.prepare("INSERT INTO feedback (match_id, action, reason) VALUES (?, ?, ?)").run(
      matchId,
      action,
      reason ?? null
    );
    if (action === "dismiss") db.prepare("UPDATE matches SET status = 'dismissed' WHERE id = ?").run(matchId);
  })();
}

export function allProjectUrls(): string[] {
  return (db.prepare("SELECT repo_url FROM projects").all() as { repo_url: string }[]).map((r) => r.repo_url);
}

export { toSummary };
