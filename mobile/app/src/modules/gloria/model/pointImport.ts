/**
 * Measurement points (distance, compass, which corner is p5m) from a table —
 * a download of sheet 02_ works, but only these columns matter
 * (case, spaces and underscores ignored):
 *
 *   point | pointNumber | point_key      N11, p-N11, p5m-N31, N10m, p10m-N, NE5, pNE-5, NE-5
 *   direction | aspect                   optional: with it, point may be just 11 / 31 / 10m / 5 / 10
 *   distance | distance_m                metres from the HSP
 *   compassDirection | compass | bearing | azimuth
 *   p5m                                  optional TRUE/1/yes; a "p5m-" prefix on the point also counts
 *   mocy                                 optional
 *   fullSummitCode | code, or country + targetRegion + summit   optional
 *   comments | comment | notes           optional
 *
 * Pure. The screen keeps the rows of one summit and one cycle and compares
 * them with the survey's stored points.
 */
import { POINTS, type Direction, type P5mCorner } from './units';

export type ImportedPoint = {
  line: number;
  full_code: string | null;
  mocy: number | null;
  key: string;
  /** true / false from the file; null when the file does not say. */
  p5m: boolean | null;
  distance_m: number | null;
  compass_deg: number | null;
  comments: string | null;
};
export type PointProblem = { line: number; message: string; value?: string };

type Field = 'point' | 'direction' | 'distance' | 'compass' | 'p5m' | 'mocy' | 'full_code' | 'country' | 'region' | 'summit' | 'comments';
const ALIASES: Record<string, Field> = {
  point: 'point',
  pointnumber: 'point',
  pointkey: 'point',
  pointcode: 'point',
  direction: 'direction',
  aspect: 'direction',
  distance: 'distance',
  distancem: 'distance',
  compassdirection: 'compass',
  compass: 'compass',
  compassdeg: 'compass',
  bearing: 'compass',
  azimuth: 'compass',
  p5m: 'p5m',
  mocy: 'mocy',
  fullsummitcode: 'full_code',
  fullcode: 'full_code',
  code: 'full_code',
  country: 'country',
  targetregion: 'region',
  summit: 'summit',
  comments: 'comments',
  comment: 'comments',
  notes: 'comments',
  note: 'comments',
};
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const KEYS = new Set(POINTS.map((p) => p.key));

/** Any accepted spelling → the app's point key, plus whether it says p5m. */
export function pointKeyOf(raw: string, direction = ''): { key: string; p5m: boolean } | null {
  let s = raw.trim().toUpperCase().replace(/\s+/g, '');
  const p5m = /^P5M-/.test(s);
  s = s.replace(/^P5M-|^P-/, '').replace(/^P(?=10M-)/, '');
  const dir = direction.trim().toUpperCase();
  let m: RegExpExecArray | null;
  if ((m = /^10M-([NESW])$/.exec(s))) s = `${m[1]}10M`; // p10m-N
  else if ((m = /^P?(NE|SE|SW|NW)-?(5|10)$/.exec(s))) s = `${m[1]}${m[2]}`; // pNE-5, NE-5
  else if (dir && /^(11|31|33|13|10M|5|10)$/.test(s)) s = dir + s; // direction column + point
  s = s.replace(/10M$/, '10m');
  return KEYS.has(s) ? { key: s, p5m } : null;
}

export function tableToPoints(table: string[][]): { rows: ImportedPoint[]; problems: PointProblem[] } {
  const h = table.findIndex((r) => r.some((c) => ALIASES[key(c)] === 'point'));
  if (h < 0) return { rows: [], problems: [{ line: 1, message: 'noPointHeader' }] };
  const col = new Map<Field, number>();
  table[h].forEach((c, i) => {
    const f = ALIASES[key(c)];
    if (f && !col.has(f)) col.set(f, i);
  });
  const rows: ImportedPoint[] = [];
  const problems: PointProblem[] = [];
  const seen = new Set<string>();
  for (let r = h + 1; r < table.length; r++) {
    const line = r + 1;
    const get = (f: Field) => (col.has(f) ? (table[r][col.get(f)!] ?? '').trim() : '');
    const rawPoint = get('point');
    if (!rawPoint) continue;
    const pk = pointKeyOf(rawPoint, get('direction'));
    if (!pk) {
      problems.push({ line, message: 'badPoint', value: rawPoint });
      continue;
    }
    const full =
      get('full_code').toUpperCase() ||
      (get('country') && get('region') && get('summit') ? `${get('country')}-${get('region')}-${get('summit')}`.toUpperCase() : '');
    const mocyRaw = get('mocy');
    const mocy = mocyRaw ? Number(mocyRaw) : null;
    if (mocy != null && !(Number.isInteger(mocy) && mocy >= 1)) {
      problems.push({ line, message: 'badMocy', value: mocyRaw });
      continue;
    }
    const num = (f: Field, min: number, max: number): number | null | 'bad' => {
      const v = get(f).replace(',', '.');
      if (!v || /^(NA|N\/A|-)$/i.test(v)) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : 'bad';
    };
    const dist = num('distance', 0, 1000);
    const comp = num('compass', 0, 360);
    if (dist === 'bad' || comp === 'bad') {
      if (dist === 'bad') problems.push({ line, message: 'badDistance', value: get('distance') });
      if (comp === 'bad') problems.push({ line, message: 'badCompass', value: get('compass') });
      continue;
    }
    const id = `${full}|${mocy ?? ''}|${pk.key}`;
    if (seen.has(id)) {
      problems.push({ line, message: 'duplicatePoint', value: `${full ? `${full} ` : ''}${pk.key}` });
      continue;
    }
    seen.add(id);
    const flag = get('p5m').toLowerCase();
    const p5m = pk.p5m || /^(true|1|yes|y|v|✓)$/.test(flag) ? true : /^(false|0|no|n)$/.test(flag) ? false : null;
    rows.push({ line, full_code: full || null, mocy, key: pk.key, p5m, distance_m: dist, compass_deg: comp, comments: get('comments') || null });
  }
  return { rows, problems };
}

/** The rows for one summit (rows without a code count as this summit), grouped by cycle. */
export function rowsBySummitCycle(rows: ImportedPoint[], fullCode: string): { cycles: Array<number | null>; other: number; of: (m: number | null) => ImportedPoint[] } {
  const mine = rows.filter((r) => r.full_code == null || r.full_code === fullCode);
  const cycles = [...new Set(mine.map((r) => r.mocy))].sort((a, b) => (b ?? 0) - (a ?? 0));
  return { cycles, other: rows.length - mine.length, of: (m) => mine.filter((r) => r.mocy === m || r.mocy == null) };
}

export type StoredPoint = { id: number; point_key: string; is_p5m: number; distance_m: number | null; compass_deg: number | null; comments: string | null };
export type PointChange = { field: 'distance_m' | 'compass_deg' | 'comments'; from: unknown; to: unknown };
export type PointDiff = { key: string; id: number; fill: boolean; changes: PointChange[] };
export type P5mDiff = { direction: Direction; from: P5mCorner | null; to: P5mCorner };

/**
 * Compare with the stored points. A point whose changed fields were all empty
 * is a "fill" (safe to take); one that overwrites values is not. Blank cells
 * never clear. p5m per direction comes from the rows that say which corner is
 * p5m; a direction naming both 11 and 31 is a problem, not a change.
 */
export function diffPoints(stored: StoredPoint[], rows: ImportedPoint[]): { points: PointDiff[]; p5m: P5mDiff[]; problems: PointProblem[] } {
  const byKey = new Map(stored.map((p) => [p.point_key, p]));
  const points: PointDiff[] = [];
  for (const r of rows) {
    const s = byKey.get(r.key);
    if (!s) continue;
    const changes: PointChange[] = (['distance_m', 'compass_deg', 'comments'] as const)
      .filter((f) => r[f] != null && r[f] !== s[f])
      .map((f) => ({ field: f, from: s[f], to: r[f] }));
    if (changes.length) points.push({ key: r.key, id: s.id, fill: changes.every((c) => c.from == null), changes });
  }
  const p5m: P5mDiff[] = [];
  const problems: PointProblem[] = [];
  for (const d of ['N', 'E', 'S', 'W'] as Direction[]) {
    const said = rows.filter((r) => r.p5m === true && (r.key === `${d}11` || r.key === `${d}31`));
    if (said.length > 1) {
      problems.push({ line: said[1].line, message: 'twoP5m', value: d });
      continue;
    }
    if (!said.length) continue;
    const to = said[0].key.slice(1) as P5mCorner;
    const now = stored.find((p) => p.is_p5m && (p.point_key === `${d}11` || p.point_key === `${d}31`));
    const from = now ? (now.point_key.slice(1) as P5mCorner) : null;
    if (from !== to) p5m.push({ direction: d, from, to });
  }
  return { points, p5m, problems };
}
