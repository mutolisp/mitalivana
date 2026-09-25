/**
 * Record snapshots on the app's database; the logic and its rules are in
 * recordSnapshotCore.ts (kept free of native imports so a Node check can run it).
 */
import { getUserDb, withTransaction } from './init';
import {
  restoreRecordSnapshotIn,
  snapshotRecordIn,
  type RecordSnapshot,
  type SnapshotKind,
} from './recordSnapshotCore';

export { sameSnapshot, type RecordSnapshot, type SnapshotKind } from './recordSnapshotCore';

export function snapshotRecord(kind: SnapshotKind, id: number): RecordSnapshot | null {
  return snapshotRecordIn(getUserDb(), kind, id);
}

export function restoreRecordSnapshot(snap: RecordSnapshot): void {
  restoreRecordSnapshotIn(getUserDb(), snap, (fn) => withTransaction(fn));
}
