// Job Radar. Everything about finding, checking and matching jobs lives here, with no database code, so it is easy to test.
// The routes that use it are in lib/app.js. The principle: never waste the person's time. A job is only called "open"
// when we checked; when we could not check, we say "could not verify" instead of guessing.

export const DAY = 86400;
import { extractSkills, scoreJob } from "./match.js";

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

// ------------------------------------------------------------------ the standard vacancy shape

const toSec = (x) => (Number.isFinite(+x) && +x > 0 ? Math.floor(+x) : null);

/** Every source's output is turned into exactly this shape before anything else touches it. */
export function normalize(source, raw) {
  const description = stripHtml(raw.description).slice(0, 8000);
  return {
    source, external_id: String(raw.external_id || "").slice(0, 200), url: String(raw.url || ""), title: stripHtml(raw.title).slice(0, 160), company: stripHtml(raw.company).slice(0, 120),
    location: stripHtml(raw.location).slice(0, 120), remote: raw.remote || /remote/i.test(raw.location || "") ? 1 : 0, employment_type: raw.employment_type || "",
    salary_min: raw.salary_min || null, salary_max: raw.salary_max || null, currency: raw.salary_min || raw.salary_max ? raw.currency || "USD" : "",
    description, tags: String(raw.tags || "").toLowerCase().slice(0, 300), posted_at: toSec(raw.posted_at), valid_through: toSec(raw.valid_through), department: String(raw.department || "").slice(0, 80),
  };
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

// ------------------------------------------------------------------ the person: matching lives in lib/match.js

export { extractSkills };
/** Back-compatible helper: score + reasons for one job. The full breakdown comes from scoreJob in lib/match.js. */
export const matchJob = (profile, job) => scoreJob(profile, job);

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
  if (/^(scan|rescan|refresh|find (me )?(new |more )?jobs|look for (new )?jobs|check for (new )?jobs|search now)\s*(again|now)?[.!]*$/.test(t)) return { action: "scan" };
  if (/why did you (send|show)|why (this|is this)|explain (this )?match/.test(t)) return { action: "why" };
  if ((m = t.match(/^(?!why\b|what\b|how\b|when\b|who\b|can\b|do\b|does\b|is\b|are\b)(?:(?:find|search(?: for)?|show|get|look for|i (?:want|need)|any)(?: me)?(?: some| new| the| a| an)?\s+)?(.{3,80}?)\s+(?:jobs?|roles?|vacancies|vacancy|positions?|openings?)(?:\s+(?:in|at|around|near|based in)\s+(.{2,60}?))?[.!?]*$/))) {
    const remote = /\bremote\b/.test(m[1]); const roles = m[1].replace(/\bremote\b/g, "").replace(/\s+/g, " ").trim();
    if (roles.length >= 3) return { action: "find", roles, location: (m[2] || "").trim(), remote };
  }
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
