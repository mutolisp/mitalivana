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
 * "It is more comfortable to work uphill; therefore only four options
 * remain, which are illustrated on Form 6-S" (p.57). Form 6-S shows them as
 * diagrams only; our reading: the first line runs along one of the two lower
 * edges, starting at one of its two ends, and each following line is 0.5 m
 * further uphill.
 */

import { SQUARE_N } from './grid';

export type WalkOption = 1 | 2 | 3 | 4;
export const WALK_OPTIONS: readonly WalkOption[] = [1, 2, 3, 4];

export const WALK_OPTION_INFO: Record<WalkOption, { edge: 'lower-left' | 'lower-right'; start: 'bottom' | 'side' }> = {
  1: { edge: 'lower-left', start: 'bottom' },
  2: { edge: 'lower-left', start: 'side' },
  3: { edge: 'lower-right', start: 'bottom' },
  4: { edge: 'lower-right', start: 'side' },
};

/** Visit order → canonical index, for an N×N frame. `option` null = row-major (1×1 m frame). */
export function walkOrder(n: number, option: WalkOption | null): number[] {
  const out: number[] = [];
  if (option == null) {
    for (let i = 0; i < n * n; i++) out.push(i);
    return out;
  }
  const { edge, start } = WALK_OPTION_INFO[option];
  for (let line = 0; line < n; line++) {
    const forward = (line % 2 === 0) === (start === 'bottom');
    for (let j = 0; j < n; j++) {
      const along = forward ? j : n - 1 - j;
      // Lines parallel to the lower-left edge keep `a` fixed; to the lower-right edge keep `b` fixed.
      out.push(edge === 'lower-left' ? line * n + along : along * n + line);
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
