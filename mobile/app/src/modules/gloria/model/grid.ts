/**
 * Cell and point masks — pure.
 *
 * A mask is a fixed-length string of '0' / '1', one character per cell (or
 * per point). NULL in the DB means the method was not done; an all-'0' mask
 * means it was done and nothing was found. Keeping the two apart is the
 * reason for strings over a normalised row per cell.
 *
 * Index is fixed to the ground, never to the order anyone walked:
 *     idx = row * N + col, row 0 = top (uphill, toward the summit),
 *     col 0 = left edge when looking toward the summit.
 *
 * The 1×1 m frequency frame (Form 5-S, manual p.121) numbers rows 1..0 from
 * top to bottom and columns 1..0 from left to right, and the Taiwan sheet
 * names its columns f{row}{col} (f11 … f00). With that numbering the sheet's
 * column order is exactly idx order, so `fColumn(idx)` is the only mapping.
 * The UI labels the same cells R1–R10 / C1–C10.
 */

// The mask functions are shared with the fixed plot's quadrats (src/lib/grid.ts);
// what stays here is GLORIA's own: the 10 × 10 sheet columns and point surfaces.
export {
  emptyMask,
  fillMask,
  getBit,
  indicesOf,
  isMask,
  popcount,
  rcLabel,
  rowCol,
  setBits,
} from '../../../lib/grid';
import { rowCol } from '../../../lib/grid';

export const QUADRAT_N = 10; // 10 × 10 frequency cells / point-frame crosshairs
export const SQUARE_N = 20; // 20 lines × 20 points in a 10×10 m square

/** Sheet 13_/14_ column name for a 10×10 cell: idx 0 → f11, 9 → f10, 90 → f01, 99 → f00. */
export function fColumn(idx: number): string {
  if (!Number.isInteger(idx) || idx < 0 || idx >= QUADRAT_N * QUADRAT_N) throw new RangeError(`cell ${idx}`);
  const { row, col } = rowCol(idx, QUADRAT_N);
  return `f${(row + 1) % 10}${(col + 1) % 10}`;
}

/** f11 … f00 in sheet column order (= idx order). */
export const F_COLUMNS: readonly string[] = Array.from({ length: QUADRAT_N * QUADRAT_N }, (_, i) => fColumn(i));

/** Inverse of `fColumn`. */
export function fColumnIndex(name: string): number {
  const m = /^f(\d)(\d)$/.exec(name);
  if (!m) throw new RangeError(`not an f-column: ${name}`);
  const row = (Number(m[1]) + 9) % 10;
  const col = (Number(m[2]) + 9) % 10;
  return row * QUADRAT_N + col;
}

// ── Point surfaces ────────────────────────────────────────────────────────

/**
 * One character per point for what the pin hit when no vascular plant was
 * hit (manual p.41 Work Step J, p.58 §5.3.1). '.' = not yet visited,
 * '-' = a vascular plant was hit (the surface below is not recorded).
 */
export const SURFACE_CODES = ['R', 'S', 'L', 'B', 'G', 'T'] as const;
export type SurfaceCode = (typeof SURFACE_CODES)[number];
export const SURFACE_UNVISITED = '.';
export const SURFACE_VASCULAR = '-';

/** Surface code → the sheet's surface-type suffix. */
export const SURFACE_NAMES: Record<SurfaceCode, string> = {
  R: 'SolidRock',
  S: 'Scree',
  L: 'LichensOnSoil',
  B: 'BryOnSoil',
  G: 'Bareground',
  T: 'Litter',
};

export function emptySurface(size: number): string {
  return SURFACE_UNVISITED.repeat(size);
}

export function setSurface(surface: string, idx: number, code: string): string {
  if (idx < 0 || idx >= surface.length) throw new RangeError(`point ${idx}`);
  return surface.slice(0, idx) + code + surface.slice(idx + 1);
}

/** Points already recorded (anything but '.'). */
export function visitedCount(surface: string | null | undefined): number {
  if (!surface) return 0;
  let n = 0;
  for (const ch of surface) if (ch !== SURFACE_UNVISITED) n++;
  return n;
}

/** Hits per surface type over visited points. */
export function surfaceHits(surface: string | null | undefined): Record<SurfaceCode, number> {
  const out = { R: 0, S: 0, L: 0, B: 0, G: 0, T: 0 } as Record<SurfaceCode, number>;
  if (!surface) return out;
  for (const ch of surface) if (ch in out) out[ch as SurfaceCode] += 1;
  return out;
}
