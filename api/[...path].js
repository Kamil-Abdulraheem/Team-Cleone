// Vercel entry point. All /api/... requests arrive here. The logic is in functions/_lib/app.js.
import { createNodeHandler } from "../functions/_lib/node.js";
import { getDb } from "../functions/_lib/libsql.js";

let cached = null; // the settings plus the database, built once per running instance

async function getEnv() {
  if (cached) return cached;
  let DB = null;
  try {
    DB = await getDb(process.env); // null when TURSO_DATABASE_URL is not set
  } catch (e) {
    console.error("Could not connect to the database:", e.message);
  }
  const env = { ...process.env, DB };
  if (DB) cached = env; // do not remember a broken setup; try again on the next request
  return env;
}

export default createNodeHandler(getEnv);
