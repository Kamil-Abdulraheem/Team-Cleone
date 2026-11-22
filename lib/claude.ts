import Anthropic from "@anthropic-ai/sdk";
import type { ProjectSummary } from "./github";

export type ScoreInput = {
  id: number;
  lane: string;
  source: string;
  signal: number;
  handle: string;
  name: string;
  artifact_title: string;
  artifact_url: string;
  facts: string;
};

export type Score = {
  id: number;
  significance: number;
  resonance: number;
  timing: number;
  score: number;
  why: string;
};

const SCORE_MODEL = () => process.env.SCORE_MODEL || "claude-sonnet-5-5";
const OUTREACH_MODEL = () => process.env.OUTREACH_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
  }
  return (client ??= new Anthropic());
}

const text = (content: Anthropic.Messages.ContentBlock[]) =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export const finalScore = (s: number, r: number, t: number) =>
  Math.round((0.3 * s + 0.4 * r + 0.3 * t) * 10) / 10;

/** Pure function so it can be tested without an API key. */
export function parseScores(raw: string, allowedIds: Set<number>): Score[] {
  const t = raw.replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("[");
  const b = t.lastIndexOf("]");
  if (a < 0 || b <= a) throw new Error("Model did not return a JSON array.");
  const arr = JSON.parse(t.slice(a, b + 1)) as Array<Record<string, unknown>>;
  const out: Score[] = [];
  for (const x of arr) {
    const id = Number(x.id);
    if (!allowedIds.has(id)) continue;
    const significance = clamp(x.significance);
    const resonance = clamp(x.resonance);
    const timing = clamp(x.timing);
    out.push({
      id,
      significance,
      resonance,
      timing,
      score: finalScore(significance, resonance, timing),
      why: String(x.why ?? "").trim(),
    });
  }
  return out;
}

const SCORE_SYSTEM = `You rate whether a person or organization is a worthwhile contact for the founder of a software project.
Use ONLY the facts supplied. Never invent details. If the facts are thin, score low.
Be strict: most candidates should score under 60. Reserve 80+ for candidates with clear, specific, recent evidence.
Each candidate carries evidence_strength (0-100), computed from public activity before you see it. Do not score a candidate far above what its facts support just because evidence_strength is high.
A "company" candidate means several people at one organization engaged with the project; treat that as stronger than one individual doing the same.
Return JSON only, no prose and no code fences.`;

export async function scoreBatch(
  project: ProjectSummary,
  batch: ScoreInput[]
): Promise<Score[]> {
  const user = `FOUNDER'S PROJECT
TODAY: ${new Date().toISOString().slice(0, 10)}

${JSON.stringify(
    {
      repo: `${project.owner}/${project.name}`,
      description: project.description,
      topics: project.topics,
      language: project.language,
      stars: project.stars,
      readme_excerpt: project.readme,
    },
    null,
    1
  )}

CANDIDATES
${JSON.stringify(
    batch.map((c) => ({
      id: c.id,
      lane: c.lane,
      source: c.source,
      evidence_strength: c.signal,
      name: c.name,
      handle: c.handle,
      artifact: c.artifact_title,
      facts: c.facts,
    })),
    null,
    1
  )}

For each candidate give integer scores 0-100:
- significance: how important and relevant their artifact is to the project's problem space
- resonance: how well their work fits a partnership, acquisition, hire or early-user relationship with this project
- timing: how strong the evidence is that now is a good moment to reach out, judged against TODAY (a star or push this week is strong; months ago is weak)
Then "why": two sentences citing specific supplied facts. No flattery.

Return a JSON array: [{"id":1,"significance":0,"resonance":0,"timing":0,"why":"..."}]`;

  const res = await getClient().messages.create({
    model: SCORE_MODEL(),
    max_tokens: 4000,
    system: SCORE_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  return parseScores(text(res.content), new Set(batch.map((c) => c.id)));
}

export async function draftOutreach(
  project: ProjectSummary,
  c: ScoreInput,
  why: string
): Promise<string> {
  const res = await getClient().messages.create({
    model: OUTREACH_MODEL(),
    max_tokens: 700,
    system:
      "You write short, specific cold emails from a software founder. Under 120 words. Plain tone. No flattery, no hype, no invented facts. Reference one real thing about the founder's project and one real thing about the recipient's work, using only the facts supplied. End with one small, easy ask. Output a 'Subject:' line, a blank line, then the body. Sign off with [Your name].",
    messages: [
      {
        role: "user",
        content: `Founder's project: ${project.owner}/${project.name} - ${project.description}
README excerpt: ${project.readme.slice(0, 600)}

Recipient: ${c.name} (${c.handle})
Their artifact: ${c.artifact_title} ${c.artifact_url}
Facts:
${c.facts}

Why they match: ${why}`,
      },
    ],
  });
  return text(res.content).trim();
}
