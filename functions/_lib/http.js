// Small helpers shared by every API route.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

export const sessionCookie = (value, maxAge) =>
  `cleone_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Reads a small JSON body. Throws a clear 400 on anything else. */
export async function readJson(req) {
  const text = await req.text();
  if (text.length > 20000) throw new HttpError(413, "Request too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid request");
  }
}

/** Blocks browser requests that come from another website. */
export function checkOrigin(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) throw new HttpError(403, "Cross-site request blocked");
}

export const clientIp = (req) => req.headers.get("cf-connecting-ip") || "local";
export const now = () => Math.floor(Date.now() / 1000);
export const monthKey = () => new Date().toISOString().slice(0, 7);
