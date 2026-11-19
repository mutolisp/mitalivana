/**
 * Start-up: take the tab lock, open user.db from its newest good snapshot,
 * run the mobile migrations, and wire writes to the snapshot flusher.
 *
 * Snapshot choice: the newest copy if it passes `PRAGMA quick_check`,
 * otherwise `.prev`. A snapshot written by a newer app version than this one
 * (schema version above LATEST_SCHEMA_VERSION) is never opened: migrating it
 * "down" is impossible and opening it could lose columns on the next save.
 */
import { LATEST_SCHEMA_VERSION } from '~/db/migrations';
import { closeDbs, getUserDb, initDb } from './dbInit';
import { loadSqlite, openMemoryDb } from './sqlite';
import {
  acquireTabLock, createFlusher, flushOnHide, readSnapshot, type Flusher, type Snapshot,
} from './persist';

export const USER_DB_KEY = 'user.db';

export type BootResult =
  | { ok: true; flusher: Flusher; recoveredFromPrev: boolean }
  | { ok: false; reason: 'other-tab' | 'newer-schema' | 'corrupt'; detail?: string };

function schemaVersionOf(bytes: Uint8Array): Promise<number | null> {
  return openMemoryDb(bytes).then((db) => {
    try {
      const ok = db.executeSync('PRAGMA quick_check;').rows[0];
      if (!ok || Object.values(ok)[0] !== 'ok') return null;
      const v = db.executeSync(
        `SELECT MAX(version) AS v FROM schema_version`,
      ).rows[0] as { v?: number } | undefined;
      return Number(v?.v ?? 0);
    } catch {
      return null;
    } finally {
      db.close();
    }
  });
}

async function pickSnapshot(): Promise<
  { snap: Snapshot | null; fromPrev: boolean } | { error: 'newer-schema' | 'corrupt'; detail: string }
> {
  for (const [key, fromPrev] of [[USER_DB_KEY, false], [`${USER_DB_KEY}.prev`, true]] as const) {
    const snap = await readSnapshot(key);
    if (!snap) {
      if (!fromPrev) continue;
      break;
    }
    const v = await schemaVersionOf(snap.bytes);
    if (v === null) continue;
    if (v > LATEST_SCHEMA_VERSION) {
      return { error: 'newer-schema', detail: `data v${v}, app v${LATEST_SCHEMA_VERSION}` };
    }
    return { snap, fromPrev };
  }
  const any = (await readSnapshot(USER_DB_KEY)) ?? (await readSnapshot(`${USER_DB_KEY}.prev`));
  if (any) return { error: 'corrupt', detail: 'no snapshot passed quick_check' };
  return { snap: null, fromPrev: false };
}

export async function bootDatabase(opts: { lockName?: string } = {}): Promise<BootResult> {
  if (!(await acquireTabLock(opts.lockName))) return { ok: false, reason: 'other-tab' };
  await loadSqlite();
  const picked = await pickSnapshot();
  if ('error' in picked) return { ok: false, reason: picked.error, detail: picked.detail };

  // The flusher reads the live DB; created first so the dirty hook can call it.
  let flusher: Flusher | null = null;
  const take = (): Snapshot => ({
    bytes: getUserDb().exportBytes(),
    schemaVersion: LATEST_SCHEMA_VERSION,
    savedAt: Date.now(),
  });
  flusher = createFlusher(USER_DB_KEY, take);
  closeDbs();
  await initDb({ snapshot: picked.snap?.bytes ?? null, onDirty: () => flusher?.schedule() });
  // A fresh database or one that just migrated forward: save it right away.
  if (!picked.snap || picked.snap.schemaVersion !== LATEST_SCHEMA_VERSION || picked.fromPrev) flusher.schedule();
  flushOnHide([flusher]);
  return { ok: true, flusher, recoveredFromPrev: picked.fromPrev };
}
