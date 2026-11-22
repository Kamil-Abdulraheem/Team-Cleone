import type { Lane } from "./db";

const API = "https://api.github.com";
const DAY = 86_400_000;

// ---- Tunables. Every threshold lives here so scan quality can be tuned in one place. ----
export const MIN_SIGNAL = 40; // evidence strength (0-100) a candidate needs to reach Claude
export const MIN_RELEVANCE = 5; // topic/language/keyword overlap a similar repo needs
export const MAX_CANDIDATES = 30;
const QUOTAS: Record<Source, number> = { star: 12, similar: 12, fork: 6 };
const STARS_WANTED = 40; // newest stargazers to profile
const FORK_BUDGET = { org: 10, modified: 15, plain: 5 };
const SIMILAR_OWNERS_PROFILED = 25;
const COMPANY_MIN_PEOPLE = 2; // a company becomes a strategic "entity" at 2+ engaged people
const COMPANY_MIN_TOP_SIGNAL = 30; // ...and at least one of them must look like a real account
const COMPANY_BONUS_PER_EXTRA = 8;
const STRATEGIC_SOLO_MIN = 60; // one strong person who names an employer also counts as company-level interest

export type Source = "star" | "fork" | "similar";

export type ProjectSummary = {
  owner: string;
  name: string;
  url: string;
  description: string;
  topics: string[];
  language: string | null;
  stars: number;
  readme: string;
};

export type Candidate = {
  lane: Lane;
  source: Source;
  dedupe_key: string; // stable identity across rescans, e.g. "company:acme" or "person:alice"
  handle: string;
  name: string;
  artifact_title: string;
  artifact_url: string;
  facts: string;
  contact: string; // public contact details only
  signal: number; // deterministic evidence strength, 0-100
};

export type CollectStats = {
  fetched: { stars: number; forks: number; similarRepos: number };
  profiles: number;
  dropped: { notAPerson: number; lowSignal: number; irrelevantRepos: number };
  companies: number;
  composed: Record<Source, number>;
  warnings: string[];
};

type GhRepo = {
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
  created_at: string;
  owner: { login: string; type: string };
};

type GhUser = {
  login: string;
  type: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  twitter_username: string | null;
  followers: number;
  public_repos: number;
  created_at: string;
  html_url: string;
};

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ HTTP layer

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limits: Record<string, { remaining: number; reset: number }> = {};

function headers(accept: string) {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cleone",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function request(path: string, accept: string, attempt = 0): Promise<Response> {
  const resource = path.startsWith("/search/") ? "search" : "core";
  const lim = limits[resource];
  if (lim && lim.remaining < 2 && Date.now() < lim.reset * 1000) {
    throw new GitHubError(
      429,
      `GitHub ${resource} rate limit reached. Resets at ${new Date(lim.reset * 1000).toISOString()}. Set GITHUB_TOKEN to raise limits.`
    );
  }
  const res = await fetch(API + path, { headers: headers(accept), cache: "no-store" });
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

async function gh<T>(path: string, accept = "application/vnd.github+json"): Promise<T> {
  const res = await request(path, accept);
  if (!res.ok) {
    const limited = res.status === 403 || res.status === 429;
    throw new GitHubError(
      res.status,
      limited
        ? "GitHub rate limit or access problem. Set GITHUB_TOKEN to raise limits."
        : `GitHub returned ${res.status} for ${path}`
    );
  }
  return (await res.json()) as T;
}

/** Run fn over items with bounded concurrency. Never throws; returns settled results. */
async function pMap<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>) {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ project

export function parseRepo(input: string): { owner: string; name: string } {
  const raw = input.trim();
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
    throw new Error("Could not read a GitHub repo from that input. Use github.com/owner/repo.");
  }
  return { owner, name: name.replace(/\.git$/i, "") };
}

async function readme(owner: string, name: string): Promise<string> {
  try {
    const res = await request(`/repos/${owner}/${name}/readme`, "application/vnd.github.raw+json");
    return res.ok ? (await res.text()).slice(0, 1500) : "";
  } catch {
    return "";
  }
}

export async function fetchProject(owner: string, name: string): Promise<ProjectSummary> {
  const repo = await gh<GhRepo>(`/repos/${owner}/${name}`);
  return {
    owner: repo.owner.login,
    name: repo.name,
    url: `https://github.com/${repo.owner.login}/${repo.name}`,
    description: repo.description ?? "",
    topics: repo.topics ?? [],
    language: repo.language,
    stars: repo.stargazers_count,
    readme: await readme(owner, name),
  };
}

// ------------------------------------------------------------------ scoring helpers

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
  "write", "written", "easy", "modern", "powerful", "lightweight",
]);

const tokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));

function relevance(p: ProjectSummary, r: GhRepo, kw: Set<string>): { score: number; shared: string[] } {
  const pt = new Set(p.topics);
  const shared: string[] = [];
  let s = 0;
  for (const t of r.topics ?? []) {
    if (!pt.has(t)) continue;
    shared.push(t);
    s += GENERIC_TOPICS.has(t) ? 0.5 : 3;
  }
  if (p.language && r.language === p.language) s += 2;
  let overlap = 0;
  for (const w of new Set(tokens(`${r.name} ${r.description ?? ""}`))) if (kw.has(w)) overlap++;
  s += Math.min(3, overlap);
  return { score: s, shared };
}

/** How real and established an account looks, 0-80. Evidence bonuses are added on top. */
function profileSignal(u: GhUser): number {
  const followers = Math.min(30, Math.log10(u.followers + 1) * 12);
  const repos = Math.min(15, Math.log10(u.public_repos + 1) * 8);
  const years = (Date.now() - new Date(u.created_at).getTime()) / (365 * DAY);
  const age = Math.max(0, Math.min(10, years * 2.5));
  const completeness = (u.bio ? 10 : 0) + (u.company ? 10 : 0) + (u.blog ? 5 : 0);
  return followers + repos + age + completeness;
}

const NO_COMPANY = new Set([
  "", "self", "freelance", "freelancer", "independent", "none", "n/a", "na", "student",
  "unemployed", "me", "myself", "personal", "open source", "opensource", "home",
]);

function companyOf(raw: string | null): { key: string; label: string } | null {
  if (!raw) return null;
  const label = raw.replace(/^@+/, "").split(/[,/|]/)[0].trim();
  const key = label
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|corp|co|limited)\.?$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (key.length < 2 || NO_COMPANY.has(key)) return null;
  return { key, label };
}

function ago(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

function contactOf(u: GhUser): string {
  const parts: string[] = [];
  if (u.email) parts.push(`email ${u.email}`);
  if (u.blog) parts.push(`web ${u.blog.startsWith("http") ? u.blog : `https://${u.blog}`}`);
  if (u.twitter_username) parts.push(`x.com/${u.twitter_username}`);
  return parts.join(" | ");
}

// ------------------------------------------------------------------ data sources

type Ev = { kind: Source; bonus: number; text: string; title: string; url: string };
type Person = { login: string; u: GhUser; ev: Ev[]; signal: number };
type Draft = {
  lane: Lane;
  source: Source;
  key: string;
  handle: string;
  name: string;
  title: string;
  url: string;
  signal: number;
  people: Person[];
  label?: string;
};

const profileCache = new Map<string, { at: number; u: GhUser | null }>();
async function profile(login: string): Promise<GhUser | null> {
  const k = login.toLowerCase();
  const hit = profileCache.get(k);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.u;
  try {
    const u = await gh<GhUser>(`/users/${login}`);
    profileCache.set(k, { at: Date.now(), u });
    return u;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      profileCache.set(k, { at: Date.now(), u: null });
      return null;
    }
    throw e;
  }
}

type Star = { login: string; at: string; type: string };

/** Stars from the public events feed: timestamped, newest first, last ~90 days. Works for any repo. */
async function starsFromEvents(p: ProjectSummary): Promise<Star[]> {
  const out: Star[] = [];
  for (let pg = 1; pg <= 3; pg++) {
    const items = await gh<{ type: string; created_at: string; actor: { login: string } }[]>(
      `/repos/${p.owner}/${p.name}/events?per_page=100&page=${pg}`
    );
    for (const e of items) if (e.type === "WatchEvent") out.push({ login: e.actor.login, at: e.created_at, type: "User" });
    if (items.length < 100) break;
  }
  return out;
}

/** Stargazers API: complete history, so it covers small repos whose events have aged out. */
async function starsFromStargazers(p: ProjectSummary): Promise<Star[]> {
  const last = Math.max(1, Math.ceil(p.stars / 100));
  const pages = last > 1 ? [last, last - 1] : [1];
  const out: Star[] = [];
  for (const pg of pages) {
    const items = await gh<{ starred_at: string; user: { login: string; type: string } }[]>(
      `/repos/${p.owner}/${p.name}/stargazers?per_page=100&page=${pg}`,
      "application/vnd.github.star+json"
    );
    for (const i of items) out.push({ login: i.user.login, at: i.starred_at, type: i.user.type });
    if (out.length >= STARS_WANTED) break;
  }
  return out;
}

async function recentStars(p: ProjectSummary, warnings: string[]): Promise<Star[]> {
  const [ev, sg] = await Promise.allSettled([starsFromEvents(p), starsFromStargazers(p)]);
  const merged = new Map<string, Star>();
  for (const r of [ev, sg]) {
    if (r.status !== "fulfilled") continue;
    for (const s of r.value) {
      const k = s.login.toLowerCase();
      const prev = merged.get(k);
      if (!prev || s.at > prev.at) merged.set(k, s);
    }
  }
  if (!merged.size) {
    for (const r of [ev, sg]) {
      if (r.status === "rejected") warnings.push(`star lookup failed: ${r.reason instanceof Error ? r.reason.message : "error"}`);
    }
  }
  return [...merged.values()]
    .filter((s) => s.login.toLowerCase() !== p.owner.toLowerCase() && !s.login.includes("[bot]") && s.type === "User")
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, STARS_WANTED);
}

async function forkPicks(p: ProjectSummary): Promise<{ all: number; picks: { repo: GhRepo; modified: boolean }[] }> {
  const forks = await gh<GhRepo[]>(`/repos/${p.owner}/${p.name}/forks?sort=newest&per_page=100`);
  const seen = new Set<string>([p.owner.toLowerCase()]);
  const tag = forks
    .filter((f) => !seen.has(f.owner.login.toLowerCase()))
    .map((repo) => ({
      repo,
      // A fresh fork keeps the parent's pushed_at. If it moved past created_at, the owner committed.
      modified: new Date(repo.pushed_at).getTime() > new Date(repo.created_at).getTime() + 60_000,
    }));
  const picks: { repo: GhRepo; modified: boolean }[] = [];
  const take = (arr: typeof tag, n: number) => {
    for (const f of arr) {
      const l = f.repo.owner.login.toLowerCase();
      if (n <= 0) break;
      if (seen.has(l)) continue;
      seen.add(l);
      picks.push(f);
      n--;
    }
  };
  take(tag.filter((f) => f.repo.owner.type === "Organization"), FORK_BUDGET.org);
  take(
    tag.filter((f) => f.modified).sort((a, b) => b.repo.pushed_at.localeCompare(a.repo.pushed_at)),
    FORK_BUDGET.modified
  );
  take(tag.filter((f) => !f.modified), FORK_BUDGET.plain);
  return { all: forks.length, picks };
}

function searchQueries(p: ProjectSummary): string[] {
  const since = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);
  const base = `-user:${p.owner} fork:false archived:false pushed:>=${since}`;
  const specific = p.topics.filter((t) => !GENERIC_TOPICS.has(t)).slice(0, 4);
  const qs: string[] = [];
  const pairs: string[] = [];
  for (let i = 0; i < specific.length; i++)
    for (let j = i + 1; j < specific.length; j++) pairs.push(`topic:${specific[i]} topic:${specific[j]}`);
  for (const pr of pairs.slice(0, 3)) qs.push(`${pr} stars:>=10 ${base}`);
  for (const t of specific.slice(0, 2)) qs.push(`topic:${t} stars:>=50 ${base}`);
  if (!qs.length) {
    const kw = [...new Set(tokens(p.description))].slice(0, 3).join(" ");
    if (kw) qs.push(`${kw} in:name,description${p.language ? ` language:${p.language}` : ""} stars:>=20 ${base}`);
  }
  return qs;
}

async function similarRepos(
  p: ProjectSummary,
  warnings: string[]
): Promise<{ fetched: number; irrelevant: number; kept: { repo: GhRepo; rel: number; shared: string[] }[] }> {
  const kw = new Set([...tokens(p.description), ...tokens(p.name)]);
  const byName = new Map<string, GhRepo>();
  for (const q of searchQueries(p)) {
    try {
      const r = await gh<{ items: GhRepo[] }>(
        `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`
      );
      for (const repo of r.items) byName.set(repo.full_name, repo);
    } catch (e) {
      warnings.push(`similar-repo search failed: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  const scored = [...byName.values()].map((repo) => ({ repo, ...relevance(p, repo, kw) }));
  const rel = scored
    .filter((x) => x.score >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score || b.repo.stargazers_count - a.repo.stargazers_count);
  const owners = new Set<string>([p.owner.toLowerCase()]);
  const kept: { repo: GhRepo; rel: number; shared: string[] }[] = [];
  for (const x of rel) {
    const o = x.repo.owner.login.toLowerCase();
    if (owners.has(o)) continue;
    owners.add(o);
    kept.push({ repo: x.repo, rel: x.score, shared: x.shared });
    if (kept.length >= SIMILAR_OWNERS_PROFILED) break;
  }
  return { fetched: scored.length, irrelevant: scored.length - rel.length, kept };
}

// ------------------------------------------------------------------ collect

function compose(drafts: Draft[]): Draft[] {
  const by: Record<Source, Draft[]> = { star: [], fork: [], similar: [] };
  for (const d of drafts) by[d.source].push(d);
  const picked: Draft[] = [];
  const rest: Draft[] = [];
  for (const k of Object.keys(by) as Source[]) {
    by[k].sort((a, b) => b.signal - a.signal);
    picked.push(...by[k].slice(0, QUOTAS[k]));
    rest.push(...by[k].slice(QUOTAS[k]));
  }
  rest.sort((a, b) => b.signal - a.signal);
  while (picked.length < MAX_CANDIDATES && rest.length) picked.push(rest.shift()!);
  return picked.sort((a, b) => b.signal - a.signal);
}

function personFacts(pr: Person, repos?: GhRepo[]): string[] {
  const u = pr.u;
  const age = ((Date.now() - new Date(u.created_at).getTime()) / (365 * DAY)).toFixed(1);
  const lines = [`${u.name || u.login} (@${u.login}, ${u.type})`];
  for (const e of [...pr.ev].sort((a, b) => b.bonus - a.bonus)) lines.push(`Evidence: ${e.text}`);
  if (u.bio) lines.push(`Bio: ${u.bio}`);
  if (u.company) lines.push(`Company: ${u.company}`);
  if (u.location) lines.push(`Location: ${u.location}`);
  lines.push(`Followers: ${u.followers}; public repos: ${u.public_repos}; account age: ${age} years`);
  if (repos?.length) {
    lines.push(
      "Recent repos: " +
        repos.map((r) => `${r.name} (${r.language ?? "n/a"}, pushed ${r.pushed_at.slice(0, 10)})`).join("; ")
    );
  }
  return lines;
}

export async function collect(p: ProjectSummary): Promise<{ candidates: Candidate[]; stats: CollectStats }> {
  const warnings: string[] = [];
  const stats: CollectStats = {
    fetched: { stars: 0, forks: 0, similarRepos: 0 },
    profiles: 0,
    dropped: { notAPerson: 0, lowSignal: 0, irrelevantRepos: 0 },
    companies: 0,
    composed: { star: 0, fork: 0, similar: 0 },
    warnings,
  };

  // 1. Pull raw signals. Each source is optional; a failure becomes a warning, not a crash.
  const [starsR, forksR, simR] = await Promise.allSettled([recentStars(p, warnings), forkPicks(p), similarRepos(p, warnings)]);
  const stars = starsR.status === "fulfilled" ? starsR.value : [];
  const forks = forksR.status === "fulfilled" ? forksR.value : { all: 0, picks: [] };
  const sim = simR.status === "fulfilled" ? simR.value : { fetched: 0, irrelevant: 0, kept: [] };
  for (const r of [starsR, forksR, simR]) {
    if (r.status === "rejected") warnings.push(r.reason instanceof Error ? r.reason.message : "source failed");
  }
  if ([starsR, forksR, simR].every((r) => r.status === "rejected")) {
    throw (starsR as PromiseRejectedResult).reason;
  }
  stats.fetched = { stars: stars.length, forks: forks.all, similarRepos: sim.fetched };
  stats.dropped.irrelevantRepos = sim.irrelevant;

  // 2. Profile everyone once.
  const logins = new Set<string>();
  for (const s of stars) if (s.type === "User") logins.add(s.login);
  for (const f of forks.picks) logins.add(f.repo.owner.login);
  for (const s of sim.kept) logins.add(s.repo.owner.login);
  const list = [...logins];
  const settled = await pMap(list, 8, profile);
  if (list.length && settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  const profiles = new Map<string, GhUser>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) profiles.set(list[i].toLowerCase(), r.value);
  });
  stats.profiles = profiles.size;

  // 3. Attach evidence to people. One person, many signals: starring AND forking stacks.
  const people = new Map<string, Person>();
  const add = (login: string, ev: Ev) => {
    const u = profiles.get(login.toLowerCase());
    if (!u) return;
    if (u.type !== "User" && u.type !== "Organization") return;
    const k = login.toLowerCase();
    const pr = people.get(k) ?? { login: u.login, u, ev: [], signal: 0 };
    pr.ev.push(ev);
    people.set(k, pr);
  };
  for (const s of stars) {
    const days = (Date.now() - new Date(s.at).getTime()) / DAY;
    add(s.login, {
      kind: "star",
      bonus: days <= 7 ? 10 : days <= 30 ? 5 : 2,
      text: `Starred ${p.owner}/${p.name} ${ago(s.at)}`,
      title: `Starred ${p.owner}/${p.name}`,
      url: `https://github.com/${s.login}`,
    });
  }
  for (const f of forks.picks) {
    add(f.repo.owner.login, {
      kind: "fork",
      bonus: f.modified ? 15 : 3,
      text: f.modified
        ? `Forked ${p.owner}/${p.name} and pushed their own commits (last push ${ago(f.repo.pushed_at)})`
        : `Forked ${p.owner}/${p.name} ${ago(f.repo.created_at)} with no changes of their own`,
      title: `Forked ${p.owner}/${p.name}`,
      url: f.repo.html_url,
    });
  }
  for (const s of sim.kept) {
    add(s.repo.owner.login, {
      kind: "similar",
      bonus: Math.min(15, s.rel * 2) + Math.min(5, Math.log10(s.repo.stargazers_count + 1) * 1.5),
      text: `Maintains similar project ${s.repo.full_name}: ${s.repo.description ?? "no description"} (${s.repo.language ?? "n/a"}, ${s.repo.stargazers_count} stars, shared topics: ${s.shared.join(", ") || "none"}, last push ${ago(s.repo.pushed_at)})`,
      title: `Maintains ${s.repo.full_name}`,
      url: s.repo.html_url,
    });
  }
  const droppedTypes = profiles.size - people.size;
  stats.dropped.notAPerson = droppedTypes;
  for (const pr of people.values()) {
    pr.signal = Math.min(100, profileSignal(pr.u) + pr.ev.reduce((a, e) => a + e.bonus, 0));
  }

  // 4. Turn people into candidates. Organizations stand alone; people sharing a company merge
  //    into one strategic "company is paying attention" entity; everyone else is an individual.
  const drafts: Draft[] = [];
  const byCompany = new Map<string, { label: string; members: Person[] }>();
  const solo: Person[] = [];
  for (const pr of people.values()) {
    if (pr.u.type === "Organization") {
      drafts.push(draftFor(pr, "strategic"));
      continue;
    }
    const c = companyOf(pr.u.company);
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
    if (g.members.length >= COMPANY_MIN_PEOPLE && top.signal >= COMPANY_MIN_TOP_SIGNAL) {
      const best = [...top.ev].sort((a, b) => b.bonus - a.bonus)[0];
      drafts.push({
        lane: "strategic",
        source: best.kind,
        key: `company:${key}`,
        handle: g.label,
        name: g.label,
        title: `${g.members.length} people from ${g.label} engaged with ${p.name}`,
        url: best.url,
        signal: Math.min(100, top.signal + COMPANY_BONUS_PER_EXTRA * (g.members.length - 1)),
        people: g.members,
        label: g.label,
      });
      stats.companies++;
    } else {
      for (const m of g.members) {
        if (m.signal >= STRATEGIC_SOLO_MIN) drafts.push(draftFor(m, "strategic", g.label));
        else solo.push(m);
      }
    }
  }
  for (const pr of solo) drafts.push(draftFor(pr, "joiners"));

  // 5. Quality gate, then balance sources so one noisy source cannot fill the list.
  const gated = drafts.filter((d) => d.signal >= MIN_SIGNAL);
  stats.dropped.lowSignal = drafts.length - gated.length;
  const chosen = compose(gated);
  for (const d of chosen) stats.composed[d.source]++;

  // 6. Enrich only the survivors with recent repos (timing evidence for the scorer).
  const targets = new Map<string, Person>();
  for (const d of chosen) for (const pr of d.people.slice(0, 2)) targets.set(pr.login.toLowerCase(), pr);
  const tl = [...targets.values()];
  const repoRes = await pMap(tl, 8, (pr) => gh<GhRepo[]>(`/users/${pr.login}/repos?sort=pushed&per_page=5`));
  const repos = new Map<string, GhRepo[]>();
  repoRes.forEach((r, i) => {
    if (r.status === "fulfilled") repos.set(tl[i].login.toLowerCase(), r.value);
  });

  const candidates: Candidate[] = chosen.map((d) => {
    const shown = d.people.slice(0, d.label ? 4 : 1);
    const lines: string[] = [];
    if (d.label) lines.push(`${d.people.length} people from ${d.label} engaged with ${p.owner}/${p.name}:`);
    shown.forEach((pr, i) => {
      if (d.label) lines.push(`-- Person ${i + 1}`);
      lines.push(...personFacts(pr, repos.get(pr.login.toLowerCase())));
    });
    return {
      lane: d.lane,
      source: d.source,
      dedupe_key: d.key,
      handle: d.handle,
      name: d.name,
      artifact_title: d.title,
      artifact_url: d.url,
      facts: lines.join("\n"),
      contact: contactOf(d.people[0].u),
      signal: Math.round(d.signal * 10) / 10,
    };
  });
  return { candidates, stats };
}

function draftFor(pr: Person, lane: Lane, company?: string): Draft {
  const best = [...pr.ev].sort((a, b) => b.bonus - a.bonus)[0];
  return {
    lane,
    source: best.kind,
    key: `person:${pr.login.toLowerCase()}`,
    handle: pr.login,
    name: pr.u.name || pr.login,
    title: company ? `${best.title}, works at ${company}` : best.title,
    url: best.url,
    signal: pr.signal,
    people: [pr],
  };
}
