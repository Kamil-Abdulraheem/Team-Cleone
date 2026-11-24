// Runs the same flows through the Turso adapter (libSQL), to prove it behaves like Cloudflare D1.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import { connect } from "../functions/_lib/libsql.js";
import { SCHEMA } from "../functions/_lib/schema.js";
import { makeApp, runScan } from "./harness.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const PW = "correct horse battery";
const KEY = "sk_test_secret";

ok("schema.js is in sync with schema.sql (run `npm run schema` if this fails)", SCHEMA === fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

const client = createClient({ url: ":memory:" });
const DB = await connect(client);
const app = makeApp({ DB, PAYSTACK_SECRET_KEY: KEY, PRO_AMOUNT: "1900000", PAYSTACK_PLAN_CODE: "PLN_x" });
const { call } = app;
const q = async (sql, ...a) => (await DB.prepare(sql).bind(...a).all()).results;

let r = await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW, name: "Ada" } });
ok("signup works on Turso", r.status === 201 && r.data.plan === "free");
const uid = r.data.user.id;
r = await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW }, as: "z" });
ok("duplicate email still refused", r.status === 409);
r = await call("GET", "/me");
ok("session lookup (a join) works", r.status === 200 && r.data.user.name === "Ada");
await call("POST", "/auth/logout");
r = await call("POST", "/auth/login", { body: { email: "ada@startup.com", password: PW } });
ok("login works", r.status === 200);

const scan = await runScan(app, "me/proj");
ok("a full scan completes (JSON state, batch upserts)", scan.steps.at(-1).done === true, JSON.stringify(scan.steps.at(-1)));
r = await call("GET", "/radar");
const lanes = r.data.lanes;
ok("paywall: 1 open per lane and the rest locked", ["strategic", "joiners", "investors"].every((l) => lanes[l].items.length <= 1) && lanes.joiners.locked.length > 0);
const open = lanes.joiners.items[0];
r = await call("POST", `/matches/${open.id}/draft`);
ok("draft works", r.status === 200 && /^Hi /.test(r.data.email));
r = await call("POST", `/matches/${open.id}/feedback`, { body: { action: "dismiss", reason: "Not relevant" } });
ok("feedback saved", r.status === 200 && (await q("SELECT * FROM feedback WHERE user_id = ?", uid)).length === 1);
r = await call("GET", "/radar");
ok("dismissal hides it and unlocks the next", !r.data.lanes.joiners.items.some((x) => x.id === open.id) && r.data.lanes.joiners.items.length === 1);

const again = await runScan(app, "me/proj");
ok("rescan upserts instead of duplicating", again.steps.at(-1).done === true && (await q("SELECT COUNT(*) AS n, COUNT(DISTINCT k) AS d FROM matches WHERE user_id = ?", uid))[0].n === (await q("SELECT COUNT(DISTINCT k) AS d FROM matches WHERE user_id = ?", uid))[0].d);
ok("usage counted", (await q("SELECT scans FROM usage WHERE user_id = ?", uid))[0].scans === 2);

const hmac = async (body) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const evt = JSON.stringify({ event: "charge.success", data: { metadata: { user_id: uid }, customer: { customer_code: "C1", email: "ada@startup.com" } } });
r = await call("POST", "/billing/webhook", { raw: evt, headers: { "x-paystack-signature": await hmac(evt) } });
r = await call("GET", "/me");
ok("signed webhook upgrades the account (upsert with COALESCE)", r.data.plan === "pro");
r = await call("GET", "/radar");
ok("Pro: nothing locked", r.data.lanes.joiners.locked.length === 0 && r.data.lanes.joiners.items.length > 3);

const second = r.data.lanes.joiners.items[0];
await call("POST", `/matches/${second.id}/copied`);
r = await call("GET", "/outreach");
ok("outreach log works", r.data.items.length === 1);
await call("POST", `/outreach/${r.data.items[0].id}/replied`, { body: { replied: true } });
r = await call("GET", "/outreach");
ok("marking a reply works (changes count from rowsAffected)", r.data.items[0].replied === 1);

// deletion must remove everything even if the database does not enforce cascades
await call("POST", "/billing/webhook", { raw: JSON.stringify({ event: "subscription.disable", data: { metadata: { user_id: uid }, customer: { email: "ada@startup.com" } } }), headers: { "x-paystack-signature": await hmac(JSON.stringify({ event: "subscription.disable", data: { metadata: { user_id: uid }, customer: { email: "ada@startup.com" } } })) } });
await DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ?").bind(uid).run();
r = await call("DELETE", "/me", { body: { password: PW } });
ok("account deletion works", r.status === 200, JSON.stringify(r.data));
const left = await Promise.all(["users WHERE id", "sessions WHERE user_id", "subscriptions WHERE user_id", "scans WHERE user_id", "matches WHERE user_id", "feedback WHERE user_id", "outreach WHERE user_id", "usage WHERE user_id"].map(async (t) => (await q(`SELECT COUNT(*) AS n FROM ${t} = ?`, uid))[0].n));
ok("every table is empty for that person afterwards", left.every((n) => n === 0), left.join());

app.restore();
console.log(`\nlibsql.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
