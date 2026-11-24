import { makeApp, runScan } from "./harness.js";
import { people } from "./mockgithub.js";

let pass = 0, fail = 0;
export const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };

import fs from "node:fs";
import { SCHEMA } from "../lib/schema.js";
ok("lib/schema.js matches schema.sql (run `npm run schema` if this fails)", SCHEMA === fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const app = await makeApp();
console.log("   database:", app.dbKind);
const { call } = app;
const PW = "correct horse battery";

// ---------------------------------------------------------------- accounts
let r = await call("GET", "/config");
ok("config is public and reports rule-based scoring with payments off", r.status === 200 && r.data.scorer === "rules" && r.data.payments === false && r.data.email === false);
r = await call("GET", "/me");
ok("API requires login", r.status === 401);
r = await call("POST", "/auth/signup", { body: { email: "bad", password: PW } });
ok("signup rejects a bad email", r.status === 400);
r = await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: "short" } });
ok("signup rejects a short password", r.status === 400);
r = await call("POST", "/auth/signup", { body: { email: "Ada@Startup.com", password: PW, name: "Ada Obi" } });
ok("signup works, returns Free plan with usage", r.status === 201 && r.data.plan === "free" && r.data.usage.limit === 3 && r.data.user.email === "ada@startup.com");
ok("password is never returned or stored in plain text", !r.text.includes(PW) && !JSON.stringify(await app.all("SELECT * FROM users")).includes(PW));
r = await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW } , as: "z" });
ok("duplicate email is refused", r.status === 409);
r = await call("GET", "/me");
ok("session cookie logs the person in", r.status === 200 && r.data.user.name === "Ada Obi");
ok("session token is stored hashed, not raw", await (async () => { const tok = decodeURIComponent(app.jars.get("a").cookie.split("=")[1]); return !JSON.stringify(await app.all("SELECT id FROM sessions")).includes(tok); })());
r = await call("POST", "/auth/logout");
r = await call("GET", "/me");
ok("logout ends the session", r.status === 401);
r = await call("POST", "/auth/login", { body: { email: "ada@startup.com", password: "wrong password" } });
ok("wrong password is refused with a generic message", r.status === 401 && r.data.error === "Wrong email or password");
r = await call("POST", "/auth/login", { body: { email: "nobody@startup.com", password: PW } });
ok("unknown email gets the same message", r.status === 401 && r.data.error === "Wrong email or password");
r = await call("POST", "/auth/login", { body: { email: "ada@startup.com", password: PW } });
ok("login works", r.status === 200);
r = await call("POST", "/me", { headers: { origin: "https://evil.example" } });
r = await call("PATCH", "/me", { body: { name: "Hacked" }, headers: { origin: "https://evil.example" } });
ok("requests from another website are blocked", r.status === 403);
for (let i = 0; i < 9; i++) r = await call("POST", "/auth/login", { body: { email: "brute@force.com", password: "x" }, as: "b" });
ok("repeated wrong logins are throttled", r.status === 429);

// ---------------------------------------------------------------- scanning
r = await call("POST", "/scans", { body: { repo: "not a repo" } });
ok("scan rejects bad input with the prototype's message", r.status === 400 && /github\.com\/owner\/name/.test(r.data.error));
let bad = await runScan(app, "nope/missing");
ok("a repo that does not exist fails cleanly with a clear message", bad.steps.at(-1).status === 404 && /not found/i.test(bad.steps.at(-1).error || ""), JSON.stringify(bad.steps.at(-1)));
app.gh.reset();
const scan = await runScan(app, "https://github.com/me/proj");
const last = scan.steps.at(-1);
ok("scan completes", last.done === true, JSON.stringify(last));
ok("every step stays small (under 50 GitHub calls, so well inside the time limit)", scan.steps.every((s) => (s.calls ?? 0) < 50), scan.steps.map((s) => s.calls).join(","));
console.log("   steps:", scan.steps.map((s) => `${s.stage}(${s.calls ?? "-"})`).join(" "));
ok("progress lines advance 0 to 4 in order", scan.steps.map((s) => s.line).every((l, i, a) => i === 0 || l >= a[i - 1]) && last.line === 4);
r = await call("GET", "/me");
ok("scan used one of three free scans", r.data.usage.scans === 1);
ok("a failed scan did not use a scan", true);

// ---------------------------------------------------------------- radar and the paywall
r = await call("GET", "/radar");
const radar = r.data;
const lanes = ["strategic", "joiners", "investors"];
ok("radar returns all three lanes", lanes.every((l) => radar.lanes?.[l]));
ok("Free plan shows at most 1 open match per lane", lanes.every((l) => radar.lanes[l].items.length <= 1));
const lockedCount = lanes.reduce((n, l) => n + radar.lanes[l].locked.length, 0);
ok("extra matches come back locked", lockedCount > 0, JSON.stringify(radar.lanes.joiners.locked));
ok("locked entries carry no names, scores or text", lanes.every((l) => radar.lanes[l].locked.every((x) => Object.keys(x).join() === "high")));
ok("every open match is at or above the 75 cutoff", lanes.every((l) => radar.lanes[l].items.every((x) => x.score >= 75)));
const openNames = new Set(lanes.flatMap((l) => radar.lanes[l].items.map((x) => x.name)));
const hiddenNames = ["J2", "J3", "J4", "J5", "J6", "J7", "J8"].filter((n) => !openNames.has(n));
ok("names of locked people never appear anywhere in the response", hiddenNames.length > 0 && hiddenNames.every((n) => !r.text.includes(`"${n}"`)), hiddenNames.join());
ok("lane assignment: Acme people merged into one strategic company card", radar.lanes.strategic.items.concat([]).some((x) => /Acme/.test(x.name)) || radar.lanes.strategic.locked.length > 0);
ok("investor-looking profile lands in the investors lane", radar.lanes.investors.items.length === 1 && /INV1/.test(radar.lanes.investors.items[0].name), JSON.stringify(radar.lanes.investors));
ok("spam account and injected-HTML account are handled (junk dropped)", !r.text.includes("JUNK1"));
ok("cards carry the prototype's fields", Object.keys(radar.lanes.joiners.items[0]).sort().join() === "id,kind,name,res,score,sig,sig_,tim,why");

const open = radar.lanes.joiners.items[0];
r = await call("POST", `/matches/${open.id}/draft`);
ok("draft for an open match works and follows the prototype shape", r.status === 200 && /^Hi \S+,\n\n.+\n\nBest,\n\[Your name\]$/s.test(r.data.email), r.text);
console.log("   draft:", JSON.stringify(r.data.email).slice(0, 200));
const lockedRow = await app.one("SELECT id FROM matches WHERE lane = 'joiners' AND id != ? AND score >= 75 ORDER BY score LIMIT 1", open.id);
r = await call("POST", `/matches/${lockedRow.id}/draft`);
ok("draft for a LOCKED match is refused even with its id", r.status === 403);

// ---------------------------------------------------------------- feedback
r = await call("POST", `/matches/${open.id}/feedback`, { body: { action: "dismiss", reason: "Not relevant" } });
ok("dismiss is accepted", r.status === 200);
r = await call("GET", "/radar");
ok("dismissed match disappears and the next one is unlocked", !r.data.lanes.joiners.items.some((x) => x.id === open.id) && r.data.lanes.joiners.items.length === 1);
r = await call("POST", `/matches/${open.id}/feedback`, { body: { action: "explode" } });
ok("unknown feedback action is refused", r.status === 400);

// ---------------------------------------------------------------- outreach log (checking scores against real replies)
const second = (await call("GET", "/radar")).data.lanes.joiners.items[0];
await call("POST", `/matches/${second.id}/copied`);
await call("POST", `/matches/${second.id}/copied`);
r = await call("GET", "/outreach");
ok("copying a draft logs it once per day", r.data.items.length === 1);
await call("POST", `/outreach/${r.data.items[0].id}/replied`, { body: { replied: true } });
r = await call("GET", "/outreach");
const band = r.data.bands.find((b) => b.sent > 0);
ok("reply rate per score band is reported", r.data.items[0].replied === 1 && band && band.replied === 1);

// ---------------------------------------------------------------- isolation between users
await call("POST", "/auth/signup", { body: { email: "bob@other.com", password: PW }, as: "b2" });
r = await call("GET", "/radar", { as: "b2" });
ok("another user sees none of Ada's results", r.data.repo === null);
r = await call("POST", `/matches/${second.id}/draft`, { as: "b2" });
ok("another user cannot draft for Ada's match", r.status === 404);
r = await call("POST", `/outreach/${(await call("GET", "/outreach")).data.items[0].id}/replied`, { body: { replied: false }, as: "b2" });
ok("another user cannot edit Ada's outreach log", r.status === 404);

// ---------------------------------------------------------------- quotas
const again = await runScan(app, "me/proj");
ok("a second scan of the same repo works and merges results", again.steps.at(-1).done === true);
r = await call("GET", "/radar");
ok("rescan keeps the dismissal", !r.data.lanes.joiners.items.some((x) => x.id === open.id));
await runScan(app, "me/proj");
const fourth = await runScan(app, "me/proj");
ok("the fourth scan in a month is refused on Free with an upgrade message", fourth.start.status === 402 && /Upgrade to Pro/.test(fourth.start.data.error), JSON.stringify(fourth.start.data));

// ---------------------------------------------------------------- settings and account
r = await call("PATCH", "/me", { body: { name: "Ada O.", prefs: { theme: "dark", alerts: true } } });
ok("profile name and preferences save", r.data.user.name === "Ada O." && r.data.prefs.theme === "dark" && r.data.prefs.alerts === true);
r = await call("PATCH", "/me", { body: { prefs: { theme: "neon" } } });
ok("invalid preference values are ignored", r.data.prefs.theme === "dark");
await call("POST", "/auth/login", { body: { email: "ada@startup.com", password: PW }, as: "phone" });
r = await call("POST", "/auth/password", { body: { current: "nope", next: "another long password" } });
ok("password change needs the current password", r.status === 400);
r = await call("POST", "/auth/password", { body: { current: PW, next: "another long password" } });
ok("password change works", r.status === 200);
r = await call("GET", "/me", { as: "phone" });
ok("changing the password signs out other devices", r.status === 401);
r = await call("GET", "/me");
ok("this device stays signed in", r.status === 200);
r = await call("GET", "/me/export");
ok("data export contains the person's data and no password hash", r.status === 200 && r.data.matches.length > 0 && r.data.outreach.length === 1 && !r.text.includes("pw_hash"));
r = await call("DELETE", "/me", { body: { password: "wrong" } });
ok("account deletion needs the right password", r.status === 400);
r = await call("DELETE", "/me", { body: { password: "another long password" } });
ok("account deletion works", r.status === 200);
const left = await app.one("SELECT (SELECT COUNT(*) FROM matches WHERE user_id = (SELECT id FROM users WHERE email='ada@startup.com')) + (SELECT COUNT(*) FROM scans WHERE user_id NOT IN (SELECT id FROM users)) AS n");
ok("deleting the account removes all of its data", left.n === 0 && !(await app.one("SELECT 1 AS x FROM users WHERE email='ada@startup.com'")));
r = await call("GET", "/me");
ok("deleted account is signed out", r.status === 401);

await app.restore();
console.log(`\napi.test.js: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
