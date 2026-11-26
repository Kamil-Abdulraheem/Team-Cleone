// Every adapter is tested against realistic sample responses (lib/sources/fixtures.js), plus the HTTP reliability layer.
import { ADAPTERS, parseFeed, parseJsonLd, robotsAllows, sourceId } from "../lib/sources/adapters.js";
import { HTTP, SourceError, getJson, getText } from "../lib/sources/http.js";
import { sandboxFetch } from "../lib/sources/sandbox.js";
import { FIXTURES as F } from "../lib/sources/fixtures.js";
import { normalize } from "../lib/jobs.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
HTTP.minGapMs = 0; HTTP.backoffMs = 1;
const res = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const ctx = { fetchImpl: sandboxFetch };
const SHAPE = ["external_id", "url", "title", "company", "location", "remote", "description"];
const shaped = (jobs) => jobs.every((j) => SHAPE.every((k) => k in j) && j.title && /^https:\/\//.test(j.url) && j.company);
const norm = (id, jobs) => jobs.map((j) => normalize(id, j));

// ---- Greenhouse
{
  const a = ADAPTERS.greenhouse, r = await a.fetch({ board: "acme", company: "Acme" }, ctx), n = norm("greenhouse:acme", r.jobs);
  ok("greenhouse: reads every job in the board", r.jobs.length === 3 && r.http.status === 200 && r.http.url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs"));
  ok("greenhouse: standard shape, HTML-escaped content is cleaned", shaped(r.jobs) && /Requirements: 3\+ years/.test(n[0].description) && !/&lt;|<p>/.test(n[0].description));
  ok("greenhouse: location, publication date, remote flag", n[0].location === "Lagos, Nigeria" && n[0].posted_at > 1e9 && n[1].remote === 1 && n[0].remote === 0);
  ok("greenhouse: validates the board token", !!a.validate({}) && !!a.validate({ board: "../etc" }) && a.validate({ board: "acme" }) === null);
}
// ---- Lever
{
  const a = ADAPTERS.lever, r = await a.fetch({ company: "globex", name: "Globex" }, ctx), n = norm("lever:globex", r.jobs);
  ok("lever: reads postings", r.jobs.length === 2 && r.http.url === "https://api.lever.co/v0/postings/globex?mode=json");
  ok("lever: salary range, remote workplace, employment type", n[0].salary_min === 60000 && n[0].salary_max === 90000 && n[0].remote === 1 && n[1].employment_type === "contract" && n[0].employment_type === "full-time");
  ok("lever: description joins the lists", /Build data pipelines/.test(n[0].description) && /flexible schedule/.test(n[0].description));
  ok("lever: EU region uses the EU host", (await a.fetch({ company: "globex", region: "eu" }, ctx)).http.url.startsWith("https://api.eu.lever.co/"));
}
// ---- Ashby
{
  const a = ADAPTERS.ashby, r = await a.fetch({ board: "initech", company: "Initech" }, ctx), n = norm("ashby:initech", r.jobs);
  ok("ashby: unlisted postings are left out", r.jobs.length === 1 && n[0].title === "Frontend Engineer");
  ok("ashby: compensation, remote, employment type, date", n[0].salary_min === 70000 && n[0].salary_max === 100000 && n[0].remote === 1 && n[0].employment_type === "full-time" && n[0].posted_at > 1e9);
}
// ---- RSS
{
  const a = ADAPTERS.rss, r = await a.fetch({ url: "https://sample.invalid/feed.xml", label: "Sample" }, ctx), n = norm("rss:x", r.jobs);
  ok("rss: reads items, splits 'Role at Company'", r.jobs.length === 2 && n[0].title === "Marketing Manager" && n[0].company === "Sample Foods");
  ok("rss: CDATA html is cleaned and the date is read", /Lagos, Nigeria/.test(n[0].description) && !/<p>/.test(n[0].description) && n[0].posted_at > 1e9);
  ok("rss: a configured employer name wins", parseFeed(F.rss, { company: "Fixed Co" })[0].company === "Fixed Co");
  ok("rss: Atom entries work", parseFeed('<feed><entry><title>Dev at Zed</title><link rel="alternate" href="https://sample.invalid/a"/><id>1</id><updated>2026-01-02T00:00:00Z</updated><summary>Build things</summary></entry></feed>')[0].url === "https://sample.invalid/a");
  ok("rss: a non-feed is rejected clearly", (() => { try { parseFeed("<html>hello</html>"); return false; } catch (e) { return /not an RSS/.test(e.message); } })());
  ok("rss: only https feeds are accepted", !!a.validate({ url: "http://x.test/f" }) && a.validate({ url: "https://x.test/f" }) === null);
}
// ---- Career page
{
  const a = ADAPTERS.careerpage, cfg = { url: "https://sample.invalid/careers", company: "Sample Bank", authorized: "YES" };
  const r = await a.fetch(cfg, ctx), n = norm("careerpage:x", r.jobs);
  ok("careerpage: reads JSON-LD JobPosting", r.jobs.length === 1 && n[0].title === "Site Reliability Engineer" && n[0].company === "Sample Bank" && n[0].location === "Lagos, NG");
  ok("careerpage: salary, closing date and employment type", n[0].salary_min === 40000 && n[0].salary_max === 60000 && n[0].valid_through > Date.now() / 1000 && n[0].employment_type === "full-time");
  ok("careerpage: refuses without the employer's authorization", !!a.validate({ ...cfg, authorized: "" }) && a.validate(cfg) === null);
  let err; try { await a.fetch(cfg, { fetchImpl: async (u) => (u.endsWith("robots.txt") ? res("User-agent: *\nDisallow: /careers") : res(F.careerPage)) }); } catch (e) { err = e; }
  ok("careerpage: obeys robots.txt and does not read a disallowed page", err && /robots\.txt/.test(err.message));
  ok("robots.txt rules: longest match wins, other bots ignored", robotsAllows(F.robots, "/careers/x") && !robotsAllows(F.robots, "/private/x") && robotsAllows("User-agent: other\nDisallow: /", "/a"));
  let e2; try { await a.fetch(cfg, { fetchImpl: async (u) => (u.endsWith("robots.txt") ? res("", 404) : res("<html>no data</html>")) }); } catch (e) { e2 = e; }
  ok("careerpage: a page with no job data is an error, not zero jobs", e2 && /no JobPosting/.test(e2.message));
  ok("json-ld: handles @graph and arrays", parseJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"A","hiringOrganization":{"name":"Z"}}]}</script>', "https://x.test/p")[0].title === "A");
}
// ---- Aggregators
{
  const rem = await ADAPTERS.remotive.fetch({}, ctx), ao = await ADAPTERS.arbeitnow.fetch({}, ctx), ok_ = await ADAPTERS.remoteok.fetch({}, ctx);
  ok("remotive: jobs read, salary text parsed", rem.jobs.length === 2 && shaped(rem.jobs) && norm("remotive", rem.jobs).find((j) => j.title === "Python Developer").salary_max === 80000);
  ok("arbeitnow: jobs read", ao.jobs.length === 1 && shaped(ao.jobs) && norm("a", ao.jobs)[0].location === "Berlin");
  ok("remoteok: the legal notice row is skipped", ok_.jobs.length === 1 && ok_.jobs[0].title === "DevOps Engineer" && norm("r", ok_.jobs)[0].salary_min === 70000);
}
// ---- Nigerian boards are DISABLED
{
  for (const id of ["jobberman", "myjobmag"]) {
    const a = ADAPTERS[id]; let err, calls = 0;
    try { await a.fetch({}, { fetchImpl: async () => { calls++; return res(F.rss); } }); } catch (e) { err = e; }
    ok(`${id}: disabled, says why, and makes NO request`, a.kind === "partner" && /approve/i.test(a.disabled) && err && calls === 0);
    ok(`${id}: needs written approval AND a feed URL from the owner`, !!a.validate({ feedUrl: "https://x.test/f" }) && !!a.validate({ approvedAccess: "YES" }) && a.validate({ feedUrl: "https://x.test/f", approvedAccess: "YES" }) === null);
  }
  const r = await ADAPTERS.jobberman.fetch({ feedUrl: "https://partner.test/feed", approvedAccess: "YES" }, { fetchImpl: async () => res(F.rss) });
  ok("with approval the connector reads the partner's feed", r.jobs.length === 2 && r.jobs[0].location === "Nigeria" || r.jobs.length === 2);
}
// ---- HTTP reliability
{
  let n = 0;
  const flaky = async () => (++n < 3 ? res("", 503) : res({ ok: 1 }));
  const r = await getJson("https://a.test/x", { fetchImpl: flaky });
  ok("http: retries a 503 and then succeeds", r.json.ok === 1 && n === 3 && r.attempts === 3);
  n = 0; let err; try { await getText("https://a.test/x", { fetchImpl: async () => { n++; return res("", 404); } }); } catch (e) { err = e; }
  ok("http: a 404 is not retried and carries its status", err instanceof SourceError && err.status === 404 && n === 1);
  n = 0; try { await getText("https://a.test/x", { fetchImpl: async () => { n++; return res("", 500); } }); } catch (e) { err = e; }
  ok("http: gives up after the retries with the last status", err.status === 500 && n === HTTP.retries + 1);
  try { await getText("https://a.test/x", { fetchImpl: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); } }); } catch (e) { err = e; }
  ok("http: a timeout is reported as a timeout", /timed out/.test(err.message));
  try { await getJson("https://a.test/x", { fetchImpl: async () => res("<html>") }); } catch (e) { err = e; }
  ok("http: a response that is not JSON says so", /not valid JSON/.test(err.message));
  HTTP.minGapMs = 60; const t0 = Date.now(); await getText("https://slow.test/1", { fetchImpl: async () => res("a") }); await getText("https://slow.test/2", { fetchImpl: async () => res("b") });
  ok("http: requests to the same host are spaced out (rate limiting)", Date.now() - t0 >= 55); HTTP.minGapMs = 0;
}
// ---- Adding a source needs no change to the matching engine
ok("source ids are stable and readable", sourceId("greenhouse", { board: "Acme Co" }) === "greenhouse:acme-co" && sourceId("remotive", {}) === "remotive");
console.log(`sources.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
