// Runs the Vercel wrapper inside a real HTTP server, to prove the Node <-> web conversion is right.
import http from "node:http";
import fs from "node:fs";
import { createNodeHandler, originalUrl } from "../lib/node.js";
import { makeApp } from "./harness.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const KEY = "sk_test_secret";
const realFetch = globalThis.fetch; // the harness replaces fetch for outside calls; the client below needs the real one
const app = await makeApp({ PAYSTACK_SECRET_KEY: KEY, PRO_AMOUNT: "1", PAYSTACK_PLAN_CODE: "P" });
const server = http.createServer(createNodeHandler(async () => app.env)).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const host = `127.0.0.1:${server.address().port}`;
const hdr = (extra = {}) => ({ "x-forwarded-proto": "https", origin: `https://${host}`, "content-type": "application/json", ...extra });
const call = (method, path, body, headers) => realFetch(base + path, { method, headers: hdr(headers), body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

let r = await call("GET", "/api/config");
ok("GET works through the wrapper", r.status === 200 && (await r.json()).payments === true);
r = await call("GET", "/api/nope");
ok("unknown route gives a clean 404", r.status === 404 && (await r.json()).error === "Not found");

r = await call("POST", "/api/auth/signup", { email: "ada@startup.com", password: "correct horse battery", name: "Ada" });
const cookie = r.headers.get("set-cookie") || "";
const body = await r.json();
ok("signup returns 201 and a secure, HttpOnly session cookie", r.status === 201 && /cleone_session=/.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie));
const session = cookie.split(";")[0];
r = await call("GET", "/api/me", undefined, { cookie: session });
ok("the cookie logs the person in on the next request", r.status === 200 && (await r.json()).user.name === "Ada");
r = await call("GET", "/api/me");
ok("without the cookie it is refused", r.status === 401);

r = await call("PATCH", "/api/me", { name: "Hacked" }, { cookie: session, origin: "https://evil.example" });
ok("a request from another website is blocked (host is rebuilt correctly)", r.status === 403);

r = await call("POST", "/api/auth/login", "{ not json", {});
ok("broken JSON gives a 400, not a crash", r.status === 400);
r = await call("POST", "/api/auth/login", "x".repeat(150_000), {});
ok("an oversized body is refused", r.status === 413);

// payment webhooks are signed over the exact bytes: the wrapper must not alter them
const raw = `{"event":"charge.success",   "data":{"metadata":{"user_id":"${body.user.id}"},"customer":{"email":"ada@startup.com"}}}`; // odd spacing on purpose
const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
r = await call("POST", "/api/billing/webhook", raw, { "x-paystack-signature": sig });
ok("a signed webhook with unusual spacing verifies (raw bytes preserved)", r.status === 200, await r.text());
r = await call("GET", "/api/me", undefined, { cookie: session });
ok("and the account is now Pro", (await r.json()).plan === "pro");
r = await call("POST", "/api/billing/webhook", raw.replace("charge", "chargf"), { "x-paystack-signature": sig });
ok("a tampered webhook is rejected", r.status === 401);

r = await call("POST", "/api/auth/logout", undefined, { cookie: session });
ok("logout clears the cookie", /Max-Age=0/.test(r.headers.get("set-cookie") || ""));


// ---- routing: every /api/... path must reach the one function file
{
  const cfg = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const fn = Object.keys(cfg.functions)[0];
  ok("vercel.json: the function file it configures exists", fs.existsSync(new URL("../" + fn, import.meta.url)) && fn === "api/index.js");
  ok("vercel.json: all /api paths (any depth) are rewritten to that function with the path kept", cfg.rewrites.some((r) => r.source === "/api/:path*" && r.destination === "/api/index?path=:path*"));
  ok("vercel.json: the cron path goes through the same rewrite", cfg.crons.every((c) => c.path.startsWith("/api/")));
  ok("no catch-all filename is used (it is not reliably routed for nested paths)", !fs.readdirSync(new URL("../api", import.meta.url)).some((f) => f.includes("[")));
  ok("original path is rebuilt from the rewrite", originalUrl("/api/index?path=auth/login") === "/api/auth/login" && originalUrl("/api/index?path=activity&limit=2") === "/api/activity?limit=2" && originalUrl("/api/index?path=jobs/abc/draft") === "/api/jobs/abc/draft" && originalUrl("/api/index") === "/api" && originalUrl("/api?path=") === "/api");
  ok("a path the platform already kept is left alone", originalUrl("/api/auth/login") === "/api/auth/login" && originalUrl("/api/activity?limit=3") === "/api/activity?limit=3");
  let rr = await call("GET", "/api/index?path=config");
  ok("a rewritten GET reaches the right route", rr.status === 200 && (await rr.json()).payments !== undefined);
  rr = await call("GET", "/api/index?path=health");
  ok("a rewritten /api/health works", rr.status === 200 && (await rr.json()).app === "cleone");
  rr = await call("POST", "/api/index?path=auth/signup", { email: "rw@startup.com", password: "correct horse battery", name: "Rw" });
  const cookie = (rr.headers.get("set-cookie") || "").split(";")[0];
  ok("a rewritten nested POST (signup) works and sets the session cookie", rr.status === 201 && cookie.includes("="), String(rr.status));
  rr = await call("GET", "/api/index?path=activity&limit=1", undefined, { cookie });
  ok("a rewritten GET keeps its own query string and the login cookie", rr.status === 200 && Array.isArray((await rr.json()).items));
}

server.close();
await app.restore();
console.log(`\nvercel.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
