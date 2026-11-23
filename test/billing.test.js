import { makeApp, runScan } from "./harness.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const PW = "correct horse battery";
const KEY = "sk_test_secret";

const hmac = async (body) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------- payments switched OFF
let app = makeApp();
await app.call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW } });
let r = await app.call("POST", "/billing/checkout");
ok("checkout says payments are off when keys are missing", r.status === 503 && /not switched on/.test(r.data.error));
r = await app.call("POST", "/waitlist", { body: { email: "wait@list.com" } });
ok("waitlist works while payments are off", r.status === 200 && !!app.env.DB.raw.prepare("SELECT 1 FROM waitlist WHERE email='wait@list.com'").get());
r = await app.call("POST", "/billing/webhook", { raw: "{}" , headers: { "x-paystack-signature": "abc" } });
ok("webhook is refused when payments are off", r.status === 401);
app.restore();

// ---------------------------------------------------------------- payments ON (Paystack stubbed)
app = makeApp({ PAYSTACK_SECRET_KEY: KEY, PRO_AMOUNT: "1900000", PRO_CURRENCY: "NGN", PAYSTACK_PLAN_CODE: "PLN_test" });
let seenInit = null;
app.onOutside(async (u, init) => {
  if (u.endsWith("/transaction/initialize")) { seenInit = JSON.parse(init.body); return Response.json({ status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: "ref1" } }); }
  if (u.includes("/transaction/verify/")) return Response.json({ status: true, data: { status: "success", metadata: { user_id: app.userId }, customer: { customer_code: "CUS_1", email: "ada@startup.com" } } });
  if (u.includes("/manage/link")) return Response.json({ status: true, data: { link: "https://paystack.com/manage/xyz" } });
});
r = await app.call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW } });
app.userId = r.data.user.id;
r = await app.call("GET", "/config");
ok("config reports payments on", r.data.payments === true);
await runScan(app, "me/proj");
r = await app.call("GET", "/radar");
const before = ["strategic", "joiners", "investors"].reduce((n, l) => n + r.data.lanes[l].items.length, 0);
const lockedBefore = r.data.lanes.joiners.locked.length;
ok("Free: results are limited and some are locked", lockedBefore > 0 && before <= 3);

r = await app.call("POST", "/billing/checkout");
ok("checkout returns the Paystack link", r.status === 200 && r.data.url === "https://checkout.paystack.com/abc");
ok("checkout sends the right email, plan, amount and our user id", seenInit.email === "ada@startup.com" && seenInit.plan === "PLN_test" && seenInit.amount === 1900000 && seenInit.metadata.user_id === app.userId && /\?billing=return$/.test(seenInit.callback_url));

// webhook security
const evt = JSON.stringify({ event: "charge.success", data: { metadata: { user_id: app.userId }, customer: { customer_code: "CUS_1", email: "ada@startup.com" } } });
r = await app.call("POST", "/billing/webhook", { raw: evt, headers: { "x-paystack-signature": "0".repeat(128) } });
ok("webhook with a wrong signature is rejected", r.status === 401);
r = await app.call("GET", "/me");
ok("a forged webhook did not upgrade anyone", r.data.plan === "free");
r = await app.call("POST", "/billing/webhook", { raw: evt, headers: { "x-paystack-signature": await hmac(evt) } });
ok("a correctly signed webhook is accepted", r.status === 200 && r.data.result === "activated", JSON.stringify(r.data));
r = await app.call("GET", "/me");
ok("the account is now Pro", r.data.plan === "pro" && r.data.planLabel === "Pro" && r.data.usage.limit === 100 && r.data.subscription.status === "active");

r = await app.call("GET", "/radar");
const after = ["strategic", "joiners", "investors"].reduce((n, l) => n + r.data.lanes[l].items.length, 0);
ok("Pro: everything above the cutoff is unlocked, nothing is locked", after > before && ["strategic", "joiners", "investors"].every((l) => r.data.lanes[l].locked.length === 0));
const lockedRowId = r.data.lanes.joiners.items.at(-1).id;
r = await app.call("POST", `/matches/${lockedRowId}/draft`);
ok("Pro can draft outreach for every match", r.status === 200);

// verify-on-return path (what happens when the person comes back from Paystack)
const app2 = app;
r = await app2.call("POST", "/auth/signup", { body: { email: "bob@startup.com", password: PW }, as: "b" });
const bobId = r.data.user.id;
app.onOutside(async (u) => u.includes("/transaction/verify/") ? Response.json({ status: true, data: { status: "success", metadata: { user_id: app.userId }, customer: { customer_code: "CUS_9" } } }) : null);
r = await app2.call("GET", "/billing/verify?reference=ref1", { as: "b" });
ok("a payment made by someone else cannot upgrade Bob", r.status === 403);
r = await app2.call("GET", "/billing/verify", { as: "b" });
ok("verify without a reference is refused", r.status === 400);

// renewal / cancel / expiry
const sub = JSON.stringify({ event: "subscription.create", data: { subscription_code: "SUB_1", customer: { email: "ada@startup.com", customer_code: "CUS_1" }, next_payment_date: new Date(Date.now() + 30 * 864e5).toISOString() } });
await app.call("POST", "/billing/webhook", { raw: sub, headers: { "x-paystack-signature": await hmac(sub) } });
r = await app.call("GET", "/me");
ok("subscription code is saved so billing can be managed", r.data.subscription.manageable === true);
r = await app.call("POST", "/billing/portal");
ok("manage-billing link comes from Paystack", r.status === 200 && r.data.url === "https://paystack.com/manage/xyz");
r = await app.call("DELETE", "/me", { body: { password: PW } });
ok("account deletion is blocked while a paid subscription is active", r.status === 409);
const cancel = JSON.stringify({ event: "subscription.disable", data: { subscription_code: "SUB_1", customer: { email: "ada@startup.com" } } });
r = await app.call("POST", "/billing/webhook", { raw: cancel, headers: { "x-paystack-signature": await hmac(cancel) } });
r = await app.call("GET", "/me");
ok("after cancelling, Pro continues until the paid period ends", r.data.plan === "pro" && r.data.subscription.status === "cancelled");
app.env.DB.raw.prepare("UPDATE subscriptions SET current_period_end = ? WHERE user_id = ?").run(Math.floor(Date.now() / 1000) - 10, app.userId);
r = await app.call("GET", "/me");
ok("once the period has ended the account falls back to Free", r.data.plan === "free");
r = await app.call("GET", "/radar");
ok("and locked results are locked again", r.data.lanes.joiners.locked.length > 0 && r.data.lanes.joiners.items.length <= 1);
r = await app.call("DELETE", "/me", { body: { password: PW } });
ok("a cancelled, expired account can be deleted", r.status === 200);
app.restore();

// ---------------------------------------------------------------- admin and Claude
app = makeApp({ ADMIN_EMAILS: "owner@cleone.app", ANTHROPIC_API_KEY: "sk-ant-test" });
let claudeCalls = 0, claudeMode = "ok";
app.onOutside(async (u, init) => {
  if (!u.includes("api.anthropic.com")) return null;
  claudeCalls++;
  if (claudeMode === "fail") return new Response("nope", { status: 500 });
  const body = JSON.parse(init.body);
  const ids = [...body.messages[0].content.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
  return Response.json({ content: [{ type: "text", text: "```json\n" + JSON.stringify([...new Set(ids)].map((id) => ({ id, significance: 90, resonance: 90, timing: 90, why: "Claude says: strong fit." }))) + "\n```" }] });
});
r = await app.call("GET", "/config");
ok("config reports Claude when a key is set", r.data.scorer === "claude");
await app.call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW } });
await runScan(app, "me/proj");
ok("Free accounts never trigger paid Claude calls", claudeCalls === 0 && app.env.DB.raw.prepare("SELECT scorer FROM scans").get().scorer === "rules");
await app.call("POST", "/auth/signup", { body: { email: "owner@cleone.app", password: PW }, as: "o" });
r = await app.call("GET", "/me", { as: "o" });
ok("an ADMIN_EMAILS account is Pro without paying", r.data.plan === "pro" && r.data.admin === true);
await runScan(app, "me/proj", "o");
ok("Pro + key: Claude is used", claudeCalls > 0 && app.env.DB.raw.prepare("SELECT scorer FROM scans WHERE user_id = ?").get(r.data.user.id).scorer === "claude");
r = await app.call("GET", "/radar", { as: "o" });
ok("Claude's reasons are what the card shows", r.data.lanes.joiners.items[0].why === "Claude says: strong fit.");
claudeMode = "fail";
await runScan(app, "me/proj", "o");
r = await app.call("GET", "/radar", { as: "o" });
ok("if Claude fails the scan still finishes with rule-based scores", r.data.repo === "me/proj" && r.data.scorer === "rules" && r.data.lanes.joiners.items[0].why !== "Claude says: strong fit.");
app.restore();

// ---------------------------------------------------------------- password reset by email
app = makeApp({ RESEND_API_KEY: "re_test", MAIL_FROM: "Cleone <hello@cleone.app>" });
let mail = null;
app.onOutside(async (u, init) => { if (u.includes("api.resend.com")) { mail = JSON.parse(init.body); return Response.json({ id: "1" }); } return null; });
await app.call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: PW } });
await app.call("POST", "/auth/logout");
r = await app.call("POST", "/auth/forgot", { body: { email: "nobody@x.com" } });
ok("forgot-password reveals nothing about which emails exist", r.status === 200 && mail === null);
r = await app.call("POST", "/auth/forgot", { body: { email: "ada@startup.com" } });
const token = mail?.text.match(/\?reset=([\w-]+)/)?.[1];
ok("reset email is sent with a one-time link", r.data.emailed === true && !!token && mail.to[0] === "ada@startup.com");
r = await app.call("POST", "/auth/reset", { body: { token: "wrong", password: "brand new password" } });
ok("a wrong reset token is refused", r.status === 400);
r = await app.call("POST", "/auth/reset", { body: { token, password: "brand new password" } });
ok("the reset link sets a new password", r.status === 200);
r = await app.call("POST", "/auth/reset", { body: { token, password: "another password 2" } });
ok("a reset link cannot be used twice", r.status === 400);
r = await app.call("POST", "/auth/login", { body: { email: "ada@startup.com", password: "brand new password" } });
ok("login works with the new password", r.status === 200);
app.restore();

console.log(`\nbilling.test.js: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
