/**
 * What team sync is doing right now, for the progress strip (SyncProgressHost)
 * shown on every screen while it runs: which record, and while files move,
 * which file and how many bytes. Module-level, so the sync keeps reporting
 * when the user leaves the screen that started it.
 *
 * Stored as keys and numbers, not text: the strip words it at render (a
 * language change must not leave a baked-in string behind).
 */
import { create } from 'zustand';

export type SyncStage = 'record' | 'upload' | 'download';

export type SyncProgress = {
  /** Record being synced (its name as the lists show it) and its place in a batch. */
  record: string | null;
  recordIndex: number | null;
  recordCount: number | null;
  stage: SyncStage;
  /** While files move. */
  fileIndex: number | null;
  fileCount: number | null;
  bytesDone: number;
  bytesTotal: number;
};

type State = {
  current: SyncProgress | null;
  /** Nested syncs (a batch that syncs records) keep the strip until the outermost ends. */
  depth: number;
  begin: () => void;
  update: (patch: Partial<SyncProgress>) => void;
  end: () => void;
};

const blank: SyncProgress = {
  record: null,
  recordIndex: null,
  recordCount: null,
  stage: 'record',
  fileIndex: null,
  fileCount: null,
  bytesDone: 0,
  bytesTotal: 0,
};

export const useSyncProgress = create<State>((set) => ({
  current: null,
  depth: 0,
  begin: () => set((s) => ({ depth: s.depth + 1, current: s.current ?? { ...blank } })),
  update: (patch) => set((s) => (s.current ? { current: { ...s.current, ...patch } } : s)),
  end: () => set((s) => (s.depth <= 1 ? { depth: 0, current: null } : { depth: s.depth - 1 })),
}));

/** Run `fn` with the strip shown (and the screen kept awake by the host). */
export async function withSyncProgress<T>(fn: () => Promise<T>): Promise<T> {
  useSyncProgress.getState().begin();
  try {
    return await fn();
  } finally {
    useSyncProgress.getState().end();
  }
}
