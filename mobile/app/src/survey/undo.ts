/**
 * Undo / redo per 20 m quadrat of a census (Modular_survey.md §7.2): before a
 * tree is saved or corrected, the quadrats it touches are kept as a slice;
 * undo restores the slice (sliceCore.restoreSlice), redo the state undo left.
 * In memory, per census, at most UNDO_LIMIT steps per quadrat; the census
 * screen clears them when it closes. Like GLORIA's per-unit undo.
 */
import { create } from 'zustand';
import { getUserDb, withTransaction } from '~/db/init';
import { generateUuid } from '~/db/uuid';
import { buildSlice, restoreSlice, type CensusSlice } from './db/sliceCore';

const UNDO_LIMIT = 30;

type Step = { codes: string[]; trees: string[]; slice: CensusSlice };
type Stacks = { undo: Step[]; redo: Step[] };

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const keyOf = (surveyId: number, code: string) => `${surveyId}|${code}`;

export const useQuadratUndo = create<{ stacks: Record<string, Stacks> }>(() => ({ stacks: {} }));

const stacksOf = (surveyId: number, code: string): Stacks => useQuadratUndo.getState().stacks[keyOf(surveyId, code)] ?? { undo: [], redo: [] };
const setStacks = (surveyId: number, code: string, s: Stacks) =>
  useQuadratUndo.setState((st) => ({ stacks: { ...st.stacks, [keyOf(surveyId, code)]: s } }));

const capture = (surveyId: number, codes: string[], trees: string[]): Step => ({ codes, trees, slice: buildSlice(ctx(), surveyId, codes, trees) });

/**
 * Keep the quadrats an edit is about to change. `codes[0]` is the quadrat
 * whose undo button takes it back (the tree's quadrat before the edit).
 */
export function checkpointQuadrats(surveyId: number, codes: readonly string[], trees: readonly string[] = []): void {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return;
  try {
    const step = capture(surveyId, list, [...trees]);
    const cur = stacksOf(surveyId, list[0]);
    setStacks(surveyId, list[0], { undo: [...cur.undo, step].slice(-UNDO_LIMIT), redo: [] });
  } catch (e) {
    // Undo is a convenience: a failed snapshot must not block the save.
    if (__DEV__) console.warn('[quadratUndo] checkpoint failed', e);
  }
}

export function canUndo(stacks: Record<string, Stacks>, surveyId: number, code: string): { undo: number; redo: number } {
  const s = stacks[keyOf(surveyId, code)];
  return { undo: s?.undo.length ?? 0, redo: s?.redo.length ?? 0 };
}

function step(surveyId: number, code: string, dir: 'undo' | 'redo'): boolean {
  const cur = stacksOf(surveyId, code);
  const from = dir === 'undo' ? cur.undo : cur.redo;
  const target = from[from.length - 1];
  if (!target) return false;
  const now = capture(surveyId, target.codes, target.trees);
  withTransaction(() => restoreSlice(ctx(), surveyId, target.slice));
  const rest = from.slice(0, -1);
  setStacks(
    surveyId,
    code,
    dir === 'undo' ? { undo: rest, redo: [...cur.redo, now] } : { undo: [...cur.undo, now], redo: rest },
  );
  return true;
}

export const undoQuadrat = (surveyId: number, code: string) => step(surveyId, code, 'undo');
export const redoQuadrat = (surveyId: number, code: string) => step(surveyId, code, 'redo');

/** Drop a census's history (its screen closed). */
export function clearCensusUndo(surveyId: number): void {
  useQuadratUndo.setState((st) => ({
    stacks: Object.fromEntries(Object.entries(st.stacks).filter(([k]) => !k.startsWith(`${surveyId}|`))),
  }));
}
