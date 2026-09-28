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

/** An in-memory database with every migration applied. The caller closes it. */
export async function migratedDb(upTo = Infinity) {
  // Foreign keys OFF while migrating, as the app has them (init.ts): a table
  // rebuild drops the old parent table, which with FKs ON deletes its children.
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  await runUserMigrations(shim(sqlite), upTo);
  return sqlite;
}

/** Run the migrations after `upTo` on a database migrated that far. */
export async function migrateRest(sqlite) {
  await runUserMigrations(shim(sqlite));
}

/** Map of table name → Set of column names, for the fully migrated schema. */
export async function schemaColumns() {
  const sqlite = await migratedDb();
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
