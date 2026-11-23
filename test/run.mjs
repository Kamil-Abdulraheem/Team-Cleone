import { spawnSync } from "node:child_process";
let bad = 0;
for (const f of ["test/api.test.js", "test/billing.test.js", "test/app.test.js"]) {
  const { existsSync } = await import("node:fs");
  if (!existsSync(f)) continue;
  console.log(`\n=== ${f}`);
  const r = spawnSync("node", [f], { stdio: "inherit" });
  if (r.status) bad++;
}
process.exit(bad ? 1 : 0);
