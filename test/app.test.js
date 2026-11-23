// Runs the real page (public/index.html + public/app.js) in a simulated phone browser against the real backend.
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { makeApp } from "./harness.js";
import { onRequest } from "../functions/api/[[path]].js";

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
        const res = await onRequest({ request: new Request("https://app.test" + url, { method: init.method || "GET", headers, body: init.body }), env: app.env });
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

// ============================================================ logged out
let app = makeApp();
let b = await browser(app);
await wait(() => b.q(".home h1")?.textContent === "Welcome back");
ok("logged-out visitors see the log-in screen", b.q(".home h1")?.textContent === "Welcome back");
ok("menu is hidden before login", b.q("#menu").style.visibility === "hidden" && b.q("#upg").style.display === "none");
b.click("#sw");
ok("can switch to create-account", b.q(".home h1").textContent === "Create your account" && !!b.q("#nm"));
b.type("#nm", "<img src=x onerror=window.__pwned=1> Ada"); b.type("#em", "ada@startup.com"); b.type("#pw", "short"); b.click("#ok");
await wait(() => b.q("#er").textContent);
ok("short password shows a readable error under the form", /at least 8/.test(b.q("#er").textContent));
b.type("#pw", "correct horse battery"); b.click("#ok");
await wait(() => b.q(".home h1")?.textContent === "Ready when you are.");
ok("signup lands on the prototype home screen", b.q(".home h1")?.textContent === "Ready when you are.");
ok("home keeps the prototype's input and text", b.q("#url").placeholder === "Paste your GitHub repo URL" && b.qa(".home .row").length === 3 && /Scan my repo/.test(b.text()));
ok("Upgrade button shows on Free", b.q("#upg").style.display === "");
ok("name containing HTML is shown as text, not run", !b.w.__pwned && !b.q("#side img") && /<img/.test(b.q(".me b").textContent));
ok("sidebar has the account row with plan", /Free plan/.test(b.q(".me small").textContent) && b.q(".av").textContent === "<");

// ============================================================ scan
b.type("#url", "not a repo"); b.click("#go");
ok("bad repo gives the prototype's message", b.toast() === "Enter a repo like github.com/owner/name");
b.type("#url", "github.com/me/proj"); b.click("#go");
ok("progress screen uses the prototype's four lines", b.q("h2")?.textContent === "Scanning proj" && b.qa("#st p").length === 4 && b.qa("#st p")[0].textContent === "Reading your README and recent commits");
ok("last line is honest about rule-based scoring", b.qa("#st p")[3].textContent === "Scoring each match");
await wait(() => b.q("h2")?.textContent === "me/proj");
ok("scan finishes and opens the radar", b.q("h2")?.textContent === "me/proj");
ok("radar keeps prototype tabs", b.qa(".tabs button").map((x) => x.textContent).join("|") === "Partners and acquirers|Joiners|Investors");
ok("note explains the scoring and the Free limit", /Rule-based scores/.test(b.q(".note").textContent) && /1 match per lane/.test(b.q(".note").textContent));

// ============================================================ the paywall in the UI
b.click(".tabs button:nth-child(2)");
await wait(() => b.q(".tabs button.on")?.textContent === "Joiners");
const open = b.qa(".card:not(.lock)"), locked = b.qa(".card.lock");
ok("Free: one real card and blurred cards for the rest", open.length === 1 && locked.length > 0, `${open.length} open, ${locked.length} locked`);
ok("real card has the prototype's parts", !!open[0].querySelector(".name") && open[0].querySelectorAll(".dims b").length === 3 && open[0].querySelectorAll(".acts button").length === 3 && /^\d+$/.test(open[0].querySelector(".score").textContent));
ok("locked cards show the prototype overlay and an unlock button", /hidden/.test(locked[0].querySelector(".ov b").textContent) && /Unlock with Pro/.test(locked[0].querySelector(".ov button").textContent));
ok("locked cards contain only placeholder text, never real people", locked.every((c) => /Hidden match/.test(c.querySelector(".blur").textContent)) && !/J[1-8]\b/.test(locked.map((c) => c.textContent).join(" ")));
ok("below-cutoff line is shown", /filtered out/.test(b.text()));

// ============================================================ outreach and feedback
b.click(".card:not(.lock) .acts .p");
await wait(() => b.q("#m"));
ok("outreach sheet opens with the draft", /^Hi \S+,/.test(b.q("#m").textContent) && /\[Your name\]/.test(b.q("#m").textContent) && /Outreach to/.test(b.q("#panel h2").textContent));
b.click("#cp");
await wait(() => b.toast() === "Copied");
ok("copying shows 'Copied'", b.toast() === "Copied");
b.click("#panel .acts button:nth-child(2)");
b.click(".card:not(.lock) .acts button:nth-child(2)");
await wait(() => b.toast() === "Noted. More like this.");
ok("Useful gives the prototype's toast", b.toast() === "Noted. More like this.");
await wait(() => b.q(".card:not(.lock)"));
b.click(".card:not(.lock) .acts button:nth-child(3)");
ok("Dismiss asks why, with the prototype's four reasons", b.q("#panel h2").textContent === "Why dismiss?" && b.qa("#panel .acts button").map((x) => x.textContent).join() === "Not relevant,Too early,Bad timing,Already know them");
b.click("#panel .acts button:nth-child(2)");
await wait(() => /Dismissed/.test(b.toast()));
ok("dismiss toast matches the prototype", b.toast() === "Dismissed: Too early");
await wait(() => b.q(".card:not(.lock)"));
ok("after dismissing, the next match is unlocked", b.qa(".card:not(.lock)").length === 1);

// ============================================================ plan page
b.click("#upg");
ok("Upgrade opens the plan page; payments off shows the waitlist as in the prototype", b.q("h2").textContent === "Cleone Pro" && !!b.q("#em") && /Join the waitlist/.test(b.q("#jn").textContent) && /\$19 a month/.test(b.text()));
b.type("#em", "wait@list.com"); b.click("#jn");
await wait(() => b.toast() === "Added to the waitlist");
ok("waitlist signup works", b.toast() === "Added to the waitlist");

// ============================================================ settings
b.click(".me"); await wait(() => b.q("#panel .row"));
ok("account menu lists Settings, Upgrade and Log out", b.qa("#panel .row").map((x) => x.textContent.trim()).join("|") === "Settings|Upgrade plan|Log out");
b.qa("#panel .row")[0].click();
await wait(() => b.q("h2")?.textContent === "Settings");
ok("settings has every section", ["Profile", "Plan and usage", "Preferences", "Outreach log", "Security", "Your data"].every((s) => b.qa(".sec").some((x) => x.textContent === s)));
ok("usage shows 1 of 3 scans", /1 of 3/.test(b.text()));
b.type("#nm", "Ada O."); b.click("#sv");
await wait(() => b.toast() === "Saved");
ok("name saves and updates the sidebar", /Ada O\./.test(b.q(".me b").textContent));
b.click('.seg button[data-t="dark"]');
await wait(() => b.d.documentElement.dataset.theme === "dark");
ok("dark theme applies instantly and is remembered", b.d.documentElement.dataset.theme === "dark" && b.w.localStorage.getItem("cleone.theme") === "dark");
await wait(() => b.q("h2")?.textContent === "Settings" && b.q(".seg button.on")?.textContent === "Dark");
b.click("#al");
await wait(() => b.q("#al")?.classList.contains("on"));
ok("weekly alerts preference saves", b.q("#al").classList.contains("on"));
await wait(() => b.qa("#ol .sw").length > 0);
ok("outreach log lists the copied draft", b.qa("#ol .sw").length === 1);
b.click("#ol .sw");
await wait(() => b.q("#ol .sw")?.classList.contains("on"));
ok("marking a reply updates the reply-rate summary", /1 of 1 replied/.test(b.q("#ol").textContent));
b.type("#cp", "correct horse battery"); b.type("#np", "a brand new password"); b.click("#pw");
await wait(() => /Password changed/.test(b.toast()));
ok("password change works from settings", /Password changed/.test(b.toast()));

// ============================================================ log out and back in
b.click(".me"); await wait(() => b.q("#panel .row")); b.qa("#panel .row")[2].click();
await wait(() => b.q(".home h1")?.textContent === "Welcome back");
ok("log out returns to the log-in screen", b.q(".home h1").textContent === "Welcome back" && !b.jar.cookie);
b.type("#em", "ada@startup.com"); b.type("#pw", "a brand new password"); b.click("#ok");
await wait(() => b.q(".home h1")?.textContent === "Ready when you are.");
ok("log in works with the new password and keeps the theme", b.q(".home h1")?.textContent === "Ready when you are." && b.d.documentElement.dataset.theme === "dark");

// ============================================================ delete account
b.click(".me"); await wait(() => b.q("#panel .row")); b.qa("#panel .row")[0].click();
await wait(() => b.q("#dl")); b.click("#dl");
b.type("#dp", "nope"); b.click("#dy");
await wait(() => b.q("#de")?.textContent);
ok("delete needs the right password", /wrong/.test(b.q("#de").textContent));
b.type("#dp", "a brand new password"); b.click("#dy");
await wait(() => b.q(".home h1")?.textContent === "Create your account");
ok("delete removes the account and returns to sign-up", b.q(".home h1")?.textContent === "Create your account" && !app.env.DB.raw.prepare("SELECT 1 FROM users").get());
app.restore();

// ============================================================ Pro and payments-on variants
app = makeApp({ ADMIN_EMAILS: "boss@cleone.app", PAYSTACK_SECRET_KEY: "k", PRO_AMOUNT: "1", PAYSTACK_PLAN_CODE: "P" });
b = await browser(app);
await wait(() => b.q("#sw")); b.click("#sw");
b.type("#nm", "Boss"); b.type("#em", "boss@cleone.app"); b.type("#pw", "correct horse battery"); b.click("#ok");
await wait(() => b.q(".home h1")?.textContent === "Ready when you are.");
ok("Pro account: Upgrade button is hidden and the plan is shown", b.q("#upg").style.display === "none" && /Pro plan/.test(b.q(".me small").textContent));
b.type("#url", "me/proj"); b.click("#go");
await wait(() => b.q("h2")?.textContent === "me/proj");
b.click(".tabs button:nth-child(2)");
await wait(() => b.q(".tabs button.on")?.textContent === "Joiners");
ok("Pro: all matches are open and nothing is blurred", b.qa(".card:not(.lock)").length > 3 && b.qa(".card.lock").length === 0 && !/1 match per lane/.test(b.q(".note").textContent));
b.click(".me"); await wait(() => b.q("#panel .row"));
ok("Pro menu has no Upgrade entry", b.qa("#panel .row").map((x) => x.textContent.trim()).join("|") === "Settings|Log out");
app.restore();

app = makeApp({ PAYSTACK_SECRET_KEY: "k", PRO_AMOUNT: "1", PAYSTACK_PLAN_CODE: "P" });
b = await browser(app);
await wait(() => b.q("#sw")); b.click("#sw");
b.type("#em", "free@user.com"); b.type("#pw", "correct horse battery"); b.click("#ok");
await wait(() => b.q(".home h1")?.textContent === "Ready when you are.");
b.click("#upg");
ok("payments on: the plan page offers Upgrade to Pro instead of the waitlist", !!b.q("#up2") && !b.q("#jn"));
app.restore();

// reset link in the address bar
app = makeApp();
b = await browser(app, "?reset=abc");
await wait(() => b.q("h2"));
ok("a reset link opens the choose-a-new-password screen", /Choose a new password/.test(b.q("h2").textContent));
app.restore();

console.log(`\napp.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
