// Job Radar. Everything about finding, checking and matching jobs lives here, with no database code, so it is easy to test.
// The routes that use it are in lib/app.js. The principle: never waste the person's time. A job is only called "open"
// when we checked; when we could not check, we say "could not verify" instead of guessing.

export const DAY = 86400;
const sec = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ text helpers

export const stripHtml = (s) =>
  String(s || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").split(/\s+/).filter(Boolean);
const csv = (s) => String(s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const STOP = new Set(["senior", "junior", "lead", "staff", "principal", "remote", "the", "and", "of", "a", "for", "in", "at", "-", "ii", "iii", "i", "sr", "jr", "mid"]);
const titleCore = (t) => words(t).filter((w) => !STOP.has(w)).join(" ");

/** Same job on several boards -> same fingerprint. Seniority words are kept out so "Sr. Django Developer" and "Django Developer" match. */
export const fingerprint = (j) =>
  [j.company, titleCore(j.title), j.remote ? "remote" : words(j.location).slice(0, 2).join(" ")]
    .map((x) => String(x || "").toLowerCase().replace(/\b(inc|ltd|llc|limited|gmbh|corp|co)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim()).join("|");

// ------------------------------------------------------------------ sources (public job feeds)
// Each source returns plain objects. If a source changes its format or goes down, fetchAll records it in source_health
// and the other sources still work. Please keep to each source's terms: these three publish free public feeds.

const num = (x) => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : null);
const epoch = (x) => { const t = typeof x === "number" ? (x > 1e12 ? x / 1000 : x) : Date.parse(x) / 1000; return Number.isFinite(t) && t > 0 ? Math.floor(t) : null; };

export const SOURCES = {
  remotive: {
    url: "https://remotive.com/api/remote-jobs?limit=200",
    parse: (d) => (d.jobs || []).map((j) => ({ url: j.url, title: j.title, company: j.company_name, location: j.candidate_required_location || "Remote", remote: 1,
      description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.publication_date), salary_text: j.salary })),
  },
  arbeitnow: {
    url: "https://www.arbeitnow.com/api/job-board-api",
    parse: (d) => (d.data || []).map((j) => ({ url: j.url, title: j.title, company: j.company_name, location: j.location || "", remote: j.remote ? 1 : 0,
      description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.created_at) })),
  },
  remoteok: {
    url: "https://remoteok.com/api", // RemoteOK asks that you link back to the job's page, which we do (the apply link is theirs).
    parse: (d) => (Array.isArray(d) ? d : []).filter((j) => j && j.position).map((j) => ({ url: j.url || j.apply_url, title: j.position, company: j.company, location: j.location || "Remote",
      remote: 1, description: j.description, tags: (j.tags || []).join(","), posted_at: epoch(j.epoch || j.date), salary_min: num(j.salary_min), salary_max: num(j.salary_max) })),
  },
};

function salaryFromText(t) {
  const m = String(t || "").replace(/,/g, "").match(/(\d{2,3})\s?k?\s*[-–to]+\s*(\d{2,3})\s?k/i);
  return m ? { salary_min: +m[1] * 1000, salary_max: +m[2] * 1000 } : {};
}

export function normalize(source, raw) {
  const description = stripHtml(raw.description).slice(0, 6000);
  const sal = raw.salary_min ? {} : salaryFromText(raw.salary_text);
  return {
    source, url: String(raw.url || ""), title: stripHtml(raw.title).slice(0, 160), company: stripHtml(raw.company).slice(0, 120),
    location: stripHtml(raw.location).slice(0, 120), remote: raw.remote ? 1 : /remote/i.test(raw.location || "") ? 1 : 0,
    salary_min: raw.salary_min || sal.salary_min || null, salary_max: raw.salary_max || sal.salary_max || null, currency: raw.salary_min || sal.salary_min ? "USD" : "",
    description, tags: String(raw.tags || "").toLowerCase().slice(0, 300), posted_at: raw.posted_at || null,
  };
}

/** Fetches every source. One failing source never stops the others. Returns { jobs, health: {source: {ok, count, error}} }. */
export async function fetchAll(fetchImpl = fetch, only) {
  const jobs = [], health = {};
  await Promise.all(Object.entries(SOURCES).filter(([k]) => !only || only.includes(k)).map(async ([name, s]) => {
    for (let attempt = 0; attempt < 2; attempt++) { // one retry
      try {
        const res = await fetchImpl(s.url, { headers: { accept: "application/json", "user-agent": "CleoneJobRadar/1.0 (+https://cleone.app)" }, signal: AbortSignal.timeout?.(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = s.parse(await res.json()).map((r) => normalize(name, r)).filter((j) => j.url.startsWith("http"));
        if (!list.length) throw new Error("the feed returned no usable jobs (format may have changed)");
        jobs.push(...list); health[name] = { ok: true, count: list.length };
        return;
      } catch (e) { health[name] = { ok: false, count: 0, error: String(e.message || e).slice(0, 200) }; }
    }
  }));
  return { jobs, health };
}

// ------------------------------------------------------------------ noise filter

/** Returns a reason string if this posting is noise and should be dropped, else null. */
export function noiseReason(j) {
  if (!j.title || !j.company) return "missing title or company";
  if (j.description.length < 80) return "no real description";
  if (/^(n\/a|confidential|hiring|company)$/i.test(j.company.trim())) return "anonymous employer";
  if (/\b(mlm|network marketing|crypto signals?|forex (signal|trader)|data entry from home)\b/i.test(j.title + " " + j.description.slice(0, 400))) return "off-topic spam";
  return null;
}

// ------------------------------------------------------------------ scam and ghost checks

const SCAM_RULES = [
  [/(registration|application|processing|training|medical|uniform|admin|interview)\s+fee|pay (a |an )?(fee|deposit)|send (us )?money|refundable deposit|purchase (your own )?(equipment|laptop) (from|through) us/i, 45, "asks you to pay a fee or deposit"],
  [/(whatsapp|telegram)( only| us| number)?[^.\n]{0,40}(\+?\d[\d\s-]{7,})/i, 20, "pushes you to WhatsApp or Telegram"],
  [/\b[a-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|ymail)\.com\b/i, 20, "applications go to a free personal email address"],
  [/(no (experience|skills?|interview) (needed|required)|guaranteed (job|income|salary)|get hired (today|immediately|instantly))/i, 20, "promises a job with no experience or interview"],
  [/(earn|make)\s+\$?\d{3,}[^.\n]{0,20}(per|a|each)\s+(day|week)/i, 25, "promises unusually high daily or weekly earnings"],
  [/(cheque|check) (will be )?(sent|mailed)|buy (gift cards?|equipment) (and|then) (be )?reimbursed/i, 40, "fake-cheque or reimbursement pattern"],
];

export function scamCheck(j) {
  const text = `${j.title}\n${j.description}`;
  let score = 0; const flags = [];
  for (const [re, pts, msg] of SCAM_RULES) if (re.test(text)) { score += pts; flags.push(msg); }
  if (j.title === j.title.toUpperCase() && j.title.length > 12) { score += 10; flags.push("title is all capital letters"); }
  if (j.salary_max && j.salary_max > 400000 && !/(director|vp|head|chief|principal)/i.test(j.title)) { score += 15; flags.push("salary is far above normal for this role"); }
  return { score: Math.min(100, score), flags };
}

/** Ghost and repeat postings. Uses what we know from our own history of the job. */
export function ghostCheck(j, hist = {}) {
  const flags = [];
  const age = j.posted_at ? Math.floor((sec() - j.posted_at) / DAY) : null;
  if (age !== null && age > 60) flags.push(`posted ${age} days ago`);
  if (hist.reposts >= 2) flags.push(`reposted ${hist.reposts} times`);
  if ((hist.sources || 1) >= 3 && age !== null && age > 30) flags.push("copied across many boards for over a month");
  if (j.description.length < 250) flags.push("very little detail about the role");
  return flags;
}

// ------------------------------------------------------------------ verification (is it really still open?)

const CLOSED_PHRASES = /(no longer (accepting|available|open)|position (has been |is )?(filled|closed)|job (has )?(expired|closed)|this (job|position|role|vacancy) (is )?(no longer|has been (closed|filled|removed))|applications? (are )?closed|not accepting applications)/i;

/**
 * Looks at the apply page. Verdicts:
 *   open        the page loads and does not say it is closed
 *   closed      the page is gone (404/410) or says it is closed
 *   unverified  we could not tell (site blocks bots, timed out, error). Never treated as open.
 */
export async function verifyJob(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; CleoneJobRadar/1.0)" }, signal: AbortSignal.timeout?.(10000) });
    if (res.status === 404 || res.status === 410) return { status: "closed", note: `the page is gone (HTTP ${res.status})` };
    if (!res.ok) return { status: "unverified", note: `could not verify: the site answered HTTP ${res.status}` };
    const body = String((await res.text()) || "").slice(0, 300000);
    if (CLOSED_PHRASES.test(stripHtml(body))) return { status: "closed", note: "the page says the role is closed" };
    return { status: "open", note: "the apply page loads and does not say it is closed" };
  } catch (e) {
    return { status: "unverified", note: "could not verify: the site did not answer" };
  }
}

// ------------------------------------------------------------------ the person: CV, skills, matching

const SKILLS = ["python", "django", "flask", "fastapi", "javascript", "typescript", "node", "react", "vue", "angular", "next.js", "html", "css", "sql", "postgresql", "mysql", "mongodb", "redis",
  "docker", "kubernetes", "aws", "azure", "gcp", "linux", "git", "java", "kotlin", "swift", "flutter", "dart", "php", "laravel", "ruby", "rails", "go", "rust", "c#", ".net", "c++",
  "figma", "ui", "ux", "product management", "agile", "scrum", "seo", "excel", "power bi", "tableau", "data analysis", "machine learning", "pytorch", "tensorflow", "devops", "ci/cd",
  "accounting", "sales", "marketing", "customer support", "copywriting", "recruiting", "project management", "graphql", "rest", "api", "testing", "qa"];

export function extractSkills(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9+#./\s]/g, " ") + " ";
  return SKILLS.filter((s) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.+#/]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
}

/** Years of experience the job asks for, per skill: "3 years of Django" -> {django: 3}. */
function yearsAsked(text) {
  const out = {};
  for (const m of String(text).toLowerCase().matchAll(/(\d{1,2})\+?\s*(?:years?|yrs)\s*(?:of\s*)?(?:experience\s*(?:with|in)\s*)?([a-z.+#/ ]{2,24})/g)) {
    const skill = SKILLS.find((s) => m[2].trim().startsWith(s)); if (skill) out[skill] = Math.max(out[skill] || 0, +m[1]);
  }
  return out;
}

export function matchJob(profile, job) {
  const mySkills = new Set(csv(profile.skills)), roles = csv(profile.roles);
  const text = `${job.title} ${job.tags} ${job.description}`.toLowerCase();
  const need = extractSkills(`${job.title} ${job.tags} ${job.description}`);
  const have = need.filter((s) => mySkills.has(s)), lack = need.filter((s) => !mySkills.has(s));
  const why = [], gaps = [];
  let score = 0;

  const roleHit = roles.find((r) => words(r).every((w) => words(job.title).includes(w) || job.title.toLowerCase().includes(w)));
  if (roleHit) { score += 40; why.push(`The title matches the role you want ("${roleHit}")`); }
  else if (roles.some((r) => words(r).some((w) => w.length > 3 && text.includes(w)))) { score += 15; why.push("The description mentions a role you are looking for"); }

  if (need.length) {
    score += Math.round(40 * (have.length / need.length));
    if (have.length) why.push(`You list ${have.slice(0, 5).join(", ")}, which the job asks for`);
  }
  if (lack.length) gaps.push(`The job also mentions ${lack.slice(0, 4).join(", ")}, which are not on your profile`);

  for (const [skill, y] of Object.entries(yearsAsked(job.description))) {
    if (mySkills.has(skill) && profile.years && profile.years < y) gaps.push(`Asks for ${y} years of ${skill}; you list ${profile.years} years in total`);
    else if (!mySkills.has(skill)) gaps.push(`Asks for ${y} years of ${skill}, which is not on your profile`);
  }

  if (profile.remote_only && !job.remote) { score -= 40; gaps.push("Not remote, and you only want remote roles"); }
  else if (job.remote) { score += 10; why.push("Remote role"); }
  else if (profile.location && words(job.location).some((w) => words(profile.location).includes(w))) { score += 10; why.push(`Based in ${job.location}`); }
  if (profile.min_salary && job.salary_max && job.salary_max < profile.min_salary) { score -= 20; gaps.push(`Pays up to about $${job.salary_max.toLocaleString("en-US")} a year, below your $${profile.min_salary.toLocaleString("en-US")} floor`); }
  if (profile.min_salary && job.salary_min && job.salary_min >= profile.min_salary) { score += 5; why.push("Pay is above your floor"); }

  return { score: Math.max(0, Math.min(100, score)), why, gaps };
}

// ------------------------------------------------------------------ CV privacy: encrypted at rest

async function cvKey(env) {
  if (!env.CV_ENCRYPTION_KEY) return null;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CV_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8)), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Returns null when no CV_ENCRYPTION_KEY is set: then the CV text is NOT stored at all, only the skills the person confirms. */
export async function encryptCv(env, text) {
  const key = await cvKey(env); if (!key || !text) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  return b64(iv) + "." + b64(ct);
}
export async function decryptCv(env, blob) {
  const key = await cvKey(env); if (!key || !blob) return "";
  try { const [iv, ct] = blob.split("."); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct))); } catch { return ""; }
}

// ------------------------------------------------------------------ plain-language commands (the same words will work in Telegram later)

const nextWeekday = (name) => { const d = new Date(); const t = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(name);
  let add = (t - d.getUTCDay() + 7) % 7 || 7; d.setUTCHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000) + add * DAY; };

export function parseCommand(text) {
  const t = String(text || "").toLowerCase().trim();
  let m;
  if ((m = t.match(/pause(?: (?:alerts|everything|scans))?(?: until| till| for)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/))) return { action: "pause", until: nextWeekday(m[1]), label: m[1] };
  if ((m = t.match(/pause(?: for)? (\d{1,2}) (day|week)s?/))) return { action: "pause", until: sec() + +m[1] * (m[2] === "week" ? 7 : 1) * DAY, label: `${m[1]} ${m[2]}${+m[1] > 1 ? "s" : ""}` };
  if (/^(resume|unpause|start again|turn (alerts )?back on)/.test(t)) return { action: "resume" };
  if (/only remote|remote only|remote jobs only/.test(t)) return { action: "remote", value: 1 };
  if (/(include|allow) (on-?site|office|non-?remote)|not only remote|any location/.test(t)) return { action: "remote", value: 0 };
  if ((m = t.match(/(?:salary|pay|minimum|min)[^0-9]{0,20}\$?\s?(\d{2,3})\s?k/))) return { action: "salary", value: +m[1] * 1000 };
  if (/why did you (send|show)|why (this|is this)|explain (this )?match/.test(t)) return { action: "why" };
  if ((m = t.match(/(?:looking for|i want|search for|target|roles?:?)\s+(.{3,80})$/))) return { action: "roles", value: m[1].replace(/\s+(roles?|jobs?)$/, "").trim() };
  return { action: "unknown" };
}

// ------------------------------------------------------------------ helping the person act (always their decision to send)

export function coverLetter(profile, job, name) {
  const mySkills = csv(profile.skills), need = extractSkills(`${job.title} ${job.tags} ${job.description}`);
  const shared = need.filter((s) => mySkills.includes(s)).slice(0, 4);
  const role = csv(profile.roles)[0] || job.title;
  const summary = `${role.replace(/^./, (c) => c.toUpperCase())} with ${profile.years ? profile.years + " year" + (profile.years > 1 ? "s" : "") + " of" : ""} experience in ${mySkills.slice(0, 5).join(", ") || "[your main skills]"}.`;
  const letter = `Dear ${job.company} hiring team,\n\nI am applying for the ${job.title} role. ${shared.length ? `The role calls for ${shared.join(", ")}, which I work with.` : "I would like to bring my experience to your team."} ${profile.years ? `I have ${profile.years} year${profile.years > 1 ? "s" : ""} of experience, ` : ""}and I would be glad to share examples of my work: [add one specific result from your CV that matches this job].\n\nThank you for your time.\n\n${name || "[Your name]"}`;
  return { summary, letter };
}

export function interviewQuestions(job) {
  const need = extractSkills(`${job.title} ${job.tags} ${job.description}`).slice(0, 4);
  return [
    `Why do you want to work at ${job.company}, and what do you know about what they do?`,
    `Walk me through a project where you used ${need[0] || "your strongest skill"}. What was your part, and what was the result?`,
    ...need.slice(1, 3).map((s) => `How would you handle a hard problem involving ${s}? Give a real example.`),
    `What would you want to learn or achieve in your first 90 days as ${job.title}?`,
    "Tell me about a time something went wrong and what you did about it.",
    job.remote ? "How do you stay productive and communicate well when working remotely?" : `How do you feel about working from ${job.location || "the office"}?`,
  ];
}

// ------------------------------------------------------------------ market view

export function marketView(rows) {
  const open = rows.filter((r) => r.status === "open");
  const sal = open.filter((r) => r.salary_min && r.salary_max).map((r) => (r.salary_min + r.salary_max) / 2).sort((a, b) => a - b);
  const byCo = {}; for (const r of rows) byCo[r.company] = (byCo[r.company] || 0) + 1;
  const ages = open.filter((r) => r.posted_at).map((r) => Math.floor((sec() - r.posted_at) / DAY)).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  return {
    openRoles: open.length,
    salary: sal.length >= 3 ? { low: Math.round(q(sal, 0.2)), median: Math.round(q(sal, 0.5)), high: Math.round(q(sal, 0.8)), n: sal.length } : null,
    medianAgeDays: q(ages, 0.5),
    hiringOften: Object.entries(byCo).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([company, n]) => ({ company, n })),
  };
}
