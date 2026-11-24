// The whole backend, independent of where it is hosted. Every request to /api/... arrives in handle() at the
// bottom and is sent to the matching handler. The Vercel entry file (api/[...path].js) is a thin wrapper that calls it.
// Each handler is short and does one thing. Rules and numbers live in lib/config.js.

import { HttpError, json, readJson, checkOrigin, sessionCookie, now, monthKey, clientIp } from "./http.js";
import { createSession, currentUser, hashPassword, randomToken, sha256Hex, throttle, validEmail, verifyPassword } from "./auth.js";
import { CUTOFF, PASSWORD_MIN, PLANS, PRICE_LABEL, SCANS_PER_HOUR, SESSION_DAYS } from "./config.js";
import { GitHubError, finishCandidates, makeGithub, parseRepo, stepEnrich, stepProfiles, stepRank, stepRepo, stepSignals } from "./engine.js";
import { draftEmail, rankLane, scoreCandidate, scoreWithClaude } from "./score.js";
import { activate, applyEvent, manageLink, paymentsEnabled, startCheckout, verifyTransaction, webhookValid } from "./billing.js";
import { emailEnabled, sendEmail } from "./mail.js";

const LANES = ["strategic", "joiners", "investors"];
const uuid = () => crypto.randomUUID();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

// ------------------------------------------------------------------ plans and usage

async function planOf(env, user) {
  const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const sub = await first(env.DB, "SELECT * FROM subscriptions WHERE user_id = ?", user.id);
  const paid = !!(sub && sub.current_period_end && sub.current_period_end > now());
  const admin = admins.includes(user.email);
  const name = admin || paid ? "pro" : "free";
  return { name, ...PLANS[name], sub, admin };
}

async function me(env, user) {
  const plan = await planOf(env, user);
  const u = await first(env.DB, "SELECT scans FROM usage WHERE user_id = ? AND month = ?", user.id, monthKey());
  return {
    user: { id: user.id, email: user.email, name: user.name },
    plan: plan.name,
    planLabel: plan.label,
    subscription: plan.sub ? { status: plan.sub.status, periodEnd: plan.sub.current_period_end, manageable: !!plan.sub.subscription_code } : null,
    admin: plan.admin,
    usage: { scans: u?.scans ?? 0, limit: plan.scansPerMonth },
    prefs: JSON.parse(user.prefs || "{}"),
  };
}

// ------------------------------------------------------------------ routes

const routes = [];
const add = (method, pattern, handler, auth = true) =>
  routes.push({ method, auth, handler, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$") });

// ---- public

add("GET", "/config", async ({ env }) =>
  json({
    payments: paymentsEnabled(env),
    email: emailEnabled(env),
    scorer: env.ANTHROPIC_API_KEY ? "claude" : "rules",
    price: PRICE_LABEL,
    cutoff: CUTOFF,
    plans: PLANS,
  }), false);

add("POST", "/auth/signup", async ({ env, req }) => {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.name || "").trim().slice(0, 80);
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address");
  if (typeof b.password !== "string" || b.password.length < PASSWORD_MIN) throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters`);
  if (b.password.length > 200) throw new HttpError(400, "Password is too long");
  await throttle(env, `signup:${clientIp(req)}`, 10, 3600);
  if (await first(env.DB, "SELECT 1 AS x FROM users WHERE email = ?", email)) throw new HttpError(409, "An account with that email already exists. Log in instead.");
  const { hash, salt } = await hashPassword(b.password);
  const id = uuid();
  await run(env.DB, "INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, email, name, hash, salt, now());
  const token = await createSession(env, req, id);
  const user = await first(env.DB, "SELECT * FROM users WHERE id = ?", id);
  return json(await me(env, user), 201, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}, false);

add("POST", "/auth/login", async ({ env, req }) => {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  await throttle(env, `login:${clientIp(req)}:${email}`, 8, 900);
  const user = await first(env.DB, "SELECT * FROM users WHERE email = ?", email);
  // Same work whether or not the account exists, so response time does not reveal which emails are registered.
  const ok = user
    ? await verifyPassword(String(b.password || ""), user.pw_hash, user.pw_salt)
    : (await verifyPassword("x", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "AAAAAAAAAAAAAAAAAAAAAA=="), false);
  if (!user || !ok) throw new HttpError(401, "Wrong email or password");
  const token = await createSession(env, req, user.id);
  return json(await me(env, user), 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}, false);

add("POST", "/auth/forgot", async ({ env, req }) => {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  await throttle(env, `forgot:${clientIp(req)}`, 5, 3600);
  const emailed = emailEnabled(env);
  if (emailed && validEmail(email)) {
    const user = await first(env.DB, "SELECT id FROM users WHERE email = ?", email);
    if (user) {
      const token = randomToken();
      await run(env.DB, "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256Hex(token), user.id, now() + 3600);
      await sendEmail(env, email, "Reset your Cleone password", `Use this link within one hour to choose a new password:\n\n${new URL(req.url).origin}/?reset=${token}\n\nIf you did not ask for this, you can ignore this email.`);
    }
  }
  return json({ ok: true, emailed });
}, false);

add("POST", "/auth/reset", async ({ env, req }) => {
  const b = await readJson(req);
  if (typeof b.password !== "string" || b.password.length < PASSWORD_MIN || b.password.length > 200) throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters`);
  const th = await sha256Hex(String(b.token || ""));
  const row = await first(env.DB, "SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?", th, now());
  if (!row) throw new HttpError(400, "This reset link has expired. Ask for a new one.");
  const { hash, salt } = await hashPassword(b.password);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(hash, salt, row.user_id),
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
  ]);
  return json({ ok: true });
}, false);

add("POST", "/waitlist", async ({ env, req }) => {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email");
  await throttle(env, `waitlist:${clientIp(req)}`, 10, 3600);
  await run(env.DB, "INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING", email, now());
  return json({ ok: true });
}, false);

add("POST", "/billing/webhook", async ({ env, req }) => {
  const raw = await req.text();
  if (!(await webhookValid(env, raw, req.headers.get("x-paystack-signature")))) throw new HttpError(401, "Bad signature");
  const result = await applyEvent(env, JSON.parse(raw));
  return json({ ok: true, result });
}, false);

// ---- account

add("POST", "/auth/logout", async ({ env, user }) => {
  await run(env.DB, "DELETE FROM sessions WHERE id = ?", user.session_id);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
});

add("POST", "/auth/logout-all", async ({ env, user }) => {
  await run(env.DB, "DELETE FROM sessions WHERE user_id = ?", user.id);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
});

add("POST", "/auth/password", async ({ env, req, user }) => {
  const b = await readJson(req);
  await throttle(env, `pw:${user.id}`, 8, 900);
  if (!(await verifyPassword(String(b.current || ""), user.pw_hash, user.pw_salt))) throw new HttpError(400, "Your current password is wrong");
  if (typeof b.next !== "string" || b.next.length < PASSWORD_MIN || b.next.length > 200) throw new HttpError(400, `New password must be at least ${PASSWORD_MIN} characters`);
  const { hash, salt } = await hashPassword(b.next);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(hash, salt, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, user.session_id), // sign out other devices
  ]);
  return json({ ok: true });
});

add("GET", "/me", async ({ env, user }) => json(await me(env, user)));

add("PATCH", "/me", async ({ env, req, user }) => {
  const b = await readJson(req);
  const prefs = JSON.parse(user.prefs || "{}");
  let name = user.name;
  if (typeof b.name === "string") name = b.name.trim().slice(0, 80);
  if (b.prefs && typeof b.prefs === "object") {
    if (["system", "light", "dark"].includes(b.prefs.theme)) prefs.theme = b.prefs.theme;
    if (typeof b.prefs.alerts === "boolean") prefs.alerts = b.prefs.alerts;
  }
  await run(env.DB, "UPDATE users SET name = ?, prefs = ? WHERE id = ?", name, JSON.stringify(prefs), user.id);
  return json(await me(env, { ...user, name, prefs: JSON.stringify(prefs) }));
});

add("DELETE", "/me", async ({ env, req, user }) => {
  const b = await readJson(req);
  if (!(await verifyPassword(String(b.password || ""), user.pw_hash, user.pw_salt))) throw new HttpError(400, "Your password is wrong");
  const plan = await planOf(env, user);
  if (plan.sub?.status === "active" && !plan.admin) throw new HttpError(409, "Cancel your subscription first (Settings, Manage billing), then delete your account.");
  await env.DB.batch(
    ["sessions", "subscriptions", "scans", "matches", "feedback", "outreach", "usage", "password_resets"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id))
      .concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id))
  );
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
});

add("GET", "/me/export", async ({ env, user }) => {
  const t = (sql) => all(env.DB, sql, user.id);
  const data = {
    exportedAt: new Date().toISOString(),
    user: { email: user.email, name: user.name, createdAt: user.created_at, prefs: JSON.parse(user.prefs || "{}") },
    scans: await t("SELECT id, repo, status, scorer, created_at, finished_at FROM scans WHERE user_id = ?"),
    matches: await t("SELECT repo, lane, name, kind, sig_text, url, score, why, contact, updated_at FROM matches WHERE user_id = ?"),
    feedback: await t("SELECT repo, k, lane, action, reason, created_at FROM feedback WHERE user_id = ?"),
    outreach: await t("SELECT repo, name, lane, score, created_at, replied FROM outreach WHERE user_id = ?"),
    usage: await t("SELECT month, scans FROM usage WHERE user_id = ?"),
  };
  return json(data, 200, { "content-disposition": 'attachment; filename="cleone-export.json"' });
});

// ---- scans

add("GET", "/scans", async ({ env, user }) =>
  json({ scans: await all(env.DB, "SELECT repo, MAX(finished_at) AS last_at FROM scans WHERE user_id = ? AND status = 'done' GROUP BY repo ORDER BY last_at DESC LIMIT 8", user.id) }));

add("POST", "/scans", async ({ env, req, user }) => {
  const b = await readJson(req);
  let repo;
  try {
    const p = parseRepo(b.repo);
    repo = `${p.owner}/${p.name}`;
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  // Resume a scan already in progress for the same repo.
  const live = await first(env.DB, "SELECT id, stage FROM scans WHERE user_id = ? AND repo = ? AND status = 'running' AND created_at > ?", user.id, repo, now() - 600);
  if (live) return json({ id: live.id, stage: live.stage });
  const plan = await planOf(env, user);
  const used = (await first(env.DB, "SELECT scans FROM usage WHERE user_id = ? AND month = ?", user.id, monthKey()))?.scans ?? 0;
  if (used >= plan.scansPerMonth) {
    throw new HttpError(402, plan.name === "free" ? `You have used your ${plan.scansPerMonth} free scans this month. Upgrade to Pro to keep scanning.` : "You have reached this month's scan limit.");
  }
  const recent = (await first(env.DB, "SELECT COUNT(*) AS n FROM scans WHERE user_id = ? AND created_at > ?", user.id, now() - 3600)).n;
  if (recent >= SCANS_PER_HOUR) throw new HttpError(429, "That is a lot of scans in an hour. Please wait a little.");
  const id = uuid();
  await run(env.DB, "INSERT INTO scans (id, user_id, repo, status, stage, created_at) VALUES (?, ?, ?, 'running', 'repo', ?)", id, user.id, repo, now());
  return json({ id, stage: "repo" }, 201);
});

// Which of the four progress lines in the app each stage belongs to.
const LINE = { repo: 0, signals: 1, profiles: 2, rank: 2, enrich: 2, finish: 3, done: 4 };

add("POST", "/scans/:id/step", async ({ env, params, user }) => {
  const scan = await first(env.DB, "SELECT * FROM scans WHERE id = ? AND user_id = ?", params.id, user.id);
  if (!scan) throw new HttpError(404, "Scan not found");
  if (scan.status !== "running") return json({ stage: scan.stage, line: LINE[scan.stage] ?? 4, done: scan.status === "done", error: scan.error });

  const gh = makeGithub(env.GITHUB_TOKEN);
  let state = JSON.parse(scan.state || "{}");
  let next;
  try {
    switch (scan.stage) {
      case "repo":
        state = await stepRepo(gh, scan.repo);
        next = "signals";
        break;
      case "signals":
        await stepSignals(gh, state);
        next = "profiles";
        break;
      case "profiles":
        next = (await stepProfiles(gh, state)) > 0 ? "profiles" : "rank";
        break;
      case "rank":
        stepRank(state);
        next = state.enrichLogins.length ? "enrich" : "finish";
        break;
      case "enrich":
        next = (await stepEnrich(gh, state)) > 0 ? "enrich" : "finish";
        break;
      case "finish": {
        const scorer = await finishScan(env, user, scan, state);
        await run(env.DB, "UPDATE scans SET status = 'done', stage = 'done', state = '{}', scorer = ?, finished_at = ? WHERE id = ?", scorer, Date.now(), scan.id);
        return json({ stage: "done", line: 4, done: true, calls: gh.calls() });
      }
      default:
        throw new Error(`Unknown stage ${scan.stage}`);
    }
  } catch (e) {
    const message = e instanceof GitHubError || /not found|repo like|Only github/.test(e.message) ? e.message : "The scan could not finish. Please try again.";
    if (!(e instanceof GitHubError) && !/not found|repo like|Only github/.test(e.message)) console.error("scan failed", e);
    await run(env.DB, "UPDATE scans SET status = 'failed', error = ?, state = '{}', finished_at = ? WHERE id = ?", message, Date.now(), scan.id);
    throw new HttpError(e instanceof GitHubError && e.status === 404 ? 404 : 502, message);
  }
  await run(env.DB, "UPDATE scans SET stage = ?, state = ? WHERE id = ?", next, JSON.stringify(state), scan.id);
  return json({ stage: next, line: LINE[next], done: false, calls: gh.calls() });
});

/** Scores the candidates and saves them. Returns which scorer was used. */
async function finishScan(env, user, scan, state) {
  const plan = await planOf(env, user);
  const candidates = finishCandidates(state);
  let scorer = "rules";
  let scores = candidates.map((c) => scoreCandidate(c));
  // Claude only for Pro, only when a key is set. Any failure falls back to the rules above.
  if (env.ANTHROPIC_API_KEY && plan.name === "pro" && candidates.length) {
    try {
      const claude = await scoreWithClaude(env, state.project, candidates);
      if (claude.length === candidates.length) {
        scores = claude.sort((a, b) => a.id - b.id);
        scorer = "claude";
      }
    } catch (e) {
      console.error("claude scoring failed, using rules", e.message);
    }
  }
  const t = now();
  const project = { owner: state.project.owner, name: state.project.name, description: state.project.description };
  const upsert = env.DB.prepare(
    `INSERT INTO matches (id, user_id, repo, k, lane, source, name, kind, sig_text, url, score, sig, res, tim, why, contact, meta, scan_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, repo, k) DO UPDATE SET
       lane = excluded.lane, source = excluded.source, name = excluded.name, kind = excluded.kind, sig_text = excluded.sig_text,
       url = excluded.url, score = excluded.score, sig = excluded.sig, res = excluded.res, tim = excluded.tim, why = excluded.why,
       contact = excluded.contact, meta = excluded.meta, scan_id = excluded.scan_id, updated_at = excluded.updated_at`
  );
  const statements = candidates.map((c, i) => {
    const s = scores[i];
    return upsert.bind(uuid(), user.id, scan.repo, c.key, c.lane, c.source, c.name, c.kind, c.sigText, c.url, s.score, s.significance, s.resonance, s.timing, s.why, c.contact, JSON.stringify({ ...c.meta, project }), scan.id, t);
  });
  statements.push(env.DB.prepare("DELETE FROM matches WHERE user_id = ? AND repo = ? AND scan_id != ?").bind(user.id, scan.repo, scan.id));
  statements.push(
    env.DB.prepare("INSERT INTO usage (user_id, month, scans) VALUES (?, ?, 1) ON CONFLICT(user_id, month) DO UPDATE SET scans = usage.scans + 1").bind(user.id, monthKey())
  );
  await env.DB.batch(statements);
  return scorer;
}

// ---- radar (the results screen). The paywall is enforced here, on the server.

async function radarFor(env, user, plan, repo) {
  const rows = await all(env.DB, "SELECT * FROM matches WHERE user_id = ? AND repo = ?", user.id, repo);
  const dismissed = new Set((await all(env.DB, "SELECT k FROM feedback WHERE user_id = ? AND repo = ? AND action = 'dismiss'", user.id, repo)).map((r) => r.k));
  const weights = {};
  for (const r of await all(
    env.DB,
    "SELECT source, SUM(CASE WHEN action = 'like' THEN 1 WHEN action = 'dismiss' AND reason = 'Not relevant' THEN -1 ELSE 0 END) AS w FROM feedback WHERE user_id = ? GROUP BY source",
    user.id
  )) weights[r.source] = r.w;
  const lanes = {};
  for (const lane of LANES) lanes[lane] = rankLane(rows.filter((r) => r.lane === lane), dismissed, weights, plan.visiblePerLane);
  return { rows, lanes };
}

add("GET", "/radar", async ({ env, url, user }) => {
  const asked = url.searchParams.get("repo");
  const latest = asked
    ? await first(env.DB, "SELECT repo, scorer, finished_at FROM scans WHERE user_id = ? AND status = 'done' AND repo = ? ORDER BY finished_at DESC LIMIT 1", user.id, asked)
    : await first(env.DB, "SELECT repo, scorer, finished_at FROM scans WHERE user_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 1", user.id);
  if (!latest) return json({ repo: null });
  const repo = latest.repo;
  const plan = await planOf(env, user);
  const { lanes } = await radarFor(env, user, plan, repo);
  const out = {};
  for (const lane of LANES) {
    out[lane] = {
      below: lanes[lane].below,
      locked: lanes[lane].locked, // only {high: true/false}; no names, no scores, nothing to unblur
      items: lanes[lane].open.map((r) => ({ id: r.id, name: r.name, kind: r.kind, sig: r.sig_text, score: r.score, sig_: r.sig, res: r.res, tim: r.tim, why: r.why })),
    };
  }
  return json({ repo, scannedAt: latest.finished_at, scorer: latest.scorer, plan: plan.name, cutoff: CUTOFF, lanes: out });
});

// ---- actions on a match

async function ownMatch(env, user, id) {
  const m = await first(env.DB, "SELECT * FROM matches WHERE id = ? AND user_id = ?", id, user.id);
  if (!m) throw new HttpError(404, "Match not found");
  return { ...m, meta: JSON.parse(m.meta || "{}") };
}

add("POST", "/matches/:id/feedback", async ({ env, req, params, user }) => {
  const b = await readJson(req);
  if (b.action !== "like" && b.action !== "dismiss") throw new HttpError(400, "Unknown action");
  const m = await ownMatch(env, user, params.id);
  await run(env.DB, "INSERT INTO feedback (user_id, repo, k, lane, source, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", user.id, m.repo, m.k, m.lane, m.source, b.action, String(b.reason || "").slice(0, 60) || null, now());
  return json({ ok: true });
});

add("POST", "/matches/:id/draft", async ({ env, params, user }) => {
  const m = await ownMatch(env, user, params.id);
  const plan = await planOf(env, user);
  // A locked match cannot be drafted for, even if someone guesses its id.
  const { lanes } = await radarFor(env, user, plan, m.repo);
  if (!lanes[m.lane].open.some((r) => r.id === m.id)) throw new HttpError(403, "Upgrade to Pro to unlock this match.");
  return json({ email: draftEmail(m.meta.project || { owner: "", name: m.repo, description: "" }, m), contact: m.contact });
});

add("POST", "/matches/:id/copied", async ({ env, params, user }) => {
  const m = await ownMatch(env, user, params.id);
  const dup = await first(env.DB, "SELECT 1 AS x FROM outreach WHERE user_id = ? AND repo = ? AND k = ? AND created_at > ?", user.id, m.repo, m.k, now() - 86400);
  if (!dup) await run(env.DB, "INSERT INTO outreach (id, user_id, repo, k, name, lane, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuid(), user.id, m.repo, m.k, m.name, m.lane, m.score, now());
  return json({ ok: true });
});

// ---- outreach log: how scores get checked against who actually replies

add("GET", "/outreach", async ({ env, user }) => {
  const rows = await all(env.DB, "SELECT id, repo, name, lane, score, created_at, replied FROM outreach WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", user.id);
  const bands = [["75 to 79", 75, 80], ["80 to 89", 80, 90], ["90 and up", 90, 101]].map(([label, lo, hi]) => {
    const inBand = rows.filter((r) => r.score >= lo && r.score < hi);
    return { label, sent: inBand.length, replied: inBand.filter((r) => r.replied).length };
  });
  return json({ items: rows, bands });
});

add("POST", "/outreach/:id/replied", async ({ env, req, params, user }) => {
  const b = await readJson(req);
  const r = await run(env.DB, "UPDATE outreach SET replied = ?, replied_at = ? WHERE id = ? AND user_id = ?", b.replied ? 1 : 0, b.replied ? now() : null, params.id, user.id);
  if (!r.meta?.changes) throw new HttpError(404, "Not found");
  return json({ ok: true });
});

// ---- billing

add("POST", "/billing/checkout", async ({ env, req, user }) => {
  if (!paymentsEnabled(env)) throw new HttpError(503, "Payments are not switched on yet.");
  const plan = await planOf(env, user);
  if (plan.name === "pro") throw new HttpError(409, "You are already on Pro.");
  try {
    return json({ url: await startCheckout(env, user, new URL(req.url).origin) });
  } catch (e) {
    console.error("checkout failed", e.message);
    throw new HttpError(502, "Could not start checkout. Please try again.");
  }
});

add("GET", "/billing/verify", async ({ env, url, user }) => {
  const reference = url.searchParams.get("reference");
  if (!reference || !paymentsEnabled(env)) throw new HttpError(400, "Nothing to verify");
  let tx;
  try {
    tx = await verifyTransaction(env, reference);
  } catch {
    throw new HttpError(502, "Could not confirm the payment yet. It may take a minute.");
  }
  if (tx.status !== "success") throw new HttpError(402, "The payment was not completed.");
  if (tx.metadata?.user_id !== user.id) throw new HttpError(403, "This payment belongs to another account.");
  await activate(env, user.id, tx);
  return json(await me(env, user));
});

add("POST", "/billing/portal", async ({ env, user }) => {
  const sub = await first(env.DB, "SELECT subscription_code FROM subscriptions WHERE user_id = ?", user.id);
  if (!sub?.subscription_code || !paymentsEnabled(env)) throw new HttpError(404, "No subscription to manage yet.");
  try {
    return json({ url: await manageLink(env, sub.subscription_code) });
  } catch {
    throw new HttpError(502, "Could not open billing. Please try again.");
  }
});

// ------------------------------------------------------------------ entry point

export async function handle(req, env) {
  try {
    if (!env.DB) throw new HttpError(500, "The database is not connected. See the README, step 2 (the Neon database).");
    checkOrigin(req);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const user = r.auth ? await currentUser(env, req) : null;
      if (r.auth && !user) throw new HttpError(401, "Please log in");
      return await r.handler({ req, env, url, params: m.groups || {}, user });
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
