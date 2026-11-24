// Runs a scan from the command line and prints the results. No database, no account, no Claude key.
//   node scripts/scan.mjs owner/repo              (or: npm run scan -- owner/repo)
//   node scripts/scan.mjs owner/repo --verbose    also prints the evidence behind each match
// Set GITHUB_TOKEN to use the full budget. Without it the smaller budget fits GitHub's anonymous limit.
// In the GitHub Actions button ("Scan a repo") the token is provided automatically.
import { finishCandidates, makeGithub, stepEnrich, stepProfiles, stepRank, stepRepo, stepSignals } from "../lib/engine.js";
import { CUTOFF } from "../lib/config.js";
import { scoreCandidate } from "../lib/score.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const repo = args.find((a) => !a.startsWith("--"));
if (!repo) { console.error("Usage: npm run scan -- owner/repo [--verbose]"); process.exit(1); }

const gh = makeGithub(process.env.GITHUB_TOKEN);
if (!gh.hasToken) console.error("GITHUB_TOKEN is not set: using the reduced anonymous budget (60 GitHub calls an hour).\n");
const perStep = [];
const track = async (name, fn) => { const before = gh.calls(); const out = await fn(); perStep.push([name, gh.calls() - before]); return out; };

try {
  const state = await track("repo", () => stepRepo(gh, repo));
  await track("signals", () => stepSignals(gh, state));
  while (await track("profiles", () => stepProfiles(gh, state)) > 0);
  stepRank(state);
  while (state.enrichLogins.some((l) => !(l in state.repos))) await track("enrich", () => stepEnrich(gh, state));
  const p = state.project, s = state.stats;
  console.log(`Project: ${p.owner}/${p.name} (${p.language ?? "n/a"}, ${p.stars} stars)  topics: ${p.topics.join(", ") || "none"}`);
  console.log(`Mode: ${s.mode}`);
  console.log(`Funnel: ${s.fetched.stars} recent stars, ${s.fetched.forks} forks, ${s.fetched.similarRepos} similar repos -> ${s.profiles} profiles -> dropped ${s.dropped.irrelevantRepos} off-topic repos, ${s.dropped.notAPerson} non-person, ${s.dropped.lowSignal} low-evidence -> ${s.companies} companies -> kept ${s.composed.star} star / ${s.composed.fork} fork / ${s.composed.similar} similar`);
  console.log(`GitHub calls per step: ${perStep.map(([n, c]) => `${n}=${c}`).join(" ")}  (each step is kept small; max here ${Math.max(...perStep.map((x) => x[1]))})`);
  for (const w of s.warnings) console.log(`Warning: ${w}`);
  console.log("");
  const rows = finishCandidates(state).map((c) => ({ ...c, r: scoreCandidate(c) })).sort((a, b) => b.r.score - a.r.score);
  const lanes = { strategic: 0, joiners: 0, investors: 0 };
  for (const c of rows) {
    const shown = c.r.score >= CUTOFF;
    if (shown) lanes[c.lane]++;
    console.log(`${shown ? "SHOWN " : "hidden"} ${String(c.r.score).padEnd(5)} [${c.lane}/${c.source}] ${c.name}  (sig ${c.r.significance} / fit ${c.r.resonance} / timing ${c.r.timing})`);
    console.log(`         ${c.kind}: ${c.sigText}`);
    if (verbose) console.log(c.facts.split("\n").map((l) => `         | ${l}`).join("\n"));
  }
  const total = rows.filter((c) => c.r.score >= CUTOFF).length;
  console.log(`\n${rows.length} candidates, ${total} at ${CUTOFF} or higher (strategic ${lanes.strategic}, joiners ${lanes.joiners}, investors ${lanes.investors}).`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
