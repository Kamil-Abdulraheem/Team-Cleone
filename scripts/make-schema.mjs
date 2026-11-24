// Rebuilds functions/_lib/schema.js from schema.sql. Run `npm run schema` after editing schema.sql.
import fs from "node:fs";
const sql = fs.readFileSync("schema.sql", "utf8");
fs.writeFileSync("functions/_lib/schema.js", "// Generated from schema.sql by `npm run schema`. Do not edit by hand; edit schema.sql instead.\nexport const SCHEMA = String.raw`" + sql.replace(/`/g, "\\`") + "`;\n");
console.log("functions/_lib/schema.js updated");
