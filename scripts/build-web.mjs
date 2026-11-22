// Builds index.html: the prototype's markup and CSS (unchanged) + the bundled scan engine + the app script.
import { build } from "esbuild";
import fs from "node:fs";

const out = await build({
  entryPoints: ["web/entry.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "Cleone",
  platform: "browser",
  target: "es2020",
  write: false,
});
const bundle = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const tpl = fs.readFileSync("web/index.template.html", "utf8");
if (!tpl.includes("/*__BUNDLE__*/")) throw new Error("template is missing the bundle marker");
fs.writeFileSync("index.html", tpl.replace("/*__BUNDLE__*/", () => bundle));
console.log(`index.html written (${(fs.statSync("index.html").size / 1024).toFixed(1)} KB, bundle ${(bundle.length / 1024).toFixed(1)} KB)`);
