// The one place every source request goes through: timeout, retries with backoff, per-host rate limiting.
// A failure here throws a SourceError carrying the HTTP status, so it can be logged and shown in the admin dashboard.

export const HTTP = { timeoutMs: 12000, retries: 2, backoffMs: 500, minGapMs: 400, maxBytes: 5_000_000 };
export const USER_AGENT = "CleoneJobRadar/1.0 (+https://github.com/Kamil-Abdulraheem/Team-Cleone; job discovery; respects robots.txt)";

export class SourceError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const lastHit = new Map(); // host -> time of the last request, so one site is never hammered
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeWait(host) {
  const wait = (lastHit.get(host) || 0) + HTTP.minGapMs - Date.now();
  lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) || 0) + HTTP.minGapMs));
  if (wait > 0) await sleep(wait);
}

/**
 * GET a URL. Returns { res, text, status, ms, attempts }. Retries network errors, 429 and 5xx (honouring Retry-After up to 5s).
 * 4xx other than 429 are not retried: they will not get better.
 */
export async function getText(url, { fetchImpl = fetch, headers = {} } = {}) {
  const host = new URL(url).host;
  let last;
  for (let attempt = 1; attempt <= HTTP.retries + 1; attempt++) {
    await politeWait(host);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5", ...headers },
        redirect: "follow",
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(HTTP.timeoutMs) : undefined,
      });
      const ms = Date.now() - t0;
      if (res.status === 429 || res.status >= 500) {
        const ra = Math.min(5000, (+res.headers?.get?.("retry-after") || 0) * 1000);
        last = new SourceError(`HTTP ${res.status}`, { status: res.status, retryable: true });
        if (attempt <= HTTP.retries) { await sleep(Math.max(ra, HTTP.backoffMs * 2 ** (attempt - 1))); continue; }
        throw last;
      }
      if (!res.ok) throw new SourceError(`HTTP ${res.status}`, { status: res.status });
      const text = String(await res.text()).slice(0, HTTP.maxBytes);
      return { res, text, status: res.status, ms, attempts: attempt };
    } catch (e) {
      if (e instanceof SourceError && !e.retryable) throw e;
      last = e instanceof SourceError ? e : new SourceError(e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${HTTP.timeoutMs / 1000}s` : `network error: ${e?.message || e}`, { retryable: true });
      if (attempt <= HTTP.retries) { await sleep(HTTP.backoffMs * 2 ** (attempt - 1)); continue; }
      throw last;
    }
  }
  throw last;
}

export async function getJson(url, opts) {
  const r = await getText(url, opts);
  try { return { ...r, json: JSON.parse(r.text) }; } catch { throw new SourceError("the response was not valid JSON (the format may have changed)", { status: r.status }); }
}
