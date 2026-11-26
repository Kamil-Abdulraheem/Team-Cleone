// Runs the real page (public/index.html + public/app.js) in a simulated phone browser against the real backend.
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { makeApp } from "./harness.js";
import { handle } from "../lib/app.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace('<script src="/app.js"></script>', () => `<script>${fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8")}</script>`);
const wait = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

async function browser(app, search = "") {
  const jar = { cookie: "" };
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://app.test/" + search,
    beforeParse(w) {
      w.fetch = async (url, init = {}) => {
        const headers = { origin: "https://app.test", "cf-connecting-ip": "9.9.9.9", ...(init.headers || {}) };
        if (jar.cookie) headers.cookie = jar.cookie;
        const res = await handle(new Request("https://app.test" + url, { method: init.method || "GET", headers, body: init.body }), app.env);
        const sc = res.headers.get("set-cookie"); if (sc) jar.cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0];
        return res;
      };
      w.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const w = dom.window, d = w.document;
  return { w, d, q: (s) => d.querySelector(s), qa: (s) => [...d.querySelectorAll(s)], text: () => d.querySelector("#main").textContent, toast: () => d.querySelector("#toast").textContent,
    click: (s) => d.querySelector(s).click(), type: (s, v) => { d.querySelector(s).value = v; }, jar };
}


const PW = "correct horse battery";
const app = await makeApp({ SOURCE_MODE: "sandbox", ADMIN_EMAILS: "boss@x.com" });
let b = await browser(app);
await wait(() => b.q("#sw")); b.click("#sw");
b.type("#nm", "Ada"); b.type("#em", "ada@x.com"); b.type("#pw", PW); b.click("#ok");
await wait(() => /Your job profile/.test(b.text()));
ok("a new user lands on Job Radar, not Repo scan", /Your job profile/.test(b.text()) && !b.q(".home h1"));
const side = () => b.q("#side").textContent;
ok("side menu: Job Radar is there, Repo scan is not, until switched on", /Job Radar/.test(side()) && !/Scan a repo/.test(side()) && !/Source Intelligence/.test(side()));
b.w.eval("nav('features')"); await wait(() => b.q(".sw[data-k]"));
ok("Features page shows both with the right states", b.qa(".sw[data-k]").length === 2 && b.q('.sw[data-k="jobs"]').classList.contains("on") && !b.q('.sw[data-k="repo"]').classList.contains("on"));
b.click('.sw[data-k="repo"]'); await wait(() => /Scan a repo/.test(side()));
ok("switching Repo scan on adds it to the side menu", /Scan a repo/.test(side()) && /Job Radar/.test(side()));
b.click('.sw[data-k="repo"]'); await wait(() => !/Scan a repo/.test(side()));
ok("and switching it off removes it", !/Scan a repo/.test(side()));

// profile -> scan -> results
b.w.eval("nav('jobs')"); await wait(() => b.q("#jr_"));
ok("profile form has qualification and work-type fields", !!b.q("#jed") && !!b.q("#jem"));
b.type("#jr_", "backend engineer"); b.type("#jcv", "Python and Django developer with 4 years of experience. BSc."); b.click("#jsv");
await wait(() => b.q("#js"), 15000); await wait(() => /Acme|Backend|Python|Engineer/.test(b.text()) || b.qa(".card.tap").length > 0, 15000);
ok("after saving, matching vacancies appear, with a clear SANDBOX banner", b.qa(".card.tap").length > 0 && /SANDBOX DATA/.test(b.text()) && /Sample/.test(b.text()));
b.w.eval(b.q(".card.tap").getAttribute("onclick")); await wait(() => /Score breakdown/.test(b.q("#panel").textContent));
const panel = b.q("#panel").textContent;
ok("a job opens to a score breakdown, reasons, missing requirements and where it came from", /Score breakdown/.test(panel) && /Where it came from/.test(panel) && /Sample data/.test(panel) && /Open employer page/.test(panel) && /never applies for you/.test(panel));
await app.restore();

// admin: Source Intelligence
const app2 = await makeApp({ SOURCE_MODE: "sandbox", ADMIN_EMAILS: "boss@x.com" });
b = await browser(app2);
await wait(() => b.q("#sw")); b.click("#sw");
b.type("#nm", "Boss"); b.type("#em", "boss@x.com"); b.type("#pw", PW); b.click("#ok");
await wait(() => /Source Intelligence/.test(b.q("#side").textContent));
ok("admins get Source Intelligence in the menu", /Source Intelligence/.test(b.q("#side").textContent));
b.w.eval("nav('sources')"); await wait(() => /Active sources/.test(b.text()));
const t = b.text();
ok("dashboard shows all seven metrics", ["Active sources", "Healthy sources", "Jobs collected", "New jobs today", "Expired jobs", "Failed requests", "Last synchronization"].every((x) => t.includes(x)));
ok("dashboard warns about sandbox and stale data instead of hiding it", /SANDBOX MODE/.test(t) && /may be stale/.test(t));
ok("Jobberman and MyJobMag show as disabled with the reason", /Jobberman/.test(t) && /MyJobMag/.test(t) && /must approve data access/.test(t));
b.click("#ssy"); await wait(() => /Healthy sources/.test(b.text()) && !/may be stale/.test(b.text()), 15000);
ok("after a sync the numbers are real and the stale warning goes away", !/may be stale/.test(b.text()));
b.click("#sdg"); await wait(() => /cannot run in sandbox/i.test(b.q("#sres").textContent), 8000);
ok("the live diagnostic says plainly it cannot be simulated in sandbox", /cannot run in sandbox/i.test(b.q("#sres").textContent));
await app2.restore();
console.log(`jobsui.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
