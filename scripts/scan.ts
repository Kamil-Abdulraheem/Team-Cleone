// Usage:
//   npm run scan -- github.com/owner/repo                 full scan (needs ANTHROPIC_API_KEY)
//   npm run scan -- github.com/owner/repo --dry           GitHub collection only: no Claude, no database
//   npm run scan -- github.com/owner/repo --dry --verbose also print the full evidence given to Claude
import { collect, fetchProject, parseRepo, type CollectStats } from "../lib/github";

function funnel(s: CollectStats) {
  console.log(
    `Funnel: ${s.fetched.stars} recent stars, ${s.fetched.forks} forks, ${s.fetched.similarRepos} similar repos found -> ` +
      `${s.profiles} profiles read -> dropped ${s.dropped.irrelevantRepos} irrelevant repos, ` +
      `${s.dropped.notAPerson} non-person accounts, ${s.dropped.lowSignal} low-evidence -> ` +
      `${s.companies} companies with 2+ engaged people -> kept ${s.composed.star} star / ${s.composed.fork} fork / ${s.composed.similar} similar`
  );
  for (const w of s.warnings) console.log(`Warning: ${w}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const verbose = args.includes("--verbose");
  const repo = args.find((a) => !a.startsWith("--"));
  if (!repo) {
    console.error("Usage: npm run scan -- github.com/owner/repo [--dry] [--verbose]");
    process.exit(1);
  }
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set. A scan makes roughly 100-150 GitHub calls; the unauthenticated limit is 60 per hour.");
  }

  if (dry) {
    const { owner, name } = parseRepo(repo);
    const project = await fetchProject(owner, name);
    console.log(`Project: ${project.owner}/${project.name} (${project.language ?? "n/a"}, ${project.stars} stars)`);
    console.log(`Topics: ${project.topics.join(", ") || "none"}\n`);
    const { candidates, stats } = await collect(project);
    funnel(stats);
    console.log("");
    for (const c of candidates) {
      const who = c.name === c.handle ? c.name : `${c.name} (@${c.handle})`;
      console.log(`[${c.lane}/${c.source}] evidence ${c.signal}  ${who}`);
      console.log(`    ${c.artifact_title}`);
      console.log(`    ${c.artifact_url}`);
      if (c.contact) console.log(`    contact: ${c.contact}`);
      if (verbose) console.log(c.facts.split("\n").map((l) => `      | ${l}`).join("\n"));
    }
    console.log(`\n${candidates.length} candidates ready for scoring (not scored in --dry mode).`);
    return;
  }

  const { runScan } = await import("../lib/pipeline");
  const r = await runScan(repo);
  funnel(r.stats);
  console.log(`Newly scored ${r.scored}, hidden below cutoff ${r.hiddenBelowCutoff}\n`);
  for (const m of r.matches) {
    console.log(`${m.score}  [${m.lane}/${m.source}] ${m.name} (@${m.handle})  evidence ${m.signal}`);
    console.log(`    sig ${m.significance} / res ${m.resonance} / tim ${m.timing}`);
    console.log(`    ${m.artifact_url}`);
    if (m.contact) console.log(`    contact: ${m.contact}`);
    console.log(`    ${m.why}\n`);
  }
  if (!r.matches.length) console.log("No matches scored 75 or higher. That is expected for a strict scorer; check the hidden count.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
