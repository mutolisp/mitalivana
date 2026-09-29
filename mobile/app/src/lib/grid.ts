/**
 * Cell masks for a square frequency grid — pure. Shared by GLORIA's 1×1 m
 * quadrats and the fixed plot's quadrats (06-plot-quadrats.md §5).
 *
 * A mask is a fixed-length string of '0' / '1', one character per cell. NULL
 * in the DB means the method was not done; an all-'0' mask means it was done
 * and nothing was found. Keeping the two apart is the reason for strings over
 * a normalised row per cell.
 *
 * Index is fixed to the ground, never to the order anyone walked:
 *     idx = row * n + col, row 0 = the top edge, col 0 = the left edge when
 *     looking toward the top edge.
 * The UI labels the same cells R1… / C1….
 */

/** Cells per side unless a quadrat says otherwise (10 × 10 cm at 1 m). */
export const DEFAULT_GRID_N = 10;

export function emptyMask(size: number): string {
  return '0'.repeat(size);
}

export function isMask(s: string | null | undefined, size: number): s is string {
  return typeof s === 'string' && s.length === size && /^[01]*$/.test(s);
}

export function getBit(mask: string, idx: number): boolean {
  return mask.charCodeAt(idx) === 49; // '1'
}

/** Set one or many indices to `on`. Returns the same string when nothing changed. */
export function setBits(mask: string, indices: Iterable<number>, on: boolean): string {
  const chars = mask.split('');
  const v = on ? '1' : '0';
  let changed = false;
  for (const i of indices) {
    if (i < 0 || i >= chars.length) throw new RangeError(`index ${i} outside mask of ${chars.length}`);
    if (chars[i] !== v) {
      chars[i] = v;
      changed = true;
    }
  }
  return changed ? chars.join('') : mask;
}

export function fillMask(size: number, on: boolean): string {
  return (on ? '1' : '0').repeat(size);
}

export function popcount(mask: string | null | undefined): number {
  if (!mask) return 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask.charCodeAt(i) === 49) n++;
  return n;
}

export function indicesOf(mask: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask.charCodeAt(i) === 49) out.push(i);
  return out;
}

export function rowCol(idx: number, n: number): { row: number; col: number } {
  return { row: Math.floor(idx / n), col: idx % n };
}

/** UI label, 1-based: "R1 · C1". */
export function rcLabel(idx: number, n: number = DEFAULT_GRID_N): string {
  const { row, col } = rowCol(idx, n);
  return `R${row + 1} · C${col + 1}`;
}
