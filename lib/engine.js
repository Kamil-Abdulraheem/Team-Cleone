// The scan engine. It reads public GitHub activity around a repo and works out who is paying attention.
//
// A full scan needs about 100-150 calls to GitHub, which is too long for one web request (Vercel stops a function
// after 30 seconds here). So a scan is split into small STEPS. Each step makes at most about 30 calls, saves its
// progress as plain data (the "state"), and the next step carries on from it. The app calls the steps one after
// another, which is also what drives the progress screen.
//
//   repo -> signals -> profiles (repeat) -> rank -> enrich (repeat) -> finish
//
// Nothing here needs a server framework, so the same file runs on Vercel, in the tests and on the command line.

const API = "https://api.github.com";
const DAY = 86_400_000;

// ---- Tunables. Change numbers here to change how strict a scan is. ----
export const TUNE = {
  minSignal: 40, // evidence strength (0-100) a candidate needs to be kept
  minRelevance: 5, // how closely a "similar project" must match
  maxCandidates: 30,
  companyMinPeople: 2, // 2+ people from one company become one "company" candidate
  companyMinTopSignal: 30,
  companyBonusPerExtra: 8,
  strategicSoloMin: 60, // one strong person who names an employer also counts as company interest
  profilesPerStep: 30,
  enrichPerStep: 30,
  concurrency: 6, // how many GitHub calls run at the same time
};
const QUOTAS = { star: 12, similar: 12, fork: 6 }; // stops one noisy source filling the list

// With a GitHub token the full budget is used; without one the smaller budget fits GitHub's 60-calls-an-hour limit.
const FULL = { stars: 40, eventPages: 3, fork: { org: 10, modified: 15, plain: 5 }, owners: 25, queries: 5, enrich: true };
const LITE = { stars: 15, eventPages: 1, fork: { org: 3, modified: 5, plain: 1 }, owners: 10, queries: 3, enrich: false };
const budget = (mode) => (mode === "full" ? FULL : LITE);

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ GitHub client

/** Small GitHub client. Counts calls so the tests can prove each step stays under the limit. */
export function makeGithub(token, fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const limits = {};
  let calls = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function request(path, accept, attempt = 0) {
    const resource = path.startsWith("/search/") ? "search" : "core";
    const lim = limits[resource];
    if (lim && lim.remaining < 2 && Date.now() < lim.reset * 1000) {
      throw new GitHubError(429, "GitHub is busy right now. Please try again in a few minutes.");
    }
    const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cleone" };
    if (token) headers.Authorization = `Bearer ${token}`;
    calls++;
    const res = await doFetch(API + path, { headers });
    const rem = res.headers.get("x-ratelimit-remaining");
    const rst = res.headers.get("x-ratelimit-reset");
    if (rem && rst) limits[resource] = { remaining: Number(rem), reset: Number(rst) };
    const retry = Number(res.headers.get("retry-after"));
    if ((res.status === 403 || res.status === 429) && retry > 0 && retry <= 20 && attempt === 0) {
      await sleep(retry * 1000);
      return request(path, accept, 1);
    }
    return res;
  }

  return {
    hasToken: !!token,
    calls: () => calls,
    async get(path, accept = "application/vnd.github+json") {
      const res = await request(path, accept);
      if (!res.ok) {
        const limited = res.status === 403 || res.status === 429;
        const repoPath = /^\/repos\/[^/]+\/[^/]+$/.test(path.split("?")[0]);
        throw new GitHubError(
          res.status,
          limited
            ? "GitHub is busy right now. Please try again in a few minutes."
            : res.status === 404 && repoPath
              ? "That repository was not found. Check the name. Private repositories cannot be scanned."
              : `GitHub returned ${res.status}`
        );
      }
      return res.json();
    },
    async text(path, accept) {
      try {
        const res = await request(path, accept);
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    },
  };
}

/** Run fn over items, a few at a time. Never throws; returns one result per item. */
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { ok: false, reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ text and link hygiene

export function parseRepo(input) {
  const raw = String(input || "").trim();
  const host = raw.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)\//i)?.[1];
  if (host && host.includes(".") && host.toLowerCase() !== "github.com") {
    throw new Error("Only github.com repositories are supported.");
  }
  const s = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^github\.com\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "");
  const [owner, name] = s.split("/");
  const ok = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !name || !ok.test(owner) || !ok.test(name)) {
    throw new Error("Enter a repo like github.com/owner/name");
  }
  return { owner, name: name.replace(/\.git$/i, "") };
}

/** One line, no control characters, no keyboard-mash, bounded length. Empty string if unusable. */
export function cleanText(s, max = 140) {
  if (!s) return "";
  const t = String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || /(.)\1{9,}/u.test(t)) return "";
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Public http(s) links only. Drops localhost, IP addresses and private hosts. */
export function cleanUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || /\s/.test(s)) return "";
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return "";
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!h.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return "";
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return "";
  return u.toString().replace(/\/$/, "");
}

function cleanEmail(e) {
  const s = String(e || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /no-?reply/i.test(s)) return "";
  return s;
}

function contactOf(u) {
  const parts = [];
  const email = cleanEmail(u.email);
  if (email) parts.push(`email ${email}`);
  const web = cleanUrl(u.blog);
  if (web) parts.push(`web ${web}`);
  if (u.twitter_username && /^[A-Za-z0-9_]{1,15}$/.test(u.twitter_username)) parts.push(`x.com/${u.twitter_username}`);
  return parts.join(" | ");
}

// ------------------------------------------------------------------ relevance and signal

const GENERIC_TOPICS = new Set([
  "cli", "command-line", "tool", "tools", "hacktoberfest", "terminal", "library", "framework",
  "open-source", "opensource", "awesome", "github", "linux", "macos", "windows", "app", "api",
  "rust", "python", "javascript", "typescript", "go", "golang", "java", "c", "cpp", "ruby", "php",
  "swift", "kotlin", "shell", "bash", "nodejs", "node", "react", "vue", "docker",
]);

const STOP = new Set([
  "with", "that", "this", "from", "your", "have", "into", "than", "them", "their", "will", "using",
  "used", "also", "more", "most", "fast", "very", "simple", "tool", "tools", "library", "based",
  "like", "just", "only", "other", "some", "what", "when", "which", "build", "built", "make",
  "write", "written", "easy", "modern", "powerful", "lightweight", "install", "installation",
  "usage", "example", "examples", "license", "contributing", "https", "http", "www", "github",
  "readme", "following", "default", "version", "release", "releases", "documentation", "docs",
  "please", "note", "support", "available", "instructions", "section", "binary", "binaries",
  "building", "development", "should", "would", "could", "there", "these", "those", "here",
]);

const stem = (w) =>
  w.replace(/(ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/ies$/, "y").replace(/([^s])s$/, "$1");

const tokens = (s) =>
  String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)).map(stem);

/** What the project is about: its description, name, and the most repeated words in its README. */
function keywordSet(p) {
  const set = new Set([...tokens(p.description), ...tokens(p.name)]);
  const freq = new Map();
  for (const w of tokens(p.readme)) freq.set(w, (freq.get(w) ?? 0) + 1);
  [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([w]) => set.add(w));
  return set;
}

function relevance(p, r, kw) {
  const pt = new Set(p.topics);
  const shared = [];
  let score = 0;
  for (const t of r.topics ?? []) {
    if (!pt.has(t)) continue;
    shared.push(t);
    score += GENERIC_TOPICS.has(t) ? 0.5 : 3;
  }
  if (p.language && r.language === p.language) score += 2;
  let overlap = 0;
  for (const w of new Set(tokens(`${r.name} ${r.description ?? ""}`))) if (kw.has(w)) overlap++;
  score += Math.min(3, overlap);
  return { score, shared, overlap };
}

/** How real and established an account looks, 0-80. Evidence bonuses are added on top. */
function profileSignal(u) {
  const followers = Math.min(30, Math.log10(u.followers + 1) * 12);
  const repos = Math.min(15, Math.log10(u.public_repos + 1) * 8);
  const years = (Date.now() - new Date(u.created_at).getTime()) / (365 * DAY);
  const age = Math.max(0, Math.min(10, years * 2.5));
  const completeness = (cleanText(u.bio) ? 10 : 0) + (u.company ? 10 : 0) + (cleanUrl(u.blog) ? 5 : 0);
  return followers + repos + age + completeness;
}

const NO_COMPANY = new Set([
  "", "self", "freelance", "freelancer", "independent", "none", "n/a", "na", "student",
  "unemployed", "me", "myself", "personal", "open source", "opensource", "home",
]);

function companyOf(raw) {
  const c = cleanText(raw, 60);
  if (!c) return null;
  const label = c.replace(/^@+/, "").split(/[,/|]/)[0].trim();
  const key = label
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|corp|co|limited)\.?$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (key.length < 2 || NO_COMPANY.has(key)) return null;
  return { key, label };
}

// Investors announce themselves in their public profile. This looks for that, nothing more.
const INVESTOR_WORDS = /\b(angel investor|investor|venture capital|venture partner|general partner|managing partner|seed investor|vc)\b/i;
const INVESTOR_FIRM = /\b(capital|ventures|vc|fund|partners)\s*$/i;
function looksLikeInvestor(u) {
  const bio = cleanText(u.bio, 300);
  const company = cleanText(u.company, 80);
  return INVESTOR_WORDS.test(bio) || INVESTOR_WORDS.test(company) || INVESTOR_FIRM.test(company);
}

function ago(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

const slimUser = (u) => ({
  login: u.login,
  type: u.type,
  name: cleanText(u.name, 80) || null,
  bio: cleanText(u.bio, 300) || null,
  company: cleanText(u.company, 80) || null,
  blog: cleanUrl(u.blog) || null,
  location: cleanText(u.location, 80) || null,
  email: cleanEmail(u.email) || null,
  twitter_username: u.twitter_username || null,
  followers: u.followers || 0,
  public_repos: u.public_repos || 0,
  created_at: u.created_at,
});

// ------------------------------------------------------------------ STEP 1: the repo (2 calls)

export async function stepRepo(gh, input) {
  const { owner, name } = parseRepo(input);
  const repo = await gh.get(`/repos/${owner}/${name}`);
  const readme = (await gh.text(`/repos/${owner}/${name}/readme`, "application/vnd.github.raw+json")) || "";
  const project = {
    owner: repo.owner.login,
    name: repo.name,
    url: `https://github.com/${repo.owner.login}/${repo.name}`,
    description: repo.description ?? "",
    topics: repo.topics ?? [],
    language: repo.language,
    stars: repo.stargazers_count,
    readme: readme.slice(0, 4000),
  };
  return { mode: gh.hasToken ? "full" : "lite", project, stats: newStats(gh.hasToken ? "full" : "lite") };
}

const newStats = (mode) => ({
  mode,
  fetched: { stars: 0, forks: 0, similarRepos: 0 },
  profiles: 0,
  dropped: { notAPerson: 0, lowSignal: 0, irrelevantRepos: 0 },
  companies: 0,
  composed: { star: 0, fork: 0, similar: 0 },
  warnings: [],
});

// ------------------------------------------------------------------ STEP 2: signals (about 11 calls)

async function starsFromEvents(gh, p, pages) {
  const out = [];
  for (let pg = 1; pg <= pages; pg++) {
    const items = await gh.get(`/repos/${p.owner}/${p.name}/events?per_page=100&page=${pg}`);
    for (const e of items) if (e.type === "WatchEvent") out.push({ login: e.actor.login, at: e.created_at });
    if (items.length < 100) break;
  }
  return out;
}

async function starsFromStargazers(gh, p, want) {
  const last = Math.max(1, Math.ceil(p.stars / 100));
  const pages = last > 1 ? [last, last - 1] : [1];
  const out = [];
  for (const pg of pages) {
    const items = await gh.get(
      `/repos/${p.owner}/${p.name}/stargazers?per_page=100&page=${pg}`,
      "application/vnd.github.star+json"
    );
    for (const i of items) if (i.user.type === "User") out.push({ login: i.user.login, at: i.starred_at });
    if (out.length >= want) break;
  }
  return out;
}

async function recentStars(gh, p, b, warnings) {
  const merged = new Map();
  const take = (list) => {
    for (const s of list) {
      const k = s.login.toLowerCase();
      const prev = merged.get(k);
      if (!prev || s.at > prev.at) merged.set(k, s);
    }
  };
  let evErr;
  try {
    take(await starsFromEvents(gh, p, b.eventPages));
  } catch (e) {
    evErr = e;
  }
  // Only spend extra calls on the stargazers list when the events feed came up short.
  if (merged.size < b.stars / 2) {
    try {
      take(await starsFromStargazers(gh, p, b.stars));
    } catch (e) {
      if (!merged.size) warnings.push(`star lookup failed: ${(evErr || e).message}`);
    }
  }
  return [...merged.values()]
    .filter((s) => s.login.toLowerCase() !== p.owner.toLowerCase() && !s.login.includes("[bot]"))
    .sort((a, c) => c.at.localeCompare(a.at))
    .slice(0, b.stars);
}

async function forkPicks(gh, p, b) {
  const forks = await gh.get(`/repos/${p.owner}/${p.name}/forks?sort=newest&per_page=100`);
  const seen = new Set([p.owner.toLowerCase()]);
  const tag = forks.map((r) => ({
    login: r.owner.login,
    type: r.owner.type,
    url: r.html_url,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    // A fresh fork keeps the parent's pushed_at. If it moved past created_at, the owner committed.
    modified: new Date(r.pushed_at).getTime() > new Date(r.created_at).getTime() + 60_000,
  }));
  const picks = [];
  const take = (arr, n) => {
    for (const f of arr) {
      const l = f.login.toLowerCase();
      if (n <= 0) break;
      if (seen.has(l)) continue;
      seen.add(l);
      picks.push(f);
      n--;
    }
  };
  take(tag.filter((f) => f.type === "Organization"), b.fork.org);
  take(tag.filter((f) => f.modified).sort((x, y) => y.pushedAt.localeCompare(x.pushedAt)), b.fork.modified);
  take(tag.filter((f) => !f.modified), b.fork.plain);
  return { all: forks.length, picks };
}

function searchQueries(p, b) {
  const since = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);
  const base = `-user:${p.owner} fork:false archived:false pushed:>=${since}`;
  const specific = p.topics.filter((t) => !GENERIC_TOPICS.has(t)).slice(0, 4);
  const qs = [];
  const pairs = [];
  for (let i = 0; i < specific.length; i++)
    for (let j = i + 1; j < specific.length; j++) pairs.push(`topic:${specific[i]} topic:${specific[j]}`);
  for (const pr of pairs.slice(0, 3)) qs.push(`${pr} stars:>=10 ${base}`);
  for (const t of specific.slice(0, 2)) qs.push(`topic:${t} stars:>=50 ${base}`);
  if (!qs.length) {
    const kw = [...keywordSet(p)].slice(0, 3).join(" ");
    if (kw) qs.push(`${kw} in:name,description${p.language ? ` language:${p.language}` : ""} stars:>=20 ${base}`);
  }
  return qs.slice(0, b.queries);
}

async function similarRepos(gh, p, b, warnings) {
  const kw = keywordSet(p);
  const byName = new Map();
  for (const q of searchQueries(p, b)) {
    try {
      const r = await gh.get(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`);
      for (const repo of r.items) byName.set(repo.full_name, repo);
    } catch (e) {
      warnings.push(`similar-repo search failed: ${e.message}`);
    }
  }
  const scored = [...byName.values()].map((repo) => ({ repo, ...relevance(p, repo, kw) }));
  // Topic overlap alone is not enough: the repo's own description must also talk about the same things.
  const rel = scored
    .filter((x) => x.score >= TUNE.minRelevance && x.overlap >= 1)
    .sort((a, c) => c.score - a.score || c.repo.stargazers_count - a.repo.stargazers_count);
  const owners = new Set([p.owner.toLowerCase()]);
  const kept = [];
  for (const x of rel) {
    const o = x.repo.owner.login.toLowerCase();
    if (owners.has(o)) continue;
    owners.add(o);
    kept.push({
      login: x.repo.owner.login,
      fullName: x.repo.full_name,
      description: cleanText(x.repo.description, 120),
      language: x.repo.language,
      stars: x.repo.stargazers_count,
      pushedAt: x.repo.pushed_at,
      url: x.repo.html_url,
      rel: x.score,
      shared: x.shared,
    });
    if (kept.length >= b.owners) break;
  }
  return { fetched: scored.length, irrelevant: scored.length - rel.length, kept };
}

export async function stepSignals(gh, state) {
  const b = budget(state.mode);
  const p = state.project;
  const warnings = state.stats.warnings;
  const [starsR, forksR, simR] = await Promise.allSettled([
    recentStars(gh, p, b, warnings),
    forkPicks(gh, p, b),
    similarRepos(gh, p, b, warnings),
  ]);
  state.stars = starsR.status === "fulfilled" ? starsR.value : [];
  state.forks = forksR.status === "fulfilled" ? forksR.value : { all: 0, picks: [] };
  state.sim = simR.status === "fulfilled" ? simR.value : { fetched: 0, irrelevant: 0, kept: [] };
  for (const r of [starsR, forksR, simR]) if (r.status === "rejected") warnings.push(r.reason.message);
  if ([starsR, forksR, simR].every((r) => r.status === "rejected")) throw starsR.reason;

  state.stats.fetched = { stars: state.stars.length, forks: state.forks.all, similarRepos: state.sim.fetched };
  state.stats.dropped.irrelevantRepos = state.sim.irrelevant;
  const logins = new Set();
  for (const s of state.stars) logins.add(s.login);
  for (const f of state.forks.picks) logins.add(f.login);
  for (const s of state.sim.kept) logins.add(s.login);
  state.logins = [...logins];
  state.profiles = {};
  return state;
}

// ------------------------------------------------------------------ STEP 3: profiles (up to 30 calls each, repeat)

/** Returns how many profiles are still waiting. Call again until it is 0. */
export async function stepProfiles(gh, state) {
  const todo = state.logins.filter((l) => !(l.toLowerCase() in state.profiles)).slice(0, TUNE.profilesPerStep);
  const res = await pMap(todo, TUNE.concurrency, async (login) => {
    try {
      return await gh.get(`/users/${login}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  });
  if (todo.length && res.every((r) => !r.ok)) throw res[0].reason;
  todo.forEach((login, i) => {
    // A failed lookup is skipped, not retried forever.
    state.profiles[login.toLowerCase()] = res[i].ok && res[i].value ? slimUser(res[i].value) : null;
  });
  const remaining = state.logins.filter((l) => !(l.toLowerCase() in state.profiles)).length;
  state.stats.profiles = Object.values(state.profiles).filter(Boolean).length;
  return remaining;
}

// ------------------------------------------------------------------ STEP 4: rank (no outside calls)

export function stepRank(state) {
  const p = state.project;
  const stats = state.stats;
  state.people = {};

  const add = (login, ev) => {
    const u = state.profiles[login.toLowerCase()];
    if (!u || (u.type !== "User" && u.type !== "Organization")) return;
    const k = login.toLowerCase();
    const pr = state.people[k] ?? { login: u.login, u, ev: [], signal: 0 };
    pr.ev.push(ev);
    state.people[k] = pr;
  };

  for (const s of state.stars) {
    const days = (Date.now() - new Date(s.at).getTime()) / DAY;
    add(s.login, {
      kind: "star",
      bonus: days <= 7 ? 10 : days <= 30 ? 5 : 2,
      text: `Starred ${p.owner}/${p.name} ${ago(s.at)}`,
      short: `Starred ${p.name} ${ago(s.at)}`,
      title: `Starred ${p.owner}/${p.name}`,
      url: `https://github.com/${s.login}`,
      at: s.at,
      rel: 0,
      repoStars: 0,
    });
  }
  for (const f of state.forks.picks) {
    add(f.login, {
      kind: "fork",
      bonus: f.modified ? 15 : 3,
      text: f.modified
        ? `Forked ${p.owner}/${p.name} and pushed their own commits (last push ${ago(f.pushedAt)})`
        : `Forked ${p.owner}/${p.name} ${ago(f.createdAt)} with no changes of their own`,
      short: f.modified ? `Forked ${p.name} and pushed their own commits` : `Forked ${p.name} ${ago(f.createdAt)}`,
      title: `Forked ${p.owner}/${p.name}`,
      url: f.url,
      at: f.modified ? f.pushedAt : f.createdAt,
      rel: 0,
      repoStars: 0,
    });
  }
  for (const s of state.sim.kept) {
    add(s.login, {
      kind: "similar",
      bonus: Math.min(15, s.rel * 2) + Math.min(5, Math.log10(s.stars + 1) * 1.5),
      text: `Maintains similar project ${s.fullName}: ${s.description || "no description"} (${s.language ?? "n/a"}, ${s.stars} stars, shared topics: ${s.shared.join(", ") || "none"}, last push ${ago(s.pushedAt)})`,
      short: `Maintains ${s.fullName} (${s.stars} stars)`,
      title: `Maintains ${s.fullName}`,
      url: s.url,
      at: s.pushedAt,
      rel: s.rel,
      repoStars: s.stars,
    });
  }
  stats.dropped.notAPerson = Object.values(state.profiles).filter(Boolean).length - Object.keys(state.people).length;
  for (const pr of Object.values(state.people)) {
    pr.signal = Math.min(100, profileSignal(pr.u) + pr.ev.reduce((a, e) => a + e.bonus, 0));
  }

  // Turn people into candidates.
  //  - Organizations stand alone (strategic).
  //  - Investor-looking people who starred or forked go to the investors lane.
  //  - People who starred or forked and share a company merge into one strategic "company" candidate.
  //  - People who only maintain a similar project are peers: joiners, never strategic because of an employer.
  const drafts = [];
  const byCompany = new Map();
  const solo = [];
  const best = (pr) => [...pr.ev].sort((a, b) => b.bonus - a.bonus)[0];
  const draftFor = (pr, lane, kind, company) => {
    const e = best(pr);
    return {
      lane,
      source: e.kind,
      key: `person:${pr.login.toLowerCase()}`,
      handle: pr.login,
      name: pr.u.name || pr.login,
      title: company ? `${e.title}, works at ${company}` : e.title,
      kind,
      url: e.url,
      signal: pr.signal,
      people: [pr.login],
    };
  };
  const kindFor = (pr) => {
    const k = best(pr).kind;
    return k === "similar" ? "Maintains a similar project" : k === "fork" ? "Forked your project" : "Starred your project";
  };

  for (const pr of Object.values(state.people)) {
    const engaged = pr.ev.some((e) => e.kind !== "similar");
    if (pr.u.type === "Organization") {
      drafts.push(draftFor(pr, "strategic", "Organization with a similar project"));
      continue;
    }
    if (engaged && looksLikeInvestor(pr.u)) {
      drafts.push(draftFor(pr, "investors", "Investor (from public profile)"));
      continue;
    }
    const c = engaged ? companyOf(pr.u.company) : null;
    if (!c) {
      solo.push(pr);
      continue;
    }
    const g = byCompany.get(c.key) ?? { label: c.label, members: [] };
    g.members.push(pr);
    byCompany.set(c.key, g);
  }
  for (const [key, g] of byCompany) {
    g.members.sort((a, b) => b.signal - a.signal);
    const top = g.members[0];
    if (g.members.length >= TUNE.companyMinPeople && top.signal >= TUNE.companyMinTopSignal) {
      const e = best(top);
      drafts.push({
        lane: "strategic",
        source: e.kind,
        key: `company:${key}`,
        handle: g.label,
        name: g.label,
        title: `${g.members.length} people from ${g.label} engaged with ${p.name}`,
        kind: `Company, ${g.members.length} people engaged`,
        url: e.url,
        signal: Math.min(100, top.signal + TUNE.companyBonusPerExtra * (g.members.length - 1)),
        people: g.members.map((m) => m.login),
        label: g.label,
      });
      stats.companies++;
    } else {
      for (const m of g.members) {
        if (m.signal >= TUNE.strategicSoloMin) drafts.push(draftFor(m, "strategic", `Works at ${g.label}`, g.label));
        else solo.push(m);
      }
    }
  }
  for (const pr of solo) drafts.push(draftFor(pr, "joiners", kindFor(pr)));

  // Quality gate, then balance sources.
  const gated = drafts.filter((d) => d.signal >= TUNE.minSignal);
  stats.dropped.lowSignal = drafts.length - gated.length;
  const by = { star: [], fork: [], similar: [] };
  for (const d of gated) by[d.source].push(d);
  const picked = [];
  const rest = [];
  for (const k of Object.keys(by)) {
    by[k].sort((a, b) => b.signal - a.signal);
    picked.push(...by[k].slice(0, QUOTAS[k]));
    rest.push(...by[k].slice(QUOTAS[k]));
  }
  rest.sort((a, b) => b.signal - a.signal);
  while (picked.length < TUNE.maxCandidates && rest.length) picked.push(rest.shift());
  state.chosen = picked.sort((a, b) => b.signal - a.signal);
  for (const d of state.chosen) stats.composed[d.source]++;

  // Who to look up recent repos for (full mode only, to save calls).
  const targets = new Set();
  if (budget(state.mode).enrich) for (const d of state.chosen) for (const l of d.people.slice(0, 2)) targets.add(l.toLowerCase());
  state.enrichLogins = [...targets];
  state.repos = {};
  return state;
}

// ------------------------------------------------------------------ STEP 5: enrich (up to 30 calls each, repeat)

export async function stepEnrich(gh, state) {
  const todo = state.enrichLogins.filter((l) => !(l in state.repos)).slice(0, TUNE.enrichPerStep);
  const res = await pMap(todo, TUNE.concurrency, (login) => gh.get(`/users/${login}/repos?sort=pushed&per_page=5`));
  todo.forEach((login, i) => {
    state.repos[login] = res[i].ok
      ? res[i].value.map((r) => ({ name: r.name, language: r.language, pushed_at: r.pushed_at }))
      : [];
  });
  return state.enrichLogins.filter((l) => !(l in state.repos)).length;
}

// ------------------------------------------------------------------ STEP 6: finish (no outside calls)

function personFacts(pr, repos) {
  const u = pr.u;
  const age = ((Date.now() - new Date(u.created_at).getTime()) / (365 * DAY)).toFixed(1);
  const lines = [`${u.name || u.login} (@${u.login}, ${u.type})`];
  for (const e of [...pr.ev].sort((a, b) => b.bonus - a.bonus)) lines.push(`Evidence: ${e.text}`);
  if (u.bio) lines.push(`Bio: ${u.bio}`);
  if (u.company) lines.push(`Company: ${u.company}`);
  if (u.location) lines.push(`Location: ${u.location}`);
  lines.push(`Followers: ${u.followers}; public repos: ${u.public_repos}; account age: ${age} years`);
  if (repos?.length) {
    lines.push("Recent repos: " + repos.map((r) => `${r.name} (${r.language ?? "n/a"}, pushed ${r.pushed_at.slice(0, 10)})`).join("; "));
  }
  return lines;
}

/** Turns the finished state into plain candidate records ready to score and save. */
export function finishCandidates(state) {
  const p = state.project;
  return state.chosen.map((d) => {
    const people = d.people.map((l) => state.people[l.toLowerCase()]);
    const top = people[0];
    const evs = people.flatMap((x) => x.ev);
    const bestEv = [...top.ev].sort((a, b) => b.bonus - a.bonus)[0];
    const relEv = [...evs].sort((a, b) => b.rel - a.rel)[0];
    const repos = state.repos?.[top.login.toLowerCase()];
    const lines = [];
    if (d.label) lines.push(`${people.length} people from ${d.label} engaged with ${p.owner}/${p.name}:`);
    people.slice(0, d.label ? 4 : 1).forEach((pr, i) => {
      if (d.label) lines.push(`-- Person ${i + 1}`);
      lines.push(...personFacts(pr, state.repos?.[pr.login.toLowerCase()]));
    });
    return {
      lane: d.lane,
      source: d.source,
      key: d.key,
      handle: d.handle,
      name: d.name,
      kind: d.kind,
      sigText: d.label ? `${people.length} people from ${d.label} engaged with ${p.name}` : bestEv.short,
      title: d.title,
      url: d.url,
      facts: lines.join("\n"),
      contact: contactOf(top.u),
      signal: Math.round(d.signal * 10) / 10,
      meta: {
        kind: d.source,
        freshestAt: evs.map((e) => e.at).sort().pop() || new Date().toISOString(),
        relevance: relEv?.rel ?? 0,
        repoStars: relEv?.rel ? relEv.repoStars : 0,
        projectStars: p.stars,
        people: people.length,
        followers: top.u.followers,
        company: d.label || companyOf(top.u.company)?.label || "",
        lastPushAt: repos?.[0]?.pushed_at || "",
        topRepo: repos?.[0]?.name || "",
        evidence: bestEv.text,
        blurb: cleanText(top.u.bio, 100),
        displayName: top.u.name || top.login,
      },
    };
  });
}
