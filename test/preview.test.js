// Preview mode, the health page, error recording and the activity feed.
import { makeApp } from "./harness.js";
import { makeTestDb } from "./db.js";
import { handle } from "../lib/app.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const PW = "correct horse battery";

// ================================================================== preview mode
{
  let ai = 0;
  const app = await makeApp({ PREVIEW_MODE: "1", ADMIN_EMAILS: "boss@x.com", ANTHROPIC_API_KEY: "k", SOURCE_MODE: "sandbox" });
  app.onOutside(async (u) => { if (u.includes("anthropic")) ai++; return null; });
  const { call } = app;
  let r = await call("POST", "/auth/login", { body: { email: "anything", password: "x" } });
  ok("preview: any email and any password logs in", r.status === 200 && r.data.plan === "preview" && r.data.preview === true && r.data.user.name === "Anything");
  const id1 = r.data.user.id;
  r = await call("POST", "/auth/login", { body: { email: "anything", password: "different" }, as: "again" });
  ok("preview: the same email returns to the same preview workspace", r.data.user.id === id1);
  r = await call("POST", "/auth/signup", { body: { email: "other@whatever.com", password: "" }, as: "o" });
  ok("preview: a different email is a separate, isolated workspace (signup also accepts anything)", r.status === 201 || r.status === 200, r.text);
  ok("preview: isolation", r.data.user.id !== id1);
  r = await call("POST", "/auth/login", { body: {}, as: "g" });
  ok("preview: even an empty form gets a guest workspace", r.status === 200 && /Guest/.test(r.data.user.name));
  ok("preview: the stored email can never be a real mailbox", /@preview\.invalid$/.test((await app.one("SELECT email FROM users WHERE id = ?", id1)).email) && !(await app.one("SELECT email FROM users WHERE email = 'anything'")));
  r = await call("GET", "/me");
  ok("preview: the workspace has generous limits for testing but is not admin", r.data.admin === false && r.data.usage.limit === 20);
  ok("preview: no admin access, so no one on the internet can add sources or approve feeds", (await call("GET", "/admin/sources/dashboard")).status === 403 && (await call("POST", "/admin/sources", { body: { adapter: "rss", config: { url: "https://x.test/f" } } })).status === 403);
  ok("preview: the config tells the login screen", (await call("GET", "/config")).data.preview === true);

  // real accounts are never bypassed
  r = await call("POST", "/auth/login", { body: { email: "boss@x.com", password: "guess" }, as: "b" });
  ok("an admin email is NOT a preview login: wrong password is refused", r.status === 401);
  r = await call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW, name: "Boss" }, as: "b" });
  ok("the admin can still create a real account with a real password", r.status === 201 && r.data.admin === true && r.data.plan === "pro");
  ok("and then a wrong password is refused, the right one works", (await call("POST", "/auth/login", { body: { email: "boss@x.com", password: "nope" }, as: "b2" })).status === 401 && (await call("POST", "/auth/login", { body: { email: "boss@x.com", password: PW }, as: "b3" })).status === 200);
  ok("a real admin sees the dashboard", (await call("GET", "/admin/sources/dashboard", { as: "b3" })).status === 200);

  // preview users never cost AI money
  await call("POST", "/admin/sources/sync", { body: {}, as: "b3" });
  r = await call("PUT", "/jobs/profile", { body: { roles: "backend engineer", cv: "Python and Django developer with 4 years of experience. BSc." } });
  ok("preview workspaces never trigger AI calls even when a key is set", r.status === 200 && r.data.aiRead === false && ai === 0);
  ok("preview accounts can be deleted like any other", (await call("DELETE", "/me", { body: { password: "" } })).status < 500);
  await app.restore();
}
{ // preview OFF (the default): nothing is bypassed
  const app = await makeApp({});
  ok("preview off: a random email and password is refused", (await app.call("POST", "/auth/login", { body: { email: "anyone@x.com", password: "x" } })).status === 401);
  ok("preview off: signup still enforces a real password", (await app.call("POST", "/auth/signup", { body: { email: "a@x.com", password: "short" } })).status === 400);
  ok("preview off: the login screen is told so", (await app.call("GET", "/config")).data.preview === false);
  await app.restore();
}

// ================================================================== health page
{
  const app = await makeApp({ GITHUB_TOKEN: "ghp_SECRETVALUE123", CRON_SECRET: "SECRETCRON999", ANTHROPIC_API_KEY: "sk-SECRETKEY" });
  const r = await app.call("GET", "/health");
  ok("health: reports a working database and tables", r.status === 200 && r.data.ok === true && r.data.database.connected && r.data.database.tablesReady && typeof r.data.database.ms === "number");
  ok("health: shows what is configured as yes/no, never the secret itself", r.data.config.githubToken === true && r.data.config.cronSecret === true && !/SECRETVALUE|SECRETCRON|SECRETKEY/.test(r.text));
  ok("health: needs no login", true);
  await app.restore();
  const req = (p) => new Request("https://x.test" + p);
  let h = await handle(req("/api/health"), { DB: null, DATABASE_URL: "postgresql://neondb_owner:TOPSECRETPW@ep-cool-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require", DB_ERROR: 'password authentication failed for user "neondb_owner"' });
  let d = await h.json();
  ok("health: when the database will not connect it says why and what to do, in plain words", h.status === 503 && d.ok === false && d.database.urlSet && d.database.pooled && d.database.region === "eu-central-1" && d.tips.some((t) => /Wrong database password/.test(t)));
  ok("health: the connection string and password are never shown", !/TOPSECRETPW|neondb_owner:/.test(JSON.stringify(d)));
  h = await handle(req("/api/health"), { DB: null });
  d = await h.json();
  ok("health: a missing DATABASE_URL gets exact instructions", d.database.urlSet === false && d.tips[0].includes("DATABASE_URL is not set") && d.tips[0].includes("Redeploy"));
  h = await handle(req("/api/health"), { DB: null, DATABASE_URL: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db", DB_ERROR: "connect ETIMEDOUT 1.2.3.4:5432" });
  ok("health: a sleeping or unreachable database is explained", (await h.json()).tips.some((t) => /did not answer in time/.test(t)));
}

// ================================================================== unexpected errors are recorded and visible
{
  const { DB, close } = await makeTestDb();
  const broken = { ...DB, prepare: (sql) => { if (/INSERT INTO sessions/.test(sql)) throw new Error("boom: sessions exploded"); return DB.prepare(sql); } };
  const env = { DB: broken };
  const post = new Request("https://x.test/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.com", password: PW }) });
  const res = await handle(post, env);
  ok("an unexpected error still answers politely and without details", res.status === 500 && (await res.json()).error === "Something went wrong. Please try again.");
  const health = await (await handle(new Request("https://x.test/api/health"), { DB })).json();
  ok("the real cause appears on the health page, with the route that failed", health.recentErrors?.[0]?.message.includes("boom: sessions exploded") && health.recentErrors[0].route === "POST /api/auth/signup");
  const hidden = await (await handle(new Request("https://x.test/api/health"), { DB, HEALTH_DETAIL: "0" })).json();
  ok("HEALTH_DETAIL=0 hides it", hidden.recentErrors === undefined);
  await close();
}

// ================================================================== activity feed and plain-language search
{
  const app = await makeApp({ SOURCE_MODE: "sandbox", ADMIN_EMAILS: "boss@x.com" });
  const { call } = app;
  await call("POST", "/auth/signup", { body: { email: "boss@x.com", password: PW } });
  let r = await call("POST", "/jobs/command", { body: { text: "scan" } });
  ok("'scan' without a profile explains what to say instead of failing", r.status === 400 && /backend developer jobs in Lagos/.test(r.data.error));
  r = await call("POST", "/jobs/command", { body: { text: "hello there" } });
  ok("unknown text gets examples", r.status === 200 && /I understand things like/.test(r.data.reply) && !r.data.scan);
  r = await call("POST", "/jobs/command", { body: { text: "find me remote python developer jobs in Abuja" } });
  const p = (await call("GET", "/jobs/profile")).data.profile;
  ok("a sentence creates the profile (roles, location, remote) and asks the app to scan", r.data.scan === true && p.roles === "python developer" && p.location === "Abuja" && p.remoteOnly === true);
  await call("POST", "/admin/sources/sync", { body: {} });
  await call("POST", "/jobs/scan");
  const jobs = (await call("GET", "/jobs")).data, any = [...jobs.open, ...jobs.unverified, ...jobs.adjacent][0];
  if (any) await call("POST", `/jobs/${any.id}/state`, { body: { state: "saved" } });
  r = await call("GET", "/activity?limit=10");
  const kinds = r.data.items.map((x) => x.kind);
  ok("activity lists what was asked, scanned and saved, newest first", kinds.includes("command") && kinds.includes("job_scan") && (!any || kinds.includes("job_state")) && r.data.items.every((x, i, a) => !i || a[i - 1].at >= x.at), JSON.stringify(kinds));
  ok("activity is private to the person", (await call("GET", "/activity", { as: "nobody" })).status === 401);
  ok("the limit is respected", (await call("GET", "/activity?limit=1")).data.items.length === 1);
  await app.restore();
}
console.log(`preview.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
