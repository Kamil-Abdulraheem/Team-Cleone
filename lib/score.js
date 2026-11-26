// Scoring and outreach drafts.
//
// RULES scoring runs everywhere with no key: deterministic, uses only the public facts the engine collected,
// and never invents anything. CLAUDE scoring (below) is optional and only used when an ANTHROPIC_API_KEY
// is set and the person is on a plan that includes it.

import { CUTOFF } from "./config.js";

const DAY = 86_400_000;
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const sentence = (s) => (/[.!?…]$/.test(s) ? s : s + ".");

/** Fresher evidence means a better moment to reach out. */
export function timingFor(iso) {
  if (!iso) return 30;
  const d = Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 1 ? 95 : d <= 3 ? 88 : d <= 7 ? 80 : d <= 14 ? 70 : d <= 30 ? 58 : d <= 90 ? 40 : 20;
}

export const finalScore = (s, r, t) => Math.round((0.3 * s + 0.4 * r + 0.3 * t) * 10) / 10;

/** c = a candidate from engine.finishCandidates(). Returns significance, resonance (shown as "Fit"), timing, score, why. */
/**
 * How reachable a similar project's owner is, judged by how close in size the two projects are.
 * A 265,000-star organization will not reply to a 200-star project; a 3,000-star one might.
 */
export function closeness(repoStars, projectStars) {
  const ratio = repoStars / Math.max(projectStars || 0, 50);
  return ratio <= 20 ? 15 : ratio <= 100 ? 8 : ratio <= 1000 ? 2 : 0;
}

export function scoreCandidate(c) {
  const m = c.meta;
  const peer = m.kind === "similar";
  // Significance: how important their work or standing is to this project.
  //  - Peers (people who maintain a similar project) count for more when closely related AND close in size.
  //  - Everyone else is judged on how established the account looks plus how fresh their evidence is.
  const rel = Math.min(10, m.relevance); // topic overlap stops counting after a point
  const near = closeness(m.repoStars, m.projectStars);
  const significance = clamp(peer ? Math.min(90, 30 + rel * 3 + near * 2) : 20 + c.signal * 0.85);
  // Resonance ("Fit"): how well they match a partnership, hire or early-user relationship.
  const founderBonus = c.lane === "cofounders" ? 12 : 0; // founder wording on a public profile is itself a fit signal
  const resonance = clamp(
    (peer ? Math.min(80, 25 + rel * 3 + near) : 25 + c.signal * 0.7 + (m.company ? 8 : 0) + 10 * (m.people - 1)) + founderBonus
  );
  // Timing: fresh interest in YOUR project is a strong cue. A peer's own recent commits say nothing about you,
  // so their timing is capped.
  const timing = peer ? Math.min(70, timingFor(m.freshestAt)) : timingFor(m.freshestAt);
  const score = finalScore(significance, resonance, timing);

  const first = m.people > 1 ? `${m.people} people from ${m.company} engaged with this project. Strongest signal: ${m.evidence}` : m.evidence;
  const who = [m.displayName, m.company ? `works at ${m.company}` : ""].filter(Boolean).join(" ");
  const bits = [m.blurb ? `"${m.blurb}"` : "", `${m.followers} followers`, m.topRepo ? `recent work on ${m.topRepo}` : ""]
    .filter(Boolean)
    .join(", ");
  return { significance, resonance, timing, score, why: `${sentence(first)} ${sentence(`${who} (${bits})`)}` };
}

// ------------------------------------------------------------------ outreach draft (same shape as the prototype)

const firstName = (n) => String(n || "").replace(/^dr\.?\s+/i, "").trim().split(/\s+/)[0] || n;

const whenText = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 60 ? `${d} days ago` : "a while ago";
};

/** What we noticed, written so it reads naturally after "I noticed". Uses only recorded facts. */
function noticed(repo, m) {
  const k = m.meta?.kind;
  if (k === "star") return `you starred ${repo} ${whenText(m.meta.freshestAt)}`;
  if (k === "fork") return /own commits/.test(m.meta?.evidence || "") ? `you forked ${repo} and made your own changes` : `you forked ${repo}`;
  const theirs = String(m.sig_text || "").replace(/^Maintains /, "").replace(/ \(.*$/, "");
  return `you maintain ${theirs}`;
}

/** project = {owner,name}; m = a saved match row with lane, name, sig_text, meta (object). */
export function draftEmail(project, m) {
  const repo = `${project.owner}/${project.name}`;
  const f = firstName(m.meta?.displayName || m.name);
  const seen = noticed(repo, m);
  const body = {
    strategic:
      m.meta?.people > 1
        ? `I maintain ${repo}, and I noticed that several people at ${m.meta.company} have been looking at it recently. I think our work could fit together, and I would like to compare notes on a possible integration or partnership.`
        : `I maintain ${repo}, and I noticed ${seen}. I think our work fits together, and I would like to compare notes on a possible integration or partnership.`,
    joiners: `I maintain ${repo}. I noticed ${seen}${m.meta?.topRepo ? `, and your work on ${m.meta.topRepo} looks closely related` : ""}. I would like to hear what you would build in this space, and whether you would like to talk.`,
    cofounders: `I am building ${repo}. I noticed ${seen}${m.meta?.topRepo ? `, and your work on ${m.meta.topRepo} caught my eye` : ""}. I am looking for someone who builds companies to compare notes, and maybe work together. Would you be open to a short call?`,
    investors: `I am building ${repo}. I noticed ${seen}. I would like to send a two-page update and hear if it fits what you look for.`,
  }[m.lane];
  return `Hi ${f},\n\n${body}\n\nBest,\n[Your name]`;
}

// ------------------------------------------------------------------ ranking and the paywall

/** Preference weights come from the person's Useful / Dismiss history, per kind of evidence, capped at +/-10. */
export const weightFor = (n) => Math.max(-10, Math.min(10, n || 0));

/**
 * Splits one lane's matches into what the person may see and what is locked. This runs on the server, so locked
 * results never leave it: the blur in the app is only decoration over placeholder text.
 * rows: saved matches for one lane. dismissed: Set of keys. weights: {star,fork,similar} numbers. visible: how many are unlocked.
 */
export function rankLane(rows, dismissed, weights, visible) {
  const rank = (r) => r.score + weightFor(weights[r.source]) * 3;
  const eligible = rows
    .filter((r) => r.score >= CUTOFF && !dismissed.has(r.k))
    .sort((a, b) => rank(b) - rank(a));
  return {
    open: eligible.slice(0, visible),
    locked: eligible.slice(visible).map((r) => ({ high: r.score >= 80 })),
    below: rows.filter((r) => r.score < CUTOFF && !dismissed.has(r.k)).length,
  };
}

// ------------------------------------------------------------------ optional Claude scoring

export function parseClaudeScores(raw, allowedIds) {
  const t = String(raw).replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("[");
  const b = t.lastIndexOf("]");
  if (a < 0 || b <= a) throw new Error("Claude did not return a JSON array");
  const out = [];
  for (const x of JSON.parse(t.slice(a, b + 1))) {
    const id = Number(x.id);
    if (!allowedIds.has(id)) continue;
    const significance = clamp(x.significance);
    const resonance = clamp(x.resonance);
    const timing = clamp(x.timing);
    out.push({ id, significance, resonance, timing, score: finalScore(significance, resonance, timing), why: String(x.why || "").trim() });
  }
  return out;
}

const CLAUDE_SYSTEM = `You rate whether a person or organization is a worthwhile contact for the founder of a software project.
Use ONLY the facts supplied. Never invent details. If the facts are thin, score low.
Be strict: most candidates should score under 60. Reserve 80+ for candidates with clear, specific, recent evidence.
Each candidate carries evidence_strength (0-100), computed from public activity before you see it. Do not score far above what the facts support just because it is high.
A "company" candidate means several people at one organization engaged with the project; treat that as stronger than one individual doing the same.
Return JSON only, no prose and no code fences.`;

/** Scores candidates in batches of 10. Returns one {id,...} per candidate it could score. */
export async function scoreWithClaude(env, project, candidates, fetchImpl = fetch) {
  const out = [];
  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const user = `TODAY: ${new Date().toISOString().slice(0, 10)}

FOUNDER'S PROJECT
${JSON.stringify({ repo: `${project.owner}/${project.name}`, description: project.description, topics: project.topics, language: project.language, stars: project.stars, readme_excerpt: (project.readme || "").slice(0, 1500) })}

CANDIDATES
${JSON.stringify(batch.map((c, n) => ({ id: i + n, lane: c.lane, source: c.source, evidence_strength: c.signal, name: c.name, facts: c.facts })))}

For each candidate give integer scores 0-100:
- significance: how important and relevant their work is to the project's problem space
- resonance: how well their work fits a partnership, acquisition, hire or early-user relationship
- timing: how strong the evidence is that now is a good moment to reach out, judged against TODAY
Then "why": two sentences citing specific supplied facts. No flattery.
Return a JSON array: [{"id":0,"significance":0,"resonance":0,"timing":0,"why":"..."}]`;
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.SCORE_MODEL || "claude-sonnet-5-5", max_tokens: 4000, system: CLAUDE_SYSTEM, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`Claude returned ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    out.push(...parseClaudeScores(text, new Set(batch.map((_, n) => i + n))));
  }
  return out;
}
