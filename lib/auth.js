// Accounts: passwords, sessions, throttling. Uses only the standard crypto that is built into Node.

import { HttpError, clientIp, now, parseCookies } from "./http.js";
import { PBKDF2_ITERATIONS, SESSION_DAYS } from "./config.js";

const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (buf) => toB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const randomToken = () => toB64Url(crypto.getRandomValues(new Uint8Array(32)));

async function derive(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: toB64(await derive(password, salt)), salt: toB64(salt) };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, hash, salt) {
  const got = new Uint8Array(await derive(password, fromB64(salt)));
  return sameBytes(got, fromB64(hash));
}

// ------------------------------------------------------------------ sessions

export async function createSession(env, req, userId) {
  const token = randomToken();
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, t, t + SESSION_DAYS * 86400, clientIp(req), (req.headers.get("user-agent") || "").slice(0, 200))
    .run();
  return token;
}

/** Returns the signed-in user row, or null. */
export async function currentUser(env, req) {
  const token = parseCookies(req).cleone_session;
  if (!token) return null;
  const sid = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?"
  ).bind(sid, now()).first();
  return row || null;
}

// ------------------------------------------------------------------ throttling

/** Allows `limit` hits per `windowSec` for a key. Throws 429 after that. */
export async function throttle(env, key, limit, windowSec) {
  const t = now();
  const row = await env.DB.prepare("SELECT window_start, count FROM throttle WHERE key = ?").bind(key).first();
  if (!row || t - row.window_start >= windowSec) {
    await env.DB.prepare("INSERT INTO throttle (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1").bind(key, t).run();
    return;
  }
  if (row.count >= limit) throw new HttpError(429, "Too many attempts. Please wait a while and try again.");
  await env.DB.prepare("UPDATE throttle SET count = count + 1 WHERE key = ?").bind(key).run();
}

export const validEmail = (e) => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
