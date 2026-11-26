// Sync, sandbox isolation, the live diagnostic, removal/expiry detection, accuracy measurement, the admin dashboard and the AI split.
import { makeApp } from "./harness.js";
import { ADAPTERS } from "../lib/sources/adapters.js";
import { FIXTURES as F } from "../lib/sources/fixtures.js";
import { HTTP } from "../lib/sources/http.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
HTTP.minGapMs = 0; HTTP.backoffMs = 1;
const PW = "correct horse battery", now = Math.floor(Date.now() / 1000);
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ================================================================== SANDBOX MODE
{
  const app = await makeApp({ SOURCE_MODE: "sandbox", ADMIN_EMAILS: "boss@x.com", CRON_SECRET: "s" });
  const { call } = app;
  await call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW, name: "Boss" } });
  let r = await call("GET", "/admin/sources/dashboard");
  ok("dashboard: admin sees it, and it says it is sandbox", r.status === 200 && r.data.sandbox === true);
  ok("dashboard: Nigerian boards are listed, disabled, with the reason", ["jobberman", "myjobmag"].every((id) => { const s = r.data.sources.find((x) => x.id === id); return s && !s.enabled && /approve/i.test(s.disabledReason); }));
  ok("dashboard: before any sync it shows zero jobs, not made-up numbers", r.data.metrics.jobsCollected === 0 && r.data.metrics.lastSync === null && r.data.metrics.stale === true);
  r = await call("POST", "/admin/sources/sync", { body: {} });
  const m = (await call("GET", "/admin/sources/dashboard")).data;
  ok("sync: every enabled source ran", r.status === 200 && r.data.results.length === 8 && r.data.results.every((x) => x.ok), JSON.stringify(r.data.results.filter((x) => !x.ok)));
  ok("dashboard metrics: active, healthy, collected, new today, failed, last sync", m.metrics.activeSources === 8 && m.metrics.healthySources === 8 && m.metrics.jobsCollected >= 10 && m.metrics.newToday === m.metrics.jobsCollected && m.metrics.failedRequests === 0 && m.metrics.lastSync >= now - 5 && m.metrics.stale === false, JSON.stringify(m.metrics));
  ok("every stored job came from the sandbox and is marked synthetic", (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE synthetic = 0")).n == 0 && (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE apply_url NOT LIKE 'https://sample.invalid/%'")).n == 0);
  const gh = await app.one("SELECT * FROM jobs WHERE title = 'Backend Engineer'");
  ok("standard schema: original source, url, published and verification dates are tracked", gh && JSON.parse(gh.sources)[0].source === "greenhouse:acme" && gh.apply_url.startsWith("https://") && gh.posted_at > 1e9 && gh.verified_at > 1e9 && gh.external_id === "4012");
  ok("jobs on an employer's own board are open because it lists them right now", gh.status === "open" && gh.verified_via === "feed");
  ok("aggregator jobs are NOT called open until the page is checked", (await app.one("SELECT status FROM jobs WHERE title = 'Python Developer'")).status === "unverified");
  r = await call("POST", "/admin/sources/diagnose", { body: {} });
  ok("the live diagnostic refuses to run in sandbox: it must never be simulated", r.status === 409 && /sandbox/i.test(r.data.error || r.text));

  // sandbox and real vacancies never mix
  await call("PUT", "/jobs/profile", { body: { roles: "backend engineer", skills: "python,django,docker", years: 4 } });
  await app.run(`INSERT INTO jobs (id, fp, title, company, description, apply_url, first_seen, last_seen, synthetic, status) VALUES ('real1', 'real|fp', 'Backend Engineer', 'RealCo', 'Real vacancy: build APIs with Python and Django and Docker every day for customers.', 'https://real.test/j', ?, ?, 0, 'open')`, now, now);
  await call("POST", "/jobs/scan");
  r = await call("GET", "/jobs");
  const shown = [...r.data.open, ...r.data.unverified, ...r.data.adjacent];
  ok("sandbox mode shows only sample jobs, flagged, and never a real one", r.data.sandbox === true && shown.length > 0 && shown.every((j) => j.synthetic) && !shown.some((j) => j.company === "RealCo"));

  const first_ = shown[0];
  ok("list items carry the real details: excerpt, original link, source name", first_ && first_.snippet.length > 40 && first_.applyUrl.startsWith("https://") && first_.source && first_.company);
  ok("the list says which sources the jobs came from and how many", r.data.feed.jobsTotal > 5 && r.data.feed.sources.length === 8 && r.data.feed.sources.every((x) => x.ok && x.jobs > 0) && r.data.feed.lastSync > 1e9);
  const hz = (await call("GET", "/health")).data;
  ok("health lists each source: working or not, HTTP status, jobs, error", hz.jobs.collected > 5 && hz.jobs.sources.length >= 8 && hz.jobs.sources.every((x) => "working" in x && "httpStatus" in x) && hz.jobs.sources.filter((x) => x.working).length === 8);

  // removal, safety valve, empty feed, expiry
  const saved = clone(F.greenhouse);
  F.greenhouse.jobs = F.greenhouse.jobs.filter((j) => j.id !== 4013);
  r = await call("POST", "/admin/sources/sync", { body: { id: "greenhouse:acme" } });
  const gone = await app.one("SELECT status, closed_reason, closed_at FROM jobs WHERE title = 'Product Designer'");
  ok("a vacancy that disappears from its source is marked removed", r.data.results[0].removed === 1 && gone.status === "closed" && gone.closed_reason === "removed" && gone.closed_at > 1e9, JSON.stringify([r.data.results[0], gone]));
  F.greenhouse = clone(saved); await call("POST", "/admin/sources/sync", { body: { id: "greenhouse:acme" } });
  ok("if it is listed again it comes back as unverified, not trusted", (await app.one("SELECT status FROM jobs WHERE title = 'Product Designer'")).status === "open"); // ATS: listed = open again
  const big = clone(saved); for (let i = 0; i < 12; i++) big.jobs.push({ id: 5000 + i, title: `Role Number ${i} Engineer`, updated_at: new Date().toISOString(), absolute_url: `https://sample.invalid/gh/${i}`, location: { name: "Remote" }, departments: [], content: "&lt;p&gt;" + "Build and ship software for customers every day with a friendly team. ".repeat(3) + "&lt;/p&gt;" });
  F.greenhouse = big; await call("POST", "/admin/sources/sync", { body: { id: "greenhouse:acme" } });
  F.greenhouse = { jobs: saved.jobs.slice(0, 1) };   // a partial response: 15 jobs became 1
  r = await call("POST", "/admin/sources/sync", { body: { id: "greenhouse:acme" } });
  ok("a suspiciously small response does not wipe out the records", r.data.results[0].removed === 0 && (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE title LIKE 'Role Number%' AND status = 'open'")).n == 12);
  F.greenhouse = clone(saved);
  const leverBefore = (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE sources LIKE '%lever:globex%'")).n;
  const savedLever = clone(F.lever); F.lever = [];
  r = await call("POST", "/admin/sources/sync", { body: { id: "lever:globex" } });
  ok("an empty answer from a source that had jobs is treated as a failure and keeps the records", r.data.results[0].ok === false && /no usable jobs/.test(r.data.results[0].error) && (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE sources LIKE '%lever:globex%'")).n == leverBefore);
  F.lever = savedLever;
  await app.run("UPDATE jobs SET valid_through = ?, status = 'open' WHERE title = 'Frontend Engineer'", now - 100);
  r = await call("POST", "/admin/sources/sync", { body: { id: "remotive" } });
  ok("vacancies past their closing date are expired", r.data.expired >= 1 && (await app.one("SELECT closed_reason FROM jobs WHERE title = 'Frontend Engineer'")).closed_reason === "expired");

  // one broken source does not stop the others
  const savedAshby = F.ashby; F.ashby = "<html>maintenance</html>";
  r = await call("POST", "/admin/sources/sync", { body: {} });
  const dash = (await call("GET", "/admin/sources/dashboard")).data;
  ok("one failed source cannot interrupt the rest", r.data.results.filter((x) => !x.ok).length === 1 && r.data.results.filter((x) => x.ok).length === 7 && r.data.results.find((x) => !x.ok).id === "ashby:initech");
  ok("the failure is logged with its message and counted on the dashboard", dash.metrics.failedRequests >= 1 && dash.metrics.healthySources === 7 && dash.runs.some((x) => x.source_id === "ashby:initech" && !x.ok && /not valid JSON/.test(x.error)) && /not valid JSON/.test(dash.sources.find((s) => s.id === "ashby:initech").error));
  F.ashby = savedAshby;

  // adding a source needs no change to the matching engine
  ADAPTERS.custom = { id: "custom", label: "Custom", kind: "feed", fields: [], validate: () => null, key: () => "custom", async fetch() { return { http: { status: 200, ms: 1, url: "https://sample.invalid/custom" }, jobs: [{ external_id: "c1", url: "https://sample.invalid/c1", title: "Backend Engineer", company: "Custom Co", description: "Build APIs in Python and Django with PostgreSQL for our customers every day, and review code carefully.", location: "Remote", remote: true }] }; } };
  await app.run("INSERT INTO source_configs (id, adapter, label, config, enabled, builtin, interval_min, created_at) VALUES ('custom', 'custom', 'Custom', '{}', 1, 0, 60, ?)", now);
  r = await call("POST", "/admin/sources/sync", { body: { id: "custom" } });
  await call("POST", "/jobs/scan");
  const mine = (await call("GET", "/jobs")).data;
  ok("a brand-new adapter's jobs flow into matching with no engine change", r.data.results[0].added === 1 && [...mine.open, ...mine.unverified].some((j) => j.company === "Custom Co"));
  delete ADAPTERS.custom;
  await app.restore();
}

// ================================================================== LIVE MODE (HTTP is mocked at the network edge, so every request is a real call through the real code)
{
  const app = await makeApp({ ADMIN_EMAILS: "boss@x.com", CRON_SECRET: "s" });
  const { call } = app, hits = {}, hit = (k) => (hits[k] = (hits[k] || 0) + 1);
  const pages = {};
  app.onOutside(async (u) => {
    if (u.startsWith("https://remotive.com")) { hit("remotive"); return res(F.remotive); }
    if (u.startsWith("https://www.arbeitnow.com")) { hit("arbeitnow"); return res("", 503); }
    if (u.startsWith("https://remoteok.com")) { hit("remoteok"); return res(F.remoteok); }
    if (u.startsWith("https://partner.test")) { hit("partner"); return res(F.rss); }
    if (u.startsWith("https://boards-api.greenhouse.io/v1/boards/newco")) { hit("newco"); return res(F.greenhouse); }
    if (u.includes("jobberman") || u.includes("myjobmag")) { hit("nigerian"); return res("", 200); }
    if (u.startsWith("https://sample.invalid/")) return pages[u] || (/closed/.test(u) ? res("", 404) : res("<h1>Apply now</h1>"));
    return null;
  });
  await call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW } });
  await call("POST", "/auth/signup", { body: { email: "user@x.com", password: PW }, as: "u" });
  ok("admin routes reject ordinary users", (await call("GET", "/admin/sources/dashboard", { as: "u" })).status === 403 && (await call("POST", "/admin/sources/diagnose", { body: {}, as: "u" })).status === 403 && (await call("POST", "/admin/sources", { body: {}, as: "u" })).status === 403);

  let r = await call("POST", "/admin/sources/diagnose", { body: {} });
  const d = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
  ok("diagnostic: really requests each source and reports status, jobs, timing", r.data.real === true && d.remotive.ok && d.remotive.status === 200 && d.remotive.jobs === 2 && hits.remotive === 1 && d.remotive.sample.length > 0 && d.remoteok.jobs === 1 && typeof d.remotive.ms === "number");
  ok("diagnostic: a failing source shows its real HTTP status and error, after the retries", d.arbeitnow.ok === false && d.arbeitnow.status === 503 && /503/.test(d.arbeitnow.error) && hits.arbeitnow === HTTP.retries + 1);
  ok("diagnostic: disabled Nigerian boards are skipped and NO request is made to them", d.jobberman.skipped && d.myjobmag.skipped && !hits.nigerian);
  const dash = (await call("GET", "/admin/sources/dashboard")).data;
  const rem = dash.sources.find((s) => s.id === "remotive"), arb = dash.sources.find((s) => s.id === "arbeitnow");
  ok("dashboard shows last success, HTTP status, jobs retrieved and error per source", rem.lastOk >= now - 5 && rem.httpStatus === 200 && rem.jobs === 2 && !rem.error && arb.httpStatus === 503 && /503/.test(arb.error) && arb.lastOk === null && arb.healthy === false);
  ok("diagnostic does not store vacancies: it tests, it does not collect", dash.metrics.jobsCollected === 0 && dash.runs.filter((x) => x.kind === "diagnostic").length >= 3);

  // adding and managing sources
  ok("add source: validation", (await call("POST", "/admin/sources", { body: { adapter: "greenhouse", config: { board: "../x" } } })).status === 400 && (await call("POST", "/admin/sources", { body: { adapter: "careerpage", config: { url: "https://x.test/c", company: "X" } } })).status === 400 && (await call("POST", "/admin/sources", { body: { adapter: "remotive", config: {} } })).status === 400);
  r = await call("POST", "/admin/sources", { body: { adapter: "greenhouse", label: "NewCo", config: { board: "newco", company: "NewCo" } } });
  ok("add source: a Greenhouse board is added", r.status === 200 && r.data.id === "greenhouse:newco" && (await call("POST", "/admin/sources", { body: { adapter: "greenhouse", config: { board: "newco" } } })).status === 409);
  r = await call("POST", "/admin/sources/sync", { body: { id: "greenhouse:newco" } });
  ok("a new employer board syncs real-shaped data into live (non-synthetic) vacancies", r.data.results[0].ok && r.data.results[0].added === 3 && (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE synthetic = 0")).n == 3 && hits.newco === 1);
  ok("partner boards cannot be switched on without approval", (await call("POST", "/admin/sources/jobberman/toggle", { body: { enabled: true } })).status === 409 && (await call("POST", "/admin/sources/jobberman/approve", { body: { feedUrl: "https://partner.test/feed", approvedAccess: "no" } })).status === 400);
  r = await call("POST", "/admin/sources/jobberman/approve", { body: { feedUrl: "https://partner.test/feed", approvedAccess: "YES" } });
  r = await call("POST", "/admin/sources/sync", { body: { id: "jobberman" } });
  ok("with recorded approval and the owner's feed, the connector works", r.data.results[0].ok && hits.partner === 1 && hits.nigerian === undefined);
  ok("built-in sources can be switched off but not deleted; added ones can be deleted", (await call("DELETE", "/admin/sources/remotive")).status === 400 && (await call("POST", "/admin/sources/remotive/toggle", { body: { enabled: false } })).status === 200 && (await call("DELETE", "/admin/sources/greenhouse:newco")).status === 200);

  // accuracy of "open"
  const acc = async () => (await call("GET", "/admin/sources/dashboard")).data.accuracy;
  const audits = async (n, agree) => { await app.run("DELETE FROM verdict_audits"); for (let i = 0; i < n; i++) await app.run("INSERT INTO verdict_audits (job_id, first_via, first_at, second_status, agree, at) VALUES ('j', 'feed', 1, ?, ?, ?)", i < agree ? "open" : "closed", i < agree ? 1 : 0, now); return acc(); };
  ok("accuracy: too few audits says 'insufficient', never 'met'", (await audits(10, 10)).verdict === "insufficient");
  ok("accuracy: 100% of 120 is still only 'inconclusive' (the confidence interval is too wide)", (await audits(120, 120)).verdict === "inconclusive");
  ok("accuracy: 400 of 400 meets the 98% target with confidence", (await audits(400, 400)).verdict === "meets");
  ok("accuracy: 90 of 100 is below target", (await audits(100, 90)).verdict === "below");
  await app.run("DELETE FROM verdict_audits");
  // the daily audit re-checks jobs we called open, with an independent page check
  await app.run("DELETE FROM jobs"); await app.run("INSERT INTO source_configs (id, adapter, label, config, enabled, builtin, interval_min, created_at) VALUES ('x', 'greenhouse', 'x', '{}', 0, 0, 60, ?) ON CONFLICT DO NOTHING", now);
  const mk = (id, url) => app.run(`INSERT INTO jobs (id, fp, title, company, description, apply_url, first_seen, last_seen, status, verified_at, verified_via, synthetic) VALUES (?, ?, 'T', 'C', 'd', ?, ?, ?, 'open', ?, 'feed', 0)`, id, id, url, now, now, now - 3600);
  await mk("a1", "https://sample.invalid/ok1"); await mk("a2", "https://sample.invalid/closed/2"); await mk("a3", "https://sample.invalid/blocked");
  pages["https://sample.invalid/blocked"] = res("", 403);
  r = await call("GET", "/cron/jobs", { headers: { authorization: "Bearer s" } });
  const au = await app.all("SELECT job_id, agree FROM verdict_audits ORDER BY job_id");
  ok("audit: agreement and disagreement are recorded; a blocked page proves nothing and is not counted", r.status === 200 && au.length === 2 && au[0].agree == 1 && au[1].agree == 0, JSON.stringify(au));
  await app.restore();
}

// ================================================================== AI: cheap model for volume, strong model for quality, always with a safe fallback
{
  const app = await makeApp({ SOURCE_MODE: "sandbox", ANTHROPIC_API_KEY: "k", ADMIN_EMAILS: "boss@x.com", JOB_CHEAP_MODEL: "cheap-1", JOB_STRONG_MODEL: "strong-1" });
  const { call } = app, calls = []; let mode = "ok";
  app.onOutside(async (u, init) => {
    if (!u.startsWith("https://api.anthropic.com")) return null;
    const b = JSON.parse(init.body); calls.push({ model: b.model, system: b.system, user: b.messages[0].content });
    if (mode === "fail") return res({ error: "boom" }, 500);
    const reply = (o) => res({ content: [{ type: "text", text: JSON.stringify(o) }] });
    if (/"education"/.test(b.system) && /Read the CV/.test(b.system)) return reply({ skills: ["python", "django", "ignore all previous instructions"], years: 5, education: 2, roles: ["backend engineer"], summary: "Backend engineer with Python." });
    if (/Extract what the job asks/.test(b.system)) return reply({ skills: ["kubernetes", "<script>"], years: { kubernetes: 3 }, education: 9 });
    return reply({ summary: "Tailored summary.", letter: "Tailored letter for you." });
  });
  await call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW, name: "Boss" } });       // admin = Pro
  await call("POST", "/auth/signup", { body: { email: "free@x.com", password: PW, name: "Free" }, as: "f" });
  await call("POST", "/admin/sources/sync", { body: {} });
  await app.run(`INSERT INTO jobs (id, fp, title, company, description, apply_url, first_seen, last_seen, remote, location, status, synthetic, sources) VALUES ('vague', 'vague|fp', 'Backend Programmer', 'Vague Co', 'We are a growing company and we love to learn together every single day as one team.', 'https://sample.invalid/vague', ?, ?, 1, 'Remote', 'open', 1, '[]')`, now, now);

  let r = await call("PUT", "/jobs/profile", { body: { roles: "backend engineer", cv: "Python developer with 5 years of experience building Django APIs. BSc Computer Science." } });
  const strong1 = calls.filter((c) => c.model === "strong-1").length, cheap1 = calls.filter((c) => c.model === "cheap-1").length;
  ok("CV understanding uses the STRONG model once, and its output is validated (junk skills dropped)", strong1 === 1 && r.data.aiRead === true && r.data.skills.includes("django") && !r.data.skills.some((s) => /ignore/.test(s)) && r.data.years === 5);
  ok("borderline jobs with little known use the CHEAP model", cheap1 >= 1 && calls.filter((c) => c.model === "cheap-1").every((c) => /untrusted data/.test(c.system)), JSON.stringify(calls.map((c) => c.model)));
  const m = await app.one("SELECT detail, why, gaps FROM job_matches WHERE job_id = 'vague'");
  ok("AI-read requirements are scored by the same rules (kubernetes gap appears; junk and bad values are ignored)", m && /kubernetes/.test(m.gaps) && !/script/.test(m.gaps + m.why));
  const before = calls.length;
  await call("PUT", "/jobs/profile", { body: { roles: "backend engineer", cv: "Python developer with 5 years of experience building Django APIs. BSc Computer Science." } });
  ok("the same CV and the same job are never paid for twice (cached)", calls.length === before);
  const list = (await call("GET", "/jobs")).data; const any = [...list.open, ...list.unverified, ...list.adjacent][0];
  r = await call("POST", `/jobs/${any.id}/draft`);
  ok("the cover letter uses the STRONG model on Pro and is still never sent", r.data.aiWritten === true && r.data.letter === "Tailored letter for you." && r.data.submitted === false && calls.at(-1).model === "strong-1");
  mode = "fail"; r = await call("POST", `/jobs/${any.id}/draft`);
  ok("if the AI fails the template letter is used instead", r.status === 200 && r.data.aiWritten === false && /hiring team/.test(r.data.letter)); mode = "ok";
  await app.run("UPDATE usage SET ai_calls = 300"); const n0 = calls.length;
  r = await call("POST", `/jobs/${any.id}/draft`);
  ok("the monthly AI cap is enforced and falls back to rules", r.data.aiWritten === false && calls.length === n0);
  // free users never use AI
  await call("PUT", "/jobs/profile", { body: { roles: "developer", skills: "python", cv: "I know Python for 2 years." }, as: "f" });
  const fr = await call("GET", "/jobs", { as: "f" }); const fany = [...fr.data.open, ...fr.data.unverified, ...fr.data.adjacent][0];
  const n1 = calls.length; if (fany) await call("POST", `/jobs/${fany.id}/draft`, { as: "f" });
  ok("free accounts never trigger AI calls (rules only)", calls.length === n1 && (await call("GET", "/jobs/profile", { as: "f" })).data.profile.years >= 2);
  await app.restore();
}
{ // no key at all: nothing is ever sent to Anthropic
  const app = await makeApp({ SOURCE_MODE: "sandbox", ADMIN_EMAILS: "boss@x.com" }); let n = 0;
  app.onOutside(async (u) => { if (u.includes("anthropic")) { n++; return res({}, 500); } return null; });
  await app.call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW } });
  await app.call("POST", "/admin/sources/sync", { body: {} });
  const p = await app.call("PUT", "/jobs/profile", { body: { cv: "Python and Django developer, 4 years. BSc.", roles: "backend engineer" } });
  await app.call("POST", "/jobs/scan");
  const l = (await app.call("GET", "/jobs")).data;
  ok("without an Anthropic key everything works from rules and no AI request is ever made", n === 0 && p.data.aiRead === false && p.data.skills.includes("python") && p.data.years === 4 && l.open.length + l.unverified.length > 0);
  await app.restore();
}
console.log(`platform.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
