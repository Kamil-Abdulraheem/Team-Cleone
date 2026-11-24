// Subscriptions through Paystack (works for Nigerian businesses; Stripe does not).
// Nothing here is live until you add PAYSTACK_SECRET_KEY, PRO_AMOUNT and PAYSTACK_PLAN_CODE in Vercel.
//
// Flow: the app asks for a checkout link -> the person pays on Paystack's page -> Paystack sends them back here
// and also calls our webhook. Either one switches Pro on. The webhook is what keeps renewals and cancellations right.

import { now } from "./http.js";

const PS = "https://api.paystack.co";
const PERIOD = 31 * 86400; // Pro lasts this long after each successful payment

export const paymentsEnabled = (env) => !!(env.PAYSTACK_SECRET_KEY && env.PRO_AMOUNT && env.PAYSTACK_PLAN_CODE);

async function ps(env, path, init = {}) {
  const res = await fetch(PS + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw new Error(data.message || `Paystack returned ${res.status}`);
  return data.data;
}

export async function startCheckout(env, user, origin) {
  const d = await ps(env, "/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: user.email,
      amount: Number(env.PRO_AMOUNT), // in the smallest unit (kobo or cents)
      currency: env.PRO_CURRENCY || "NGN",
      plan: env.PAYSTACK_PLAN_CODE,
      callback_url: `${origin}/?billing=return`,
      metadata: { user_id: user.id },
    }),
  });
  return d.authorization_url;
}

export async function verifyTransaction(env, reference) {
  return ps(env, `/transaction/verify/${encodeURIComponent(reference)}`);
}

export async function manageLink(env, subscriptionCode) {
  const d = await ps(env, `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`);
  return d.link;
}

/** Paystack signs every webhook with HMAC-SHA512 of the raw body. */
export async function webhookValid(env, rawBody, signature) {
  if (!env.PAYSTACK_SECRET_KEY || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PAYSTACK_SECRET_KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function setSubscription(env, userId, f) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, provider, customer_code, subscription_code, status, current_period_end, updated_at)
     VALUES (?, 'paystack', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       customer_code = COALESCE(excluded.customer_code, subscriptions.customer_code),
       subscription_code = COALESCE(excluded.subscription_code, subscriptions.subscription_code),
       status = excluded.status,
       current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
       updated_at = excluded.updated_at`
  ).bind(userId, f.customer_code ?? null, f.subscription_code ?? null, f.status, f.current_period_end ?? null, now()).run();
}

/** A successful payment switches Pro on for one more period. */
export const activate = (env, userId, data) =>
  setSubscription(env, userId, {
    status: "active",
    customer_code: data?.customer?.customer_code,
    subscription_code: data?.plan_object?.subscription_code || data?.subscription_code,
    current_period_end: now() + PERIOD,
  });

async function findUser(env, data) {
  const byMeta = data?.metadata?.user_id;
  if (byMeta) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(byMeta).first();
    if (u) return u.id;
  }
  const code = data?.subscription_code || data?.subscription?.subscription_code;
  if (code) {
    const s = await env.DB.prepare("SELECT user_id FROM subscriptions WHERE subscription_code = ?").bind(code).first();
    if (s) return s.user_id;
  }
  const email = String(data?.customer?.email || "").toLowerCase();
  if (email) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (u) return u.id;
  }
  return null;
}

/** Handles the Paystack events that matter. Returns what it did, for the logs. */
export async function applyEvent(env, event) {
  const data = event.data || {};
  const userId = await findUser(env, data);
  if (!userId) return "no matching user";
  switch (event.event) {
    case "charge.success":
      await activate(env, userId, data);
      return "activated";
    case "subscription.create":
      await setSubscription(env, userId, {
        status: "active",
        customer_code: data.customer?.customer_code,
        subscription_code: data.subscription_code,
        current_period_end: data.next_payment_date ? Math.floor(new Date(data.next_payment_date).getTime() / 1000) : now() + PERIOD,
      });
      return "subscription created";
    case "subscription.disable":
    case "subscription.not_renew":
      // Cancelled: Pro stays until the end of the period already paid for.
      await setSubscription(env, userId, { status: "cancelled" });
      return "cancelled";
    case "invoice.payment_failed":
      await setSubscription(env, userId, { status: "past_due" });
      return "payment failed";
    default:
      return "ignored";
  }
}
