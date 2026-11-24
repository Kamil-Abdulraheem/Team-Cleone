// The database: PostgreSQL on Neon. The rest of the app talks to it through a few simple calls:
//   db.prepare("SELECT ... WHERE id = ?").bind(id).first()   one row, or null
//   .all()   -> { results: [rows] }        .run()   -> { meta: { changes } }
//   db.batch([statement, statement])       several statements that all succeed or none do
// Questions marks (?) in the SQL are turned into Postgres's $1, $2 ... here, so the SQL stays easy to read.

import pg from "pg";
import { SCHEMA } from "./schema.js";

// BIGINT, COUNT(*) and SUM() would arrive as text. Our numbers are small, so turn them into real numbers.
pg.types.setTypeParser(20, (v) => Number(v));

const toPg = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const clean = (args) => args.map((v) => (v === undefined ? null : v));

/** pool = anything with query(text, values) and connect() (a node-postgres Pool, or the test stand-in). */
export function wrapPool(pool) {
  const make = (sql, args) => ({
    bind: (...a) => make(sql, a),
    async first() {
      const r = await pool.query(toPg(sql), clean(args));
      return r.rows[0] ?? null;
    },
    async all() {
      const r = await pool.query(toPg(sql), clean(args));
      return { results: r.rows };
    },
    async run() {
      const r = await pool.query(toPg(sql), clean(args));
      return { meta: { changes: r.rowCount } };
    },
    _statement: () => ({ text: toPg(sql), values: clean(args) }),
  });
  return {
    prepare: (sql) => make(sql, []),
    async batch(list) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const s of list) {
          const { text, values } = s._statement();
          await c.query(text, values);
        }
        await c.query("COMMIT");
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        c.release();
      }
      return [];
    },
    pool,
  };
}

/** Creates the tables if they are missing (safe to repeat), then returns the database. */
export async function connect(pool) {
  try {
    await pool.query(SCHEMA);
  } catch (e) {
    // Two instances starting at the same moment can collide while creating the tables. The second try succeeds.
    await pool.query(SCHEMA);
  }
  return wrapPool(pool);
}

/** Uses DATABASE_URL (the Neon connection string Vercel adds for you). Returns null if it is not set. */
export async function getDb(env) {
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) return null;
  // One connection per running instance keeps us far below Neon's connection limit.
  const pool = new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  return connect(pool);
}
