/**
 * The photo checklist of one survey — Form 1's photo checkboxes. Pure.
 *
 * Obligatory (manual §4.4, Work Steps O–S; Box 4.4 "Mark the photo checkboxes
 * in Forms 1 and 4"), plus the project's own Form 1 items (hp, 5mp):
 *   CL-N…W        3×3 m quadrat cluster overview           (WS Q; item code N/E/S/W)
 *   N11:bare      1-m² quadrat top view, frame not mounted  (WS P)
 *   N11:hp        the same with the pointing frame          (project Form 1 "hp")
 *   P5M-N         the p5m corner pole of a direction        (project Form 1 "5mp")
 *   P10M-N        p10m-N pole                               (WS R)
 *   pNE-5 …       intersection-line poles                   (WS R)
 *   HSP           highest summit point                      (WS O)
 *   SU-OV         entire summit                             (WS S)
 * Optional (WS P "each quarter of a quadrat may be taken additionally"):
 *   N11:UL / UR / LL / LR
 *
 * An item is done when ticked or when it has a photo. Where the photo lives:
 * `point` columns of gloria_points, the survey's overview_photos, or the
 * checklist row itself.
 */
import { CORNERS, DIAGONALS, DIRECTIONS, QUADRAT_CODES, type Direction, type P5mCorner } from './units';

export const QUARTERS = ['UL', 'UR', 'LL', 'LR'] as const;

export type PhotoSource =
  | { kind: 'point'; key: string; col: 'photo_m2' | 'photo_m2f' | 'photo_point' }
  | { kind: 'p5m'; direction: Direction } // the photo_point of whichever corner is p5m
  | { kind: 'overview' }
  | { kind: 'own' };

export type PhotoItem = {
  item: string;
  required: boolean;
  source: PhotoSource;
  /** Annex III element 5 (item code) and element 8 (detail), for the export name. */
  code: string;
  note?: string;
};

export function photoItems(): PhotoItem[] {
  const out: PhotoItem[] = [];
  for (const d of DIRECTIONS) {
    out.push({ item: `CL-${d}`, required: true, source: { kind: 'own' }, code: d });
    for (const c of CORNERS) {
      const q = d + c;
      out.push({ item: `${q}:bare`, required: true, source: { kind: 'point', key: q, col: 'photo_m2' }, code: q });
      out.push({ item: `${q}:hp`, required: true, source: { kind: 'point', key: q, col: 'photo_m2f' }, code: q, note: 'hp' });
      for (const x of QUARTERS) out.push({ item: `${q}:${x}`, required: false, source: { kind: 'own' }, code: q, note: x });
    }
    out.push({ item: `P5M-${d}`, required: true, source: { kind: 'p5m', direction: d }, code: `p5m-${d}` });
    out.push({ item: `P10M-${d}`, required: true, source: { kind: 'point', key: `${d}10m`, col: 'photo_point' }, code: `p10m-${d}` });
  }
  for (const g of DIAGONALS)
    for (const n of ['5', '10'])
      out.push({ item: `p${g}-${n}`, required: true, source: { kind: 'point', key: `${g}${n}`, col: 'photo_point' }, code: `p${g}-${n}` });
  out.push({ item: 'HSP', required: true, source: { kind: 'own' }, code: 'HSP' });
  out.push({ item: 'SU-OV', required: true, source: { kind: 'overview' }, code: 'SU-OV' });
  return out;
}

export type CheckRow = { item: string; checked: number; photo_uri: string | null };
export type PointPhotos = { point_key: string; is_p5m: number; photo_m2: string | null; photo_m2f: string | null; photo_point: string | null };

/** The photo an item has, from wherever it is stored. */
export function photoOf(
  it: PhotoItem,
  ctx: { checks: Map<string, CheckRow>; points: Map<string, PointPhotos>; p5m: Partial<Record<Direction, P5mCorner>>; overviewCount: number },
): string | null {
  const s = it.source;
  if (s.kind === 'own') return ctx.checks.get(it.item)?.photo_uri ?? null;
  if (s.kind === 'overview') return ctx.overviewCount > 0 ? 'overview' : null;
  if (s.kind === 'p5m') {
    const c = ctx.p5m[s.direction];
    return c ? (ctx.points.get(s.direction + c)?.photo_point ?? null) : null;
  }
  return ctx.points.get(s.key)?.[s.col] ?? null;
}

export type ItemState = { item: PhotoItem; checked: boolean; photo: string | null; done: boolean };

export function checklistState(input: {
  checks: CheckRow[];
  points: PointPhotos[];
  overviewCount: number;
}): { items: ItemState[]; required: { done: number; total: number }; optional: { done: number; total: number } } {
  const checks = new Map(input.checks.map((c) => [c.item, c]));
  const points = new Map(input.points.map((p) => [p.point_key, p]));
  const p5m: Partial<Record<Direction, P5mCorner>> = {};
  for (const p of input.points) if (p.is_p5m) p5m[p.point_key[0] as Direction] = p.point_key.slice(1) as P5mCorner;
  const ctx = { checks, points, p5m, overviewCount: input.overviewCount };
  const items = photoItems().map((item) => {
    const checked = checks.get(item.item)?.checked === 1;
    const photo = photoOf(item, ctx);
    return { item, checked, photo, done: checked || photo != null };
  });
  const count = (req: boolean) => {
    const xs = items.filter((i) => i.item.required === req);
    return { done: xs.filter((i) => i.done).length, total: xs.length };
  };
  return { items, required: count(true), optional: count(false) };
}

/** The checklist as a table for the export (one row per item, checklist order). */
export const CHECKLIST_HEADER = ['item', 'itemCode', 'detail', 'required', 'checked', 'photoInApp', 'done'] as const;
export function checklistRows(items: ItemState[]): string[][] {
  const tf = (b: boolean) => (b ? 'TRUE' : 'FALSE');
  return items.map((s) => [s.item.item, s.item.code, s.item.note ?? '', tf(s.item.required), tf(s.checked), tf(s.photo != null), tf(s.done)]);
}

/** Items that sit on the quadrat row of the checklist, in column order. */
export const QUADRAT_COLUMNS = ['bare', 'hp', ...QUARTERS] as const;
export { QUADRAT_CODES };
