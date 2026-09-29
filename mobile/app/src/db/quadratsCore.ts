/**
 * Fixed-plot 1×1 m quadrats (06-plot-quadrats.md §2, v77), the rules without
 * the app's connection: every function takes `db`, so scripts/check-quadrats.mjs
 * runs them under node:sqlite against the real migrations. The app calls them
 * through src/db/quadrats.ts.
 *
 * Rules kept here, not in the screens:
 *   - the quadrat count follows the layout (corners + centre, one per subplot,
 *     …); shrinking removes only quadrats that hold nothing;
 *   - once a quadrat holds data its size, grid and top edge are fixed — the
 *     masks are indexed on the ground by them;
 *   - a locked quadrat ("完成並鎖定") takes no edit until it is unlocked;
 *   - cover is NULL (not estimated) or in (0, 100] — 0 is a delete, not a value;
 *     a frequency mask is NULL (not done) or exactly grid_n² cells; a count is
 *     0..grid_n².
 * Every write stamps the quadrat and its plot, so versions and sync see it.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { DEFAULT_GRID_N, isMask } from '../lib/grid';

export type QuadratDb = {
  executeSync: (sql: string, params?: Scalar[]) => { rows?: unknown[]; insertId?: number };
};

export type QuadratLayout = 'cornersCenter' | 'perSubplot' | 'diagonal' | 'custom';
export type TopEdge = 'N' | 'E' | 'S' | 'W' | 'upslope';
export type FreqMode = 'cells' | 'count';

export const TOP_EDGES: readonly TopEdge[] = ['N', 'E', 'S', 'W', 'upslope'];
export const MIN_GRID_N = 2;
export const MAX_GRID_N = 10;
export const MIN_QUADRATS = 1;
export const MAX_QUADRATS = 25;

/** plot_surveys.quadrat_config: settings only, never data. sizeM / gridN /
 *  topEdge are the defaults a NEW quadrat starts with. */
export type QuadratConfig = {
  enabled: boolean;
  layout: QuadratLayout;
  recordCover: boolean;
  recordFreq: boolean;
  recordSurface: boolean;
  carryPrevious: boolean;
  sizeM: number;
  gridN: number;
  topEdge: TopEdge;
};

export const DEFAULT_QUADRAT_CONFIG: QuadratConfig = {
  enabled: false,
  layout: 'cornersCenter',
  recordCover: true,
  recordFreq: true,
  recordSurface: true,
  carryPrevious: false,
  sizeM: 1,
  gridN: DEFAULT_GRID_N,
  topEdge: 'N',
};

export const SURFACE_COLUMNS = [
  'cov_vascular',
  'cov_solid_rock',
  'cov_scree',
  'cov_lichens',
  'cov_bryophytes',
  'cov_bare_ground',
  'cov_litter',
] as const;
export type SurfaceColumn = (typeof SURFACE_COLUMNS)[number];

export type Quadrat = {
  id: number;
  uuid: string;
  plot_survey_id: number;
  subplot_id: number | null;
  idx: number;
  label: string;
  position: string | null;
  size_m: number;
  grid_n: number;
  top_edge: TopEdge;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  freq_mode: FreqMode;
  locked: 0 | 1;
  started_at: number | null;
  ended_at: number | null;
  notes: string | null;
  photo_paths: string | null;
  created_at: number;
  updated_at: number;
} & Record<SurfaceColumn, number | null>;

export type QuadratSpecies = {
  id: number;
  quadrat_id: number;
  taxon_id: string;
  cover_pct: number | null;
  freq_cells: string | null;
  freq_count: number | null;
  height_cm: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

/** A refused write; `code` is what the screen explains. */
export type QuadratErrorCode = 'locked' | 'geometry-locked' | 'invalid';
export class QuadratError extends Error {
  code: QuadratErrorCode;
  constructor(code: QuadratErrorCode) {
    super(`quadrat: ${code}`);
    this.code = code;
  }
}

const num = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

/** Read the stored JSON; anything missing or malformed falls back to the default. */
export function parseQuadratConfig(json: string | null | undefined): QuadratConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = json ? JSON.parse(json) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // Malformed: the defaults.
  }
  const d = DEFAULT_QUADRAT_CONFIG;
  const bool = (k: keyof QuadratConfig) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean));
  return {
    enabled: bool('enabled'),
    layout: (['cornersCenter', 'perSubplot', 'diagonal', 'custom'] as const).includes(o.layout as QuadratLayout)
      ? (o.layout as QuadratLayout)
      : d.layout,
    recordCover: bool('recordCover'),
    recordFreq: bool('recordFreq'),
    recordSurface: bool('recordSurface'),
    carryPrevious: bool('carryPrevious'),
    sizeM: num(o.sizeM, 0.01, 100, d.sizeM),
    gridN: Math.round(num(o.gridN, MIN_GRID_N, MAX_GRID_N, d.gridN)),
    topEdge: TOP_EDGES.includes(o.topEdge as TopEdge) ? (o.topEdge as TopEdge) : d.topEdge,
  };
}

const CORNERS_CENTER = ['NW', 'NE', 'C', 'SW', 'SE'];

/** Where quadrat `idx` (1-based) sits under a layout; null = the user names it. */
export function positionFor(layout: QuadratLayout, idx: number): string | null {
  return layout === 'cornersCenter' ? (CORNERS_CENTER[idx - 1] ?? null) : null;
}

function rows<T>(db: QuadratDb, sql: string, params: Scalar[] = []): T[] {
  return (db.executeSync(sql, params).rows ?? []) as T[];
}

function touch(db: QuadratDb, quadratId: number, now: number): void {
  db.executeSync(`UPDATE plot_quadrats SET updated_at = ? WHERE id = ?`, [now, quadratId]);
  db.executeSync(
    `UPDATE plot_surveys SET updated_at = ? WHERE id = (SELECT plot_survey_id FROM plot_quadrats WHERE id = ?)`,
    [now, quadratId],
  );
}

export function getQuadratConfig(db: QuadratDb, plotId: number): QuadratConfig {
  const r = rows<{ quadrat_config: string | null }>(db, `SELECT quadrat_config FROM plot_surveys WHERE id = ?`, [plotId]);
  return parseQuadratConfig(r[0]?.quadrat_config);
}

export function setQuadratConfig(db: QuadratDb, plotId: number, patch: Partial<QuadratConfig>, now: number): QuadratConfig {
  // Round-tripped through the parser so a bad patch value cannot be stored.
  const next = parseQuadratConfig(JSON.stringify({ ...getQuadratConfig(db, plotId), ...patch }));
  db.executeSync(`UPDATE plot_surveys SET quadrat_config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(next), now, plotId]);
  return next;
}

export function listQuadrats(db: QuadratDb, plotId: number): Quadrat[] {
  return rows<Quadrat>(db, `SELECT * FROM plot_quadrats WHERE plot_survey_id = ? ORDER BY idx`, [plotId]);
}

export function getQuadrat(db: QuadratDb, id: number): Quadrat | null {
  return rows<Quadrat>(db, `SELECT * FROM plot_quadrats WHERE id = ?`, [id])[0] ?? null;
}

/** Anything recorded in it: a species, a surface cover, a position, a note, a photo. */
export function quadratHasData(db: QuadratDb, id: number): boolean {
  const cov = SURFACE_COLUMNS.map((c) => `${c} IS NOT NULL`).join(' OR ');
  return (
    rows(
      db,
      `SELECT 1 FROM plot_quadrats q WHERE q.id = ? AND (
         EXISTS (SELECT 1 FROM plot_quadrat_species s WHERE s.quadrat_id = q.id)
         OR ${cov} OR lat IS NOT NULL OR notes IS NOT NULL OR photo_paths IS NOT NULL)`,
      [id],
    ).length > 0
  );
}

/** Add quadrat at the lowest free idx, placed by the plot's layout. */
export function addQuadrat(
  db: QuadratDb,
  plotId: number,
  uuid: string,
  now: number,
  opts: { subplotId?: number | null } = {},
): number {
  const cfg = getQuadratConfig(db, plotId);
  const taken = new Set(listQuadrats(db, plotId).map((q) => q.idx));
  let idx = 1;
  while (taken.has(idx)) idx++;
  const res = db.executeSync(
    `INSERT INTO plot_quadrats
       (uuid, plot_survey_id, subplot_id, idx, label, position, size_m, grid_n, top_edge, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, plotId, opts.subplotId ?? null, idx, `Q${idx}`, positionFor(cfg.layout, idx), cfg.sizeM, cfg.gridN, cfg.topEdge, now, now],
  );
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, plotId]);
  return Number(res.insertId ?? 0);
}

/**
 * Grow or shrink to `count` quadrats (1–25). Per-subplot places one in each
 * subplot, in subplot order. Shrinking removes empty quadrats from the end;
 * the ones holding data stay and are returned, so the screen can say why
 * the count did not fall.
 */
export function setQuadratCount(db: QuadratDb, plotId: number, count: number, now: number, newUuid: () => string): Quadrat[] {
  const cfg = getQuadratConfig(db, plotId);
  const want = Math.max(MIN_QUADRATS, Math.min(MAX_QUADRATS, Math.round(count)));
  const subplots = rows<{ id: number }>(db, `SELECT id FROM plot_subplots WHERE plot_survey_id = ? ORDER BY idx`, [plotId]);
  let have = listQuadrats(db, plotId);
  while (have.length < want) {
    const i = have.length;
    addQuadrat(db, plotId, newUuid(), now, { subplotId: cfg.layout === 'perSubplot' ? (subplots[i]?.id ?? null) : null });
    have = listQuadrats(db, plotId);
  }
  const kept: Quadrat[] = [];
  let left = have.length;
  for (const q of [...have].reverse()) {
    if (left <= want) break;
    if (quadratHasData(db, q.id)) {
      kept.push(q);
    } else {
      db.executeSync(`DELETE FROM plot_quadrats WHERE id = ?`, [q.id]);
      left--;
    }
  }
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, plotId]);
  return kept;
}

export type QuadratPatch = Partial<
  Pick<Quadrat, 'label' | 'position' | 'subplot_id' | 'size_m' | 'grid_n' | 'top_edge' | 'lat' | 'lng' | 'accuracy' | 'notes' | 'photo_paths'> &
    Record<SurfaceColumn, number | null>
>;

const GEOMETRY = ['size_m', 'grid_n', 'top_edge'] as const;

export function updateQuadrat(db: QuadratDb, id: number, patch: QuadratPatch, now: number): void {
  const q = getQuadrat(db, id);
  if (!q) return;
  if (q.locked) throw new QuadratError('locked');
  const changesGeometry = GEOMETRY.some((k) => k in patch && patch[k] !== q[k]);
  if (changesGeometry && quadratHasData(db, id)) throw new QuadratError('geometry-locked');
  if ('grid_n' in patch && !(Number.isInteger(patch.grid_n) && patch.grid_n! >= MIN_GRID_N && patch.grid_n! <= MAX_GRID_N)) {
    throw new QuadratError('invalid');
  }
  if ('size_m' in patch && !(typeof patch.size_m === 'number' && patch.size_m > 0)) throw new QuadratError('invalid');
  if ('top_edge' in patch && !TOP_EDGES.includes(patch.top_edge as TopEdge)) throw new QuadratError('invalid');
  if ('label' in patch && !patch.label?.trim()) throw new QuadratError('invalid');
  for (const c of SURFACE_COLUMNS) {
    const v = patch[c];
    if (v != null && !(v >= 0 && v <= 100)) throw new QuadratError('invalid');
  }
  const keys = Object.keys(patch) as (keyof QuadratPatch)[];
  if (keys.length === 0) return;
  db.executeSync(
    `UPDATE plot_quadrats SET ${keys.map((k) => `${k} = ?`).join(', ')},
       started_at = COALESCE(started_at, ?) WHERE id = ?`,
    [...keys.map((k) => (k === 'label' ? patch.label!.trim() : ((patch[k] ?? null) as Scalar))), now, id],
  );
  touch(db, id, now);
}

/** "完成並鎖定" and its undo from the ⋯ menu. Locking stamps ended_at once. */
export function setQuadratLocked(db: QuadratDb, id: number, locked: boolean, now: number): void {
  db.executeSync(
    `UPDATE plot_quadrats SET locked = ?, ended_at = CASE WHEN ? THEN COALESCE(ended_at, ?) ELSE ended_at END WHERE id = ?`,
    [locked ? 1 : 0, locked ? 1 : 0, now, id],
  );
  touch(db, id, now);
}

export function setFreqMode(db: QuadratDb, id: number, mode: FreqMode, now: number): void {
  const q = getQuadrat(db, id);
  if (!q) return;
  if (q.locked) throw new QuadratError('locked');
  db.executeSync(`UPDATE plot_quadrats SET freq_mode = ? WHERE id = ?`, [mode, id]);
  touch(db, id, now);
}

/** Delete a quadrat and its species (explicitly: foreign keys may be off). */
export function deleteQuadrat(db: QuadratDb, id: number, now: number): void {
  const q = getQuadrat(db, id);
  if (!q) return;
  db.executeSync(`DELETE FROM plot_quadrat_species WHERE quadrat_id = ?`, [id]);
  db.executeSync(`DELETE FROM plot_quadrats WHERE id = ?`, [id]);
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, q.plot_survey_id]);
}

export function listQuadratSpecies(db: QuadratDb, quadratId: number): QuadratSpecies[] {
  return rows<QuadratSpecies>(db, `SELECT * FROM plot_quadrat_species WHERE quadrat_id = ? ORDER BY created_at, id`, [quadratId]);
}

function unlockedQuadrat(db: QuadratDb, quadratId: number): Quadrat {
  const q = getQuadrat(db, quadratId);
  if (!q) throw new QuadratError('invalid');
  if (q.locked) throw new QuadratError('locked');
  return q;
}

/** Add a species to a quadrat; a species already there keeps its row. */
export function addQuadratSpecies(db: QuadratDb, quadratId: number, taxonId: string, now: number): number {
  unlockedQuadrat(db, quadratId);
  const had = rows<{ id: number }>(db, `SELECT id FROM plot_quadrat_species WHERE quadrat_id = ? AND taxon_id = ?`, [quadratId, taxonId]);
  if (had[0]) return had[0].id;
  const res = db.executeSync(
    `INSERT INTO plot_quadrat_species (quadrat_id, taxon_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [quadratId, taxonId, now, now],
  );
  db.executeSync(`UPDATE plot_quadrats SET started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, quadratId]);
  touch(db, quadratId, now);
  return Number(res.insertId ?? 0);
}

export type QuadratSpeciesPatch = Partial<Pick<QuadratSpecies, 'cover_pct' | 'freq_cells' | 'freq_count' | 'height_cm' | 'notes'>>;

export function updateQuadratSpecies(db: QuadratDb, id: number, patch: QuadratSpeciesPatch, now: number): void {
  const row = rows<QuadratSpecies>(db, `SELECT * FROM plot_quadrat_species WHERE id = ?`, [id])[0];
  if (!row) return;
  const q = unlockedQuadrat(db, row.quadrat_id);
  const cells = q.grid_n * q.grid_n;
  const v = { ...patch };
  if (v.cover_pct != null && !(v.cover_pct > 0 && v.cover_pct <= 100)) throw new QuadratError('invalid');
  if (v.freq_cells != null && !isMask(v.freq_cells, cells)) throw new QuadratError('invalid');
  if (v.freq_count != null) v.freq_count = Math.max(0, Math.min(cells, Math.round(v.freq_count)));
  if (v.height_cm != null && !(v.height_cm >= 0)) throw new QuadratError('invalid');
  const keys = Object.keys(v) as (keyof QuadratSpeciesPatch)[];
  if (keys.length === 0) return;
  db.executeSync(`UPDATE plot_quadrat_species SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => (v[k] ?? null) as Scalar),
    now,
    id,
  ]);
  touch(db, row.quadrat_id, now);
}

export function deleteQuadratSpecies(db: QuadratDb, id: number, now: number): void {
  const row = rows<QuadratSpecies>(db, `SELECT quadrat_id FROM plot_quadrat_species WHERE id = ?`, [id])[0];
  if (!row) return;
  unlockedQuadrat(db, row.quadrat_id);
  db.executeSync(`DELETE FROM plot_quadrat_species WHERE id = ?`, [id]);
  touch(db, row.quadrat_id, now);
}

/** Taxa recorded in the plot's quadrats but missing from its species list
 *  (the "加入草本層" hint), in first-seen order. */
export function quadratTaxaNotInPlot(db: QuadratDb, plotId: number): string[] {
  return rows<{ taxon_id: string }>(
    db,
    `SELECT s.taxon_id FROM plot_quadrat_species s JOIN plot_quadrats q ON q.id = s.quadrat_id
      WHERE q.plot_survey_id = ?
        AND s.taxon_id NOT IN (SELECT taxon_id FROM plot_species_records WHERE plot_survey_id = ?)
      GROUP BY s.taxon_id ORDER BY MIN(s.created_at), MIN(s.id)`,
    [plotId, plotId],
  ).map((r) => r.taxon_id);
}
