// Calls the real backend exactly like Cloudflare would, with a fake database and a fake GitHub.
import { makeD1 } from "./d1.js";
import { mockGithub } from "./mockgithub.js";
import { onRequest } from "../functions/api/[[path]].js";

export function makeApp(extraEnv = {}) {
  const gh = mockGithub();
  const realFetch = globalThis.fetch;
  const handlers = [];
  // Anything that is not GitHub goes to a stub chosen by the test (Paystack, Anthropic, Resend).
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com")) return gh.fetch(u, init);
    for (const h of handlers) { const r = await h(u, init); if (r) return r; }
    throw new Error(`Unexpected outside call to ${u}`);
  };
  const env = { DB: makeD1(), GITHUB_TOKEN: "test-token", ...extraEnv };
  const jars = new Map();
  async function call(method, path, { body, as = "a", headers = {}, raw } = {}) {
    const jar = jars.get(as) || { cookie: "" };
    jars.set(as, jar);
    const h = { origin: "https://app.test", "cf-connecting-ip": `10.0.0.${as.charCodeAt(0) % 200}`, ...headers };
    if (jar.cookie) h.cookie = jar.cookie;
    const init = { method, headers: h };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) { init.body = JSON.stringify(body); h["content-type"] = "application/json"; }
    const res = await onRequest({ request: new Request(`https://app.test/api${path}`, init), env });
    const sc = res.headers.get("set-cookie");
    if (sc) jar.cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text };
  }
  return { call, env, gh, onOutside: (h) => handlers.unshift(h), restore: () => (globalThis.fetch = realFetch), jars };
}

export async function runScan(app, repo, as = "a", maxSteps = 30) {
  const start = await app.call("POST", "/scans", { body: { repo }, as });
  if (start.status >= 400) return { start };
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = await app.call("POST", `/scans/${start.data.id}/step`, { as });
    steps.push({ status: r.status, ...(r.data || {}) });
    if (r.status >= 400 || r.data.done) break;
  }
  return { start, steps };
}
