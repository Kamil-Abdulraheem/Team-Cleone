// Usage:
//   npm run scan -- github.com/owner/repo          full scan (needs ANTHROPIC_API_KEY)
//   npm run scan -- github.com/owner/repo --dry    GitHub collection only, no Claude, no database
import { collect, fetchProject, parseRepo } from "../lib/github";

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const repo = args.find((a) => !a.startsWith("--"));
  if (!repo) {
    console.error("Usage: npm run scan -- github.com/owner/repo [--dry]");
    process.exit(1);
  }

  if (dry) {
    const { owner, name } = parseRepo(repo);
    const project = await fetchProject(owner, name);
    console.log(`Project: ${project.owner}/${project.name} (${project.language ?? "n/a"}, ${project.stars} stars)`);
    console.log(`Topics: ${project.topics.join(", ") || "none"}\n`);
    const candidates = await collect(project);
    for (const c of candidates) {
      console.log(`[${c.lane}] ${c.name} (@${c.handle})\n  ${c.artifact_title}\n  ${c.artifact_url}`);
    }
    console.log(`\n${candidates.length} candidates collected (not scored).`);
    return;
  }

  const { runScan } = await import("../lib/pipeline");
  const r = await runScan(repo);
  console.log(`Collected ${r.collected}, newly scored ${r.scored}, hidden below cutoff ${r.hiddenBelowCutoff}\n`);
  for (const m of r.matches) {
    console.log(`${m.score}  [${m.lane}] ${m.name} (@${m.handle})`);
    console.log(`    sig ${m.significance} / res ${m.resonance} / tim ${m.timing}`);
    console.log(`    ${m.artifact_url}`);
    console.log(`    ${m.why}\n`);
  }
  if (!r.matches.length) console.log("No matches scored 75 or higher. That is expected for a strict scorer; check the hidden count.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
