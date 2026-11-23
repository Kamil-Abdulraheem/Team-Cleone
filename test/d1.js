// A stand-in for Cloudflare D1 using SQLite in memory, so the real backend code can be tested on any computer.
import Database from "better-sqlite3";
import fs from "node:fs";

export function makeD1() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  // Like the real D1, bind() returns a NEW statement, so one prepared statement can be reused with different values.
  const make = (sql, args) => ({
    bind: (...a) => make(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec() { db.prepare(sql).run(...args); },
  });
  const prepare = (sql) => make(sql, []);
  return {
    prepare,
    async batch(list) { db.transaction(() => list.forEach((s) => s._exec()))(); return []; },
    raw: db,
  };
}
