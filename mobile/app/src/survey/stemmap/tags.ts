/**
 * Tree tags and stem tags (docs/planned/Modular_survey.md §5.4).
 *
 * - A stem's tag is `<tree tag>-<stem number>` (1-1, 1-2, 2-1); stem numbers
 *   never change.
 * - New trees take numbers from their TAG BLOCK's range. Tag blocks are fixed
 *   when the plot is created (they follow the physical tags) and are separate
 *   from sync blocks. Blocks are numbered column-first from the lower left,
 *   following Condit's per-column tag sequences (10,000 tags per column, book
 *   p.46, PDF p.57).
 * - Two records with one tag are the same tree unless they are more than 1 m
 *   apart (Condit treats a shift of 1 m or more as a mismapping to correct,
 *   book p.86, PDF p.97) or carry different species.
 *
 * Pure: check:stemmap runs it under Node.
 */
import { fgQuadratCounts, type FrameGeometry, type XY } from './coords';

export function formatStemTag(treeTag: string, stemNo: number): string {
  return `${treeTag}-${stemNo}`;
}

export function parseStemTag(tag: string): { tree: string; stem: number } | null {
  const m = /^(.+)-(\d+)$/.exec(tag.trim());
  return m ? { tree: m[1], stem: Number(m[2]) } : null;
}

/** Tag block of a plot position. `blockQuadrats` = block edge in quadrats. */
export function tagBlockIndex(p: XY, f: FrameGeometry, blockQuadrats: number): number {
  const { cols, rows } = fgQuadratCounts(f);
  const blockCols = Math.ceil(cols / blockQuadrats);
  const blockRows = Math.ceil(rows / blockQuadrats);
  const side = blockQuadrats * f.quadratM;
  const bc = Math.min(blockCols - 1, Math.max(0, Math.floor(p.x / side + 1e-9)));
  const br = Math.min(blockRows - 1, Math.max(0, Math.floor(p.y / side + 1e-9)));
  return bc * blockRows + br;
}

export function tagRange(block: number, rangeSize: number): { first: number; last: number } {
  return { first: block * rangeSize + 1, last: (block + 1) * rangeSize };
}

/** The lowest unused number in a block's range, or null when the range is full. */
export function nextFreeTag(block: number, rangeSize: number, used: Iterable<string | number>): number | null {
  const { first, last } = tagRange(block, rangeSize);
  const taken = new Set<number>();
  for (const t of used) {
    const n = typeof t === 'number' ? t : /^\d+$/.test(t.trim()) ? Number(t) : NaN;
    if (Number.isInteger(n) && n >= first && n <= last) taken.add(n);
  }
  for (let n = first; n <= last; n++) if (!taken.has(n)) return n;
  return null;
}

export const SAME_TREE_MAX_M = 1;

/** Two records carrying one tag: are they evidently different trees? */
export function tagConflict(a: XY & { taxonId: string }, b: XY & { taxonId: string }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > SAME_TREE_MAX_M || a.taxonId !== b.taxonId;
}
