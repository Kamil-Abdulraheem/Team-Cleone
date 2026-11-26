// Job source adapters. Each adapter is independent and turns one kind of source into the SAME vacancy shape:
//
//   { external_id, url, title, company, location, remote, employment_type, salary_min, salary_max, currency,
//     description, tags, posted_at, valid_through, department }
//
// The matching engine only ever sees that shape, so adding a source means adding one entry to ADAPTERS below and
// nothing else. An adapter is: { id, label, kind, fields, validate(config), fetch(config, ctx) -> { jobs, http } }.
//   kind "ats"        the employer's own applicant tracking system: if a job is listed, it is open right now.
//   kind "feed"       RSS or a public feed. Listed does not mean open, so we still check the apply page.
//   kind "career"     an employer career page, only with the employer's authorization.
//   kind "aggregator" a public job board feed.
//   kind "partner"    needs approved access. Disabled until the owner of the data approves it.

import { SourceError, USER_AGENT, getJson, getText } from "./http.js";
import { stripHtml } from "../jobs.js";

const num = (x) => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : null);
const epoch = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const t = typeof x === "number" ? (x > 1e12 ? x / 1000 : x) : Date.parse(x) / 1000;
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
};
const unescapeHtml = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isRemote = (s) => /\b(remote|work from home|anywhere|telecommut)/i.test(String(s || ""));
const EMPLOYMENT = (s) => {
  const t = String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  return /fulltime/.test(t) ? "full-time" : /parttime/.test(t) ? "part-time" : /contract|freelance|temporary|temp/.test(t) ? "contract" : /intern/.test(t) ? "internship" : "";
};
const toYear = (n, unit) => {
  const u = String(unit || "").toLowerCase();
  return !n ? null : /hour/.test(u) ? Math.round(n * 2080) : /month/.test(u) ? Math.round(n * 12) : /week/.test(u) ? Math.round(n * 52) : Math.round(n);
};
const need = (config, ...keys) => keys.filter((k) => !String(config?.[k] || "").trim()).map((k) => `${k} is required`).join(", ") || null;
const safeToken = (s) => /^[A-Za-z0-9._-]{1,80}$/.test(String(s || ""));

// ------------------------------------------------------------------ ATS adapters (public job-board APIs)

const greenhouse = {
  id: "greenhouse", label: "Greenhouse", kind: "ats",
  fields: [{ key: "board", label: "Board token (the name in boards.greenhouse.io/<token>)", required: true }, { key: "company", label: "Company name" }],
  validate: (c) => need(c, "board") || (safeToken(c.board) ? null : "board token has unexpected characters"),
  key: (c) => c.board,
  async fetch(c, { fetchImpl }) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.board)}/jobs?content=true`;
    const r = await getJson(url, { fetchImpl });
    if (!Array.isArray(r.json?.jobs)) throw new SourceError("unexpected response: no jobs list", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.jobs.map((j) => ({
      external_id: String(j.id), url: j.absolute_url, title: j.title, company: c.company || c.board, location: j.location?.name || "",
      remote: isRemote(j.location?.name), description: stripHtml(unescapeHtml(j.content)), tags: (j.departments || []).map((d) => d.name).join(","),
      department: (j.departments || [])[0]?.name || "", posted_at: epoch(j.first_published || j.updated_at) })) };
  },
};

const lever = {
  id: "lever", label: "Lever", kind: "ats",
  fields: [{ key: "company", label: "Company slug (the name in jobs.lever.co/<slug>)", required: true }, { key: "name", label: "Company display name" }, { key: "region", label: "Region: us (default) or eu" }],
  validate: (c) => need(c, "company") || (safeToken(c.company) ? null : "company slug has unexpected characters"),
  key: (c) => c.company,
  async fetch(c, { fetchImpl }) {
    const host = c.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    const url = `https://${host}/v0/postings/${encodeURIComponent(c.company)}?mode=json`;
    const r = await getJson(url, { fetchImpl });
    if (!Array.isArray(r.json)) throw new SourceError("unexpected response: expected a list of postings", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.map((j) => ({
      external_id: j.id, url: j.hostedUrl || j.applyUrl, title: j.text, company: c.name || c.company, location: j.categories?.location || (j.country || ""),
      remote: j.workplaceType === "remote" || isRemote(j.categories?.location), employment_type: EMPLOYMENT(j.categories?.commitment),
      description: [j.descriptionPlain || stripHtml(j.description), ...(j.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n"),
      tags: [j.categories?.team, j.categories?.department].filter(Boolean).join(","), department: j.categories?.department || j.categories?.team || "", posted_at: epoch(j.createdAt),
      salary_min: j.salaryRange ? toYear(num(j.salaryRange.min), j.salaryRange.interval) : null, salary_max: j.salaryRange ? toYear(num(j.salaryRange.max), j.salaryRange.interval) : null,
      currency: j.salaryRange?.currency || "" })) };
  },
};

const ashby = {
  id: "ashby", label: "Ashby", kind: "ats",
  fields: [{ key: "board", label: "Job board name (the name in jobs.ashbyhq.com/<name>)", required: true }, { key: "company", label: "Company name" }],
  validate: (c) => need(c, "board") || (safeToken(c.board) ? null : "board name has unexpected characters"),
  key: (c) => c.board,
  async fetch(c, { fetchImpl }) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.board)}?includeCompensation=true`;
    const r = await getJson(url, { fetchImpl });
    if (!Array.isArray(r.json?.jobs)) throw new SourceError("unexpected response: no jobs list", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.jobs.filter((j) => j.isListed !== false).map((j) => {
      const sal = (j.compensation?.summaryComponents || []).find((x) => /salary/i.test(x.compensationType || ""));
      return { external_id: j.id, url: j.jobUrl || j.applyUrl, title: j.title, company: c.company || c.board, location: j.location || "", remote: !!j.isRemote || isRemote(j.location),
        employment_type: EMPLOYMENT(j.employmentType), description: j.descriptionPlain || stripHtml(j.descriptionHtml), tags: [j.department, j.team].filter(Boolean).join(","),
        department: j.department || "", posted_at: epoch(j.publishedAt), salary_min: sal ? toYear(num(sal.minValue), sal.interval) : null, salary_max: sal ? toYear(num(sal.maxValue), sal.interval) : null, currency: sal?.currencyCode || "" };
    }) };
  },
};

// ------------------------------------------------------------------ RSS / Atom (no XML library: a small, safe reader that never fetches entities)

const cdata = (s) => String(s || "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? cdata(m[1]) : ""; };
const atomLink = (block) => (block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || "";

export function parseFeed(xml, config = {}) {
  const items = [...String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  if (!items.length && !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new SourceError("the response is not an RSS or Atom feed");
  return items.map((b) => {
    let title = unescapeHtml(stripHtml(tag(b, "title")));
    let company = config.company || tag(b, "company") || tag(b, "dc:creator") || "";
    const at = title.match(/^(.+?)\s+(?:at|@|-|\|)\s+([^|-]{2,60})$/i);  // "Backend Developer at Acme"
    if (!config.company && !company && at) { title = at[1].trim(); company = at[2].trim(); }
    const link = tag(b, "link") || atomLink(b) || tag(b, "guid");
    const body = tag(b, "description") || tag(b, "content:encoded") || tag(b, "content") || tag(b, "summary");
    return { external_id: tag(b, "guid") || tag(b, "id") || link, url: link, title, company: company || config.label || "", location: tag(b, "location") || tag(b, "job_listing:location") || config.location || "",
      remote: isRemote(`${title} ${tag(b, "location")}`), description: stripHtml(unescapeHtml(body)), tags: [tag(b, "category")].filter(Boolean).join(","),
      employment_type: EMPLOYMENT(tag(b, "job_type") || tag(b, "type")), posted_at: epoch(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")) };
  });
}

const rss = {
  id: "rss", label: "RSS / Atom feed", kind: "feed",
  fields: [{ key: "url", label: "Feed URL (https)", required: true }, { key: "company", label: "Employer name (if the whole feed is one employer)" }, { key: "label", label: "Name of this feed" }],
  validate: (c) => need(c, "url") || (/^https:\/\//i.test(c.url) ? null : "the feed URL must start with https://"),
  key: (c) => new URL(c.url).host + new URL(c.url).pathname,
  async fetch(c, { fetchImpl }) {
    const r = await getText(c.url, { fetchImpl });
    return { http: { status: r.status, ms: r.ms, url: c.url }, jobs: parseFeed(r.text, c) };
  },
};

// ------------------------------------------------------------------ employer career pages (JSON-LD), only where authorized

export function robotsAllows(robotsTxt, path) {
  let applies = false, allowed = true, best = -1;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") applies = v === "*" || /cleone/i.test(v);
    else if (applies && (k === "disallow" || k === "allow") && v && path.startsWith(v) && v.length > best) { best = v.length; allowed = k === "allow"; }
  }
  return allowed;
}

export function parseJsonLd(html, pageUrl) {
  const out = [];
  const walk = (n) => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk);
    if (/JobPosting/i.test([].concat(n["@type"] || []).join(","))) out.push(n); if (n["@graph"]) walk(n["@graph"]); if (n.itemListElement) walk(n.itemListElement); if (n.item) walk(n.item); };
  for (const m of String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1].trim())); } catch {} }
  return out.map((j) => {
    const loc = [].concat(j.jobLocation || [])[0]?.address || {};
    const sal = j.baseSalary?.value || {};
    return { external_id: String(j.identifier?.value || j.identifier || j.url || ""), url: j.url || pageUrl, title: j.title, company: j.hiringOrganization?.name || "",
      location: [loc.addressLocality, loc.addressRegion, loc.addressCountry?.name || loc.addressCountry].filter(Boolean).join(", "), remote: /TELECOMMUTE/i.test(j.jobLocationType || ""),
      employment_type: EMPLOYMENT([].concat(j.employmentType || [])[0]), description: stripHtml(unescapeHtml(j.description)), tags: "", posted_at: epoch(j.datePosted), valid_through: epoch(j.validThrough),
      salary_min: toYear(num(sal.minValue ?? sal.value), sal.unitText), salary_max: toYear(num(sal.maxValue ?? sal.value), sal.unitText), currency: j.baseSalary?.currency || "" };
  });
}

const careerpage = {
  id: "careerpage", label: "Employer career page", kind: "career",
  fields: [{ key: "url", label: "Career page URL (https)", required: true }, { key: "company", label: "Employer name", required: true }, { key: "authorized", label: "Type YES to confirm the employer authorized us to read this page", required: true }],
  validate: (c) => need(c, "url", "company") || (/^https:\/\//i.test(c.url) ? (String(c.authorized).toUpperCase() === "YES" || c.authorized === true ? null : "needs the employer's authorization: confirm it") : "the URL must start with https://"),
  key: (c) => new URL(c.url).host,
  async fetch(c, { fetchImpl }) {
    const u = new URL(c.url);
    let robots = ""; try { robots = (await getText(`${u.origin}/robots.txt`, { fetchImpl })).text; } catch (e) { if (e.status && e.status !== 404) throw new SourceError(`could not read robots.txt (${e.message})`, { status: e.status }); }
    if (!robotsAllows(robots, u.pathname)) throw new SourceError("robots.txt does not allow reading this page, so we will not");
    const r = await getText(c.url, { fetchImpl });
    const jobs = parseJsonLd(r.text, c.url).map((j) => ({ ...j, company: j.company || c.company }));
    if (!jobs.length) throw new SourceError("no JobPosting data found on the page", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url: c.url }, jobs };
  },
};

// ------------------------------------------------------------------ public aggregator feeds

const remotive = {
  id: "remotive", label: "Remotive", kind: "aggregator", fields: [], validate: () => null, key: () => "remotive",
  async fetch(c, { fetchImpl }) {
    const url = "https://remotive.com/api/remote-jobs?limit=200"; const r = await getJson(url, { fetchImpl });
    if (!Array.isArray(r.json?.jobs)) throw new SourceError("unexpected response: no jobs list", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.jobs.map((j) => ({ external_id: String(j.id || j.url), url: j.url, title: j.title, company: j.company_name, location: j.candidate_required_location || "Remote", remote: true,
      employment_type: EMPLOYMENT(j.job_type), description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.publication_date), ...salaryText(j.salary) })) };
  },
};
function salaryText(t) { const m = String(t || "").replace(/,/g, "").match(/(\d{2,3})\s?k?\s*[-–to]+\s*\$?(\d{2,3})\s?k/i); return m ? { salary_min: +m[1] * 1000, salary_max: +m[2] * 1000, currency: "USD" } : {}; }

const arbeitnow = {
  id: "arbeitnow", label: "Arbeitnow", kind: "aggregator", fields: [], validate: () => null, key: () => "arbeitnow",
  async fetch(c, { fetchImpl }) {
    const url = "https://www.arbeitnow.com/api/job-board-api"; const r = await getJson(url, { fetchImpl });
    if (!Array.isArray(r.json?.data)) throw new SourceError("unexpected response: no data list", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.data.map((j) => ({ external_id: j.slug || j.url, url: j.url, title: j.title, company: j.company_name, location: j.location || "", remote: !!j.remote,
      employment_type: EMPLOYMENT([].concat(j.job_types || [])[0]), description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.created_at) })) };
  },
};

const remoteok = {
  id: "remoteok", label: "RemoteOK", kind: "aggregator", fields: [], validate: () => null, key: () => "remoteok",
  async fetch(c, { fetchImpl }) {
    const url = "https://remoteok.com/api"; const r = await getJson(url, { fetchImpl }); // RemoteOK asks for a link back to the job page: we keep their URL as the apply link.
    if (!Array.isArray(r.json)) throw new SourceError("unexpected response: expected a list", { status: r.status });
    return { http: { status: r.status, ms: r.ms, url }, jobs: r.json.filter((j) => j && j.position).map((j) => ({ external_id: String(j.id || j.url), url: j.url || j.apply_url, title: j.position, company: j.company,
      location: j.location || "Remote", remote: true, description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.epoch || j.date), salary_min: num(j.salary_min), salary_max: num(j.salary_max), currency: num(j.salary_min) ? "USD" : "" })) };
  },
};

// ------------------------------------------------------------------ Nigerian boards: built, but DISABLED until the owner approves access
// Jobberman and MyJobMag publish no public API we have permission to use, and their terms restrict scraping. So these connectors do
// nothing until an admin records that the board owner approved access AND supplies the feed URL the owner provided (RSS/Atom).
// Until then enabling them is refused and no request is ever made. See README "Nigerian boards".

const partner = (id, label, site) => ({
  id, label, kind: "partner", disabled: `Disabled: ${label} (${site}) must approve data access first. Ask them for an RSS/Atom or API feed for partners, then add the feed URL here.`,
  fields: [{ key: "feedUrl", label: "Feed URL supplied by the owner (https)", required: true }, { key: "approvedAccess", label: "Type YES to confirm the owner approved this access in writing", required: true }],
  validate: (c) => (String(c.approvedAccess).toUpperCase() === "YES" && /^https:\/\//i.test(c.feedUrl || "") ? null : "disabled until the owner approves access and provides a feed URL"),
  key: () => id,
  async fetch(c, ctx) {
    if (this.validate(c)) throw new SourceError(this.disabled);
    const r = await getText(c.feedUrl, ctx); // approved feeds are read as RSS/Atom; a JSON partner feed would get its own small parser here
    return { http: { status: r.status, ms: r.ms, url: c.feedUrl }, jobs: parseFeed(r.text, { label, location: "Nigeria" }) };
  },
});

export const ADAPTERS = Object.fromEntries([greenhouse, lever, ashby, rss, careerpage, remotive, arbeitnow, remoteok, partner("jobberman", "Jobberman", "jobberman.com"), partner("myjobmag", "MyJobMag", "myjobmag.com")].map((a) => [a.id, a]));

/** Builds the source id for a configured instance, e.g. greenhouse:acme */
export const sourceId = (adapter, config) => (ADAPTERS[adapter].kind === "aggregator" || ADAPTERS[adapter].kind === "partner" ? adapter : `${adapter}:${slug(ADAPTERS[adapter].key(config))}`);
export const catalog = () => Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, kind: a.kind, fields: a.fields, disabled: a.disabled || null, configurable: a.fields.length > 0 }));
export { USER_AGENT };
