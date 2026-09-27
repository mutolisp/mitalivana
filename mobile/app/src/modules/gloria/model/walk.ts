/**
 * Walking order for point-intercept recording — pure.
 *
 * Storage is canonical (see grid.ts); a walk only maps the order points are
 * visited to storage indices, so changing the walk option after points are
 * recorded never scrambles data, and two surveys with different options stay
 * comparable.
 *
 * 1×1 m point-framing (manual p.41, Work Step J): 10 × 10 crosshairs. The
 * manual prescribes no order; we visit row by row from the top-left, same
 * as the frequency frame. Canonical idx = row * 10 + col (grid.ts).
 *
 * 10×10 m square (manual p.57–58, §5.3.1): 20 lines × 20 points, 0.25 m in
 * from the boundary, 0.5 m apart, each line walked from the end where the
 * previous one finished (boustrophedon). The square sits as a diamond on the
 * slope (corners uphill / downhill along the principal measurement line), so
 * its canonical frame is its own two lower edges:
 *     idx = a * 20 + b
 *     a = 0..19: distance from the lower-LEFT edge  = 0.25 + 0.5a m
 *     b = 0..19: distance from the lower-RIGHT edge = 0.25 + 0.5b m
 * (left / right as seen looking toward the summit).
 *
 * Manual p.57: "you can start with the first line from any of the four
 * corners in either of the two possible directions. It is more comfortable,
 * however, to work uphill; therefore only four options remain, which are
 * illustrated on Form 6-S … On the first line start in the direction as
 * indicated on the marked sketch, and begin the next line from the opposite
 * [end]". The Form 6-S sketch (HSP at the top corner) shows, left to right,
 * the start line on each of the four edges, walked uphill:
 *   1  upper-left edge,  left corner → top corner    (b fixed at the far end)
 *   2  lower-right edge, bottom corner → right corner (b fixed at 0)
 *   3  upper-right edge, right corner → top corner    (a fixed at the far end)
 *   4  lower-left edge,  bottom corner → left corner  (a fixed at 0)
 * Every first line runs with the free coordinate rising from 0; the next
 * lines step 0.5 m across the square and alternate direction.
 */

import { SQUARE_N } from './grid';

export type WalkOption = 1 | 2 | 3 | 4;
export const WALK_OPTIONS: readonly WalkOption[] = [1, 2, 3, 4];

/** Which coordinate a line keeps fixed, and whether the lines start at its far end (Form 6-S). */
export const WALK_OPTION_INFO: Record<WalkOption, { fixed: 'a' | 'b'; fromFar: boolean }> = {
  1: { fixed: 'b', fromFar: true },
  2: { fixed: 'b', fromFar: false },
  3: { fixed: 'a', fromFar: true },
  4: { fixed: 'a', fromFar: false },
};

/** Visit order → canonical index, for an N×N frame. `option` null = row-major (1×1 m frame). */
export function walkOrder(n: number, option: WalkOption | null): number[] {
  const out: number[] = [];
  if (option == null) {
    for (let i = 0; i < n * n; i++) out.push(i);
    return out;
  }
  const { fixed, fromFar } = WALK_OPTION_INFO[option];
  for (let line = 0; line < n; line++) {
    const across = fromFar ? n - 1 - line : line;
    const forward = line % 2 === 0; // the first line uphill, then back and forth
    for (let j = 0; j < n; j++) {
      const along = forward ? j : n - 1 - j;
      out.push(fixed === 'b' ? along * n + across : across * n + along);
    }
  }
  return out;
}

/** 1-based line / point of a visit position. */
export function linePoint(seq: number, n: number): { line: number; point: number } {
  return { line: Math.floor(seq / n) + 1, point: (seq % n) + 1 };
}

/** Hits of one mask on each line, in walking order. */
export function lineHits(mask: string, order: readonly number[], n: number): number[] {
  const out = new Array<number>(n).fill(0);
  order.forEach((idx, seq) => {
    if (mask.charCodeAt(idx) === 49) out[Math.floor(seq / n)] += 1;
  });
  return out;
}

/**
 * Percent cover from hits. 100 crosshairs: hits = %. 400 points:
 * "percent species cover = strokes per species/4" (p.58).
 */
export function coverFromHits(hits: number, points: number): number {
  return (hits * 100) / points;
}

export function isSquareSize(len: number): boolean {
  return len === SQUARE_N * SQUARE_N;
}
