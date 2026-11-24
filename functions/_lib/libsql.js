// Database for hosts that do not have Cloudflare D1 (Vercel, or your own computer): Turso.
// Turso is SQLite, so schema.sql and every query in the app work unchanged. This file only makes Turso answer
// the same few questions D1 does: prepare(sql).bind(...).first() / .all() / .run(), and batch([...]).

import { createClient } from "@libsql/client/web";
import { SCHEMA } from "./schema.js";

/** Wraps a libSQL client so it behaves like a Cloudflare D1 database. */
export function wrapClient(client) {
  const plain = (cols, row) => Object.fromEntries(cols.map((c) => [c, row[c]]));
  const make = (sql, args) => ({
    bind: (...a) => make(sql, a),
    async first() {
      const r = await client.execute({ sql, args });
      return r.rows[0] ? plain(r.columns, r.rows[0]) : null;
    },
    async all() {
      const r = await client.execute({ sql, args });
      return { results: r.rows.map((row) => plain(r.columns, row)) };
    },
    async run() {
      const r = await client.execute({ sql, args });
      return { meta: { changes: r.rowsAffected } };
    },
    _statement: () => ({ sql, args }),
  });
  return {
    prepare: (sql) => make(sql, []),
    // All statements succeed together or none do.
    async batch(list) {
      await client.batch(list.map((s) => s._statement()), "write");
      return [];
    },
    client,
  };
}

/** Creates the tables if they are missing (safe to run every time), then returns the database. */
export async function connect(client) {
  await client.executeMultiple(SCHEMA);
  return wrapClient(client);
}

/** Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Returns null when they are not set. */
export async function getDb(env) {
  if (!env.TURSO_DATABASE_URL) return null;
  const url = env.TURSO_DATABASE_URL.replace(/^libsql:/, "https:"); // plain HTTPS works best from serverless
  return connect(createClient({ url, authToken: env.TURSO_AUTH_TOKEN }));
}
