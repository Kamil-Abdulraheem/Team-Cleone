// A fake GitHub with a small, realistic neighbourhood around the repo "me/proj".
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString();
const repo = (login, type, n, extra = {}) => ({ full_name: `${login}/${n}`, name: n, html_url: `https://github.com/${login}/${n}`, description: "fast file search tool", topics: ["search", "filesystem"], language: "Rust", stargazers_count: 300, pushed_at: iso(2), created_at: iso(400), owner: { login, type }, ...extra });
const user = (login, o = {}) => ({ login, type: "User", name: login.toUpperCase(), bio: "Software engineer building developer tools", company: null, blog: `https://${login}.dev`, location: "Lagos", email: null, twitter_username: null, followers: 600, public_repos: 80, created_at: iso(2500), ...o });

export const people = {
  a1: user("a1", { company: "@Acme Inc.", email: "a1@acme.dev" }), a2: user("a2", { company: "acme" }), a3: user("a3", { company: "ACME" }),
  globex: user("globex", { company: "Globex", followers: 2000, public_repos: 120 }),
  inv1: user("inv1", { bio: "Angel investor and seed-stage developer tools fan", followers: 1500 }),
  forker: user("forker", { followers: 300 }),
  peer: user("peer", { followers: 900, company: "Initech" }),
  xss: user("xss", { bio: "<img src=x onerror=alert(1)>", name: "<b>Evil</b>", followers: 4000, public_repos: 300 }),
  junk1: user("junk1", { bio: null, blog: "", followers: 0, public_repos: 1, created_at: iso(5) }),
  bigorg: { ...user("bigorg"), type: "Organization", followers: 900, public_repos: 120 },
};
people.cof1 = user("cof1", { bio: "Founder building a developer-tools startup. Looking for a technical co-founder.", followers: 700, public_repos: 45 });
people.cof2 = user("cof2", { bio: "Indie hacker. Bootstrapped two SaaS products.", followers: 500, public_repos: 30 });
people.cof3 = user("cof3", { bio: "Founding engineer at a Series A company", company: "Initech", followers: 300 });
const joiners = ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8"];
for (const j of joiners) people[j] = user(j, { company: null });

const stars = ["a1", "a2", "a3", "globex", "inv1", ...joiners, "xss", "junk1"];
const watch = (l, d) => ({ type: "WatchEvent", created_at: iso(d), actor: { login: l } });
const resp = (x, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => x, text: async () => (typeof x === "string" ? x : JSON.stringify(x)) });

/** Returns {fetch, calls}. calls() is how many GitHub requests were made since reset(). */
export function mockGithub() {
  let n = 0;
  const f = async (url) => {
    const u = decodeURIComponent(String(url));
    if (!u.startsWith("https://api.github.com")) return resp({}, 599);
    n++;
    if (/\/repos\/me\/cof\/readme/.test(u)) return resp("# cof\nfast file search filesystem tool for developers");
    if (/\/repos\/me\/cof\/events/.test(u)) return resp(["cof1", "cof2", "cof3", "j1"].map((l, i) => watch(l, 0.5 + i * 0.3)));
    if (/\/repos\/me\/cof\/(stargazers|forks)/.test(u)) return resp(/forks/.test(u) ? [] : {}, /forks/.test(u) ? 200 : 404);
    if (/\/repos\/me\/cof$/.test(u)) return resp(repo("me", "User", "cof", { topics: ["search", "filesystem"], stargazers_count: 120, description: "fast file search tool" }));
    if (/\/repos\/me\/proj\/readme/.test(u)) return resp("# proj\nfast file search filesystem tool for developers");
    if (/\/repos\/me\/proj\/events/.test(u)) return resp(stars.map((l, i) => watch(l, 0.2 + i * 0.3)));
    if (/\/repos\/me\/proj\/stargazers/.test(u)) return resp({}, 404);
    if (/\/repos\/me\/proj\/forks/.test(u)) return resp([repo("forker", "User", "proj", { created_at: iso(20), pushed_at: iso(2) }), repo("bigorg", "Organization", "proj", { created_at: iso(9), pushed_at: iso(9) })]);
    if (/\/repos\/me\/proj$/.test(u)) return resp(repo("me", "User", "proj", { topics: ["search", "filesystem"], stargazers_count: 120, description: "fast file search tool" }));
    if (/\/repos\/nope\/missing$/.test(u)) return resp({}, 404);
    if (/\/search\/repositories/.test(u)) return resp({ items: [repo("peer", "User", "peerproj", { pushed_at: iso(1) })] });
    if (/\/users\/(\w+)\/repos/.test(u)) return resp([repo("x", "User", "latest-work")]);
    const m = u.match(/\/users\/(\w+)$/);
    if (m) return people[m[1]] ? resp(people[m[1]]) : resp({}, 404);
    return resp({}, 404);
  };
  return { fetch: f, calls: () => n, reset: () => (n = 0) };
}
