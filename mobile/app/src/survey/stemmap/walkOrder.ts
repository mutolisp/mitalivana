/**
 * The order trees are visited inside a quadrat — what "next tree" follows on a
 * recensus.
 *
 * Condit (1998) Fig. 2.2.2 (book p.45, PDF p.56): work "always proceeds in a
 * clockwise direction, within each subquadrat, within 10 x 10 m regions, and
 * within the 20 x 20 m quadrat". Read off the figure's arrows: the four
 * 10 × 10 m regions go lower-left, upper-left, upper-right, lower-right, and
 * inside each region the four subquadrats go the same way — 1,1 → 1,2 → 2,2 →
 * 2,1 → 1,3 → 1,4 → 2,4 → 2,3 → 3,3 → … → 4,1. Inside a subquadrat the loop
 * starts at its lower-left and runs up the left side.
 *
 * App's rules where the figure is silent: the same quadrant recursion for any
 * power-of-two subquadrat count; other counts walk the columns up and down
 * (serpentine) from the lower left; trees inside one subquadrat are ordered by
 * their clockwise angle round its centre, starting from the lower-left.
 *
 * Pure: check:stemmap runs it under Node.
 */
import { fgQuadratCounts, subquadratOf, type FrameGeometry } from './coords';

export type SubCell = { i: number; j: number };

function quadrants(n: number, offI: number, offJ: number, out: SubCell[]): void {
  if (n === 1) {
    out.push({ i: offI + 1, j: offJ + 1 });
    return;
  }
  const h = n / 2;
  quadrants(h, offI, offJ, out); // lower-left
  quadrants(h, offI, offJ + h, out); // upper-left
  quadrants(h, offI + h, offJ + h, out); // upper-right
  quadrants(h, offI + h, offJ, out); // lower-right
}

const isPowerOfTwo = (n: number) => n >= 1 && (n & (n - 1)) === 0;

/** Subquadrats of one quadrat in walking order. */
export function subquadratOrder(perSide: number): SubCell[] {
  const out: SubCell[] = [];
  if (isPowerOfTwo(perSide)) {
    quadrants(perSide, 0, 0, out);
    return out;
  }
  for (let i = 1; i <= perSide; i++) {
    for (let k = 1; k <= perSide; k++) out.push({ i, j: i % 2 === 1 ? k : perSide + 1 - k });
  }
  return out;
}

/** Sort key of a tree inside its quadrat: [subquadrat rank, clockwise angle]. */
export function walkKey(localX: number, localY: number, f: FrameGeometry): [number, number] {
  const n = fgQuadratCounts(f).subPerSide;
  const order = subquadratOrder(n);
  const { i, j } = subquadratOf(localX, localY, f);
  const rank = order.findIndex((c) => c.i === i && c.j === j);
  const cx = (i - 0.5) * f.subquadratM;
  const cy = (j - 0.5) * f.subquadratM;
  // Compass-style angle round the subquadrat centre (0 = up, clockwise),
  // shifted so the lower-left direction (225°) comes first.
  const compass = (Math.atan2(localX - cx, localY - cy) * 180) / Math.PI;
  const angle = (((compass - 225) % 360) + 360) % 360;
  return [rank, angle];
}

export function sortByWalk<T extends { localX: number; localY: number }>(items: readonly T[], f: FrameGeometry): T[] {
  const keyed = items.map((it) => ({ it, k: walkKey(it.localX, it.localY, f) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
  return keyed.map((e) => e.it);
}
