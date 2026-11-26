// The matching engine. Explainable on purpose: every score is a weighted sum of named components, and every component says
// WHY. Two rules matter most:
//   1. Missing information is not a mismatch. If a job does not state its salary, salary is "unknown" and is left out of the
//      score instead of being counted against the job. The result also reports how much of the picture was known (confidence).
//   2. Nothing is invented. Every sentence comes from a fact in the CV profile or the job text.
// No AI is needed. AI (lib/ai.js) can add extra facts about a job or a CV, which this same engine then scores.

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const PRIOR = 0.35, PRIOR_W = 15;
export const WEIGHTS = { skills: 30, role: 15, experience: 12, responsibilities: 10, location: 10, salary: 8, qualifications: 8, employment: 7 };
const LABEL = { skills: "Skills", role: "Role", experience: "Experience", responsibilities: "Responsibilities", location: "Location", salary: "Salary", qualifications: "Qualifications", employment: "Employment type" };

export const SKILLS = ["python", "django", "flask", "fastapi", "javascript", "typescript", "node", "react", "vue", "angular", "next.js", "html", "css", "sql", "postgresql", "mysql", "mongodb", "redis",
  "docker", "kubernetes", "aws", "azure", "gcp", "linux", "git", "java", "kotlin", "swift", "flutter", "dart", "php", "laravel", "ruby", "rails", "go", "rust", "c#", ".net", "c++",
  "figma", "ui", "ux", "product management", "agile", "scrum", "seo", "excel", "power bi", "tableau", "data analysis", "machine learning", "pytorch", "tensorflow", "devops", "ci/cd",
  "accounting", "sales", "marketing", "customer support", "copywriting", "recruiting", "project management", "graphql", "rest", "api", "testing", "qa", "airflow", "spark", "data engineering", "terraform", "security"];

// Skills in the same family transfer to each other at half value.
const FAMILIES = [["python", "django", "flask", "fastapi"], ["javascript", "typescript", "node", "react", "vue", "angular", "next.js"], ["sql", "postgresql", "mysql", "mongodb", "redis"], ["java", "kotlin"],
  ["php", "laravel"], ["ruby", "rails"], ["c#", ".net"], ["docker", "kubernetes", "terraform", "devops", "ci/cd", "linux"], ["aws", "azure", "gcp"], ["figma", "ui", "ux"], ["machine learning", "pytorch", "tensorflow", "data analysis"],
  ["airflow", "spark", "data engineering", "sql"], ["marketing", "seo", "copywriting"], ["sales", "customer support"], ["agile", "scrum", "project management", "product management"], ["testing", "qa"], ["rest", "api", "graphql"]];
const familyMates = (s) => [...new Set(FAMILIES.filter((f) => f.includes(s)).flat())].filter((x) => x !== s);

// Roles a person could realistically move into from their target role. Used for "adjacent opportunities".
const ADJACENT = { "backend developer": ["software engineer", "devops engineer", "data engineer", "platform engineer", "api developer", "python developer"], "frontend developer": ["full stack developer", "ui engineer", "web developer", "react developer"],
  "full stack developer": ["backend developer", "frontend developer", "software engineer"], "data analyst": ["data scientist", "business analyst", "analytics engineer", "bi analyst"], "data scientist": ["machine learning engineer", "data analyst", "data engineer"],
  "devops engineer": ["site reliability engineer", "platform engineer", "cloud engineer", "backend developer"], "product designer": ["ux designer", "ui designer", "product manager", "ux researcher"], "product manager": ["project manager", "business analyst", "product owner"],
  "customer support": ["customer success", "account manager", "technical support", "support engineer"], "marketing manager": ["growth manager", "content strategist", "brand manager", "digital marketer"], accountant: ["financial analyst", "auditor", "finance officer"] };

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").split(/\s+/).filter(Boolean);
const csv = (s) => (Array.isArray(s) ? s : String(s || "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

export function extractSkills(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9+#./\s]/g, " ") + " ";
  return SKILLS.filter((s) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.+#/]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
}

export function eduLevel(text) {
  const t = String(text || "").toLowerCase();
  return /\b(ph\.?d|doctorate|doctoral)\b/.test(t) ? 4 : /\b(master'?s?|msc|m\.sc|mba|m\.eng)\b/.test(t) ? 3 : /\b(bachelor'?s?|bsc|b\.sc|b\.eng|b\.tech|hnd|degree)\b/.test(t) ? 2 : /\b(ond|nce|diploma|secondary|waec|ssce|a-levels?|associate)\b/.test(t) ? 1 : 0;
}
export const EDU_NAME = ["", "secondary school or diploma", "a bachelor's degree or HND", "a master's degree", "a doctorate"];

/** Years of experience a CV claims: the largest "N years" it states (people write "5 years of ..."), 0 when none. */
export function yearsFromCv(text) {
  let best = 0; for (const m of String(text || "").toLowerCase().matchAll(/(\d{1,2})\+?\s*(?:years?|yrs)/g)) best = Math.max(best, +m[1]);
  return Math.min(best, 45);
}

// ------------------------------------------------------------------ what a job asks for

const RESP = /\b(build|design|develop|lead|manage|maintain|deliver|analy[sz]e|write|test|support|own|review|implement|create|improve|plan|coordinate|monitor|deploy|optimi[sz]e|collaborate|mentor)\w*/i;
const NOISE = new Set(["will", "with", "that", "this", "from", "your", "have", "work", "team", "also", "other", "their", "about", "using", "across", "within", "every", "ensure", "thousands", "customers", "closely", "product", "design", "release", "features", "ideas", "idea", "daily", "services"]);

export function requirementsOf(job, extra = {}) {
  const text = `${job.title}. ${job.tags || ""}. ${job.description || ""}`;
  const skills = [...new Set([...extractSkills(text), ...(extra.skills || [])])];
  const yearsBySkill = {};
  for (const m of String(job.description || "").toLowerCase().matchAll(/(\d{1,2})\+?\s*(?:years?|yrs)\s*(?:of\s*)?(?:experience\s*(?:with|in)\s*)?([a-z.+#/ ]{2,24})/g)) {
    const sk = SKILLS.find((s) => m[2].trim().startsWith(s)); if (sk) yearsBySkill[sk] = Math.max(yearsBySkill[sk] || 0, +m[1]);
  }
  for (const [k, v] of Object.entries(extra.years || {})) yearsBySkill[k] = Math.max(yearsBySkill[k] || 0, +v || 0);
  const minYears = Math.max(0, ...Object.values(yearsBySkill), ...[...String(job.description || "").toLowerCase().matchAll(/(\d{1,2})\+?\s*(?:years?|yrs)/g)].map((m) => +m[1]).filter((n) => n < 30));
  const sentences = String(job.description || "").split(/(?<=[.!?\n])\s+/);
  const eduSentence = sentences.find((s) => /\b(degree|bachelor|bsc|b\.sc|master|msc|phd|diploma|hnd|ond|qualification)\b/i.test(s));
  const resp = sentences.filter((s) => RESP.test(s)).slice(0, 8);
  const keywords = [...new Set(words(resp.join(" ")).filter((w) => w.length >= 5 && !NOISE.has(w)))].slice(0, 14);
  return { skills, yearsBySkill, minYears, edu: extra.edu || (eduSentence ? eduLevel(eduSentence) : 0), keywords };
}

// ------------------------------------------------------------------ the person

export function candidateOf(p) {
  return { roles: csv(p.roles), skills: new Set(csv(p.skills)), years: +p.years || 0, edu: +p.education || 0, location: String(p.location || ""), remoteOnly: !!(p.remote_only ?? p.remoteOnly),
    minSalary: +(p.min_salary ?? p.minSalary) || 0, employment: csv(p.employment), text: `${csv(p.skills).join(" ")} ${csv(p.roles).join(" ")} ${p.summary || ""} ${p.cvText || ""}`.toLowerCase() };
}

const RESTRICT = /\b(us|usa|u\.s\.|united states|canada|uk|united kingdom|europe|eu|germany|australia|north america)\b[^.\n]{0,25}\b(only|based|residents?|citizens?)\b|\b(only|must (?:be|reside|live))\b[^.\n]{0,40}\b(us|usa|united states|canada|uk|europe|eu|germany|australia)\b/i;
const OPEN_TO_AFRICA = /\b(africa|nigeria|worldwide|anywhere|global|emea)\b/i;
const status = (s) => (s === null ? "unknown" : s >= 0.75 ? "match" : s >= 0.4 ? "partial" : "mismatch");

/**
 * Scores one job for one person. Returns:
 *  { score 0-100, confidence 0-1, parts[], why[], gaps[], unknown[], transferable[], adjacent, capped }
 * `extra` holds facts added by AI about the job ({skills, years, edu}); the rules score them the same way.
 */
export function scoreJob(profile, job, extra = {}) {
  const c = candidateOf(profile), req = requirementsOf(job, extra);
  const parts = {}, why = [], gaps = [], unknown = [], transferable = [];
  let adjacent = false;

  // --- skills
  if (req.skills.length) {
    let pts = 0; const have = [], lack = [];
    for (const s of req.skills) {
      if (c.skills.has(s)) { pts += 1; have.push(s); continue; }
      const mate = familyMates(s).find((m) => c.skills.has(m));
      if (mate) { pts += 0.5; transferable.push(`Your ${mate} experience transfers to ${s}`); } else lack.push(s);
    }
    parts.skills = pts / req.skills.length;
    if (have.length) why.push(`You list ${have.slice(0, 5).join(", ")}, which the job asks for`);
    if (transferable.length) why.push(transferable[0] + (transferable.length > 1 ? ` (and ${transferable.length - 1} more skill${transferable.length > 2 ? "s" : ""})` : ""));
    if (lack.length) gaps.push(`The job also mentions ${lack.slice(0, 4).join(", ")}, which are not on your profile`);
  } else { parts.skills = null; unknown.push("The job does not name specific skills, so skills could not be compared."); }

  // --- role
  const title = job.title.toLowerCase();
  if (c.roles.length) {
    const hit = c.roles.find((r) => words(r).every((w) => title.includes(w)));
    const adj = !hit && c.roles.find((r) => (ADJACENT[r] || []).some((a) => words(a).every((w) => title.includes(w))));
    const part = !hit && !adj && c.roles.find((r) => words(r).some((w) => w.length > 3 && title.includes(w)));
    if (hit) { parts.role = 1; why.push(`The title matches the role you want ("${hit}")`); }
    else if (adj) { parts.role = 0.6; adjacent = true; why.push(`Adjacent to your target role "${adj}": a realistic next step`); }
    else if (part) { parts.role = 0.4; why.push(`The title overlaps with a role you want ("${part}")`); }
    else if (c.roles.some((r) => words(r).some((w) => w.length > 3 && `${job.tags} ${job.description}`.toLowerCase().includes(w)))) { parts.role = 0.2; gaps.push("The title is not one of the roles you want, though the description mentions them"); }
    else { parts.role = 0; gaps.push("The title is not one of the roles you want"); }
  } else { parts.role = null; unknown.push("You have not said which roles you want, so the role could not be compared."); }

  // --- experience
  if (req.minYears > 0) {
    if (c.years > 0) {
      parts.experience = Math.min(1, c.years / req.minYears);
      const bySkill = Object.entries(req.yearsBySkill).sort((a, b) => b[1] - a[1])[0];
      if (c.years >= req.minYears) why.push(`Your ${c.years} year${c.years > 1 ? "s" : ""} of experience meets the ${req.minYears} asked`);
      else gaps.push(bySkill ? `Asks for ${bySkill[1]} years of ${bySkill[0]}; you list ${c.years} year${c.years > 1 ? "s" : ""} in total` : `Asks for ${req.minYears}+ years of experience; you list ${c.years}`);
    } else { parts.experience = null; unknown.push(`The job asks for ${req.minYears}+ years but your years of experience are not on your profile.`); }
  } else { parts.experience = null; unknown.push("The job does not state the experience it needs."); }
  for (const [s, y] of Object.entries(req.yearsBySkill)) if (!c.skills.has(s) && !gaps.some((g) => g.includes(`${y} years of ${s}`))) gaps.push(`Asks for ${y} years of ${s}, which is not on your profile`);

  // --- responsibilities
  if (req.keywords.length && c.text.trim().split(/\s+/).length >= 6) {
    const hits = req.keywords.filter((k) => c.text.includes(k.slice(0, Math.max(5, k.length - 2))));
    parts.responsibilities = Math.min(1, hits.length / Math.max(3, Math.round(req.keywords.length * 0.4)));
    if (hits.length) why.push(`Your profile covers parts of what you would do (${hits.slice(0, 4).join(", ")})`);
  } else { parts.responsibilities = null; unknown.push(req.keywords.length ? "Add your CV so the job's responsibilities can be compared with your experience." : "The job does not describe the day-to-day work."); }

  // --- location
  const geo = `${job.location} ${String(job.description).slice(0, 700)}`;
  let capped = false;
  if (job.remote) {
    const m = RESTRICT.exec(geo), country = m && (m[1] || m[3]);
    const restricted = !!(m && !OPEN_TO_AFRICA.test(geo) && c.location && !new RegExp(`\\b${country.replace(/[.]/g, "\\.")}\\b`, "i").test(c.location));
    parts.location = restricted ? 0.25 : 1;
    if (restricted) gaps.push("Remote, but the posting appears limited to candidates in specific countries that may not include yours");
    else why.push(OPEN_TO_AFRICA.test(geo) ? "Remote and open to candidates in your region" : "Remote role");
  } else if (c.remoteOnly) { parts.location = 0; capped = true; gaps.push("Not remote, and you only want remote roles"); }
  else if (job.location && c.location) {
    const ok = words(job.location).some((w) => w.length > 2 && words(c.location).includes(w));
    parts.location = ok ? 1 : 0.15; (ok ? why : gaps).push(ok ? `Based in ${job.location}` : `On-site in ${job.location}, away from ${c.location}`);
  } else { parts.location = null; unknown.push(!job.location ? "The job does not say where it is based." : "Add your location to compare it with where the job is."); }

  // --- salary (only compared when both sides are stated and in USD)
  if (c.minSalary && job.salary_max && (!job.currency || job.currency === "USD")) {
    parts.salary = job.salary_max >= c.minSalary ? 1 : 0;
    (parts.salary ? why : gaps).push(parts.salary ? "Pay is at or above your floor" : `Pays up to about $${job.salary_max.toLocaleString("en-US")} a year, below your $${c.minSalary.toLocaleString("en-US")} floor`);
  } else { parts.salary = null; unknown.push(job.salary_max ? "Pay could not be compared (set a minimum in USD to compare)." : "The job does not state its pay, so salary was not counted for or against it."); }

  // --- qualifications
  if (req.edu && c.edu) {
    parts.qualifications = c.edu >= req.edu ? 1 : c.edu === req.edu - 1 ? 0.5 : 0.2;
    (parts.qualifications >= 1 ? why : gaps).push(parts.qualifications >= 1 ? "Your qualification level meets what is asked" : `Asks for ${EDU_NAME[req.edu]}; your profile lists a lower level`);
  } else { parts.qualifications = null; unknown.push(req.edu ? "Add your highest qualification to compare it with what the job asks." : "The job does not state a qualification."); }

  // --- employment type
  if (job.employment_type && c.employment.length) {
    parts.employment = c.employment.includes(job.employment_type) ? 1 : 0;
    (parts.employment ? why : gaps).push(parts.employment ? `${job.employment_type} work, as you prefer` : `This is ${job.employment_type} work; you prefer ${c.employment.join(" or ")}`);
  } else { parts.employment = null; if (!job.employment_type) unknown.push("The job does not state if it is full-time, part-time or contract."); }

  // --- weighted sum over what is known
  let got = 0, knownW = 0;
  for (const k of Object.keys(WEIGHTS)) if (parts[k] !== null && parts[k] !== undefined) { got += WEIGHTS[k] * parts[k]; knownW += WEIGHTS[k]; }
  // Shrink toward a modest prior so a high score cannot be built from one or two known facts (e.g. only "remote").
  let score = ((got + PRIOR * PRIOR_W) / (knownW + PRIOR_W)) * 100;
  if (capped) score = Math.min(score, 30); // a stated hard preference (remote only) is never outvoted
  return {
    score: Math.round(clamp(score)), confidence: +(knownW / 100).toFixed(2), adjacent, capped, why, gaps, unknown, transferable,
    parts: Object.keys(WEIGHTS).map((k) => ({ key: k, label: LABEL[k], weight: WEIGHTS[k], score: parts[k] === null ? null : +parts[k].toFixed(2), status: status(parts[k] ?? null) })),
  };
}
