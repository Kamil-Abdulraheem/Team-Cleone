import type { CandidateMeta } from "./github";

// Rule-based scoring and outreach. No API key, no network, deterministic.
// Everything it says comes from public facts collected in github.ts. It never invents anything.
// When an ANTHROPIC_API_KEY is available the Node pipeline can use Claude instead (lib/claude.ts).

export type ScoreSubject = {
  lane: string;
  source: string;
  signal: number;
  name: string;
  handle: string;
  artifact_title: string;
  contact?: string;
  meta: CandidateMeta;
};

export type RuleScore = {
  significance: number;
  resonance: number;
  timing: number;
  score: number;
  why: string;
};

const DAY = 86_400_000;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : s + ".");

/** Fresher evidence means a better moment to reach out. */
export function timingFor(iso: string | undefined): number {
  if (!iso) return 30;
  const d = Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 1 ? 95 : d <= 3 ? 88 : d <= 7 ? 80 : d <= 14 ? 70 : d <= 30 ? 58 : d <= 90 ? 40 : 20;
}

export function scoreCandidate(c: ScoreSubject): RuleScore {
  const m = c.meta;
  const peer = m.kind === "similar";
  // significance: how important their work or standing is to this project.
  // Peers (people who maintain a similar project) are capped below fresh, direct interest:
  // a peer is a possible partner, but someone who just starred or forked is a warmer lead.
  const significance = clamp(
    peer
      ? Math.min(90, 35 + m.relevance * 5 + Math.min(15, Math.log10(m.repoStars + 1) * 4))
      : 20 + c.signal * 0.85
  );
  // resonance: how well they fit a partnership, hire or early-user relationship
  const resonance = clamp(
    peer
      ? Math.min(80, 25 + m.relevance * 4)
      : 25 + c.signal * 0.7 + (m.company ? 8 : 0) + 10 * (m.people - 1)
  );
  const timing = timingFor(m.freshestAt);
  const score = Math.round((0.3 * significance + 0.4 * resonance + 0.3 * timing) * 10) / 10;

  const first = m.people > 1
    ? `${m.people} people from ${m.company} engaged with this project. Strongest signal: ${m.evidence}`
    : m.evidence;
  const who = [
    m.displayName,
    m.company ? `works at ${m.company}` : "",
  ].filter(Boolean).join(" ");
  const bits = [
    m.blurb ? `"${m.blurb}"` : "",
    `${m.followers} followers`,
    m.topRepo ? `recent work on ${m.topRepo}` : "",
  ].filter(Boolean).join(", ");
  const why = `${sentence(first)} ${sentence(`${who} (${bits})`)}`;
  return { significance, resonance, timing, score, why };
}

type ProjectLike = { owner: string; name: string; description: string };
type EmailSubject = { name: string; handle: string; artifact_title: string; contact?: string; meta: CandidateMeta };

function firstName(n: string): string {
  const t = n.replace(/^dr\.?\s+/i, "").trim().split(/\s+/)[0];
  return t || n;
}

export function draftEmail(project: ProjectLike, c: EmailSubject): string {
  const m = c.meta;
  const proj = `${project.owner}/${project.name}`;
  const what = project.description ? ` (${project.description.replace(/[.\s]+$/, "")})` : "";
  const bridge = m.topRepo ? ` Your work on ${m.topRepo} looks closely related.` : "";
  const opener =
    m.people > 1
      ? `I noticed several people at ${m.company} have been looking at ${proj} recently.`
      : m.kind === "fork"
        ? `I noticed you forked ${proj}.`
        : m.kind === "similar"
          ? `I came across ${c.artifact_title.replace(/^Maintains /, "")} while looking at projects close to ${proj}.`
          : `I noticed you starred ${proj} recently.`;
  const email = c.contact?.match(/email (\S+@\S+)/)?.[1];
  return [
    email ? `To: ${email}\n` : "",
    `Subject: ${proj} and a question`,
    "",
    `Hi ${firstName(m.displayName || c.name)},`,
    "",
    `${opener}${bridge} I am building ${proj}${what}, and I would like to trade notes on where it could go next. Do you have 20 minutes next week?`,
    "",
    "Best,",
    "[Your name]",
  ].filter((l, i) => !(i === 0 && l === "")).join("\n");
}
