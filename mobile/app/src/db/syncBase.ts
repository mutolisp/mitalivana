/**
 * The common ancestor of a record for team merge (migration v57): per row, its
 * content hash as of the last exchange with another device. See
 * src/lib/mergeEngine.ts for how it is used.
 *
 * Written after an import (the imported rows, as stored here) and after a
 * merge (the sender's rows). Sent out with every export in the `sync:` block.
 */
import type { BaseEntry, SyncBlock } from '~/lib/mergeEngine';
import type { MergeKind } from '~/lib/mergeDocs';
import { getUserDb, withTransaction } from './init';

/** A record kind, or 'survey': a tree census keeps one base for all its blocks (censusSyncCore.ts). */
export type BaseKind = MergeKind | 'survey';

export function getSyncBase(kind: BaseKind, uuid: string): BaseEntry[] {
  const res = getUserDb().executeSync(
    `SELECT tbl, row_key, hash FROM sync_base WHERE record_kind = ? AND record_uuid = ?`,
    [kind, uuid],
  );
  return ((res.rows ?? []) as { tbl: string; row_key: string; hash: string }[]).map((r) => [r.tbl, r.row_key, r.hash]);
}

export function setSyncBase(kind: BaseKind, uuid: string, entries: BaseEntry[]): void {
  withTransaction(() => {
    const db = getUserDb();
    db.executeSync(`DELETE FROM sync_base WHERE record_kind = ? AND record_uuid = ?`, [kind, uuid]);
    for (const [tbl, key, hash] of entries) {
      db.executeSync(
        `INSERT OR REPLACE INTO sync_base (record_kind, record_uuid, tbl, row_key, hash) VALUES (?, ?, ?, ?, ?)`,
        [kind, uuid, tbl, key, hash],
      );
    }
  });
}

/** Dropped with the record: nothing else refers to it. */
export function clearSyncBase(kind: BaseKind, uuid: string): void {
  getUserDb().executeSync(`DELETE FROM sync_base WHERE record_kind = ? AND record_uuid = ?`, [kind, uuid]);
}

/** The `sync:` block an export carries: this device's ancestor for the record. */
export function syncBlockFor(kind: MergeKind, uuid: string): SyncBlock {
  return { exported_at: Date.now(), base: getSyncBase(kind, uuid) };
}
