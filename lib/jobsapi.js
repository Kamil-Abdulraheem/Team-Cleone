// Job Radar routes. Registered from lib/app.js.
//   lib/sources/*  where vacancies come from (adapters)     lib/sync.js   storing them, scheduling, health, accuracy
//   lib/match.js   scoring and explaining a match           lib/ai.js     optional cheap/strong model split
// Nothing here ever applies to a job for the person. The most it does is draft text and open the employer's own page.

import { JOB_CUTOFF, JOB_MAX_ALERTS_PER_RUN, JOB_RECHECK_AFTER, JOB_SCAM_HIDE, JOB_VERIFY_PER_SCAN } from "./config.js";
import { DAY, coverLetter, decryptCv, encryptCv, interviewQuestions, marketView, parseCommand, verifyJob } from "./jobs.js";
import { eduLevel, extractSkills, scoreJob, yearsFromCv } from "./match.js";
import { aiEnabled, cvViaAi, letterViaAi, requirementsViaAi } from "./ai.js";
import { ADAPTERS, catalog, sourceId } from "./sources/adapters.js";
import { auditSample, dashboard, diagnose, ensureSources, fetcher, isSandbox, syncDue, syncSource, syntheticFlag, validateSource } from "./sync.js";

const STATES = ["new", "saved", "applied", "replied", "interview", "offer", "rejected", "dismissed"];
const TRACKED = ["applied", "replied", "interview", "offer", "rejected"];
const EMPLOYMENT = ["full-time", "part-time", "contract", "internship"];
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const sec = () => Math.floor(Date.now() / 1000);

export function registerJobs(add, c) {
  const { first, all, run, planOf, json, readJson, HttpError, monthKey, uuid, throttle, sendEmail, emailEnabled } = c;

  /** Checks the apply page. A verdict newer than maxAge is reused (shared by all users). Feed-verified jobs are already fresh. */
  async function verify(env, job, maxAge = JOB_RECHECK_AFTER) {
    if (job.verified_at && job.verified_at > sec() - maxAge && job.status !== "unverified") return job;
    const v = await verifyJob(job.apply_url, fetcher(env));
    const t = sec();
    await run(env.DB, "UPDATE jobs SET status = ?, verified_at = ?, verify_note = ?, verified_via = 'page', closed_at = ?, closed_reason = ? WHERE id = ?", v.status, t, v.note, v.status === "closed" ? t : null, v.status === "closed" ? "page" : "", job.id);
    return { ...job, status: v.status, verified_at: t, verify_note: v.note, verified_via: "page" };
  }

  /** What this person has liked or dismissed teaches the matcher: same company or similar title words. */
  async function learned(env, userId) {
    const rows = await all(env.DB, "SELECT mm.state, mm.note, j.company, j.title FROM job_matches mm JOIN jobs j ON j.id = mm.job_id WHERE mm.user_id = ? AND mm.state IN ('dismissed','saved','applied','interview','offer')", userId);
    const bad = new Set(), good = new Set(), badWords = {};
    for (const r of rows) {
      if (r.state === "dismissed") { if (/not relevant|wrong role/i.test(r.note)) { bad.add(r.company.toLowerCase()); for (const w of r.title.toLowerCase().split(/\W+/).filter((x) => x.length > 3)) badWords[w] = (badWords[w] || 0) + 1; } }
      else good.add(r.company.toLowerCase());
    }
    return { bad, good, badWords };
  }

  async function refreshMatches(env, user, plan) {
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    if (!p) return 0;
    const started = sec(), L = await learned(env, user.id), cvText = p.cv_enc ? await decryptCv(env, p.cv_enc) : "";
    const profile = { ...p, cvText };
    const useAi = aiEnabled(env) && plan.name === "pro"; let aiLeft = 8; // at most 8 cheap-model reads per refresh
    const jobs = await all(env.DB, "SELECT * FROM jobs WHERE status != 'closed' AND synthetic = ? AND last_seen > ? ORDER BY last_seen DESC LIMIT 1500", syntheticFlag(env), sec() - 45 * DAY);
    let n = 0;
    for (const j of jobs) {
      let m = scoreJob(profile, j);
      if (useAi && aiLeft > 0 && m.score >= JOB_CUTOFF - 5 && m.score < 70 && m.confidence < 0.6) {
        aiLeft--; const extra = await requirementsViaAi(env, { userId: user.id, month: monthKey() }, j);
        if (extra) m = scoreJob(profile, j, extra);
      }
      const co = j.company.toLowerCase();
      let score = m.score;
      if (L.bad.has(co)) score -= 25; if (L.good.has(co)) score += 8;
      score = Math.max(0, Math.min(100, score - Math.min(15, j.title.toLowerCase().split(/\W+/).filter((x) => L.badWords[x] >= 2).length * 5)));
      if (score < JOB_CUTOFF) continue;
      const detail = JSON.stringify({ confidence: m.confidence, parts: m.parts, unknown: m.unknown, transferable: m.transferable, adjacent: m.adjacent });
      await run(env.DB, `INSERT INTO job_matches (id, user_id, job_id, score, why, gaps, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, job_id) DO UPDATE SET score = excluded.score, why = excluded.why, gaps = excluded.gaps, detail = excluded.detail, updated_at = excluded.updated_at`,
        uuid(), user.id, j.id, score, JSON.stringify(m.why), JSON.stringify(m.gaps), detail, sec(), sec());
      n++;
    }
    await run(env.DB, "DELETE FROM job_matches WHERE user_id = ? AND state = 'new' AND alerted_at IS NULL AND updated_at < ?", user.id, started); // no longer a fit
    return n;
  }

  const shape = (r) => {
    const d = J(r.detail, {});
    return { id: r.job_id || r.id, title: r.title, company: r.company, location: r.location, remote: !!r.remote, employmentType: r.employment_type || "",
      salary: r.salary_min ? { min: r.salary_min, max: r.salary_max, currency: r.currency || "USD" } : null, score: r.score, confidence: d.confidence ?? null, adjacent: !!d.adjacent,
      status: r.status, verifyNote: r.verify_note, verifiedAt: r.verified_at, verifiedVia: r.verified_via, postedAt: r.posted_at, scamScore: r.scam_score, scamFlags: J(r.scam_flags, []), ghostFlags: J(r.ghost_flags, []),
      boards: J(r.sources, []).length, state: r.state, why: J(r.why, []), gaps: J(r.gaps, []), synthetic: !!r.synthetic };
  };

  const base = (env) => `SELECT mm.job_id, mm.score, mm.why, mm.gaps, mm.detail, mm.state, mm.note, mm.follow_up, mm.alerted_at, mm.closed_alerted_at, j.* FROM job_matches mm JOIN jobs j ON j.id = mm.job_id WHERE mm.user_id = ? AND j.synthetic = ${syntheticFlag(env)}`;

  /** Which discoverable jobs this person may open. The Free plan sees the best few; the rest are only counted. Enforced on the server. */
  async function discoverable(env, user, plan) {
    const rows = await all(env.DB, base(env) + " AND mm.state IN ('new','saved') AND j.status != 'closed' AND j.scam_score < ? ORDER BY CASE j.status WHEN 'open' THEN 0 ELSE 1 END, mm.score DESC LIMIT 200", user.id, JOB_SCAM_HIDE);
    return { rows, visible: new Set(rows.slice(0, plan.jobsVisible).map((r) => r.job_id)) };
  }
  const own = async (env, user, id) => { const r = await first(env.DB, base(env) + " AND mm.job_id = ?", user.id, id); if (!r) throw new HttpError(404, "Job not found"); return r; };
  const usable = async (env, user, id) => {
    const r = await own(env, user, id), plan = await planOf(env, user);
    if (TRACKED.includes(r.state) || r.scam_score >= JOB_SCAM_HIDE || r.status === "closed") return { r, plan };
    if (!(await discoverable(env, user, plan)).visible.has(id)) throw new HttpError(403, "Upgrade to Pro to unlock this job.");
    return { r, plan };
  };
  const requireAdmin = async (env, user) => { if (!(await planOf(env, user)).admin) throw new HttpError(403, "Admins only"); };

  // ---------------------------------------------------------------- profile

  add("GET", "/jobs/profile", async ({ env, user }) => {
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    return json({ profile: p ? { roles: p.roles, skills: p.skills, years: p.years, education: p.education, employment: p.employment, location: p.location, remoteOnly: !!p.remote_only, minSalary: p.min_salary, pausedUntil: p.paused_until, hasCv: !!p.cv_enc,
      summary: p.summary, monitor: !!p.monitor, alertMin: p.alert_min } : null, encryption: !!env.CV_ENCRYPTION_KEY, ai: aiEnabled(env), sandbox: isSandbox(env) });
  });

  add("PUT", "/jobs/profile", async ({ env, req, user }) => {
    const b = await readJson(req), plan = await planOf(env, user);
    const cv = String(b.cv || "").slice(0, 15000);
    const old = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    // Read the CV: AI on Pro when a key is set, otherwise rules. Either way the person can edit everything afterwards.
    const ai = cv && plan.name === "pro" ? await cvViaAi(env, { userId: user.id, month: monthKey() }, cv) : null;
    const found = ai?.skills?.length ? ai.skills : extractSkills(cv);
    const skills = typeof b.skills === "string" ? b.skills : [...new Set([...(old?.skills ? old.skills.split(",") : []), ...found])].join(",");
    const roles = String(b.roles ?? (old?.roles || ai?.roles?.join(", ") || "")).slice(0, 300);
    const employment = String(b.employment ?? old?.employment ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => EMPLOYMENT.includes(x)).join(",");
    const row = {
      roles, skills: skills.slice(0, 600), years: Math.max(0, Math.min(50, +b.years || ai?.years || yearsFromCv(cv) || old?.years || 0)), education: [0, 1, 2, 3, 4].includes(+b.education) && b.education !== undefined && +b.education > 0 ? +b.education : ai?.education || eduLevel(cv) || old?.education || 0,
      location: String(b.location ?? old?.location ?? "").slice(0, 100), remote: b.remoteOnly === undefined ? old?.remote_only || 0 : b.remoteOnly ? 1 : 0, minSalary: Math.max(0, +b.minSalary || 0), employment,
      summary: String(ai?.summary || old?.summary || "").slice(0, 240), monitor: b.monitor === undefined ? old?.monitor ?? 1 : b.monitor ? 1 : 0, alertMin: Math.max(50, Math.min(95, +b.alertMin || old?.alert_min || 70)),
    };
    if (!row.roles.trim() && !row.skills.trim()) throw new HttpError(400, "Add at least one role you want or paste your CV so we can find your skills.");
    const enc = cv ? await encryptCv(env, cv) : old?.cv_enc || null; // with no encryption key the CV text is simply not stored
    await run(env.DB, `INSERT INTO job_profiles (user_id, roles, skills, years, education, employment, location, remote_only, min_salary, cv_enc, summary, monitor, alert_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET roles = excluded.roles, skills = excluded.skills, years = excluded.years, education = excluded.education, employment = excluded.employment, location = excluded.location, remote_only = excluded.remote_only,
        min_salary = excluded.min_salary, cv_enc = excluded.cv_enc, summary = excluded.summary, monitor = excluded.monitor, alert_min = excluded.alert_min, updated_at = excluded.updated_at`,
      user.id, row.roles, row.skills, row.years, row.education, row.employment, row.location, row.remote, row.minSalary, enc, row.summary, row.monitor, row.alertMin, sec());
    const matches = await refreshMatches(env, user, plan);
    return json({ ok: true, skills: row.skills.split(",").filter(Boolean), years: row.years, education: row.education, aiRead: !!ai, cvStored: !!enc,
      cvNote: cv && !enc ? "Your CV text was read to find skills but not stored, because encryption is not switched on for this server." : null, matches });
  });

  add("DELETE", "/jobs/profile", async ({ env, user }) => {
    await run(env.DB, "DELETE FROM job_matches WHERE user_id = ?", user.id);
    await run(env.DB, "DELETE FROM job_profiles WHERE user_id = ?", user.id);
    return json({ ok: true });
  });

  // ---------------------------------------------------------------- scan

  add("POST", "/jobs/scan", async ({ env, user }) => {
    const plan = await planOf(env, user);
    const p = await first(env.DB, "SELECT 1 AS x FROM job_profiles WHERE user_id = ?", user.id);
    if (!p) throw new HttpError(400, "Tell us what you are looking for first (roles or your CV).");
    await throttle(env, `jobscan:${user.id}`, 6, 3600);
    const used = (await first(env.DB, "SELECT job_scans FROM usage WHERE user_id = ? AND month = ?", user.id, monthKey()))?.job_scans ?? 0;
    if (used >= plan.jobScansPerMonth) throw new HttpError(402, plan.name === "free" ? `The Free plan includes ${plan.jobScansPerMonth} job scans a month. Upgrade to Pro for more.` : "You reached this month's job scan limit.");
    const sync = await syncDue(env);                       // only sources that are due: a fresh read is shared by everyone
    const matched = await refreshMatches(env, user, plan);
    const top = await all(env.DB, base(env) + " AND mm.state IN ('new','saved') AND j.status != 'closed' AND j.scam_score < ? ORDER BY mm.score DESC LIMIT ?", user.id, JOB_SCAM_HIDE, JOB_VERIFY_PER_SCAN);
    let checked = 0;
    for (const r of top) { const before = r.verified_at; if ((await verify(env, r)).verified_at !== before) checked++; }
    await run(env.DB, "INSERT INTO usage (user_id, month, scans, job_scans) VALUES (?, ?, 0, 1) ON CONFLICT(user_id, month) DO UPDATE SET job_scans = usage.job_scans + 1", user.id, monthKey());
    const src = await all(env.DB, "SELECT id, label, enabled, fails_in_row, last_count, last_error, last_ok FROM source_configs WHERE enabled = 1 ORDER BY id");
    return json({ matched, checked, added: sync.results.reduce((a, r) => a + (r.added || 0), 0), reused: !sync.results.length, sandbox: isSandbox(env),
      sources: src.map((s) => ({ source: s.id, label: s.label, ok: s.fails_in_row === 0 && !!s.last_ok, count: s.last_count, error: s.fails_in_row ? s.last_error : "" })) });
  });

  // ---------------------------------------------------------------- results

  add("GET", "/jobs", async ({ env, user }) => {
    const plan = await planOf(env, user);
    const p = await first(env.DB, "SELECT paused_until FROM job_profiles WHERE user_id = ?", user.id);
    const { rows, visible } = await discoverable(env, user, plan);
    const items = rows.filter((r) => visible.has(r.job_id)).map(shape);
    const sus = (await all(env.DB, base(env) + " AND mm.state IN ('new','saved') AND j.scam_score >= ? ORDER BY mm.score DESC LIMIT 20", user.id, JOB_SCAM_HIDE)).map(shape);
    const tracker = (await all(env.DB, base(env) + " AND mm.state IN ('applied','replied','interview','offer','rejected') ORDER BY mm.updated_at DESC LIMIT 100", user.id)).map((r) => ({ ...shape(r), note: r.note, followUp: r.follow_up }));
    const closed = (await all(env.DB, base(env) + " AND j.status = 'closed' AND (mm.state = 'saved' OR mm.alerted_at IS NOT NULL) AND mm.state NOT IN ('applied','replied','interview','offer','rejected') ORDER BY j.verified_at DESC LIMIT 20", user.id)).map(shape);
    return json({ plan: plan.name, sandbox: isSandbox(env), cutoff: JOB_CUTOFF, pausedUntil: p?.paused_until || 0,
      open: items.filter((x) => x.status === "open" && !x.adjacent), unverified: items.filter((x) => x.status !== "open" && !x.adjacent), adjacent: items.filter((x) => x.adjacent),
      locked: rows.length - items.length, suspicious: sus, tracker, closed });
  });

  add("GET", "/jobs/alerts", async ({ env, user }) => {
    const rows = await all(env.DB, base(env) + " AND (mm.alerted_at IS NOT NULL OR mm.closed_alerted_at IS NOT NULL OR (mm.follow_up IS NOT NULL AND mm.follow_up <= ? AND mm.state = 'applied')) ORDER BY mm.updated_at DESC LIMIT 50", user.id, sec());
    const out = [];
    for (const r of rows) {
      if (r.closed_alerted_at) out.push({ type: "closed", at: r.closed_alerted_at, job: shape(r) });
      else if (r.state === "applied" && r.follow_up && r.follow_up <= sec()) out.push({ type: "followup", at: r.follow_up, job: shape(r) });
      else if (r.alerted_at) out.push({ type: "new", at: r.alerted_at, job: shape(r) });
    }
    return json({ alerts: out.sort((a, b) => b.at - a.at) });
  });

  add("GET", "/jobs/market", async ({ env, user }) => {
    const p = await first(env.DB, "SELECT roles FROM job_profiles WHERE user_id = ?", user.id);
    const role = (p?.roles || "").split(",")[0].trim().toLowerCase();
    const rows = await all(env.DB, "SELECT title, company, status, salary_min, salary_max, posted_at FROM jobs WHERE synthetic = ? AND last_seen > ?", syntheticFlag(env), sec() - 45 * DAY);
    const mine = role ? rows.filter((r) => role.split(/\s+/).every((w) => r.title.toLowerCase().includes(w))) : rows;
    return json({ role: role || null, ...marketView(mine), note: "Based on postings our sources listed in the last 45 days. Salaries are only included where the posting states them." });
  });

  add("GET", "/jobs/:id", async ({ env, params, user }) => {
    const { r, plan } = await usable(env, user, params.id);
    const full = await first(env.DB, "SELECT * FROM jobs WHERE id = ?", r.job_id), d = J(r.detail, {});
    const sameCo = (await first(env.DB, "SELECT COUNT(*) AS n FROM jobs WHERE company = ? AND synthetic = ? AND last_seen > ?", r.company, syntheticFlag(env), sec() - 45 * DAY))?.n ?? 0;
    const age = r.posted_at ? Math.floor((sec() - r.posted_at) / DAY) : null, srcs = J(full.sources, []);
    return json({ ...shape(r), description: full.description, applyUrl: full.apply_url, originalSource: srcs[0]?.source || null, boardLinks: srcs, note: r.note, followUp: r.follow_up,
      parts: d.parts || [], unknown: d.unknown || [], transferable: d.transferable || [], validThrough: full.valid_through, closedReason: full.closed_reason, department: undefined,
      companyOpenRoles: sameCo, ageDays: age, likelyToCloseSoon: age !== null && age > 21 && r.status === "open" ? "Posted over 3 weeks ago; roles like this are often filled around now. Apply early." : null, canDraft: plan.jobsVisible > 0 });
  });

  // ---------------------------------------------------------------- acting on a job (the person always decides)

  add("POST", "/jobs/:id/state", async ({ env, req, params, user }) => {
    const b = await readJson(req);
    if (!STATES.includes(b.state)) throw new HttpError(400, "Unknown state");
    await own(env, user, params.id);
    const follow = b.state === "applied" ? sec() + Math.max(1, Math.min(60, +b.followUpDays || 7)) * DAY : null;
    await run(env.DB, "UPDATE job_matches SET state = ?, note = ?, follow_up = ?, updated_at = ? WHERE user_id = ? AND job_id = ?", b.state, String(b.note || "").slice(0, 300), follow, sec(), user.id, params.id);
    return json({ ok: true, followUp: follow });
  });

  add("POST", "/jobs/:id/report", async ({ env, req, params, user }) => {
    const b = await readJson(req);
    if (!["was_closed", "looks_scam", "useful"].includes(b.kind)) throw new HttpError(400, "Unknown report");
    await own(env, user, params.id);
    await run(env.DB, "INSERT INTO job_reports (user_id, job_id, kind, created_at) VALUES (?, ?, ?, ?)", user.id, params.id, b.kind, sec());
    const n = (await first(env.DB, "SELECT COUNT(DISTINCT user_id) AS n FROM job_reports WHERE job_id = ? AND kind = ?", params.id, b.kind))?.n ?? 0;
    if (b.kind === "was_closed") await run(env.DB, "UPDATE jobs SET status = ?, verify_note = ?, verified_at = ?, verified_via = 'report', closed_at = ?, closed_reason = ? WHERE id = ?", n >= 2 ? "closed" : "unverified", n >= 2 ? "reported closed by several people" : "someone reported this as closed; being re-checked", sec(), n >= 2 ? sec() : null, n >= 2 ? "reported" : "", params.id);
    if (b.kind === "looks_scam" && n >= 2) await run(env.DB, "UPDATE jobs SET scam_score = GREATEST(scam_score, ?) WHERE id = ?", JOB_SCAM_HIDE, params.id);
    return json({ ok: true });
  });

  add("POST", "/jobs/:id/recheck", async ({ env, params, user }) => {
    const { r } = await usable(env, user, params.id);
    await throttle(env, `recheck:${user.id}`, 30, 3600);
    const j = await verify(env, r, 60);
    return json({ status: j.status, note: j.verify_note, checkedAt: j.verified_at });
  });

  add("POST", "/jobs/:id/draft", async ({ env, params, user }) => {
    const { r, plan } = await usable(env, user, params.id);
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    const ai = plan.name === "pro" ? await letterViaAi(env, { userId: user.id, month: monthKey() }, p, r, user.name, J(r.why, [])) : null; // STRONG model, Pro only
    const d = ai || coverLetter(p, r, user.name);
    return json({ ...d, aiWritten: !!ai, applyUrl: r.apply_url, submitted: false, warning: r.status === "open" ? null : "We could not confirm this job is still open. Check the employer's page before you apply." });
  });

  add("POST", "/jobs/:id/prep", async ({ env, params, user }) => {
    const { r } = await usable(env, user, params.id);
    return json({ questions: interviewQuestions(r) });
  });

  // ---------------------------------------------------------------- plain-language commands

  add("POST", "/jobs/command", async ({ env, req, user }) => {
    const b = await readJson(req), plan = await planOf(env, user);
    const cmd = parseCommand(b.text);
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    if (!p && cmd.action !== "unknown") throw new HttpError(400, "Set up your job profile first.");
    const upd = (sql, ...a) => run(env.DB, sql + " WHERE user_id = ?", ...a, user.id);
    switch (cmd.action) {
      case "pause": await upd("UPDATE job_profiles SET paused_until = ?", cmd.until); return json({ reply: `Paused until ${cmd.label}. I will not send alerts until then.`, pausedUntil: cmd.until });
      case "resume": await upd("UPDATE job_profiles SET paused_until = 0"); return json({ reply: "Alerts are back on." });
      case "remote": await upd("UPDATE job_profiles SET remote_only = ?", cmd.value); await refreshMatches(env, user, plan); return json({ reply: cmd.value ? "Only remote jobs from now on." : "Showing remote and on-site jobs." });
      case "salary": await upd("UPDATE job_profiles SET min_salary = ?", cmd.value); return json({ reply: `Minimum pay set to $${cmd.value.toLocaleString("en-US")} a year. Jobs that state a lower maximum will rank lower.` });
      case "roles": await upd("UPDATE job_profiles SET roles = ?", cmd.value.slice(0, 300)); await refreshMatches(env, user, plan); return json({ reply: `Now looking for: ${cmd.value}.` });
      case "why": {
        const r = b.jobId ? await own(env, user, b.jobId) : await first(env.DB, base(env) + " AND mm.alerted_at IS NOT NULL ORDER BY mm.alerted_at DESC LIMIT 1", user.id);
        if (!r) return json({ reply: "I have not sent you any alerts yet." });
        const why = J(r.why, []), gaps = J(r.gaps, []);
        return json({ reply: `${r.title} at ${r.company} scored ${r.score}. ${why.join(". ")}${why.length ? "." : ""}${gaps.length ? " Gaps: " + gaps.join("; ") + "." : ""}`, jobId: r.job_id });
      }
      default: return json({ reply: 'I understand things like: "pause until Monday", "pause for 2 weeks", "resume", "only remote now", "minimum salary 60k", "looking for backend developer" and "why did you send this?".' });
    }
  });

  // ---------------------------------------------------------------- the scheduled run (Vercel cron or any scheduler calls this)
  // Sync due sources, expire old vacancies, audit "open" verdicts, then watch for relevant new vacancies for Pro members.

  add("GET", "/cron/jobs", async ({ env, req }) => {
    if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) throw new HttpError(401, "Not allowed");
    const sync = await syncDue(env);
    const audited = isSandbox(env) ? 0 : await auditSample(env, (u) => verifyJob(u, fetcher(env)));
    const t = sec();
    let alerts = 0, closedAlerts = 0;
    if (!isSandbox(env)) {   // sample vacancies must never trigger a real alert
      const profiles = await all(env.DB, "SELECT p.user_id, p.monitor, p.alert_min FROM job_profiles p WHERE p.paused_until < ?", t);
      for (const { user_id, monitor, alert_min } of profiles) {
        const user = await first(env.DB, "SELECT * FROM users WHERE id = ?", user_id);
        if (J(user.prefs, {}).features?.jobs === false) continue;
        const plan = await planOf(env, user);
        await refreshMatches(env, user, plan);
        // 1. Continuous monitoring (Pro): alert on highly relevant, confirmed-open, non-suspicious jobs, re-checked right before sending.
        if (plan.jobAlerts && monitor) {
          const cands = (await all(env.DB, base(env) + " AND mm.state = 'new' AND mm.alerted_at IS NULL AND j.scam_score < ? AND mm.score >= ? AND j.status != 'closed' ORDER BY mm.score DESC LIMIT 20", user.id, JOB_SCAM_HIDE, alert_min))
            .filter((r) => (J(r.detail, {}).confidence ?? 0) >= 0.5); // do not alert on a high score built from very little known
          const sent = [];
          for (const r of cands) {
            if (sent.length >= JOB_MAX_ALERTS_PER_RUN) break;
            if ((await verify(env, r, 3600)).status !== "open") continue;
            await run(env.DB, "UPDATE job_matches SET alerted_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ?", t, t, user.id, r.job_id);
            sent.push(r);
          }
          alerts += sent.length;
          if (sent.length && emailEnabled(env)) await sendEmail(env, user.email, `${sent.length} highly relevant job${sent.length > 1 ? "s" : ""} for you (checked open today)`,
            sent.map((r) => `${r.title}, ${r.company} (match ${r.score})\n${r.apply_url}\n${J(r.why, [])[0] || ""}`).join("\n\n") + "\n\nWe checked each page just before sending this. Cleone never applies for you.").catch(() => {});
        }
        // 2. "This just closed" for jobs the person was alerted on, saved, or applied to.
        const watch = await all(env.DB, base(env) + " AND mm.closed_alerted_at IS NULL AND (mm.alerted_at IS NOT NULL OR mm.state IN ('saved','applied'))", user.id);
        const gone = [];
        for (const r of watch) if ((await verify(env, r)).status === "closed") gone.push(r);
        for (const r of gone) await run(env.DB, "UPDATE job_matches SET closed_alerted_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ?", t, t, user.id, r.job_id);
        closedAlerts += gone.length;
        if (gone.length && plan.jobAlerts && emailEnabled(env)) await sendEmail(env, user.email, "A job we told you about has closed", gone.map((r) => `${r.title}, ${r.company} is no longer open. Do not spend time applying.`).join("\n")).catch(() => {});
      }
    }
    return json({ ok: true, synced: sync.results.map((r) => ({ id: r.id, ok: r.ok, jobs: r.jobs, added: r.added, removed: r.removed, error: r.error })), skipped: sync.skipped, expired: sync.expired, audited, alerts, closedAlerts });
  }, false);

  // ---------------------------------------------------------------- Source Intelligence (admins only)

  add("GET", "/admin/sources/dashboard", async ({ env, user }) => { await requireAdmin(env, user); return json({ ...(await dashboard(env)), adapters: catalog(), ai: { enabled: aiEnabled(env), cheap: env.JOB_CHEAP_MODEL || "claude-haiku-5-5", strong: env.JOB_STRONG_MODEL || "claude-sonnet-5-5" } }); });

  add("POST", "/admin/sources/diagnose", async ({ env, req, user }) => {
    await requireAdmin(env, user);
    const b = await readJson(req).catch(() => ({}));
    try { return json({ real: true, at: sec(), results: await diagnose(env, b.id ? [b.id] : null) }); } catch (e) { if (e.status === 409) throw new HttpError(409, e.message); throw e; }
  });

  add("POST", "/admin/sources/sync", async ({ env, req, user }) => {
    await requireAdmin(env, user); await ensureSources(env);
    const b = await readJson(req).catch(() => ({}));
    const out = await syncDue(env, { force: true, only: b.id ? [b.id] : null });
    return json({ results: out.results, expired: out.expired, skipped: out.skipped });
  });

  add("POST", "/admin/sources", async ({ env, req, user }) => {
    await requireAdmin(env, user); await ensureSources(env);
    const b = await readJson(req), a = ADAPTERS[b.adapter];
    if (!a || a.kind === "aggregator") throw new HttpError(400, "Choose a source type");
    const config = Object.fromEntries(a.fields.map((f) => [f.key, String(b.config?.[f.key] || "").trim().slice(0, 300)]).filter(([, v]) => v));
    const bad = validateSource(b.adapter, config); if (bad) throw new HttpError(400, bad);
    const id = sourceId(b.adapter, config);
    if (await first(env.DB, "SELECT 1 AS x FROM source_configs WHERE id = ?", id)) throw new HttpError(409, "That source is already added");
    await run(env.DB, "INSERT INTO source_configs (id, adapter, label, config, enabled, builtin, interval_min, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)", id, b.adapter, String(b.label || config.company || config.name || config.board || a.label).slice(0, 80), JSON.stringify(config), Math.max(15, Math.min(1440, +b.intervalMin || 360)), sec());
    return json({ ok: true, id });
  });

  add("POST", "/admin/sources/:id/toggle", async ({ env, req, params, user }) => {
    await requireAdmin(env, user); await ensureSources(env);
    const b = await readJson(req), row = await first(env.DB, "SELECT * FROM source_configs WHERE id = ?", params.id);
    if (!row) throw new HttpError(404, "Source not found");
    const a = ADAPTERS[row.adapter];
    if (b.enabled && a.disabled && a.validate(J(row.config, {}))) throw new HttpError(409, a.disabled); // partner boards stay off until access is approved
    await run(env.DB, "UPDATE source_configs SET enabled = ? WHERE id = ?", b.enabled ? 1 : 0, params.id);
    return json({ ok: true });
  });

  add("POST", "/admin/sources/:id/approve", async ({ env, req, params, user }) => {
    await requireAdmin(env, user); await ensureSources(env);
    const row = await first(env.DB, "SELECT * FROM source_configs WHERE id = ?", params.id), a = row && ADAPTERS[row.adapter];
    if (!a || a.kind !== "partner") throw new HttpError(404, "Not a partner source");
    const b = await readJson(req), config = { feedUrl: String(b.feedUrl || "").trim(), approvedAccess: String(b.approvedAccess || "").trim() };
    const bad = a.validate(config); if (bad) throw new HttpError(400, bad);
    await run(env.DB, "UPDATE source_configs SET config = ?, enabled = 1 WHERE id = ?", JSON.stringify(config), params.id);
    return json({ ok: true });
  });

  add("DELETE", "/admin/sources/:id", async ({ env, params, user }) => {
    await requireAdmin(env, user);
    const row = await first(env.DB, "SELECT builtin FROM source_configs WHERE id = ?", params.id);
    if (!row) throw new HttpError(404, "Source not found");
    if (row.builtin) throw new HttpError(400, "Built-in sources can be switched off but not deleted");
    await run(env.DB, "DELETE FROM source_configs WHERE id = ?", params.id);
    return json({ ok: true });
  });
}
