/**
 * Web replacement for mobile/app/src/db/init.ts (swapped in by the
 * mobile bridge, so every reused module that imports `./init` or `~/db/init`
 * lands here).
 *
 * Same contract as the mobile file:
 *   - `initDb()` opens user.db, runs the real `runUserMigrations` with foreign
 *     keys OFF, then switches them ON (order explained in init.ts);
 *   - `getUserDb()` throws before init;
 *   - `withTransaction(fn)` is reentrant by depth, BEGIN IMMEDIATE, and `fn`
 *     must stay synchronous.
 *
 * Mobile-only startup work (legacy bundle, raster pack, map style, stale daily
 * sessions) does not exist here and is skipped.
 *
 * Persistence: writes mark the DB dirty; the snapshot is scheduled only when
 * no transaction is open, so a half-applied transaction is never saved.
 */
import { runUserMigrations } from '~/db/migrations';
import { openMemoryDb, type SyncDb } from './sqlite';

let userDb: SyncDb | null = null;
let txDepth = 0;
let dirty = false;
let onDirty: (() => void) | null = null;

export type InitProgressFn = (step: string) => void;

export type InitOptions = {
  /** Snapshot to start from (null/undefined → empty database). */
  snapshot?: Uint8Array | null;
  /** Called after a committed write; persist.ts schedules a flush from it. */
  onDirty?: () => void;
};

function markDirty(): void {
  dirty = true;
  if (txDepth === 0) onDirty?.();
}

export async function initDb(opts: InitOptions | InitProgressFn = {}): Promise<{ user: SyncDb }> {
  if (userDb) return { user: userDb };
  const o: InitOptions = typeof opts === 'function' ? {} : opts;
  onDirty = o.onDirty ?? null;
  const db = await openMemoryDb(o.snapshot, markDirty);
  db.executeSync('PRAGMA foreign_keys = OFF;');
  // The mobile type is op-sqlite's DB; this wrapper implements the part
  // migrations use (executeSync), which is what schema-columns.mjs relies on too.
  await runUserMigrations(db as never);
  db.executeSync('PRAGMA foreign_keys = ON;');
  userDb = db;
  return { user: db };
}

export function getUserDb(): SyncDb {
  if (!userDb) throw new Error('User DB not initialized — call initDb() first');
  return userDb;
}

export function isDbOpen(): boolean {
  return userDb !== null;
}

export function withTransaction<T>(fn: () => T): T {
  const db = getUserDb();
  if (txDepth > 0) return fn();
  db.executeSync('BEGIN IMMEDIATE;');
  txDepth = 1;
  try {
    const out = fn();
    db.executeSync('COMMIT;');
    return out;
  } catch (e) {
    try {
      db.executeSync('ROLLBACK;');
    } catch {
      // already rolled back by SQLite (e.g. a fatal statement error)
    }
    throw e;
  } finally {
    txDepth = 0;
    if (dirty) onDirty?.();
  }
}

/** True when a write happened since the last `takeDirty()`. */
export function takeDirty(): boolean {
  const d = dirty;
  dirty = false;
  return d;
}

export function inTransaction(): boolean {
  return txDepth > 0;
}

export function closeDbs(): void {
  userDb?.close();
  userDb = null;
  txDepth = 0;
  dirty = false;
}

/** Drop everything and start from an empty, migrated database. */
export async function clearAllUserData(): Promise<void> {
  const cb = onDirty;
  closeDbs();
  await initDb({ snapshot: null, onDirty: cb ?? undefined });
  markDirty();
}
