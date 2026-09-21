/**
 * The real v38 user schema, derived by running the real migrations.
 *
 * `check-roundtrip` used to compare the exporter against a hand-written
 * fixture, so a column the fixture never mentioned could be added to the table
 * and dropped by the exporter without failing anything — `starred`,
 * `audio_paths` and the four `inat_*` columns all slipped through that way.
 *
 * `migrations.ts` imports nothing from op-sqlite but a type, and every `up()`
 * uses `db.executeSync` only, so the migrations run unchanged against
 * `node:sqlite` behind a small shim. What comes out is the schema the app
 * actually has, not a description of it.
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';

function shim(sqlite) {
  return {
    executeSync(sql, params = []) {
      const stmt = sqlite.prepare(sql);
      try {
        return { rows: stmt.all(...params) };
      } catch {
        const res = stmt.run(...params);
        return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
      }
    },
  };
}

/** Map of table name → Set of column names, for the fully migrated schema. */
export async function schemaColumns() {
  const sqlite = new DatabaseSync(':memory:');
  await runUserMigrations(shim(sqlite));
  const out = new Map();
  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all();
  for (const { name } of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info(${name})`).all();
    out.set(name, new Set(cols.map((c) => c.name)));
  }
  sqlite.close();
  return out;
}
