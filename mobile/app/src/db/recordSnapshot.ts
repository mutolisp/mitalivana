/**
 * Record snapshots on the app's database; the logic and its rules are in
 * recordSnapshotCore.ts (kept free of native imports so a Node check can run it).
 */
import { dbFor, transactionFor } from './previewDb';
import {
  restoreRecordSnapshotIn,
  snapshotRecordIn,
  type RecordSnapshot,
  type SnapshotKind,
} from './recordSnapshotCore';

export { sameSnapshot, type RecordSnapshot, type SnapshotKind } from './recordSnapshotCore';

export function snapshotRecord(kind: SnapshotKind, id: number): RecordSnapshot | null {
  // A builder preview's survey is undone in its scratch file (previewDb.ts).
  return snapshotRecordIn(kind === 'modular' ? dbFor(id) : dbFor(null), kind, id);
}

export function restoreRecordSnapshot(snap: RecordSnapshot): void {
  const id = snap.kind === 'modular' ? snap.id : null;
  restoreRecordSnapshotIn(dbFor(id), snap, (fn) => transactionFor(id, fn));
}
