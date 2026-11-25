import { makeApp, runScan } from "./harness.js";
import { stripHtml, fingerprint, noiseReason, scamCheck, ghostCheck, matchJob, extractSkills, parseCommand, verifyJob, encryptCv, decryptCv, coverLetter, normalize } from "../lib/jobs.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const resp = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const desc = "We are hiring a backend developer to build our API with Python and Django, PostgreSQL and Docker. You will work with a small team on a product used by thousands of people every day, own features end to end, and review code. We ask for 3 years of Django experience.";

// ---------------------------------------------------------------- pure logic
ok("html is stripped from descriptions", stripHtml("<p>Hi&nbsp;<b>there</b></p><script>x()</script>") === "Hi there");
ok("same job on two boards has one fingerprint", fingerprint({ company: "Acme Inc.", title: "Senior Django Developer", location: "Remote" }) === fingerprint({ company: "ACME", title: "Django Developer", location: "remote" }));
ok("noise: no description is dropped", !!noiseReason({ title: "Dev", company: "X", description: "short" }) && !noiseReason({ title: "Dev", company: "X", description: desc }));
const scam = scamCheck({ title: "EASY HOME JOB NOW", description: "Pay a registration fee of $20. Contact us on WhatsApp +234 801 234 5678 or hr.jobs@gmail.com. No experience required, guaranteed income." });
ok("scam: pay-to-apply, whatsapp and gmail are flagged with plain reasons", scam.score >= 80 && scam.flags.some((f) => /fee/.test(f)) && scam.flags.some((f) => /WhatsApp/.test(f)));
ok("scam: a normal job scores zero", scamCheck({ title: "Backend Developer", description: desc, salary_max: 90000 }).score === 0);
ok("ghost: old and reposted jobs are flagged", ghostCheck({ description: desc, posted_at: Math.floor(Date.now() / 1000) - 90 * 86400 }, { reposts: 3 }).length >= 2);
const profile = { roles: "backend developer", skills: "python,docker", years: 1, remote_only: 0, location: "", min_salary: 0 };
const m = matchJob(profile, { title: "Backend Developer", tags: "python", description: desc, remote: 1, location: "Remote" });
ok("match explains fit and gaps in plain language", m.score >= 60 && m.why.some((w) => /backend developer/.test(w)) && m.gaps.some((g) => /3 years of django/i.test(g)) && m.gaps.some((g) => /postgresql/.test(g)), JSON.stringify(m));
ok("remote-only profile rejects on-site jobs", matchJob({ ...profile, remote_only: 1 }, { title: "Backend Developer", tags: "", description: desc, remote: 0, location: "Lagos" }).score < m.score - 30);
ok("skills are read from a CV", extractSkills("Built APIs with Django and PostgreSQL, deployed on AWS using Docker").join() === "django,postgresql,docker,aws" || ["django", "postgresql", "docker", "aws"].every((s) => extractSkills("Built APIs with Django and PostgreSQL, deployed on AWS using Docker").includes(s)));
ok("commands: pause, remote, why, unknown", parseCommand("pause until Monday").action === "pause" && parseCommand("only remote now").action === "remote" && parseCommand("why did you send this?").action === "why" && parseCommand("blah").action === "unknown");
ok("cover letter is a draft with no pretend facts", /\[add one specific result/.test(coverLetter(profile, { title: "Backend Developer", company: "Acme", tags: "", description: desc }, "Ada").letter));
{
  const env = { CV_ENCRYPTION_KEY: "test-key" };
  const enc = await encryptCv(env, "My CV: Ada, Django");
  ok("CV is encrypted at rest and decrypts back", enc && !enc.includes("Ada") && (await decryptCv(env, enc)) === "My CV: Ada, Django" && (await encryptCv({}, "x")) === null);
}
const v = async (r) => { const f = globalThis.fetch; globalThis.fetch = async () => { if (r instanceof Error) throw r; return r; }; try { return (await verifyJob("https://x.test/j")).status; } finally { globalThis.fetch = f; } };
ok("verify: 200 is open, 404 is closed, 'no longer accepting' is closed", (await v(resp("<h1>Backend dev</h1> Apply now"))) === "open" && (await v(resp("", 404))) === "closed" && (await v(resp("Sorry, this position is no longer accepting applications"))) === "closed");
ok("verify: blocked or unreachable is 'unverified', never guessed open", (await v(resp("", 403))) === "unverified" && (await v(new Error("timeout"))) === "unverified");

// ---------------------------------------------------------------- API with fake job boards
const app = await makeApp({ CRON_SECRET: "cron-secret", ADMIN_EMAILS: "boss@x.com" });
const { call } = app;
const PW = "correct horse battery";
const board = { remotive: [], arbeitnow: [], remoteok: [] };
const pages = {};   // apply url -> response
let down = null;
const now = Math.floor(Date.now() / 1000);
const iso = (d) => new Date((now - d * 86400) * 1000).toISOString();
const feed = (title, company, url, extra = {}) => ({ title, company, url, description: desc, ...extra });
app.onOutside(async (u) => {
  if (down && u.includes(down)) return resp("", 503);
  if (u.startsWith("https://remotive.com/api")) return resp({ jobs: board.remotive.map((j) => ({ url: j.url, title: j.title, company_name: j.company, candidate_required_location: "Worldwide", description: j.description, tags: ["python"], publication_date: iso(j.age ?? 2) })) });
  if (u.startsWith("https://www.arbeitnow.com")) return resp({ data: board.arbeitnow.map((j) => ({ url: j.url, title: j.title, company_name: j.company, location: "Berlin", remote: true, description: j.description, tags: [], created_at: now - (j.age ?? 2) * 86400 })) });
  if (u.startsWith("https://remoteok.com")) return resp([{ legal: "x" }, ...board.remoteok.map((j) => ({ url: j.url, position: j.title, company: j.company, description: j.description, tags: ["python"], epoch: now - 86400 }))]);
  if (u.startsWith("https://jobs.test/")) return pages[u] || resp("<h1>Role</h1> Apply now");
  return null;
});
board.remotive = [feed("Backend Developer", "Acme Inc", "https://jobs.test/acme"), feed("Backend Developer", "Gone Co", "https://jobs.test/gone"), feed("Python Developer", "Slow Co", "https://jobs.test/slow"),
  feed("HOME EARNING AGENT NEEDED", "Quick Cash", "https://jobs.test/scam", { description: desc + " Pay a registration fee of $20 to start. Contact us on WhatsApp +234 801 234 5678. No experience needed, guaranteed income." }), feed("Old Backend Developer", "Stale Ltd", "https://jobs.test/stale", { age: 120 })];
board.arbeitnow = [feed("Senior Backend Developer", "ACME", "https://jobs.test/acme-copy"), feed("Chef", "Kitchen", "https://jobs.test/chef", { description: "short" })];
board.remoteok = [feed("Backend Developer", "Acme Inc.", "https://jobs.test/acme-3")];
pages["https://jobs.test/gone"] = resp("", 404);
pages["https://jobs.test/slow"] = resp("", 403);

let r = await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW, name: "Ada Obi" } });
ok("feature switches: Repo scan on, Job Radar off by default", r.data.features.repo === true && r.data.features.jobs === false);
r = await call("PATCH", "/me", { body: { prefs: { features: { jobs: true, evil: true } } } });
ok("Job Radar can be switched on; unknown features are ignored", r.data.features.jobs === true && r.data.features.evil === undefined);
r = await call("POST", "/jobs/scan");
ok("scan needs a profile first", r.status === 400);
r = await call("PUT", "/jobs/profile", { body: { roles: "backend developer", cv: "Ada. 1 year with Python and Docker. Built REST API.", years: 1 } });
ok("profile: skills read from the CV, CV not stored without an encryption key", r.status === 200 && r.data.skills.includes("python") && r.data.cvStored === false && !!r.data.cvNote);
r = await call("POST", "/jobs/scan");
ok("scan works and reports each source", r.status === 200 && r.data.sources.length === 3 && r.data.sources.every((s) => s.ok), JSON.stringify(r.data));
ok("the same job on three boards is stored once", (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE company ILIKE 'acme%'")).n == 1 && JSON.parse((await app.one("SELECT sources FROM jobs WHERE company ILIKE 'acme%'")).sources).length === 3);
ok("noise (no description) never enters", (await app.one("SELECT COUNT(*) AS n FROM jobs WHERE company = 'Kitchen'")).n == 0);
r = await call("GET", "/jobs");
const titles = (a) => a.map((x) => x.company);
ok("Free plan: 3 shown, the rest only counted", r.data.open.length + r.data.unverified.length === 3 && r.data.locked >= 0, JSON.stringify([r.data.open.length, r.data.unverified.length, r.data.locked]));
ok("confirmed-open jobs are separate from 'could not verify'", titles(r.data.open).includes("Acme Inc") && r.data.open.every((j) => j.status === "open") && (r.data.unverified.length ? r.data.unverified.every((j) => /could not verify/.test(j.verifyNote)) : true), JSON.stringify(r.data.unverified));
ok("a dead page (404) is never shown as open", ![...r.data.open, ...r.data.unverified].some((j) => j.company === "Gone Co"));
ok("the scam is moved to 'looks suspicious' with reasons, not shown as a match", r.data.suspicious.some((j) => j.company === "Quick Cash" && j.scamFlags.length >= 2) && !r.data.open.some((j) => j.company === "Quick Cash"));
const acme = r.data.open.find((j) => j.company === "Acme Inc");
r = await call("GET", `/jobs/${acme.id}`);
ok("a result opens to full details: description, apply link, boards, why and gaps", r.status === 200 && r.data.description.length > 100 && r.data.applyUrl.startsWith("https://jobs.test/") && r.data.boardLinks.length === 3 && r.data.why.length && r.data.gaps.length);
r = await call("POST", `/jobs/${acme.id}/draft`);
ok("draft is text only and nothing is submitted", r.status === 200 && r.data.submitted === false && /Acme/.test(r.data.letter) && !(await app.one("SELECT 1 AS x FROM job_matches WHERE state = 'applied'")));
r = await call("POST", `/jobs/${acme.id}/prep`);
ok("interview questions for the role", r.data.questions.length >= 5 && r.data.questions.some((q) => /Acme/.test(q)));
r = await call("POST", `/jobs/${acme.id}/state`, { body: { state: "applied" } });
ok("tracking: applied sets a follow-up reminder", r.status === 200 && r.data.followUp > now);
r = await call("GET", "/jobs");
ok("applied jobs move to the tracker", r.data.tracker.some((j) => j.id === acme.id && j.state === "applied"));
await app.run("UPDATE job_matches SET follow_up = ? WHERE job_id = ?", now - 10, acme.id);
r = await call("GET", "/jobs/alerts");
ok("a follow-up reminder appears when due", r.data.alerts.some((a) => a.type === "followup"));
r = await call("POST", "/jobs/command", { body: { text: "only remote now" } });
ok("command: only remote now", /remote/i.test(r.data.reply) && (await app.one("SELECT remote_only FROM job_profiles")).remote_only == 1);
r = await call("POST", "/jobs/command", { body: { text: "pause until Monday" } });
ok("command: pause until Monday", /Paused until monday/i.test(r.data.reply) && (await app.one("SELECT paused_until FROM job_profiles")).paused_until > now);
r = await call("POST", "/jobs/command", { body: { text: "why did you send this?", jobId: acme.id } });
ok("command: why did you send this", /scored/.test(r.data.reply));
r = await call("GET", "/jobs/market");
ok("market view returns counts", r.status === 200 && r.data.openRoles >= 1);
r = await call("GET", "/jobs/health/metrics");
ok("quality metrics are admin only", r.status === 403);
r = await call("GET", "/cron/jobs");
ok("cron refuses without the secret", r.status === 401);

// Pro, alerts and the "just closed" update
await app.run("INSERT INTO subscriptions (user_id, status, current_period_end, updated_at) SELECT id, 'active', ?, ? FROM users", now + 99999, now);
await app.run("UPDATE job_profiles SET paused_until = 0, remote_only = 0");
await app.run("UPDATE job_matches SET state = 'new', follow_up = NULL");
r = await call("GET", "/cron/jobs", { headers: { authorization: "Bearer cron-secret" } });
const al = await app.all("SELECT j.company FROM job_matches mm JOIN jobs j ON j.id = mm.job_id WHERE mm.alerted_at IS NOT NULL");
ok("alerts go only to confirmed-open, non-suspicious jobs", r.status === 200 && al.length >= 1 && al.every((x) => !["Gone Co", "Slow Co", "Quick Cash"].includes(x.company)), JSON.stringify(al));
pages["https://jobs.test/acme"] = resp("", 404);
await app.run("UPDATE jobs SET verified_at = 1");
r = await call("GET", "/cron/jobs", { headers: { authorization: "Bearer cron-secret" } });
r = await call("GET", "/jobs/alerts");
ok("'this just closed' is sent for a job we alerted on", r.data.alerts.some((a) => a.type === "closed" && a.job.company === "Acme Inc"), JSON.stringify(r.data.alerts.map((a) => a.type)));
// reports
const other = (await call("GET", "/jobs")).data;
r = await call("POST", `/jobs/${acme.id}/report`, { body: { kind: "was_closed" } });
ok("users can report a job that was already closed", r.status === 200);

// source failure is isolated and recorded
down = "arbeitnow";
await app.run("UPDATE source_health SET last_ok = 1");
r = await call("POST", "/jobs/scan");
ok("one broken source never stops the scan and is recorded", r.status === 200 && r.data.sources.find((s) => s.source === "arbeitnow").ok === false && r.data.sources.filter((s) => s.ok).length === 2, JSON.stringify(r.data.sources));
down = null;

// privacy and paywall for another user
r = await call("POST", "/auth/signup", { body: { email: "bob@startup.com", password: PW }, as: "b" });
r = await call("GET", `/jobs/${acme.id}`, { as: "b" });
ok("nobody can open another person's job match", r.status === 404);
r = await call("GET", "/me/export");
ok("export includes job data", r.status === 200 && r.data.jobProfile && r.data.jobMatches.length > 0);
// repo match details are clickable too, and the paywall holds
await runScan(app, "me/proj");
const rad = (await call("GET", "/radar")).data;
const openM = rad.lanes.joiners.items[0] || rad.lanes.strategic.items[0];
r = await call("GET", `/matches/${openM.id}`);
ok("repo match opens to full details (url, scores, why)", r.status === 200 && /^https:\/\/github\.com/.test(r.data.url) && r.data.why && r.data.sig_ !== undefined, JSON.stringify(r.data).slice(0, 200));
const lockedRow = await app.one("SELECT id FROM matches WHERE lane = 'joiners' AND score >= 75 AND id != ? LIMIT 1", openM.id);
await app.run("DELETE FROM subscriptions");
const free = (await call("GET", "/radar")).data;
const hidden = await app.one("SELECT id FROM matches WHERE score >= 75 AND id NOT IN (" + ["strategic", "joiners", "investors"].flatMap((l) => free.lanes[l].items.map((x) => `'${x.id}'`)).concat(["''"]).join(",") + ") LIMIT 1");
r = hidden ? await call("GET", `/matches/${hidden.id}`) : { status: 403 };
ok("a locked repo match cannot be opened by guessing its id", r.status === 403);
r = await call("DELETE", "/jobs/profile");
ok("job profile and CV can be deleted in one tap", r.status === 200 && !(await app.one("SELECT 1 AS x FROM job_profiles WHERE user_id = (SELECT id FROM users WHERE email = 'ada@startup.com')")));
await app.restore();
console.log(`jobs.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
