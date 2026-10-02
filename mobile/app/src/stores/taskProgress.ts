/**
 * A long operation the person has to wait for (deleting a large census,
 * importing one, a full backup or restore, compacting the database), shown by
 * TaskProgressHost over every screen: the step, and where it can be counted,
 * how far it is.
 *
 * Most of this work holds the JS thread. A step yields once, so its name is on
 * screen before the work starts; counted work yields again at most every
 * 100 ms, so the bar moves without a render after every piece. Work inside one
 * database transaction cannot yield (anything else that writes meanwhile would
 * land in the transaction), so it shows only its step and the spinner, which
 * is native and keeps turning while JS is busy (1E).
 *
 * Stored as an i18n key and numbers, not text, like syncProgress.ts — except
 * an export's own stage captions (bundleExport's ExportProgress), passed on
 * as they come.
 */
import { create } from 'zustand';

export type TaskStep = {
  key: string;
  params?: Record<string, string | number>;
  /** Already worded (an export stage); shown instead of `key`. */
  label?: string;
  done?: number;
  total?: number;
  /** done / total are bytes (shown as MB). */
  bytes?: boolean;
};

type State = {
  current: TaskStep | null;
  depth: number;
};

export const useTaskProgress = create<State>(() => ({ current: null, depth: 0 }));

/** One macrotask: what was set before it is rendered when it returns. */
export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

const EVERY_MS = 100;

export type TaskReporter = {
  /** A new step; returns once it can be on screen. */
  step: (key: string, params?: Record<string, string | number>) => Promise<void>;
  /** How far the step is; yields to the UI now and then. */
  progress: (done: number, total: number, bytes?: boolean) => Promise<void>;
  /** For bundleExport's onProgress (finalizeZip yields by itself). */
  exportProgress: (p: { label: string; done?: number; total?: number; bytes?: boolean }) => void;
};

export function taskReporter(): TaskReporter {
  let last = 0;
  return {
    step: async (key, params) => {
      useTaskProgress.setState((s) => (s.current ? { current: { key, params } } : s));
      last = Date.now();
      await yieldToUi();
    },
    progress: async (done, total, bytes) => {
      useTaskProgress.setState((s) => (s.current ? { current: { ...s.current, done, total, bytes } } : s));
      if (Date.now() - last < EVERY_MS && done < total) return;
      last = Date.now();
      await yieldToUi();
    },
    exportProgress: (p) => useTaskProgress.setState((s) => (s.current ? { current: { key: '', ...p } } : s)),
  };
}

/** Run `fn` with the progress panel up; nested tasks share the outer panel. */
export async function runTask<T>(fn: (r: TaskReporter) => Promise<T>): Promise<T> {
  useTaskProgress.setState((s) => ({ depth: s.depth + 1, current: s.current ?? { key: 'task.working' } }));
  try {
    return await fn(taskReporter());
  } finally {
    useTaskProgress.setState((s) => (s.depth <= 1 ? { depth: 0, current: null } : { depth: s.depth - 1 }));
  }
}
