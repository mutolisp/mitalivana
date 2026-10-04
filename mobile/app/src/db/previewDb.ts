/**
 * The builder's 預覽 on a scratch database (2G-e, decided 2026-10-04): the
 * real survey screens run on a survey whose rows live in a file of their own,
 * so nothing of the preview reaches user.db. Every id in that file starts at
 * PREVIEW_ID_BASE (its sqlite_sequence is raised when it is made), so a call
 * is routed by the id it is about rather than by a global switch: a real
 * record's background work — a track being recorded, a GNSS fix arriving —
 * keeps writing to user.db while a preview is open.
 *
 * What must not follow a preview id into user.db skips it (record versions,
 * the record menu's versions / merge log / team sync, the track recorder,
 * ending another active record on reopen).
 */
import type { DB } from '@op-engineering/op-sqlite';
import { getUserDb, withTransaction } from './init';
import { isPreviewId } from './previewIds';

export { isPreviewId, PREVIEW_ID_BASE, raisePreviewIds } from './previewIds';

let scratch: DB | null = null;
let txDepth = 0;

/** The preview page opens and closes it. */
export function setPreviewDb(db: DB | null): void {
  scratch = db;
}

/** user.db, or the scratch file for a preview id; a preview id after its preview closed has nowhere to go. */
export function dbFor(id: number | null | undefined): DB {
  if (!isPreviewId(id)) return getUserDb();
  if (!scratch) throw new Error('preview closed');
  return scratch;
}

/** withTransaction on the database `id` lives in. */
export function transactionFor<T>(id: number | null | undefined, fn: () => T): T {
  if (!isPreviewId(id)) return withTransaction(fn);
  const db = dbFor(id);
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
      // already rolled back by SQLite
    }
    throw e;
  } finally {
    txDepth = 0;
  }
}
