// A fresh, empty database for each test.
//  - If TEST_DATABASE_URL is set, uses that real PostgreSQL (in its own temporary schema).
//  - Otherwise uses PGlite, a complete PostgreSQL that runs inside Node, so `npm test` needs no setup at all.
import pg from "pg";
import { connect } from "../lib/postgres.js";

export async function makeTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const name = "t" + Math.random().toString(36).slice(2, 10);
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${name}`);
    const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${name}` });
    const DB = await connect(pool);
    return { DB, kind: "real PostgreSQL", close: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${name} CASCADE`); await admin.end(); } };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const fix = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
  const shim = {
    async query(text, values) {
      if (!values || values.length === 0) {
        const res = await db.exec(text);
        const last = res[res.length - 1];
        return { rows: fix(last?.rows ?? []), rowCount: last?.affectedRows ?? last?.rows?.length ?? 0 };
      }
      const r = await db.query(text, values);
      return { rows: fix(r.rows), rowCount: r.affectedRows ?? r.rows.length };
    },
    async connect() { return { query: (t, v) => shim.query(t, v), release() {} }; },
  };
  const DB = await connect(shim);
  return { DB, kind: "PGlite (PostgreSQL in Node)", close: async () => db.close() };
}
