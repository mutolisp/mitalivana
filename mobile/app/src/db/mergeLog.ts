/**
 * What each merge changed in a record (migration v67), newest first — the
 * record's 合併紀錄. Written by applyPendingMerge (src/lib/teamMergeFlow.ts)
 * for team sync and for imported teammates' files alike.
 */
import type { MergeKind } from '~/lib/mergeDocs';
import type { MergeChange } from '~/lib/mergeEngine';
import { getUserDb } from './init';

export type MergeLogEntry = { id: number; author: string | null; merged_at: number; changes: MergeChange[] };

export function addMergeLog(kind: MergeKind, uuid: string, author: string | null, changes: MergeChange[]): number | null {
  if (!changes.length) return null;
  const r = getUserDb().executeSync(
    `INSERT INTO merge_log (record_kind, record_uuid, author, merged_at, changes) VALUES (?, ?, ?, ?, ?)`,
    [kind, uuid, author, Date.now(), JSON.stringify(changes)],
  );
  return Number(r.insertId);
}

export function listMergeLog(kind: MergeKind, uuid: string): MergeLogEntry[] {
  const rows = (getUserDb().executeSync(
    `SELECT id, author, merged_at, changes FROM merge_log WHERE record_kind = ? AND record_uuid = ? ORDER BY merged_at DESC, id DESC`,
    [kind, uuid],
  ).rows ?? []) as Array<{ id: number; author: string | null; merged_at: number; changes: string }>;
  return rows.map((r) => {
    let changes: MergeChange[] = [];
    try {
      changes = JSON.parse(r.changes) as MergeChange[];
    } catch {
      // unreadable entry: shown as empty
    }
    return { id: r.id, author: r.author, merged_at: r.merged_at, changes };
  });
}

export function hasMergeLog(kind: MergeKind, uuid: string): boolean {
  return ((getUserDb().executeSync(`SELECT 1 FROM merge_log WHERE record_kind = ? AND record_uuid = ? LIMIT 1`, [kind, uuid]).rows ?? []).length > 0);
}
