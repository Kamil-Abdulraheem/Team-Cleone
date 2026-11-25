// Job Radar routes. Registered from lib/app.js. The pure logic (sources, scam checks, matching) is in lib/jobs.js.
// Nothing here ever applies to a job for the person. The most it does is draft text and open the employer's own page.

import { JOB_CUTOFF, JOB_MAX_ALERTS_PER_RUN, JOB_RECHECK_AFTER, JOB_SCAM_HIDE, JOB_VERIFY_PER_SCAN } from "./config.js";
import { DAY, coverLetter, decryptCv, encryptCv, extractSkills, fetchAll, fingerprint, ghostCheck, interviewQuestions, marketView, matchJob, noiseReason, parseCommand, scamCheck, verifyJob } from "./jobs.js";

const STATES = ["new", "saved", "applied", "replied", "interview", "offer", "rejected", "dismissed"];
const TRACKED = ["applied", "replied", "interview", "offer", "rejected"];
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const sec = () => Math.floor(Date.now() / 1000);

export function registerJobs(add, c) {
  const { first, all, run, planOf, json, readJson, HttpError, monthKey, uuid, throttle, clientIp, sendEmail, emailEnabled } = c;

  // ---------------------------------------------------------------- shared pipeline

  /** Reads the public feeds and stores the jobs. A fresh read in the last 15 minutes is reused (it is shared by everyone). */
  async function ingest(env, { force = false } = {}) {
    const last = (await first(env.DB, "SELECT MAX(last_ok) AS t FROM source_health"))?.t || 0;
    if (!force && last > sec() - 900) return { skipped: true, health: {} };
    const { jobs, health } = await fetchAll(fetch);
    const t = sec();
    for (const [source, h] of Object.entries(health)) {
      await run(env.DB, `INSERT INTO source_health (source, last_ok, last_fail, fails_in_row, last_count, last_error) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET last_ok = COALESCE(?, source_health.last_ok), last_fail = COALESCE(?, source_health.last_fail),
          fails_in_row = CASE WHEN ? THEN 0 ELSE source_health.fails_in_row + 1 END, last_count = ?, last_error = ?`,
        source, h.ok ? t : null, h.ok ? null : t, h.ok ? 0 : 1, h.count, h.error || "", h.ok ? t : null, h.ok ? null : t, h.ok ? 1 : 0, h.count, h.error || "");
    }
    let added = 0, dropped = 0;
    for (const j of jobs.slice(0, 400)) {
      if (noiseReason(j)) { dropped++; continue; }
      const fp = fingerprint(j);
      const old = await first(env.DB, "SELECT * FROM jobs WHERE fp = ?", fp);
      const scam = scamCheck(j);
      if (!old) {
        await run(env.DB, `INSERT INTO jobs (id, fp, title, company, location, remote, salary_min, salary_max, currency, description, tags, posted_at, first_seen, last_seen, sources, apply_url, scam_score, scam_flags, ghost_flags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uuid(), fp, j.title, j.company, j.location, j.remote, j.salary_min, j.salary_max, j.currency, j.description, j.tags, j.posted_at, t, t,
          JSON.stringify([{ source: j.source, url: j.url }]), j.url, scam.score, JSON.stringify(scam.flags), JSON.stringify(ghostCheck(j, {})));
        added++;
        continue;
      }
      // Same job again: merge the board, notice reposts (the board shows it as new again), keep one row so the person is alerted once.
      const sources = J(old.sources, []);
      if (!sources.some((s) => s.source === j.source)) sources.push({ source: j.source, url: j.url });
      const repost = j.posted_at && old.posted_at && j.posted_at - old.posted_at > 7 * DAY ? 1 : 0;
      const reposts = old.reposts + repost;
      const status = old.status === "closed" ? "unverified" : old.status; // it came back: not trusted until checked again
      await run(env.DB, "UPDATE jobs SET last_seen = ?, sources = ?, reposts = ?, posted_at = COALESCE(?, posted_at), status = ?, scam_score = ?, scam_flags = ?, ghost_flags = ? WHERE id = ?",
        t, JSON.stringify(sources), reposts, repost ? j.posted_at : null, status, Math.max(old.scam_score, scam.score), JSON.stringify(scam.flags),
        JSON.stringify(ghostCheck({ ...j, posted_at: old.posted_at || j.posted_at }, { reposts, sources: sources.length })), old.id);
    }
    return { skipped: false, added, dropped, health };
  }

  /** Checks the apply page. A verdict newer than JOB_RECHECK_AFTER is reused (shared by all users), unless maxAge says otherwise. */
  async function verify(env, job, maxAge = JOB_RECHECK_AFTER) {
    if (job.verified_at && job.verified_at > sec() - maxAge && job.status !== "unverified") return job;
    const v = await verifyJob(job.apply_url);
    await run(env.DB, "UPDATE jobs SET status = ?, verified_at = ?, verify_note = ? WHERE id = ?", v.status, sec(), v.note, job.id);
    return { ...job, status: v.status, verified_at: sec(), verify_note: v.note };
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

  async function refreshMatches(env, user) {
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    if (!p) return 0;
    const L = await learned(env, user.id);
    const jobs = await all(env.DB, "SELECT * FROM jobs WHERE status != 'closed' AND last_seen > ? ORDER BY last_seen DESC LIMIT 1500", sec() - 45 * DAY);
    let n = 0;
    for (const j of jobs) {
      const m = matchJob(p, j);
      const co = j.company.toLowerCase();
      if (L.bad.has(co)) m.score -= 25; if (L.good.has(co)) m.score += 8;
      const wl = j.title.toLowerCase().split(/\W+/).filter((x) => L.badWords[x] >= 2).length; m.score -= Math.min(15, wl * 5);
      m.score = Math.max(0, Math.min(100, m.score));
      if (m.score < JOB_CUTOFF) continue;
      const t = sec();
      await run(env.DB, `INSERT INTO job_matches (id, user_id, job_id, score, why, gaps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, job_id) DO UPDATE SET score = excluded.score, why = excluded.why, gaps = excluded.gaps, updated_at = excluded.updated_at`,
        uuid(), user.id, j.id, m.score, JSON.stringify(m.why), JSON.stringify(m.gaps), t, t);
      n++;
    }
    return n;
  }

  const shape = (r) => ({
    id: r.job_id || r.id, title: r.title, company: r.company, location: r.location, remote: !!r.remote,
    salary: r.salary_min ? { min: r.salary_min, max: r.salary_max, currency: r.currency || "USD" } : null,
    score: r.score, status: r.status, verifyNote: r.verify_note, verifiedAt: r.verified_at, postedAt: r.posted_at,
    scamScore: r.scam_score, scamFlags: J(r.scam_flags, []), ghostFlags: J(r.ghost_flags, []),
    boards: J(r.sources, []).length, state: r.state, why: J(r.why, []), gaps: J(r.gaps, []),
  });

  const baseSelect = "SELECT mm.job_id, mm.score, mm.why, mm.gaps, mm.state, mm.note, mm.follow_up, mm.alerted_at, mm.closed_alerted_at, j.* FROM job_matches mm JOIN jobs j ON j.id = mm.job_id WHERE mm.user_id = ?";

  /** Which discoverable jobs this person may open. The Free plan sees the best few; the rest are only counted. Enforced here, on the server. */
  async function discoverable(env, user, plan) {
    const rows = await all(env.DB, baseSelect + " AND mm.state IN ('new','saved') AND j.status != 'closed' AND j.scam_score < ? ORDER BY CASE j.status WHEN 'open' THEN 0 ELSE 1 END, mm.score DESC LIMIT 200", user.id, JOB_SCAM_HIDE);
    return { rows, visible: new Set(rows.slice(0, plan.jobsVisible).map((r) => r.job_id)) };
  }

  const own = async (env, user, id) => {
    const r = await first(env.DB, baseSelect + " AND mm.job_id = ?", user.id, id);
    if (!r) throw new HttpError(404, "Job not found");
    return r;
  };
  const usable = async (env, user, id) => {
    const r = await own(env, user, id);
    const plan = await planOf(env, user);
    if (TRACKED.includes(r.state) || r.scam_score >= JOB_SCAM_HIDE || r.status === "closed") return { r, plan };
    const { visible } = await discoverable(env, user, plan);
    if (!visible.has(id)) throw new HttpError(403, "Upgrade to Pro to unlock this job.");
    return { r, plan };
  };

  // ---------------------------------------------------------------- profile

  add("GET", "/jobs/profile", async ({ env, user }) => {
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    return json({ profile: p ? { roles: p.roles, skills: p.skills, years: p.years, location: p.location, remoteOnly: !!p.remote_only, minSalary: p.min_salary, pausedUntil: p.paused_until, hasCv: !!p.cv_enc } : null, encryption: !!env.CV_ENCRYPTION_KEY });
  });

  add("PUT", "/jobs/profile", async ({ env, req, user }) => {
    const b = await readJson(req);
    const cv = String(b.cv || "").slice(0, 15000);
    const old = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    const extracted = cv ? extractSkills(cv) : [];
    const skills = typeof b.skills === "string" ? b.skills : [...new Set([...(old?.skills ? old.skills.split(",") : []), ...extracted])].join(",");
    const row = {
      roles: String(b.roles ?? old?.roles ?? "").slice(0, 300), skills: skills.slice(0, 600), years: Math.max(0, Math.min(50, +b.years || old?.years || 0)),
      location: String(b.location ?? old?.location ?? "").slice(0, 100), remote: b.remoteOnly === undefined ? old?.remote_only || 0 : b.remoteOnly ? 1 : 0, minSalary: Math.max(0, +b.minSalary || 0),
    };
    if (!row.roles.trim() && !row.skills.trim()) throw new HttpError(400, "Add at least one role you want or paste your CV so we can find your skills.");
    const enc = cv ? await encryptCv(env, cv) : old?.cv_enc || null; // with no encryption key the CV text is simply not stored
    await run(env.DB, `INSERT INTO job_profiles (user_id, roles, skills, years, location, remote_only, min_salary, cv_enc, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET roles = excluded.roles, skills = excluded.skills, years = excluded.years, location = excluded.location, remote_only = excluded.remote_only, min_salary = excluded.min_salary, cv_enc = excluded.cv_enc, updated_at = excluded.updated_at`,
      user.id, row.roles, row.skills, row.years, row.location, row.remote, row.minSalary, enc, sec());
    const matches = await refreshMatches(env, user);
    return json({ ok: true, skills: row.skills.split(",").filter(Boolean), cvStored: !!enc, cvNote: cv && !enc ? "Your CV text was read to find skills but not stored, because encryption is not switched on for this server." : null, matches });
  });

  add("DELETE", "/jobs/profile", async ({ env, user }) => {
    await run(env.DB, "DELETE FROM job_matches WHERE user_id = ?", user.id);
    await run(env.DB, "DELETE FROM job_profiles WHERE user_id = ?", user.id);
    return json({ ok: true });
  });

  // ---------------------------------------------------------------- scan

  add("POST", "/jobs/scan", async ({ env, req, user }) => {
    const plan = await planOf(env, user);
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    if (!p) throw new HttpError(400, "Tell us what you are looking for first (roles or your CV).");
    await throttle(env, `jobscan:${user.id}`, 6, 3600);
    const used = (await first(env.DB, "SELECT job_scans FROM usage WHERE user_id = ? AND month = ?", user.id, monthKey()))?.job_scans ?? 0;
    if (used >= plan.jobScansPerMonth) throw new HttpError(402, plan.name === "free" ? `The Free plan includes ${plan.jobScansPerMonth} job scans a month. Upgrade to Pro for more.` : "You reached this month's job scan limit.");
    const ing = await ingest(env);
    const matched = await refreshMatches(env, user);
    // Check the apply pages of the best matches (shared verdicts keep this cheap).
    const top = await all(env.DB, baseSelect + " AND mm.state IN ('new','saved') AND j.status != 'closed' AND j.scam_score < ? ORDER BY mm.score DESC LIMIT ?", user.id, JOB_SCAM_HIDE, JOB_VERIFY_PER_SCAN);
    let checked = 0;
    for (const r of top) { const before = r.verified_at; const j = await verify(env, r); if (j.verified_at !== before) checked++; }
    await run(env.DB, "INSERT INTO usage (user_id, month, scans, job_scans) VALUES (?, ?, 0, 1) ON CONFLICT(user_id, month) DO UPDATE SET job_scans = usage.job_scans + 1", user.id, monthKey());
    const health = await all(env.DB, "SELECT source, last_ok, last_fail, fails_in_row, last_count, last_error FROM source_health");
    return json({ matched, checked, added: ing.added ?? 0, reused: !!ing.skipped, sources: health.map((h) => ({ source: h.source, ok: h.fails_in_row === 0, count: h.last_count, error: h.fails_in_row ? h.last_error : "" })) });
  });

  // ---------------------------------------------------------------- results

  add("GET", "/jobs", async ({ env, user }) => {
    const plan = await planOf(env, user);
    const p = await first(env.DB, "SELECT paused_until FROM job_profiles WHERE user_id = ?", user.id);
    const { rows, visible } = await discoverable(env, user, plan);
    const items = rows.filter((r) => visible.has(r.job_id)).map(shape);
    const locked = rows.length - items.length;
    const sus = (await all(env.DB, baseSelect + " AND mm.state IN ('new','saved') AND j.scam_score >= ? ORDER BY mm.score DESC LIMIT 20", user.id, JOB_SCAM_HIDE)).map(shape);
    const tracker = (await all(env.DB, baseSelect + " AND mm.state IN ('applied','replied','interview','offer','rejected') ORDER BY mm.updated_at DESC LIMIT 100", user.id)).map((r) => ({ ...shape(r), note: r.note, followUp: r.follow_up }));
    const closed = (await all(env.DB, baseSelect + " AND j.status = 'closed' AND (mm.state = 'saved' OR mm.alerted_at IS NOT NULL) AND mm.state NOT IN ('applied','replied','interview','offer','rejected') ORDER BY j.verified_at DESC LIMIT 20", user.id)).map(shape);
    return json({ plan: plan.name, cutoff: JOB_CUTOFF, pausedUntil: p?.paused_until || 0, open: items.filter((x) => x.status === "open"), unverified: items.filter((x) => x.status !== "open"), locked, suspicious: sus, tracker, closed });
  });

  add("GET", "/jobs/alerts", async ({ env, user }) => {
    const rows = await all(env.DB, baseSelect + " AND (mm.alerted_at IS NOT NULL OR mm.closed_alerted_at IS NOT NULL OR (mm.follow_up IS NOT NULL AND mm.follow_up <= ? AND mm.state = 'applied')) ORDER BY mm.updated_at DESC LIMIT 50", user.id, sec());
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
    const rows = await all(env.DB, "SELECT title, company, status, salary_min, salary_max, posted_at FROM jobs WHERE last_seen > ?", sec() - 45 * DAY);
    const mine = role ? rows.filter((r) => role.split(/\s+/).every((w) => r.title.toLowerCase().includes(w))) : rows;
    return json({ role: role || null, ...marketView(mine), note: "Based on postings our sources listed in the last 45 days. Salaries are only included where the posting states them." });
  });

  add("GET", "/jobs/:id", async ({ env, params, user }) => {
    const { r, plan } = await usable(env, user, params.id);
    const full = await first(env.DB, "SELECT * FROM jobs WHERE id = ?", r.job_id);
    const sameCo = (await first(env.DB, "SELECT COUNT(*) AS n FROM jobs WHERE company = ? AND last_seen > ?", r.company, sec() - 45 * DAY))?.n ?? 0;
    const age = r.posted_at ? Math.floor((sec() - r.posted_at) / DAY) : null;
    return json({ ...shape(r), description: full.description, applyUrl: full.apply_url, boardLinks: J(full.sources, []), note: r.note, followUp: r.follow_up,
      companyOpenRoles: sameCo, ageDays: age, likelyToCloseSoon: age !== null && age > 21 && r.status === "open" ? "Posted over 3 weeks ago; roles like this are often filled around now. Apply early." : null,
      canDraft: plan.name === "pro" || plan.jobsVisible > 0 });
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
    if (b.kind === "was_closed") await run(env.DB, "UPDATE jobs SET status = ?, verify_note = ?, verified_at = ? WHERE id = ?", n >= 2 ? "closed" : "unverified", n >= 2 ? "reported closed by several people" : "someone reported this as closed; being re-checked", sec(), params.id);
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
    const { r } = await usable(env, user, params.id);
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    const d = coverLetter(p, r, user.name);
    return json({ ...d, applyUrl: r.apply_url, submitted: false, warning: r.status === "open" ? null : "We could not confirm this job is still open. Check the employer's page before you apply." });
  });

  add("POST", "/jobs/:id/prep", async ({ env, params, user }) => {
    const { r } = await usable(env, user, params.id);
    return json({ questions: interviewQuestions(r) });
  });

  // ---------------------------------------------------------------- plain-language commands

  add("POST", "/jobs/command", async ({ env, req, user }) => {
    const b = await readJson(req);
    const cmd = parseCommand(b.text);
    const p = await first(env.DB, "SELECT * FROM job_profiles WHERE user_id = ?", user.id);
    if (!p && cmd.action !== "unknown") throw new HttpError(400, "Set up your job profile first.");
    const upd = (sql, ...a) => run(env.DB, sql + " WHERE user_id = ?", ...a, user.id);
    switch (cmd.action) {
      case "pause": await upd("UPDATE job_profiles SET paused_until = ?", cmd.until); return json({ reply: `Paused until ${cmd.label}. I will not send alerts until then.`, pausedUntil: cmd.until });
      case "resume": await upd("UPDATE job_profiles SET paused_until = 0"); return json({ reply: "Alerts are back on." });
      case "remote": await upd("UPDATE job_profiles SET remote_only = ?", cmd.value); await refreshMatches(env, user); return json({ reply: cmd.value ? "Only remote jobs from now on." : "Showing remote and on-site jobs." });
      case "salary": await upd("UPDATE job_profiles SET min_salary = ?", cmd.value); return json({ reply: `Minimum pay set to $${cmd.value.toLocaleString("en-US")} a year. Jobs that state a lower maximum will rank lower.` });
      case "roles": await upd("UPDATE job_profiles SET roles = ?", cmd.value.slice(0, 300)); await refreshMatches(env, user); return json({ reply: `Now looking for: ${cmd.value}.` });
      case "why": {
        const r = b.jobId ? await own(env, user, b.jobId)
          : await first(env.DB, baseSelect + " AND mm.alerted_at IS NOT NULL ORDER BY mm.alerted_at DESC LIMIT 1", user.id);
        if (!r) return json({ reply: "I have not sent you any alerts yet." });
        const why = J(r.why, []), gaps = J(r.gaps, []);
        return json({ reply: `${r.title} at ${r.company} scored ${r.score}. ${why.join(". ")}${why.length ? "." : ""}${gaps.length ? " Gaps: " + gaps.join("; ") + "." : ""}`, jobId: r.job_id });
      }
      default: return json({ reply: 'I understand things like: "pause until Monday", "pause for 2 weeks", "resume", "only remote now", "minimum salary 60k", "looking for backend developer" and "why did you send this?".' });
    }
  });

  // ---------------------------------------------------------------- the scheduled run (Vercel cron calls this; so can any scheduler)

  add("GET", "/cron/jobs", async ({ env, req }) => {
    if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) throw new HttpError(401, "Not allowed");
    const ing = await ingest(env, { force: true });
    const t = sec();
    let alerts = 0, closedAlerts = 0;
    const profiles = await all(env.DB, "SELECT p.user_id FROM job_profiles p JOIN users u ON u.id = p.user_id WHERE p.paused_until < ?", t);
    for (const { user_id } of profiles) {
      const user = await first(env.DB, "SELECT * FROM users WHERE id = ?", user_id);
      if (!J(user.prefs, {}).features?.jobs) continue;
      const plan = await planOf(env, user);
      await refreshMatches(env, user);
      // 1. New jobs: alert only on confirmed-open ones, checked again right now, never suspicious ones. Pro only.
      if (plan.jobAlerts) {
        const cands = await all(env.DB, baseSelect + " AND mm.state = 'new' AND mm.alerted_at IS NULL AND j.scam_score < ? AND mm.score >= ? AND j.status != 'closed' ORDER BY mm.score DESC LIMIT 20", user.id, JOB_SCAM_HIDE, JOB_CUTOFF + 20);
        const sent = [];
        for (const r of cands) {
          if (sent.length >= JOB_MAX_ALERTS_PER_RUN) break;
          const j = await verify(env, r, 3600); // re-check just before sending
          if (j.status !== "open") continue;
          await run(env.DB, "UPDATE job_matches SET alerted_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ?", t, t, user.id, r.job_id);
          sent.push(r);
        }
        alerts += sent.length;
        if (sent.length && emailEnabled(env)) await sendEmail(env, user.email, `${sent.length} new job${sent.length > 1 ? "s" : ""} for you (checked open today)`,
          sent.map((r) => `${r.title}, ${r.company} (match ${r.score})\n${r.apply_url}\n${J(r.why, [])[0] || ""}`).join("\n\n") + "\n\nWe checked each page just before sending this. Cleone never applies for you.").catch(() => {});
      }
      // 2. "This just closed": for jobs the person alerted on, saved, or applied to.
      const watch = await all(env.DB, baseSelect + " AND mm.closed_alerted_at IS NULL AND (mm.alerted_at IS NOT NULL OR mm.state IN ('saved','applied'))", user.id);
      const gone = [];
      for (const r of watch) { const j = await verify(env, r); if (j.status === "closed") gone.push(r); }
      for (const r of gone) await run(env.DB, "UPDATE job_matches SET closed_alerted_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ?", t, t, user.id, r.job_id);
      closedAlerts += gone.length;
      if (gone.length && plan.jobAlerts && emailEnabled(env)) await sendEmail(env, user.email, "A job we told you about has closed", gone.map((r) => `${r.title}, ${r.company} is no longer open. Do not spend time applying.`).join("\n")).catch(() => {});
    }
    return json({ ok: true, ingested: ing.added ?? 0, alerts, closedAlerts, sources: ing.health });
  }, false);

  // ---------------------------------------------------------------- quality and source health (admins only)

  add("GET", "/jobs/health/metrics", async ({ env, user }) => {
    const plan = await planOf(env, user);
    if (!plan.admin) throw new HttpError(403, "Admins only");
    const sources = await all(env.DB, "SELECT * FROM source_health ORDER BY source");
    const verdicts = await all(env.DB, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
    const alerted = (await first(env.DB, "SELECT COUNT(*) AS n FROM job_matches WHERE alerted_at IS NOT NULL"))?.n ?? 0;
    const falseAlerts = (await first(env.DB, "SELECT COUNT(DISTINCT user_id || job_id) AS n FROM job_reports WHERE kind = 'was_closed' AND job_id IN (SELECT job_id FROM job_matches WHERE alerted_at IS NOT NULL)"))?.n ?? 0;
    const funnel = await all(env.DB, "SELECT state, COUNT(*) AS n FROM job_matches GROUP BY state");
    const f = Object.fromEntries(funnel.map((x) => [x.state, x.n]));
    const applied = (f.applied || 0) + (f.replied || 0) + (f.interview || 0) + (f.offer || 0) + (f.rejected || 0);
    return json({
      sources: sources.map((s) => ({ ...s, healthy: s.fails_in_row === 0 })), verdicts: Object.fromEntries(verdicts.map((v) => [v.status, v.n])),
      alertsSent: alerted, falseAlertRate: alerted ? +(falseAlerts / alerted).toFixed(3) : null, falseAlertSample: alerted,
      funnel: { alerted, applied, interview: (f.interview || 0) + (f.offer || 0) }, note: "Rates are only meaningful once the sample is large. 'was closed' counts come from user reports.",
    });
  });
}
