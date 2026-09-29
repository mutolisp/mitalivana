/**
 * Record versions (docs: the plan of 2026-09-28) — the pure rules, so
 * check:record-versions runs them in Node.
 *
 * A version is a whole snapshot of a record (the same local document team
 * merge compares), compressed. These rules decide:
 *   - whether a snapshot is stored at all (same content as the latest: no);
 *   - whether a "left the screen" snapshot extends the latest one (within 30
 *     minutes of the previous leave) instead of adding a row;
 *   - which automatic versions go when a record has more than 30 (manual
 *     ones, the user's own, stay);
 *   - how long versions of a deleted record wait before they go (30 days).
 */
import { baseOf, defaultDecision, rowHash, type Combiners, type Decision, type MergeItem, type MergeSide } from './mergeEngine';

export type VersionReason = 'done' | 'leave' | 'before_merge' | 'after_merge' | 'before_restore' | 'before_import' | 'before_delete' | 'manual';
export const VERSION_REASONS: readonly VersionReason[] = ['done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'before_delete', 'manual'];

export const LEAVE_MERGE_MS = 30 * 60 * 1000;
export const KEEP_AUTO = 30;
export const DELETED_KEEP_MS = 30 * 24 * 3600 * 1000;

export type VersionMeta = { id: number; reason: VersionReason; content_hash: string; created_at: number; updated_at: number };

export type SavePlan = { kind: 'skip' } | { kind: 'insert' } | { kind: 'update'; id: number } | { kind: 'relabel'; id: number };

/**
 * What to do with a new snapshot given the record's latest version:
 *   - manual: always a new version (the user marks a point, even unchanged);
 *   - same content as a latest "leave", saved for any other reason (before a
 *     restore, an import, a merge …): that version takes the new reason. As a
 *     leave it would be overwritten by the next leave within 30 minutes, and
 *     the state before the restore would be gone (2026-09-29);
 *   - same content as the latest otherwise: nothing;
 *   - a leave within 30 minutes of a leave: that version is updated;
 *   - otherwise a new version.
 */
export function planSave(latest: VersionMeta | null, hash: string, reason: VersionReason, now: number): SavePlan {
  if (reason === 'manual') return { kind: 'insert' };
  if (latest && latest.content_hash === hash) {
    return reason !== 'leave' && latest.reason === 'leave' ? { kind: 'relabel', id: latest.id } : { kind: 'skip' };
  }
  if (reason === 'leave' && latest?.reason === 'leave' && now - latest.updated_at < LEAVE_MERGE_MS) return { kind: 'update', id: latest.id };
  return { kind: 'insert' };
}

/** Ids to delete: automatic versions beyond the newest KEEP_AUTO; manual ones are kept. */
export function pickPrune(versions: ReadonlyArray<Pick<VersionMeta, 'id' | 'reason' | 'created_at'>>): number[] {
  return [...versions]
    .filter((v) => v.reason !== 'manual')
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
    .slice(KEEP_AUTO)
    .map((v) => v.id);
}

/** A deleted record's versions go once this many ms have passed since the deletion was noticed. */
export function expired(deletedAt: number | null, now: number): boolean {
  return deletedAt != null && now - deletedAt > DELETED_KEEP_MS;
}

/**
 * Restoring a version = merging it in as "the other side" with the current
 * record as the common ancestor: every difference is then a one-sided change.
 * Everything takes the version's side — rows the version lacks are deleted,
 * which the merge default ('keep mine') would not do.
 */
export function restoreDecisions(items: readonly MergeItem[]): Map<string, Decision> {
  return new Map(items.map((it) => [it.id, { ...defaultDecision(it), pick: 'remote' as const }]));
}

/**
 * Content of a snapshot for "has it changed": every row's data AND the fields
 * team merge combines instead of comparing (surveyors, time span, track —
 * kept in `extra`), so a version that differs only there is still stored.
 */
export function snapshotHash(side: MergeSide): string {
  const extras = Object.entries(side).flatMap(([tbl, rs]) => rs.filter((r) => r.extra).map((r) => [tbl, r.key, rowHash(r.extra!)]));
  return rowHash({ rows: baseOf(side), extras });
}

/**
 * Team merge's combiners with each field taking the version's value: restoring
 * brings surveyors / times / track back exactly (not unioned with the current
 * ones), and the diff lists them only where they really differ.
 */
export function takeVersion(combiners: Combiners): Combiners {
  return Object.fromEntries(
    Object.entries(combiners).map(([tbl, fs]) => [tbl, Object.fromEntries(Object.keys(fs).map((f) => [f, (_now: unknown, then: unknown) => then ?? null]))]),
  );
}
