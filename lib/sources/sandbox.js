// Sandbox mode (SOURCE_MODE=sandbox): serves the SAMPLE responses from fixtures.js instead of calling the internet,
// so the product can be developed with no network. Everything it produces is stored as synthetic and labelled in the app.
// The live diagnostic refuses to run in this mode, because a diagnostic must never be simulated.
import { FIXTURES as F } from "./fixtures.js";

const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

export async function sandboxFetch(url) {
  const u = String(url);
  if (u.startsWith("https://boards-api.greenhouse.io/")) return res(F.greenhouse);
  if (u.startsWith("https://api.lever.co/") || u.startsWith("https://api.eu.lever.co/")) return res(F.lever);
  if (u.startsWith("https://api.ashbyhq.com/")) return res(F.ashby);
  if (u === "https://remotive.com/api/remote-jobs?limit=200") return res(F.remotive);
  if (u.startsWith("https://www.arbeitnow.com/")) return res(F.arbeitnow);
  if (u.startsWith("https://remoteok.com/api")) return res(F.remoteok);
  if (u.endsWith("/robots.txt")) return res(F.robots);
  if (u.startsWith("https://sample.invalid/feed")) return res(F.rss);
  if (u.startsWith("https://sample.invalid/careers")) return res(F.careerPage);
  if (u.startsWith("https://sample.invalid/closed/")) return res("", 404);
  if (u.startsWith("https://sample.invalid/")) return res("<html><body><h1>Sample job page</h1> Apply now</body></html>");
  return res("", 404);
}
