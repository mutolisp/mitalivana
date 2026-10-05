/**
 * Fixed-plot 1×1 m quadrats (06-plot-quadrats.md §2, v77), the rules without
 * the app's connection: every function takes `db`, so scripts/check-quadrats.mjs
 * runs them under node:sqlite against the real migrations. The app calls them
 * through src/db/quadrats.ts.
 *
 * Rules kept here, not in the screens:
 *   - the quadrat count follows the layout (corners + centre, one per subplot,
 *     …); shrinking removes only quadrats that hold nothing;
 *   - every quadrat of a plot has the plot's grid (user decision 2026-09-29):
 *     the grid is a plot setting, and it cannot change once any quadrat has
 *     frequency data or is locked;
 *   - once a quadrat holds data its size and top edge are fixed — the masks
 *     are indexed on the ground by them;
 *   - a locked quadrat ("完成並鎖定") takes no edit until it is unlocked;
 *   - cover is NULL (not estimated) or in (0, 100] — 0 is a delete, not a value;
 *     a frequency mask is NULL (not done) or exactly grid_n² cells; a count is
 *     0..grid_n².
 * Every write stamps the quadrat and its plot, so versions and sync see it.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { DEFAULT_GRID_N, isMask } from '../lib/grid';
import type { ImportedQuadrat, ImportedQuadratSpecies } from '../lib/quadratYaml';

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
  /** Frequency over the whole plot (v78): the plot is one grid; its species
   *  records get the masks. Independent of the quadrats. */
  freqEnabled: boolean;
  freqGridN: number;
  freqTopEdge: TopEdge;
  freqMode: FreqMode;
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
  freqEnabled: false,
  freqGridN: DEFAULT_GRID_N,
  freqTopEdge: 'N',
  freqMode: 'cells',
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
export type QuadratErrorCode = 'locked' | 'geometry-locked' | 'invalid' | 'full';
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
    freqEnabled: bool('freqEnabled'),
    freqGridN: Math.round(num(o.freqGridN, MIN_GRID_N, MAX_GRID_N, d.freqGridN)),
    freqTopEdge: TOP_EDGES.includes(o.freqTopEdge as TopEdge) ? (o.freqTopEdge as TopEdge) : d.freqTopEdge,
    freqMode: o.freqMode === 'count' ? 'count' : 'cells',
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
  // At most MAX_QUADRATS, as the count setting: a 26th made that setting
  // delete the last empty one when it was next touched (code review L11).
  if (taken.size >= MAX_QUADRATS) throw new QuadratError('full');
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
  // The grid is the plot's (changed through the config), never one quadrat's.
  if ('grid_n' in patch && patch.grid_n !== getQuadratConfig(db, q.plot_survey_id).gridN) throw new QuadratError('invalid');
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

/** Delete a quadrat and its species (explicitly: foreign keys may be off). A locked one is unlocked first (code review L10). */
export function deleteQuadrat(db: QuadratDb, id: number, now: number): void {
  const q = getQuadrat(db, id);
  if (!q) return;
  if (q.locked) throw new QuadratError('locked');
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

/**
 * Re-place the quadrats after a layout change: corners + centre renames the
 * first five, one-per-subplot moves them into the subplots in order. Other
 * layouts keep what is there (a custom position is the user's). Locked
 * quadrats are left alone.
 */
export function applyLayout(db: QuadratDb, plotId: number, now: number): void {
  const cfg = getQuadratConfig(db, plotId);
  const subplots = rows<{ id: number }>(db, `SELECT id FROM plot_subplots WHERE plot_survey_id = ? ORDER BY idx`, [plotId]);
  listQuadrats(db, plotId).forEach((q, i) => {
    if (q.locked) return;
    if (cfg.layout === 'cornersCenter') {
      db.executeSync(`UPDATE plot_quadrats SET position = ?, updated_at = ? WHERE id = ?`, [positionFor('cornersCenter', q.idx), now, q.id]);
    } else if (cfg.layout === 'perSubplot') {
      db.executeSync(`UPDATE plot_quadrats SET subplot_id = ?, position = NULL, updated_at = ? WHERE id = ?`, [subplots[i]?.id ?? null, now, q.id]);
    }
  });
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, plotId]);
}

/** Whether the plot's grid may still change: no quadrat has frequency data or is locked. */
export function gridChangeable(db: QuadratDb, plotId: number): boolean {
  return (
    rows(
      db,
      `SELECT 1 FROM plot_quadrats q WHERE q.plot_survey_id = ? AND (q.locked = 1 OR EXISTS (
         SELECT 1 FROM plot_quadrat_species s WHERE s.quadrat_id = q.id AND (s.freq_cells IS NOT NULL OR s.freq_count IS NOT NULL)))`,
      [plotId],
    ).length === 0
  );
}

/**
 * Give the configured size and top edge to every quadrat still empty and
 * unlocked, and the grid to all of them (the caller checked gridChangeable
 * before changing it). Returns how many kept their own size / top edge
 * because they hold data.
 */
export function applyGeometryDefaults(db: QuadratDb, plotId: number, now: number): number {
  const cfg = getQuadratConfig(db, plotId);
  let kept = 0;
  db.executeSync(`UPDATE plot_quadrats SET grid_n = ?, updated_at = ? WHERE plot_survey_id = ? AND grid_n != ?`, [cfg.gridN, now, plotId, cfg.gridN]);
  for (const q of listQuadrats(db, plotId)) {
    if (q.size_m === cfg.sizeM && q.top_edge === cfg.topEdge) continue;
    if (q.locked || quadratHasData(db, q.id)) {
      kept++;
      continue;
    }
    db.executeSync(`UPDATE plot_quadrats SET size_m = ?, top_edge = ?, updated_at = ? WHERE id = ?`, [cfg.sizeM, cfg.topEdge, now, q.id]);
  }
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, plotId]);
  return kept;
}

/**
 * Make every quadrat of the plot use one grid, after something that could mix
 * them (an import, a merge, merging plots). The grid is the config's, or the
 * first quadrat's when there is no config. A mask that does not fit is
 * frequency not done — never stretched. So is a count from a quadrat on
 * another grid: 20 of 5 × 5 is 80 %, the same 20 of 10 × 10 would read 20 %
 * (code review M15, 2026-10-04). A count on the plot's grid is capped at the cells.
 */
export function normalizeGrid(db: QuadratDb, plotId: number, now: number): void {
  const cfgRow = rows<{ quadrat_config: string | null }>(db, `SELECT quadrat_config FROM plot_surveys WHERE id = ?`, [plotId])[0];
  const first = listQuadrats(db, plotId)[0];
  if (!first) return;
  const n = cfgRow?.quadrat_config ? parseQuadratConfig(cfgRow.quadrat_config).gridN : first.grid_n;
  // Before the grid changes: the counts of the quadrats it changes for.
  db.executeSync(
    `UPDATE plot_quadrat_species SET freq_count = NULL
     WHERE freq_count IS NOT NULL AND quadrat_id IN (SELECT id FROM plot_quadrats WHERE plot_survey_id = ? AND grid_n != ?)`,
    [plotId, n],
  );
  db.executeSync(`UPDATE plot_quadrats SET grid_n = ?, updated_at = ? WHERE plot_survey_id = ? AND grid_n != ?`, [n, now, plotId, n]);
  db.executeSync(
    `UPDATE plot_quadrat_species SET
       freq_cells = CASE WHEN freq_cells IS NOT NULL AND length(freq_cells) != ? THEN NULL ELSE freq_cells END,
       freq_count = CASE WHEN freq_count > ? THEN ? ELSE freq_count END
     WHERE quadrat_id IN (SELECT id FROM plot_quadrats WHERE plot_survey_id = ?)`,
    [n * n, n * n, n * n, plotId],
  );
}

/**
 * Switch between painted cells and plain counts. A quadrat holds one or the
 * other, so the side switched away from is cleared (the screen confirms first
 * when that loses data).
 */
export function switchFreqMode(db: QuadratDb, id: number, mode: FreqMode, now: number): void {
  const q = getQuadrat(db, id);
  if (!q || q.freq_mode === mode) return;
  if (q.locked) throw new QuadratError('locked');
  db.executeSync(`UPDATE plot_quadrats SET freq_mode = ? WHERE id = ?`, [mode, id]);
  db.executeSync(
    mode === 'count'
      ? `UPDATE plot_quadrat_species SET freq_cells = NULL, updated_at = ? WHERE quadrat_id = ?`
      : `UPDATE plot_quadrat_species SET freq_count = NULL, updated_at = ? WHERE quadrat_id = ?`,
    [now, id],
  );
  touch(db, id, now);
}

/**
 * Species of the same quadrat (same idx) in the previous survey of this plot
 * (same plotid, fixed, started earlier) — names only, for "帶入前次物種".
 */
export function previousQuadratTaxa(db: QuadratDb, plotId: number, idx: number): string[] {
  return rows<{ taxon_id: string }>(
    db,
    `SELECT s.taxon_id FROM plot_quadrat_species s
       JOIN plot_quadrats q ON q.id = s.quadrat_id
      WHERE q.idx = ? AND q.plot_survey_id = (
        SELECT p.id FROM plot_surveys p, plot_surveys cur
         WHERE cur.id = ? AND p.id != cur.id AND p.plot_type = 'fixed'
           AND TRIM(p.plotid) = TRIM(cur.plotid)
           AND COALESCE(p.start_ts, p.created_at) < COALESCE(cur.start_ts, cur.created_at)
           AND EXISTS (SELECT 1 FROM plot_quadrats pq WHERE pq.plot_survey_id = p.id)
         ORDER BY COALESCE(p.start_ts, p.created_at) DESC LIMIT 1)
      ORDER BY s.created_at, s.id`,
    [idx, plotId],
  ).map((r) => r.taxon_id);
}

/**
 * Insert a quadrat read from a file (import, a teammate's copy). The values
 * were coerced by quadratsFromYaml; ids are this device's.
 */
export function writeQuadratRow(
  db: QuadratDb,
  plotId: number,
  q: Omit<ImportedQuadrat, 'species' | 'photo_files' | 'uuid' | 'subplot'>,
  opts: { uuid: string; subplotId: number | null; photoPaths: string | null; now: number },
): number {
  const cols: [string, Scalar][] = [
    ['uuid', opts.uuid],
    ['plot_survey_id', plotId],
    ['subplot_id', opts.subplotId],
    ['idx', q.idx],
    ['label', q.label],
    ['position', q.position],
    ['size_m', q.size_m],
    ['grid_n', q.grid_n],
    ['top_edge', q.top_edge],
    ['lat', q.lat],
    ['lng', q.lng],
    ['accuracy', q.accuracy],
    ...SURFACE_COLUMNS.map((c): [string, Scalar] => [c, q[c]]),
    ['freq_mode', q.freq_mode],
    ['locked', q.locked ? 1 : 0],
    ['started_at', q.started_at],
    ['ended_at', q.ended_at],
    ['notes', q.notes],
    ['photo_paths', opts.photoPaths],
    ['created_at', opts.now],
    ['updated_at', opts.now],
  ];
  const res = db.executeSync(
    `INSERT INTO plot_quadrats (${cols.map(([k]) => k).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(([, v]) => v),
  );
  return Number(res.insertId ?? 0);
}

/** OR IGNORE: two ids remapped onto one taxon on import must not abort it. */
export function writeQuadratSpeciesRow(db: QuadratDb, quadratId: number, s: ImportedQuadratSpecies, now: number): void {
  db.executeSync(
    `INSERT OR IGNORE INTO plot_quadrat_species (quadrat_id, taxon_id, cover_pct, freq_cells, freq_count, height_cm, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [quadratId, s.taxon_id, s.cover_pct, s.freq_cells, s.freq_count, s.height_cm, s.notes, now, now],
  );
}

/**
 * Quadrats of a plot made by merging several (mergePlotSurveys). Settings
 * come from the first (primary) source. For each quadrat number the primary's
 * quadrat is taken, unless it holds nothing and a later source's does; a
 * quadrat is never assembled from two sources, so species of different
 * surveys never share a grid. Subplots are re-pointed through `subplotIdOf`.
 */
export function copyMergedQuadrats(
  db: QuadratDb,
  sourceIds: readonly number[],
  newPlotId: number,
  subplotIdOf: (sourceId: number, oldSubplotId: number | null) => number | null,
  now: number,
  newUuid: () => string,
): void {
  if (!sourceIds.length) return;
  const cfg = rows<{ quadrat_config: string | null }>(db, `SELECT quadrat_config FROM plot_surveys WHERE id = ?`, [sourceIds[0]])[0];
  db.executeSync(`UPDATE plot_surveys SET quadrat_config = ? WHERE id = ?`, [cfg?.quadrat_config ?? null, newPlotId]);
  const chosen = new Map<number, { src: number; q: Quadrat }>();
  for (const src of sourceIds) {
    for (const q of listQuadrats(db, src)) {
      const had = chosen.get(q.idx);
      if (!had || (!quadratHasData(db, had.q.id) && quadratHasData(db, q.id))) chosen.set(q.idx, { src, q });
    }
  }
  for (const idx of [...chosen.keys()].sort((a, b) => a - b)) {
    const { src, q } = chosen.get(idx)!;
    const id = writeQuadratRow(db, newPlotId, q, {
      uuid: newUuid(),
      subplotId: subplotIdOf(src, q.subplot_id),
      photoPaths: q.photo_paths,
      now,
    });
    // Keep the source's times rather than the merge's.
    db.executeSync(`UPDATE plot_quadrats SET created_at = ?, updated_at = ? WHERE id = ?`, [q.created_at, now, id]);
    for (const s of listQuadratSpecies(db, q.id)) writeQuadratSpeciesRow(db, id, s, now);
  }
  // A quadrat taken from a source on another grid keeps its cover, not its cells.
  normalizeGrid(db, newPlotId, now);
}

// ── frequency over the whole plot (v78) ─────────────────────────────────────

/** Whether the plot grid may still change: no species record has frequency data. */
export function plotFreqChangeable(db: QuadratDb, plotId: number): boolean {
  return (
    rows(db, `SELECT 1 FROM plot_species_records WHERE plot_survey_id = ? AND (freq_cells IS NOT NULL OR freq_count IS NOT NULL) LIMIT 1`, [plotId])
      .length === 0
  );
}

/**
 * A plot species record's frequency: a mask of exactly freqGridN² cells, or
 * a count capped at the cells. NULL = not done. The record and the plot are
 * stamped. The plot's own lock is the screen's business (useRecordEditing).
 */
export function setPlotSpeciesFreq(
  db: QuadratDb,
  recordId: number,
  patch: { freq_cells?: string | null; freq_count?: number | null },
  now: number,
): void {
  const rec = rows<{ plot_survey_id: number }>(db, `SELECT plot_survey_id FROM plot_species_records WHERE id = ?`, [recordId])[0];
  if (!rec) return;
  const n = getQuadratConfig(db, rec.plot_survey_id).freqGridN;
  const sets: string[] = [];
  const args: Scalar[] = [];
  if ('freq_cells' in patch) {
    if (patch.freq_cells != null && !isMask(patch.freq_cells, n * n)) throw new QuadratError('invalid');
    sets.push('freq_cells = ?');
    args.push(patch.freq_cells ?? null);
  }
  if ('freq_count' in patch) {
    sets.push('freq_count = ?');
    args.push(patch.freq_count == null ? null : Math.max(0, Math.min(n * n, Math.round(patch.freq_count))));
  }
  if (!sets.length) return;
  db.executeSync(`UPDATE plot_species_records SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...args, now, recordId]);
  db.executeSync(`UPDATE plot_surveys SET updated_at = ? WHERE id = ?`, [now, rec.plot_survey_id]);
}

/** Cells ⇄ counts for the plot grid; the side left is cleared (the screen confirms first). */
export function switchPlotFreqMode(db: QuadratDb, plotId: number, mode: FreqMode, now: number): void {
  if (getQuadratConfig(db, plotId).freqMode === mode) return;
  setQuadratConfig(db, plotId, { freqMode: mode }, now);
  db.executeSync(
    mode === 'count'
      ? `UPDATE plot_species_records SET freq_cells = NULL, updated_at = ? WHERE plot_survey_id = ? AND freq_cells IS NOT NULL`
      : `UPDATE plot_species_records SET freq_count = NULL, updated_at = ? WHERE plot_survey_id = ? AND freq_count IS NOT NULL`,
    [now, plotId],
  );
}

/** After an import or a merge: masks that do not fit the plot grid are frequency not done; counts capped. */
export function normalizePlotFreq(db: QuadratDb, plotId: number): void {
  const n = getQuadratConfig(db, plotId).freqGridN;
  db.executeSync(
    `UPDATE plot_species_records SET
       freq_cells = CASE WHEN freq_cells IS NOT NULL AND length(freq_cells) != ? THEN NULL ELSE freq_cells END,
       freq_count = CASE WHEN freq_count > ? THEN ? ELSE freq_count END
     WHERE plot_survey_id = ?`,
    [n * n, n * n, n * n, plotId],
  );
}
