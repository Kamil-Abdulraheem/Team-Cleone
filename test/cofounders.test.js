import { makeApp, runScan } from "./harness.js";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const app = await makeApp({ ADMIN_EMAILS: "ada@startup.com" });
const { call } = app;
await call("POST", "/auth/signup", { body: { email: "ada@startup.com", password: "correct horse battery" } });
const s = await runScan(app, "me/cof");
ok("scan finishes", s.steps.at(-1).done === true, JSON.stringify(s.steps.at(-1)));
const r = (await call("GET", "/radar?repo=me/cof")).data;
const co = r.lanes.cofounders;
const names = [...co.items.map((x) => x.name), ...(await app.all("SELECT name FROM matches WHERE lane = 'cofounders'")).map((x) => x.name)];
ok("founder bios land in the co-founders lane", names.includes("COF1") && names.includes("COF2"), JSON.stringify(names));
ok("a 'founding engineer' employee is not treated as a co-founder", !names.includes("COF3"));
ok("an ordinary starrer is not a co-founder", !names.includes("J1"));
ok("lane is returned with the same card fields as the others", !co.items[0] || Object.keys(co.items[0]).sort().join() === Object.keys(r.lanes.joiners.items[0] || co.items[0]).sort().join());
const top = co.items[0];
if (top) {
  const d = await call("POST", `/matches/${top.id}/draft`);
  ok("co-founder outreach draft is written for a co-founder conversation", d.status === 200 && /co-?founder|work together|short call/i.test(d.data.email));
  const det = await call("GET", `/matches/${top.id}`);
  ok("co-founder match opens to full details", det.status === 200 && det.data.lane === "cofounders");
}
await app.restore();
console.log(`cofounders.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
