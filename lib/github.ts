import type { Lane } from "./db";

const API = "https://api.github.com";

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
  handle: string;
  name: string;
  artifact_title: string;
  artifact_url: string;
  facts: string;
};

type GhRepo = {
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string;
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
  followers: number;
  public_repos: number;
};

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function headers(accept = "application/vnd.github+json") {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cleone",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { headers: headers(), cache: "no-store" });
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
    const res = await fetch(`${API}/repos/${owner}/${name}/readme`, {
      headers: headers("application/vnd.github.raw+json"),
      cache: "no-store",
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, 1500);
  } catch {
    return "";
  }
}

export async function fetchProject(owner: string, name: string): Promise<ProjectSummary> {
  const repo = await gh<GhRepo>(`/repos/${owner}/${name}`);
  return {
    owner: repo.owner.login,
    name: repo.name,
    url: repo.html_url,
    description: repo.description ?? "",
    topics: repo.topics ?? [],
    language: repo.language,
    stars: repo.stargazers_count,
    readme: await readme(owner, name),
  };
}

async function profileFacts(login: string): Promise<{ name: string; facts: string[] }> {
  const [u, repos] = await Promise.allSettled([
    gh<GhUser>(`/users/${login}`),
    gh<GhRepo[]>(`/users/${login}/repos?sort=pushed&per_page=4`),
  ]);
  const facts: string[] = [];
  let name = login;
  if (u.status === "fulfilled") {
    const p = u.value;
    name = p.name || login;
    facts.push(`Account type: ${p.type}`);
    if (p.bio) facts.push(`Bio: ${p.bio}`);
    if (p.company) facts.push(`Company: ${p.company}`);
    if (p.location) facts.push(`Location: ${p.location}`);
    facts.push(`Followers: ${p.followers}; public repos: ${p.public_repos}`);
  }
  if (repos.status === "fulfilled" && repos.value.length) {
    facts.push(
      "Recent repos: " +
        repos.value
          .map((r) => `${r.name} (${r.language ?? "n/a"}, pushed ${r.pushed_at.slice(0, 10)})`)
          .join("; ")
    );
  }
  return { name, facts };
}

function laneFor(ownerType: string): Lane {
  return ownerType === "Organization" ? "strategic" : "joiners";
}

export async function collect(p: ProjectSummary): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>([p.owner.toLowerCase()]);

  // (a) Recent forkers. Forking is the strongest public sign of interest.
  const forks = await gh<GhRepo[]>(
    `/repos/${p.owner}/${p.name}/forks?sort=newest&per_page=30`
  ).catch(() => [] as GhRepo[]);
  const forkPicks: GhRepo[] = [];
  for (const f of forks) {
    const login = f.owner.login.toLowerCase();
    if (seen.has(login)) continue;
    seen.add(login);
    forkPicks.push(f);
    if (forkPicks.length >= 12) break;
  }

  // (b) Similar repos from GitHub search, by first topic and language.
  const terms: string[] = [];
  if (p.topics[0]) terms.push(`topic:${p.topics[0]}`);
  if (p.language) terms.push(`language:${p.language}`);
  if (!terms.length) terms.push(`${p.name} in:name,description`);
  const q = `${terms.join(" ")} -user:${p.owner} fork:false`;
  const found = await gh<{ items: GhRepo[] }>(
    `/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=30`
  ).catch(() => ({ items: [] as GhRepo[] }));
  const similarPicks: GhRepo[] = [];
  for (const r of found.items) {
    const login = r.owner.login.toLowerCase();
    if (seen.has(login)) continue;
    seen.add(login);
    similarPicks.push(r);
    if (similarPicks.length >= 15) break;
  }

  const build = async (r: GhRepo, kind: "fork" | "similar") => {
    const prof = await profileFacts(r.owner.login);
    const facts = [
      kind === "fork"
        ? `Forked ${p.owner}/${p.name} (repo: ${r.full_name}, last pushed ${r.pushed_at.slice(0, 10)})`
        : `Owns a similar repo: ${r.full_name} - ${r.description ?? "no description"} (${r.language ?? "n/a"}, ${r.stargazers_count} stars, last pushed ${r.pushed_at.slice(0, 10)})`,
      ...(r.topics?.length ? [`Topics: ${r.topics.join(", ")}`] : []),
      ...prof.facts,
    ];
    out.push({
      lane: laneFor(r.owner.type),
      handle: r.owner.login,
      name: prof.name,
      artifact_title: kind === "fork" ? `Fork: ${r.full_name}` : r.full_name,
      artifact_url: r.html_url,
      facts: facts.join("\n"),
    });
  };

  await Promise.allSettled([
    ...forkPicks.map((r) => build(r, "fork")),
    ...similarPicks.map((r) => build(r, "similar")),
  ]);
  return out;
}
