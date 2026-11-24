// Lets the same backend run on Vercel (and any Node server). Vercel gives us a Node request and response;
// the backend speaks the web-standard Request and Response. This file converts between the two.

import { handle } from "./app.js";

const MAX_BODY = 100_000;

async function toRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.readableEnded && req.body !== undefined) {
      // The platform already read the body for us.
      body = typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
    } else {
      // Read the raw bytes. Payment webhooks are signed over the exact bytes, so they must not be re-encoded.
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw Object.assign(new Error("too large"), { tooLarge: true });
        chunks.push(c);
      }
      body = Buffer.concat(chunks);
    }
  }
  return new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body });
}

async function send(res, response) {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** getEnv() returns the settings object (including DB) the backend should use. */
export function createNodeHandler(getEnv) {
  return async function handler(req, res) {
    try {
      const request = await toRequest(req);
      await send(res, await handle(request, await getEnv()));
    } catch (e) {
      const tooLarge = e && e.tooLarge;
      if (!tooLarge) console.error(e);
      res.statusCode = tooLarge ? 413 : 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: tooLarge ? "Request too large" : "Something went wrong. Please try again." }));
    }
  };
}
