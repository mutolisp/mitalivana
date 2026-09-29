/**
 * The R / C number keypad under a frequency grid (user spec 2026-09-29) —
 * pure, so every press is pinned by check:quadrats.
 *
 *   - Tap R then C (or C then R): that cell is toggled. The first tap waits,
 *     marked, for the other axis; a second tap on the same axis replaces it,
 *     and the same button again clears it.
 *   - Long press R (or C): that row (column) is locked; from then on a tap on
 *     the other axis toggles a cell of it straight away. A tap on the locked
 *     axis moves the lock there. Long press the locked button again to
 *     unlock; long press another button to lock that one instead.
 *
 * Buttons are 0-based here (k = 0 … n−1); labels read 1–9 and 0 for the tenth.
 */

export type KeypadAxis = 'r' | 'c';
export type KeypadKey = { axis: KeypadAxis; k: number };
export type KeypadState = { pending: KeypadKey | null; lock: KeypadKey | null };

export const KEYPAD_EMPTY: KeypadState = { pending: null, lock: null };

/** 1–9, then 0 for the tenth row or column. */
export function keypadLabel(k: number): string {
  return String((k + 1) % 10);
}

const cellOf = (a: KeypadKey, b: KeypadKey, n: number) => {
  const r = a.axis === 'r' ? a.k : b.k;
  const c = a.axis === 'c' ? a.k : b.k;
  return r * n + c;
};

/** A tap: the new state, and the cell to toggle (null when none yet). */
export function keypadPress(s: KeypadState, key: KeypadKey, n: number): { state: KeypadState; cell: number | null } {
  if (key.k < 0 || key.k >= n) return { state: s, cell: null };
  if (s.lock) {
    if (s.lock.axis === key.axis) return { state: { pending: null, lock: key }, cell: null };
    return { state: { pending: null, lock: s.lock }, cell: cellOf(s.lock, key, n) };
  }
  if (!s.pending) return { state: { pending: key, lock: null }, cell: null };
  if (s.pending.axis === key.axis) {
    return { state: { pending: s.pending.k === key.k ? null : key, lock: null }, cell: null };
  }
  return { state: KEYPAD_EMPTY, cell: cellOf(s.pending, key, n) };
}

/** A long press: lock that row / column, or unlock it when it is the locked one. */
export function keypadLongPress(s: KeypadState, key: KeypadKey): KeypadState {
  const same = s.lock && s.lock.axis === key.axis && s.lock.k === key.k;
  return { pending: null, lock: same ? null : key };
}

/** How a button shows: waiting for the other axis, locked, or neither. */
export function keypadMark(s: KeypadState, key: KeypadKey): 'pending' | 'locked' | null {
  if (s.lock && s.lock.axis === key.axis && s.lock.k === key.k) return 'locked';
  if (s.pending && s.pending.axis === key.axis && s.pending.k === key.k) return 'pending';
  return null;
}
