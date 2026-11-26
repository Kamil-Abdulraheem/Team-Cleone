// Vercel entry point. All /api/... requests arrive here. The logic is in lib/app.js.
import { createNodeHandler } from "../lib/node.js";
import { getDb } from "../lib/postgres.js";

let cached = null; // the settings plus the database, built once per running instance

async function getEnv() {
  if (cached) return cached;
  let DB = null, DB_ERROR = "";
  try {
    DB = await getDb(process.env); // null when DATABASE_URL is not set
  } catch (e) {
    console.error("Could not connect to the database:", e.message);
    DB_ERROR = String(e.message || e).slice(0, 300); // shown (scrubbed) by /api/health
  }
  const env = { ...process.env, DB, DB_ERROR };
  if (DB) cached = env; // do not remember a broken setup; try again on the next request
  return env;
}

export default createNodeHandler(getEnv);
