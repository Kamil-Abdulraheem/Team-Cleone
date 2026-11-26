// Synchronization: pulls every enabled source, stores vacancies in the standard shape, and notices when vacancies disappear.
// One failing source never stops the others (each runs in its own try/catch), and every request is logged to source_runs.

import { ADAPTERS, sourceId } from "./sources/adapters.js";
import { sandboxFetch } from "./sources/sandbox.js";
import { DAY, fingerprint, ghostCheck, noiseReason, normalize, scamCheck } from "./jobs.js";

const sec = () => Math.floor(Date.now() / 1000);
// Sources are FETCHED in parallel but STORED one after another, so two boards listing the same job never overwrite each other.
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const first = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

export const isSandbox = (env) => env.SOURCE_MODE === "sandbox";
export const syntheticFlag = (env) => (isSandbox(env) ? 1 : 0);
const realFetch = (...a) => globalThis.fetch(...a); // looked up at call time
export const fetcher = (env) => (isSandbox(env) ? sandboxFetch : realFetch);

// ------------------------------------------------------------------ the list of sources

const seeded = new WeakSet();
export async function ensureSources(env) {
  if (seeded.has(env.DB)) return;
  const t = sec();
  const rows = [["remotive", "remotive", "Remotive", 1, 1, 360], ["arbeitnow", "arbeitnow", "Arbeitnow", 1, 1, 360], ["remoteok", "remoteok", "RemoteOK", 1, 1, 360],
    ["jobberman", "jobberman", "Jobberman (disabled: needs approved access)", 0, 1, 360], ["myjobmag", "myjobmag", "MyJobMag (disabled: needs approved access)", 0, 1, 360]];
  if (isSandbox(env)) rows.push(["greenhouse:acme", "greenhouse", "Acme (sample Greenhouse board)", 1, 0, 60], ["lever:globex", "lever", "Globex (sample Lever board)", 1, 0, 60], ["ashby:initech", "ashby", "Initech (sample Ashby board)", 1, 0, 60],
    ["rss:sample.invalid-feed.xml", "rss", "Sample RSS feed", 1, 0, 60], ["careerpage:sample.invalid", "careerpage", "Sample Bank career page", 1, 0, 60]);
  const cfg = { greenhouse: { board: "acme", company: "Acme" }, lever: { company: "globex", name: "Globex" }, ashby: { board: "initech", company: "Initech" }, rss: { url: "https://sample.invalid/feed.xml", label: "Sample Foods" }, careerpage: { url: "https://sample.invalid/careers", company: "Sample Bank", authorized: "YES" } };
  for (const [id, adapter, label, enabled, builtin, interval] of rows)
    await run(env.DB, "INSERT INTO source_configs (id, adapter, label, config, enabled, builtin, interval_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", id, adapter, label, JSON.stringify(cfg[adapter] || {}), enabled, builtin, interval, t);
  seeded.add(env.DB);
}

export function validateSource(adapter, config) {
  const a = ADAPTERS[adapter];
  if (!a) return "Unknown source type";
  if (a.kind === "aggregator") return "Built-in sources are already added";
  return a.validate(config || {});
}

// ------------------------------------------------------------------ storing vacancies

async function logRun(env, id, kind, r) {
  await run(env.DB, "INSERT INTO source_runs (source_id, kind, at, ok, http_status, jobs, new_jobs, removed, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, kind, sec(), r.ok ? 1 : 0, r.status ?? null, r.jobs || 0, r.added || 0, r.removed || 0, r.ms ?? null, String(r.error || "").slice(0, 300));
}

async function markSource(env, row, r) {
  const t = sec();
  if (r.ok) await run(env.DB, "UPDATE source_configs SET last_attempt = ?, last_ok = ?, fails_in_row = 0, last_status = ?, last_count = ?, last_ms = ?, last_error = '' WHERE id = ?", t, t, r.status ?? null, r.jobs, r.ms ?? null, row.id);
  else await run(env.DB, "UPDATE source_configs SET last_attempt = ?, last_fail = ?, fails_in_row = fails_in_row + 1, last_status = ?, last_ms = ?, last_error = ? WHERE id = ?", t, t, r.status ?? null, r.ms ?? null, String(r.error || "").slice(0, 300), row.id);
}

async function store(env, row, jobs, adapter) {
  const t = sec(), syn = syntheticFlag(env), ats = adapter.kind === "ats" || adapter.kind === "career";
  const rows = jobs.filter((j) => !noiseReason(j)).map((j) => ({ j, fp: fingerprint(j) }));
  const existing = new Map();
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150).map((x) => x.fp);
    for (const e of await all(env.DB, `SELECT * FROM jobs WHERE fp IN (${chunk.map(() => "?").join(",")})`, ...chunk)) existing.set(e.fp, e);
  }
  const seen = new Set(); let added = 0;
  for (const { j, fp } of rows) {
    if (seen.has(fp)) continue; seen.add(fp);
    let old = existing.get(fp);
    const scam = scamCheck(j), expired = j.valid_through && j.valid_through < t;
    const listed = ats && !expired;   // the employer's own board lists it right now
    if (!old) {
      const ins = await run(env.DB, `INSERT INTO jobs (id, fp, title, company, location, remote, salary_min, salary_max, currency, description, tags, posted_at, first_seen, last_seen, sources, apply_url, status, verified_at, verify_note, verified_via,
          scam_score, scam_flags, ghost_flags, external_id, employment_type, valid_through, closed_at, closed_reason, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fp) DO NOTHING`,
        crypto.randomUUID(), fp, j.title, j.company, j.location, j.remote, j.salary_min, j.salary_max, j.currency, j.description, j.tags, j.posted_at, t, t, JSON.stringify([{ source: row.id, url: j.url }]), j.url,
        expired ? "closed" : listed ? "open" : "unverified", listed || expired ? t : null, expired ? "passed its closing date" : listed ? "listed on the employer's own job board when we last synced" : "", expired ? "expired" : listed ? "feed" : "",
        scam.score, JSON.stringify(scam.flags), JSON.stringify(ghostCheck(j, {})), j.external_id, j.employment_type, j.valid_through, expired ? t : null, expired ? "expired" : "", syn);
      if (ins.meta?.changes) { added++; continue; }
      old = await first(env.DB, "SELECT * FROM jobs WHERE fp = ?", fp); // another board stored it a moment ago: merge into that row
      if (!old) continue;
    }
    const sources = J(old.sources, []);
    const mine = sources.find((s) => s.source === row.id);
    if (!mine) sources.push({ source: row.id, url: j.url }); else mine.url = j.url;
    const repost = j.posted_at && old.posted_at && j.posted_at - old.posted_at > 7 * DAY ? 1 : 0, reposts = old.reposts + repost;
    let status = old.status, note = old.verify_note, via = old.verified_via, closedAt = old.closed_at, reason = old.closed_reason, verifiedAt = old.verified_at;
    if (expired) { status = "closed"; note = "passed its closing date"; via = "expired"; closedAt = closedAt || t; reason = "expired"; verifiedAt = t; }
    else if (listed) { status = "open"; note = "listed on the employer's own job board when we last synced"; via = "feed"; closedAt = null; reason = ""; verifiedAt = t; }
    else if (old.status === "closed" && old.closed_reason !== "expired") { status = "unverified"; note = "it was listed again; not trusted until checked"; closedAt = null; reason = ""; }
    await run(env.DB, `UPDATE jobs SET last_seen = ?, sources = ?, reposts = ?, posted_at = COALESCE(?, posted_at), valid_through = COALESCE(?, valid_through), status = ?, verify_note = ?, verified_via = ?, verified_at = ?, closed_at = ?, closed_reason = ?,
        scam_score = ?, scam_flags = ?, ghost_flags = ?, employment_type = CASE WHEN employment_type = '' THEN ? ELSE employment_type END, salary_min = COALESCE(salary_min, ?), salary_max = COALESCE(salary_max, ?) WHERE id = ?`,
      t, JSON.stringify(sources), reposts, repost ? j.posted_at : null, j.valid_through, status, note, via, verifiedAt, closedAt, reason, Math.max(old.scam_score, scam.score), JSON.stringify(scam.flags),
      JSON.stringify(ghostCheck({ ...j, posted_at: old.posted_at || j.posted_at }, { reposts, sources: sources.length })), j.employment_type, j.salary_min, j.salary_max, old.id);
  }
  return { added, seen };
}

/** Vacancies this source no longer lists are removed from it. If no source lists a vacancy any more, it is closed as "removed". */
async function detectRemoved(env, row, seen, lastCount, fetchedCount) {
  if (lastCount > 10 && fetchedCount < lastCount * 0.5) return { removed: 0, note: "the feed returned far fewer jobs than last time, so nothing was marked removed (possible partial response)" };
  const t = sec(); let removed = 0;
  for (const j of await all(env.DB, "SELECT id, fp, sources, status FROM jobs WHERE sources LIKE ? AND status != 'closed'", `%"source":${JSON.stringify(row.id)}%`)) {
    if (seen.has(j.fp)) continue;
    const rest = J(j.sources, []).filter((s) => s.source !== row.id);
    if (rest.length) await run(env.DB, "UPDATE jobs SET sources = ? WHERE id = ?", JSON.stringify(rest), j.id);
    else { await run(env.DB, "UPDATE jobs SET sources = ?, status = 'closed', closed_at = ?, closed_reason = 'removed', verified_at = ?, verified_via = 'feed', verify_note = ? WHERE id = ?", "[]", t, t, "no longer listed by its source", j.id); removed++; }
  }
  return { removed };
}

export async function expireJobs(env) {
  const t = sec();
  const r = await run(env.DB, "UPDATE jobs SET status = 'closed', closed_at = ?, closed_reason = 'expired', verify_note = 'passed its closing date', verified_at = ?, verified_via = 'expired' WHERE status != 'closed' AND valid_through IS NOT NULL AND valid_through < ?", t, t, t);
  return r.meta?.changes || 0;
}

// ------------------------------------------------------------------ sync one source / all due sources

export async function syncSource(env, row, { fetchImpl } = {}) {
  const adapter = ADAPTERS[row.adapter]; const out = { id: row.id, label: row.label, ok: false };
  if (!adapter) { out.error = "unknown source type"; await logRun(env, row.id, "sync", out); return out; }
  const t0 = Date.now();
  try {
    const res = await adapter.fetch(J(row.config, {}), { fetchImpl: fetchImpl || fetcher(env) });
    const jobs = res.jobs.map((j) => normalize(row.id, j)).filter((j) => /^https?:\/\//.test(j.url) && j.title);
    if (!jobs.length && (row.last_count > 0 || adapter.kind !== "ats")) throw Object.assign(new Error("the source returned no usable jobs (its format may have changed); existing records were kept"), { status: res.http?.status });
    const { added, seen, rem } = await serial(async () => { const st = await store(env, row, jobs, adapter); return { ...st, rem: await detectRemoved(env, row, st.seen, row.last_count, jobs.length) }; });
    Object.assign(out, { ok: true, status: res.http?.status, ms: res.http?.ms ?? Date.now() - t0, jobs: jobs.length, added, removed: rem.removed, note: rem.note });
  } catch (e) {
    Object.assign(out, { ok: false, status: e.status ?? null, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
    console.error(`source ${row.id} failed: ${out.error}`);
  }
  await markSource(env, row, out); await logRun(env, row.id, "sync", out);
  return out;
}

const dueIn = (r) => Math.min(24 * 60, r.interval_min * (r.fails_in_row >= 3 ? 2 ** Math.min(4, r.fails_in_row - 2) : 1)) * 60; // failing sources are retried less often

/** Syncs every enabled source that is due (or all, with force). Runs a few at a time and stops starting new ones near the time limit. */
export async function syncDue(env, { force = false, only = null, budgetMs = 22000, concurrency = 3 } = {}) {
  await ensureSources(env);
  const t = sec(), deadline = Date.now() + budgetMs;
  let rows = await all(env.DB, "SELECT * FROM source_configs WHERE enabled = 1 ORDER BY COALESCE(last_attempt, 0) ASC");
  if (only) rows = rows.filter((r) => only.includes(r.id));
  const queue = rows.filter((r) => force || !r.last_attempt || r.last_attempt + dueIn(r) <= t);
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && Date.now() < deadline) { const r = queue.shift(); results.push(await syncSource(env, r)); }
  }));
  const expired = await expireJobs(env);
  await run(env.DB, "DELETE FROM source_runs WHERE at < ?", t - 14 * DAY);
  return { results, skipped: queue.map((r) => r.id), expired };
}

// ------------------------------------------------------------------ live diagnostic: REAL requests, never simulated

export async function diagnose(env, ids) {
  if (isSandbox(env)) { const e = new Error("The live diagnostic cannot run in sandbox mode: it must make real requests. Remove SOURCE_MODE=sandbox on the deployed backend."); e.status = 409; throw e; }
  await ensureSources(env);
  let rows = await all(env.DB, "SELECT * FROM source_configs ORDER BY id");
  if (ids?.length) rows = rows.filter((r) => ids.includes(r.id));
  return Promise.all(rows.map(async (row) => {
    const adapter = ADAPTERS[row.adapter], at = sec(), cfg = J(row.config, {});
    if (!adapter) return { id: row.id, label: row.label, ok: false, error: "unknown source type", at };
    if (adapter.disabled && adapter.validate(cfg)) return { id: row.id, label: row.label, adapter: row.adapter, ok: false, skipped: true, error: adapter.disabled, at };
    const t0 = Date.now(); let r;
    try {
      const res = await adapter.fetch(cfg, { fetchImpl: realFetch });
      r = { ok: true, status: res.http.status, ms: res.http.ms, jobs: res.jobs.length, url: res.http.url, sample: res.jobs.slice(0, 3).map((j) => j.title) };
    } catch (e) { r = { ok: false, status: e.status ?? null, ms: Date.now() - t0, jobs: 0, error: String(e.message || e).slice(0, 300) }; }
    await markSource(env, row, r); await logRun(env, row.id, "diagnostic", r);
    return { id: row.id, label: row.label, adapter: row.adapter, enabled: !!row.enabled, at, real: true, ...r };
  }));
}

// ------------------------------------------------------------------ numbers for the Source Intelligence dashboard

export async function dashboard(env) {
  await ensureSources(env);
  const t = sec(), syn = syntheticFlag(env), startOfDay = t - (t % DAY);
  const sources = await all(env.DB, "SELECT * FROM source_configs ORDER BY builtin DESC, id");
  const healthy = (s) => s.enabled && s.last_ok && s.fails_in_row === 0 && s.last_ok > t - Math.max(24 * 3600, s.interval_min * 60 * 3);
  const n = async (sql, ...a) => (await first(env.DB, sql, ...a))?.n ?? 0;
  const lastSync = (await first(env.DB, "SELECT MAX(last_ok) AS t FROM source_configs"))?.t || null;
  const active = sources.filter((s) => s.enabled);
  const stale = lastSync ? t - lastSync > Math.max(2 * 3600 * 6, 2 * Math.min(...active.map((s) => s.interval_min * 60), 21600)) : true;
  return {
    sandbox: isSandbox(env),
    metrics: {
      activeSources: active.length, healthySources: sources.filter(healthy).length,
      jobsCollected: await n("SELECT COUNT(*) AS n FROM jobs WHERE synthetic = ?", syn),
      newToday: await n("SELECT COUNT(*) AS n FROM jobs WHERE synthetic = ? AND first_seen >= ?", syn, startOfDay),
      expiredJobs: await n("SELECT COUNT(*) AS n FROM jobs WHERE synthetic = ? AND status = 'closed'", syn),
      failedRequests: await n("SELECT COUNT(*) AS n FROM source_runs WHERE ok = 0 AND at > ?", t - DAY),
      lastSync, stale,
    },
    sources: sources.map((s) => ({ id: s.id, label: s.label, adapter: s.adapter, kind: ADAPTERS[s.adapter]?.kind, enabled: !!s.enabled, builtin: !!s.builtin, healthy: !!healthy(s), intervalMin: s.interval_min,
      lastAttempt: s.last_attempt, lastOk: s.last_ok, httpStatus: s.last_status, jobs: s.last_count, failsInRow: s.fails_in_row, error: s.last_error, ms: s.last_ms, disabledReason: ADAPTERS[s.adapter]?.disabled && ADAPTERS[s.adapter].validate(J(s.config, {})) ? ADAPTERS[s.adapter].disabled : null })),
    runs: await all(env.DB, "SELECT source_id, kind, at, ok, http_status, jobs, new_jobs, removed, ms, error FROM source_runs ORDER BY id DESC LIMIT 25"),
    accuracy: await accuracy(env),
  };
}

// ------------------------------------------------------------------ how accurate is "open"? Measured, never assumed.

const wilson = (k, n, z = 1.96) => { if (!n) return [0, 1]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return [(c - m) / d, (c + m) / d]; };

/**
 * Two independent measurements of the "open" verdict:
 *  1. Audits: a random sample of jobs we called open are re-checked shortly after, and we count how often the second check agrees.
 *  2. User reports: of jobs we alerted on at least 24 hours ago, how many a person reported as "already closed".
 * The 98% target is only called met when the 95% confidence interval's LOWER bound is at or above 98% on at least 100 audits.
 */
export async function accuracy(env) {
  const TARGET = 0.98, MIN_N = 100;
  const a = await first(env.DB, "SELECT COUNT(*) AS n, COALESCE(SUM(agree), 0) AS k FROM verdict_audits");
  const by = Object.fromEntries((await all(env.DB, "SELECT first_via AS via, COUNT(*) AS n, COALESCE(SUM(agree), 0) AS k FROM verdict_audits GROUP BY first_via")).map((r) => [r.via || "page", { audits: +r.n, agreed: +r.k }]));
  const n = +a.n, k = +a.k, [lo, hi] = wilson(k, n);
  const alerted = (await first(env.DB, "SELECT COUNT(*) AS n FROM job_matches WHERE alerted_at IS NOT NULL AND alerted_at < ?", sec() - DAY))?.n ?? 0;
  const bad = (await first(env.DB, "SELECT COUNT(DISTINCT r.user_id || r.job_id) AS n FROM job_reports r JOIN job_matches m ON m.job_id = r.job_id AND m.user_id = r.user_id WHERE r.kind = 'was_closed' AND m.alerted_at IS NOT NULL AND m.alerted_at < ?", sec() - DAY))?.n ?? 0;
  const [alo, ahi] = wilson(alerted - bad, alerted);
  const verdict = n < MIN_N ? "insufficient" : lo >= TARGET ? "meets" : hi < TARGET ? "below" : "inconclusive";
  return { byMethod: by, note: "Audits of 'feed' verdicts are independent (the employer's board versus the page itself). Audits of 'page' verdicts re-use the same method, so they are weaker evidence.", target: TARGET, audits: n, agreed: k, rate: n ? +(k / n).toFixed(4) : null, ci95: n ? [+lo.toFixed(4), +hi.toFixed(4)] : null, verdict, minAudits: MIN_N,
    alertsChecked: alerted, reportedClosed: bad, alertAccuracy: alerted ? +((alerted - bad) / alerted).toFixed(4) : null, alertCi95: alerted ? [+alo.toFixed(4), +ahi.toFixed(4)] : null };
}

/** Daily: re-check a random sample of jobs we recently called open by an independent method, and record whether it still holds. */
export async function auditSample(env, verifyFn, size = 20) {
  const t = sec();
  const sample = await all(env.DB, "SELECT id, apply_url, verified_via, verified_at, sources FROM jobs WHERE status = 'open' AND synthetic = ? AND verified_at BETWEEN ? AND ? ORDER BY random() LIMIT ?", syntheticFlag(env), t - 6 * 3600, t - 900, size);
  let n = 0;
  for (const j of sample) {
    const v = await verifyFn(j.apply_url);           // independent check: the page itself
    if (v.status === "unverified") continue;           // a page that blocks us proves nothing either way, so it is not counted
    await run(env.DB, "INSERT INTO verdict_audits (job_id, first_via, first_at, second_status, agree, at) VALUES (?, ?, ?, ?, ?, ?)", j.id, j.verified_via || "page", j.verified_at, v.status, v.status === "open" ? 1 : 0, t);
    n++;
  }
  return n;
}

export { sourceId };
