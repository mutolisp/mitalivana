/**
 * A census "slice": everything one census holds in a set of 20 m quadrats, as
 * a document — the unit of quadrat versions and undo (1C-a) and of team sync
 * blocks (1C-b). docs/planned/Modular_survey.md §7.2.
 *
 * - buildSlice: the document (rows keyed by uuid, foreign keys as uuids).
 * - censusSide: the rows as the merge engine compares them. Rows the schema
 *   makes unique by owner are keyed by owner, not by their own uuid, so two
 *   copies of one measurement meet: a measurement by its stem, a value by its
 *   owner + component + field + idx, a quadrat by its code.
 * - applySliceOps: writes merge operations back (insert / partial update /
 *   delete), uuid → local id, parents before children.
 * - restoreSlice: makes the census equal to a slice in its scope (versions,
 *   undo), under three rules:
 *     · a tree or stem is deleted only if it was created after the slice was
 *       taken (that undoes an addition); an older tree missing from the slice
 *       moved in later and stays;
 *     · a measurement, value or photo is deleted only if its tree was in the
 *       slice (otherwise it belongs to a tree that moved in);
 *     · correction history is never deleted.
 *
 * Takes a context (db, clock, uuid) like stemmapCore; check:survey-db runs it
 * under node:sqlite.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { unionSurveyors } from '../../db/merge';
import { restoreDecisions, takeVersion } from '../../lib/recordVersionsCore';
import { baseOf, diffSides, planOps, type Combiners, type MergeOp, type MergeRow, type MergeSide, type Row } from '../../lib/mergeEngine';
import { getSurvey, touchFgQuadrat, type Ctx, type SurveyDb } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ── the document ────────────────────────────────────────────────────────────

/** Frame columns carried in a slice (identity and geometry; ids left out). */
export const FRAME_COLS = [
  'uuid', 'code', 'name', 'size_x_m', 'size_y_m', 'quadrat_m', 'subquadrat_m', 'tag_block_quadrats', 'tag_block_size',
  'origin_lat', 'origin_lng', 'origin_accuracy_m', 'origin_datum', 'bearing_deg', 'bearing_ref', 'declination_deg',
  'dbh_min_cm', 'extreme_pct', 'extreme_min', 'notes',
] as const;
export const SURVEY_COLS = [
  'uuid', 'census_no', 'template_id', 'template_version', 'template_snapshot', 'template_hash', 'status', 'start_ts', 'stop_ts',
  'investigators', 'notes', 'sync_block_quadrats', 'lat', 'lng', 'accuracy',
] as const;
const QUADRAT_COLS = ['uuid', 'quadrat_code', 'status', 'started_at', 'ended_at', 'recorded_by', 'notes'] as const;
const TREE_COLS = [
  'uuid', 'tag', 'taxon_id', 'used_name_id', 'used_scientific_name', 'verbatim_identification', 'x_m', 'y_m', 'quadrat_code',
  'coord_method', 'local_x_m', 'local_y_m', 'ref_kind', 'ref_code', 'distance_m', 'azimuth_deg', 'azimuth_ref', 'slope_deg',
  'lat', 'lng', 'accuracy', 'notes',
] as const;
const MEASURE_COLS = ['uuid', 'dbh_cm', 'pom_m', 'pom_seq', 'is_main', 'stem_dead', 'pending', 'measured_at', 'recorded_by', 'notes'] as const;
const VALUE_COLS = ['uuid', 'component', 'field', 'idx', 'value_num', 'value_text', 'unit'] as const;

export type CensusSlice = {
  record_type: 'census_slice';
  schema: 1;
  /** When the slice was read (ms): restore deletes only rows created after it. */
  taken_at: number;
  /** The quadrat codes asked for — what a restore covers, even if they held nothing yet. */
  scope: string[];
  frame: Row;
  series: Row;
  survey: Row;
  quadrats: Row[];
  trees: Row[];
  stems: Row[];
  measures: Row[];
  stemValues: Row[];
  treeValues: Row[];
  history: Row[];
  media: Row[];
};

export const pick = (r: Row, cols: readonly string[]): Row => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));

/** Rows per INSERT when filling a temp table (well under SQLite's parameter limit). */
const CHUNK = 400;

/** Fill a one-column temp table (created on first use, emptied first). */
function fillTemp(ctx: { db: SurveyDb }, table: string, colDef: string, values: readonly Scalar[]): void {
  run(ctx, `CREATE TEMP TABLE IF NOT EXISTS ${table} (${colDef} PRIMARY KEY)`);
  run(ctx, `DELETE FROM ${table}`);
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    run(ctx, `INSERT OR IGNORE INTO ${table} VALUES ${part.map(() => '(?)').join(', ')}`, part);
  }
}

/**
 * The census in these quadrats. `extraTrees` (uuids) adds trees that are now
 * elsewhere — a restore must see a tree that moved out of its scope.
 *
 * The quadrats, trees and stems in scope go through temp tables rather than
 * `IN (?, ?, …)` lists: a whole census of a large plot has more stems than
 * SQLite takes parameters in one statement (32 766), and an export or a merge
 * from a file reads the whole census (1E stress test).
 *
 * `permanent: false` leaves out the trees, stems and their history (empty
 * lists): an export writes those once, from its last census.
 */
export function buildSlice(ctx: Ctx, surveyId: number, codes: readonly string[], extraTrees: readonly string[] = [], opts: { permanent?: boolean } = {}): CensusSlice {
  const permanent = opts.permanent ?? true;
  const s = getSurvey(ctx, surveyId);
  if (!s) throw new Error(`no census ${surveyId}`);
  const frame = one<Row>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [s.frame_id])!;
  const series = one<Row>(ctx, `SELECT uuid, template_id, series_code FROM fw_frame_series WHERE id = ?`, [s.series_id])!;
  const codeList = [...new Set(codes)];
  fillTemp(ctx, 'temp.slice_codes', 'code TEXT', codeList);
  fillTemp(ctx, 'temp.slice_extra', 'uuid TEXT', [...new Set(extraTrees)]);
  // Trees this census sees (not first recorded in a later census of its series), in scope.
  run(ctx, `CREATE TEMP TABLE IF NOT EXISTS slice_trees (id INTEGER PRIMARY KEY)`);
  run(ctx, `DELETE FROM temp.slice_trees`);
  // Two statements, each led by its temp table (CROSS JOIN fixes the order): `quadrat IN (…) OR
  // uuid IN (…)` — and the uuid half alone — made SQLite walk every tree of the plot (1E).
  for (const from of ['temp.slice_codes c CROSS JOIN fw_individuals i ON i.quadrat_code = c.code', 'temp.slice_extra x CROSS JOIN fw_individuals i ON i.uuid = x.uuid'])
    run(
      ctx,
      `INSERT OR IGNORE INTO temp.slice_trees SELECT i.id FROM ${from} LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
        WHERE i.frame_id = ? AND (fi.id IS NULL OR fi.series_id <> ? OR fi.census_no <= ?)`,
      [s.frame_id, s.series_id, s.census_no],
    );
  run(ctx, `CREATE TEMP TABLE IF NOT EXISTS slice_stems (id INTEGER PRIMARY KEY)`);
  run(ctx, `DELETE FROM temp.slice_stems`);
  run(
    ctx,
    `INSERT INTO temp.slice_stems SELECT st.id FROM fw_stems st LEFT JOIN fw_surveys fs ON fs.id = st.first_survey_id
      WHERE st.individual_id IN (SELECT id FROM temp.slice_trees) AND (fs.id IS NULL OR fs.series_id <> ? OR fs.census_no <= ?)`,
    [s.series_id, s.census_no],
  );
  const trees = !permanent
    ? []
    : rows<Row & { id: number; first_uuid: string | null }>(
        ctx,
        `SELECT i.*, fi.uuid AS first_uuid FROM fw_individuals i
           LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
          WHERE i.id IN (SELECT id FROM temp.slice_trees)
          ORDER BY i.id`,
      );
  const stems = !permanent
    ? []
    : rows<Row & { id: number; individual_id: number; tree_uuid: string; first_uuid: string | null }>(
        ctx,
        `SELECT st.*, i.uuid AS tree_uuid, fs.uuid AS first_uuid FROM fw_stems st
           JOIN fw_individuals i ON i.id = st.individual_id
           LEFT JOIN fw_surveys fs ON fs.id = st.first_survey_id
          WHERE st.id IN (SELECT id FROM temp.slice_stems)
          ORDER BY st.id`,
      );
  const measures = rows<Row & { id: number; stem_uuid: string }>(
    ctx,
    `SELECT m.*, st.uuid AS stem_uuid FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id
      WHERE m.survey_id = ? AND m.stem_id IN (SELECT id FROM temp.slice_stems) ORDER BY m.id`,
    [surveyId],
  );
  const stemValues = rows<Row & { stem_uuid: string }>(
    ctx,
    `SELECT v.*, st.uuid AS stem_uuid FROM fw_stem_values v
       JOIN fw_stem_measures m ON m.id = v.measure_id JOIN fw_stems st ON st.id = m.stem_id
      WHERE m.survey_id = ? AND m.stem_id IN (SELECT id FROM temp.slice_stems) ORDER BY v.id`,
    [surveyId],
  );
  const treeValues = rows<Row & { tree_uuid: string }>(
    ctx,
    `SELECT v.*, i.uuid AS tree_uuid FROM fw_individual_values v JOIN fw_individuals i ON i.id = v.individual_id
      WHERE v.survey_id = ? AND v.individual_id IN (SELECT id FROM temp.slice_trees) ORDER BY v.id`,
    [surveyId],
  );
  const history = !permanent
    ? []
    : rows<Row & { tree_uuid: string; survey_uuid: string | null }>(
        ctx,
        `SELECT h.*, i.uuid AS tree_uuid, sv.uuid AS survey_uuid FROM fw_individual_history h
           JOIN fw_individuals i ON i.id = h.individual_id LEFT JOIN fw_surveys sv ON sv.id = h.survey_id
          WHERE h.individual_id IN (SELECT id FROM temp.slice_trees) ORDER BY h.id`,
      );
  const media = rows<Row & { tree_uuid: string | null; stem_uuid: string | null }>(
    ctx,
    `SELECT md.*, i.uuid AS tree_uuid, st.uuid AS stem_uuid FROM fw_media md
       LEFT JOIN fw_individuals i ON i.id = md.individual_id
       LEFT JOIN fw_stem_measures m ON m.id = md.measure_id LEFT JOIN fw_stems st ON st.id = m.stem_id
      WHERE md.survey_id = ? AND md.individual_id IN (SELECT id FROM temp.slice_trees) ORDER BY md.id`,
    [surveyId],
  );
  const quadrats = rows<Row>(
    ctx,
    `SELECT * FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code IN (SELECT code FROM temp.slice_codes) ORDER BY quadrat_code`,
    [surveyId],
  );
  return {
    record_type: 'census_slice',
    schema: 1,
    taken_at: ctx.now(),
    scope: codeList,
    frame: pick(frame, FRAME_COLS),
    series,
    survey: pick(s as unknown as Row, SURVEY_COLS),
    quadrats: quadrats.map((q) => pick(q, QUADRAT_COLS)),
    trees: trees.map((t) => ({ ...pick(t, TREE_COLS), first_survey_uuid: t.first_uuid })),
    stems: stems.map((st) => ({ uuid: st.uuid, tree_uuid: st.tree_uuid, stem_no: st.stem_no, first_survey_uuid: st.first_uuid, notes: st.notes ?? null })),
    measures: measures.map((m) => ({ ...pick(m, MEASURE_COLS), stem_uuid: m.stem_uuid })),
    stemValues: stemValues.map((v) => ({ ...pick(v, VALUE_COLS), stem_uuid: v.stem_uuid })),
    treeValues: treeValues.map((v) => ({ ...pick(v, VALUE_COLS), tree_uuid: v.tree_uuid })),
    history: history.map((h) => ({
      uuid: h.uuid,
      tree_uuid: h.tree_uuid,
      survey_uuid: h.survey_uuid,
      field: h.field,
      old_value: h.old_value,
      new_value: h.new_value,
      reason: h.reason,
      by: h.by,
      at: h.at,
    })),
    media: media.map((md) => ({ uuid: md.uuid, tree_uuid: md.tree_uuid, stem_uuid: md.stem_uuid, component: md.component, kind: md.kind, uri: md.uri })),
  };
}

// ── as merge rows ───────────────────────────────────────────────────────────

const omit = (o: Row, keys: readonly string[]): Row => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const valueKey = (owner: unknown, v: Row) => `${owner}|${v.component}|${v.field}|${v.idx}`;

/** Quadrat working time spans both copies'; recorders are pooled (1C-b merges). */
export const CENSUS_COMBINERS: Combiners = {
  fgquadrat: {
    started_at: (a, b) => {
      const xs = [a, b].filter((v): v is number => typeof v === 'number');
      return xs.length ? Math.min(...xs) : null;
    },
    ended_at: (a, b) => {
      const xs = [a, b].filter((v): v is number => typeof v === 'number');
      return xs.length ? Math.max(...xs) : null;
    },
    recorded_by: (a, b) => unionSurveyors([(a as string) ?? null, (b as string) ?? null]),
  },
};
const QUADRAT_COMBINED = ['started_at', 'ended_at', 'recorded_by'] as const;

export function censusSide(sl: CensusSlice): MergeSide {
  const tagOf = new Map(sl.trees.map((t) => [t.uuid as string, t.tag as string]));
  // A map, not stems.find per row: a whole census has tens of thousands of stems (1E).
  const stemOf = new Map(sl.stems.map((x) => [x.uuid as string, x]));
  const stemLabel = (stemUuid: unknown) => {
    const st = stemOf.get(stemUuid as string);
    return st ? `${tagOf.get(st.tree_uuid as string) ?? '?'}-${st.stem_no}` : String(stemUuid);
  };
  const quadrat: MergeRow[] = sl.quadrats.map((q) => ({
    key: q.quadrat_code as string,
    data: omit(q, ['uuid', ...QUADRAT_COMBINED]),
    extra: { uuid: q.uuid, ...Object.fromEntries(QUADRAT_COMBINED.map((k) => [k, q[k] ?? null])) },
    label: q.quadrat_code as string,
  }));
  const tree: MergeRow[] = sl.trees.map((t) => ({
    key: t.uuid as string,
    data: omit(t, ['uuid']),
    dupKey: `tag:${t.tag}`,
    label: t.tag as string,
    group: t.quadrat_code as string,
  }));
  const stem: MergeRow[] = sl.stems.map((st) => ({
    key: st.uuid as string,
    data: omit(st, ['uuid']),
    dupKey: `${st.tree_uuid}|${st.stem_no}`,
    label: stemLabel(st.uuid),
  }));
  const measure: MergeRow[] = sl.measures.map((m) => ({
    key: m.stem_uuid as string,
    data: omit(m, ['uuid', 'stem_uuid']),
    extra: { uuid: m.uuid },
    label: stemLabel(m.stem_uuid),
  }));
  const sval: MergeRow[] = sl.stemValues.map((v) => ({
    key: valueKey(v.stem_uuid, v),
    data: omit(v, ['uuid']),
    extra: { uuid: v.uuid },
    label: `${stemLabel(v.stem_uuid)} ${v.field}`,
  }));
  const ival: MergeRow[] = sl.treeValues.map((v) => ({
    key: valueKey(v.tree_uuid, v),
    data: omit(v, ['uuid']),
    extra: { uuid: v.uuid },
    label: `${tagOf.get(v.tree_uuid as string) ?? '?'} ${v.field}`,
  }));
  const history: MergeRow[] = sl.history.map((h) => ({ key: h.uuid as string, data: omit(h, ['uuid']), label: `${tagOf.get(h.tree_uuid as string) ?? '?'} ${h.field}` }));
  const media: MergeRow[] = sl.media.map((md) => ({ key: md.uuid as string, data: omit(md, ['uuid']), label: `${tagOf.get(md.tree_uuid as string) ?? '?'} ${md.kind}` }));
  return { fgquadrat: quadrat, tree, stem, measure, sval, ival, history, media };
}

// ── writing operations back ─────────────────────────────────────────────────

/** Insert order; deletes run the other way. */
/** Side tables; the 20 m quadrat is `fgquadrat` (`quadrat` is the plot's 1 × 1 m one, §7.8). */
const ORDER = ['fgquadrat', 'tree', 'stem', 'measure', 'sval', 'ival', 'history', 'media'] as const;

export type ApplyOptions = {
  /** Deletions allowed for a tree or stem row, by key (restore's rules). */
  mayDelete?: (tbl: string, key: string) => boolean;
};

type Ids = { survey: number; frame: number; series: number; censusNo: number };

/**
 * Apply merge operations to one census. Returns the quadrats touched (they are
 * stamped). A stem inserted under a number its tree already uses (two copies
 * each added stem 3) takes the next free number.
 */
export function applySliceOps(ctx: Ctx, surveyId: number, ops: readonly MergeOp[], opts: ApplyOptions = {}): string[] {
  const s = getSurvey(ctx, surveyId);
  if (!s) throw new Error(`no census ${surveyId}`);
  const ids: Ids = { survey: surveyId, frame: s.frame_id, series: s.series_id, censusNo: s.census_no };
  const now = ctx.now();
  const touched = new Set<string>();
  // A quadrat row this apply deleted is not stamped back into existence.
  const removedQuadrats = new Set<string>();
  // Lookups are cached for this apply (a census from a file is ~100 000 rows,
  // 1E); every insert and delete below keeps the caches true.
  const idCache = new Map<string, number | null>();
  const quadratCache = new Map<number, string | null>();
  const measureCache = new Map<number, number | null>();
  const idOf = (tbl: 'fw_individuals' | 'fw_stems' | 'fw_surveys', uuid: unknown) => {
    if (uuid == null) return null;
    const k = `${tbl}|${uuid as string}`;
    if (!idCache.has(k)) idCache.set(k, one<{ id: number }>(ctx, `SELECT id FROM ${tbl} WHERE uuid = ?`, [uuid as string])?.id ?? null);
    return idCache.get(k)!;
  };
  const treeQuadrat = (treeId: number | null) => {
    if (treeId == null) return null;
    if (!quadratCache.has(treeId)) quadratCache.set(treeId, one<{ q: string }>(ctx, `SELECT quadrat_code AS q FROM fw_individuals WHERE id = ?`, [treeId])?.q ?? null);
    return quadratCache.get(treeId)!;
  };
  const touchTree = (treeId: number | null) => {
    const q = treeQuadrat(treeId);
    if (q) touched.add(q);
  };
  const measureOfStem = (stemUuid: unknown) => {
    const stemId = idOf('fw_stems', stemUuid);
    if (stemId == null) return null;
    if (!measureCache.has(stemId)) measureCache.set(stemId, one<{ id: number }>(ctx, `SELECT id FROM fw_stem_measures WHERE survey_id = ? AND stem_id = ?`, [surveyId, stemId])?.id ?? null);
    return measureCache.get(stemId)!;
  };
  const setCols = (tbl: string, where: string, whereArgs: Scalar[], data: Row, stamp: boolean) => {
    const cols = Object.keys(data);
    if (!cols.length && !stamp) return;
    const sets = [...cols.map((c) => `${c} = ?`), ...(stamp ? ['updated_at = ?'] : [])];
    run(ctx, `UPDATE ${tbl} SET ${sets.join(', ')} WHERE ${where}`, [...cols.map((c) => data[c] as Scalar), ...(stamp ? [now] : []), ...whereArgs]);
  };

  const byTable = (tbl: string) => ops.filter((o) => o.tbl === tbl);
  for (const tbl of [...ORDER].reverse()) {
    for (const op of byTable(tbl)) {
      if (op.op !== 'delete') continue;
      if (opts.mayDelete && !opts.mayDelete(tbl, op.key)) continue;
      deleteRow(tbl, op.key);
    }
  }
  for (const tbl of ORDER) {
    // Updates first: one may free a unique value (a renumbered tag) an insert takes.
    for (const op of byTable(tbl)) if (op.op === 'update') updateRow(tbl, op.key, { ...op.data, ...(op.extra ?? {}) });
    for (const op of byTable(tbl)) if (op.op === 'insert') insertRow(tbl, op.row);
  }
  for (const q of touched) if (!removedQuadrats.has(q)) touchFgQuadrat(ctx, surveyId, q);
  return [...touched];

  function deleteRow(tbl: string, key: string) {
    switch (tbl) {
      case 'history':
        return; // correction history is never deleted
      case 'fgquadrat':
        run(ctx, `DELETE FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = ?`, [surveyId, key]);
        removedQuadrats.add(key);
        return;
      case 'tree': {
        const id = idOf('fw_individuals', key);
        touchTree(id);
        if (id != null) {
          run(ctx, `DELETE FROM fw_individuals WHERE id = ?`, [id]);
          idCache.set(`fw_individuals|${key}`, null);
          // Its stems and measurements went with it (cascade).
          idCache.clear();
          measureCache.clear();
        }
        return;
      }
      case 'stem': {
        const id = idOf('fw_stems', key);
        if (id == null) return;
        touchTree(one<{ t: number }>(ctx, `SELECT individual_id AS t FROM fw_stems WHERE id = ?`, [id])?.t ?? null);
        run(ctx, `DELETE FROM fw_stems WHERE id = ?`, [id]);
        idCache.set(`fw_stems|${key}`, null);
        measureCache.delete(id);
        return;
      }
      case 'measure': {
        const mid = measureOfStem(key);
        if (mid == null) return;
        touchTree(idOf('fw_individuals', one<{ u: string }>(ctx, `SELECT i.uuid AS u FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE st.uuid = ?`, [key])?.u));
        run(ctx, `DELETE FROM fw_stem_measures WHERE id = ?`, [mid]);
        measureCache.set(idOf('fw_stems', key)!, null);
        return;
      }
      case 'sval': {
        const [stemUuid, component, field, idx] = key.split('|');
        const mid = measureOfStem(stemUuid);
        if (mid != null) run(ctx, `DELETE FROM fw_stem_values WHERE measure_id = ? AND component = ? AND field = ? AND idx = ?`, [mid, component, field, Number(idx)]);
        return;
      }
      case 'ival': {
        const [treeUuid, component, field, idx] = key.split('|');
        const tid = idOf('fw_individuals', treeUuid);
        touchTree(tid);
        if (tid != null) run(ctx, `DELETE FROM fw_individual_values WHERE survey_id = ? AND individual_id = ? AND component = ? AND field = ? AND idx = ?`, [surveyId, tid, component, field, Number(idx)]);
        return;
      }
      case 'media':
        run(ctx, `DELETE FROM fw_media WHERE uuid = ?`, [key]);
        return;
    }
  }

  function insertRow(tbl: string, row: MergeRow) {
    const d = { ...row.data, ...(row.extra ?? {}) };
    switch (tbl) {
      case 'fgquadrat': {
        if (one(ctx, `SELECT id FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = ?`, [surveyId, row.key])) return updateRow(tbl, row.key, d);
        run(
          ctx,
          `INSERT INTO fw_survey_quadrats (uuid, survey_id, quadrat_code, status, started_at, ended_at, recorded_by, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [(d.uuid as string) ?? ctx.uuid(), surveyId, row.key, (d.status as string) ?? 'open', d.started_at as Scalar, d.ended_at as Scalar, d.recorded_by as Scalar, d.notes as Scalar, now, now],
        );
        touched.add(row.key);
        return;
      }
      case 'tree': {
        if (idOf('fw_individuals', row.key) != null) return updateRow(tbl, row.key, d);
        const cols = TREE_COLS.filter((c) => c !== 'uuid');
        const res = run(
          ctx,
          `INSERT INTO fw_individuals (uuid, frame_id, ${cols.join(', ')}, first_survey_id, created_at, updated_at) VALUES (?, ?, ${marks(cols.length)}, ?, ?, ?)`,
          [row.key, ids.frame, ...cols.map((c) => d[c] as Scalar), idOf('fw_surveys', d.first_survey_uuid), now, now],
        );
        const newId = Number(res.insertId);
        idCache.set(`fw_individuals|${row.key}`, newId);
        quadratCache.set(newId, d.quadrat_code as string);
        touched.add(d.quadrat_code as string);
        return;
      }
      case 'stem': {
        if (idOf('fw_stems', row.key) != null) return updateRow(tbl, row.key, d);
        const treeId = idOf('fw_individuals', d.tree_uuid);
        if (treeId == null) throw new Error(`stem ${row.key}: tree ${String(d.tree_uuid)} missing`);
        let no = Number(d.stem_no);
        if (one(ctx, `SELECT id FROM fw_stems WHERE individual_id = ? AND stem_no = ?`, [treeId, no])) {
          no = (one<{ n: number }>(ctx, `SELECT MAX(stem_no) AS n FROM fw_stems WHERE individual_id = ?`, [treeId])?.n ?? 0) + 1;
        }
        const res = run(ctx, `INSERT INTO fw_stems (uuid, individual_id, stem_no, first_survey_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          row.key,
          treeId,
          no,
          idOf('fw_surveys', d.first_survey_uuid),
          d.notes as Scalar,
          now,
          now,
        ]);
        const newId = Number(res.insertId);
        idCache.set(`fw_stems|${row.key}`, newId);
        measureCache.set(newId, null);
        touchTree(treeId);
        return;
      }
      case 'measure': {
        if (measureOfStem(row.key) != null) return updateRow(tbl, row.key, d);
        const stemId = idOf('fw_stems', row.key);
        if (stemId == null) throw new Error(`measure: stem ${row.key} missing`);
        const cols = MEASURE_COLS.filter((c) => c !== 'uuid');
        const res = run(
          ctx,
          `INSERT INTO fw_stem_measures (uuid, survey_id, stem_id, ${cols.join(', ')}, created_at, updated_at) VALUES (?, ?, ?, ${marks(cols.length)}, ?, ?)`,
          [(d.uuid as string) ?? ctx.uuid(), surveyId, stemId, ...cols.map((c) => d[c] as Scalar), now, now],
        );
        measureCache.set(stemId, Number(res.insertId));
        touchTree(one<{ t: number }>(ctx, `SELECT individual_id AS t FROM fw_stems WHERE id = ?`, [stemId])?.t ?? null);
        return;
      }
      case 'sval': {
        const mid = measureOfStem(d.stem_uuid);
        if (mid == null) throw new Error(`value: no measurement for stem ${String(d.stem_uuid)}`);
        const res = run(
          ctx,
          `INSERT OR IGNORE INTO fw_stem_values (uuid, measure_id, component, field, idx, value_num, value_text, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [(d.uuid as string) ?? ctx.uuid(), mid, d.component as Scalar, d.field as Scalar, d.idx as Scalar, d.value_num as Scalar, d.value_text as Scalar, d.unit as Scalar, now],
        );
        // Already there (the owner's key matched): take the values.
        if (!res.rowsAffected) updateRow(tbl, row.key, d);
        return;
      }
      case 'ival': {
        const tid = idOf('fw_individuals', d.tree_uuid);
        if (tid == null) throw new Error(`value: tree ${String(d.tree_uuid)} missing`);
        const res = run(
          ctx,
          `INSERT OR IGNORE INTO fw_individual_values (uuid, survey_id, individual_id, component, field, idx, value_num, value_text, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [(d.uuid as string) ?? ctx.uuid(), surveyId, tid, d.component as Scalar, d.field as Scalar, d.idx as Scalar, d.value_num as Scalar, d.value_text as Scalar, d.unit as Scalar, now],
        );
        touchTree(tid);
        if (!res.rowsAffected) updateRow(tbl, row.key, d);
        return;
      }
      case 'history': {
        if (one(ctx, `SELECT id FROM fw_individual_history WHERE uuid = ?`, [row.key])) return;
        const tid = idOf('fw_individuals', d.tree_uuid);
        if (tid == null) return;
        run(ctx, `INSERT INTO fw_individual_history (uuid, individual_id, survey_id, field, old_value, new_value, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          row.key,
          tid,
          idOf('fw_surveys', d.survey_uuid),
          d.field as Scalar,
          d.old_value as Scalar,
          d.new_value as Scalar,
          d.reason as Scalar,
          d.by as Scalar,
          d.at as Scalar,
        ]);
        return;
      }
      case 'media': {
        if (one(ctx, `SELECT id FROM fw_media WHERE uuid = ?`, [row.key])) return;
        const tid = idOf('fw_individuals', d.tree_uuid);
        run(ctx, `INSERT INTO fw_media (uuid, survey_id, individual_id, measure_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          row.key,
          surveyId,
          tid,
          d.stem_uuid == null ? null : measureOfStem(d.stem_uuid),
          d.component as Scalar,
          d.kind as Scalar,
          d.uri as Scalar,
          now,
        ]);
        touchTree(tid);
        return;
      }
    }
  }

  function updateRow(tbl: string, key: string, data: Row) {
    const d = omit(data, ['uuid']);
    switch (tbl) {
      case 'fgquadrat':
        setCols('fw_survey_quadrats', 'survey_id = ? AND quadrat_code = ?', [surveyId, key], pickKnown(d, QUADRAT_COLS), true);
        touched.add(key);
        return;
      case 'tree': {
        const id = idOf('fw_individuals', key);
        if (id == null) return;
        touchTree(id);
        const cols = pickKnown(d, TREE_COLS);
        if ('first_survey_uuid' in d) cols.first_survey_id = idOf('fw_surveys', d.first_survey_uuid);
        setCols('fw_individuals', 'id = ?', [id], cols, true);
        // A move lands in its new quadrat (stamped too).
        if ('quadrat_code' in cols) quadratCache.set(id, cols.quadrat_code as string);
        touchTree(id);
        return;
      }
      case 'stem': {
        const id = idOf('fw_stems', key);
        if (id == null) return;
        const cols: Row = {};
        if ('notes' in d) cols.notes = d.notes;
        setCols('fw_stems', 'id = ?', [id], cols, true);
        return;
      }
      case 'measure': {
        const mid = measureOfStem(key);
        if (mid == null) return;
        setCols('fw_stem_measures', 'id = ?', [mid], pickKnown(d, MEASURE_COLS), true);
        touchTree(one<{ t: number }>(ctx, `SELECT st.individual_id AS t FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE m.id = ?`, [mid])?.t ?? null);
        return;
      }
      case 'sval': {
        const [stemUuid, component, field, idx] = key.split('|');
        const mid = measureOfStem(stemUuid);
        if (mid == null) return;
        setCols('fw_stem_values', 'measure_id = ? AND component = ? AND field = ? AND idx = ?', [mid, component, field, Number(idx)], pickKnown(d, ['value_num', 'value_text', 'unit']), true);
        return;
      }
      case 'ival': {
        const [treeUuid, component, field, idx] = key.split('|');
        const tid = idOf('fw_individuals', treeUuid);
        if (tid == null) return;
        setCols('fw_individual_values', 'survey_id = ? AND individual_id = ? AND component = ? AND field = ? AND idx = ?', [surveyId, tid, component, field, Number(idx)], pickKnown(d, ['value_num', 'value_text', 'unit']), true);
        touchTree(tid);
        return;
      }
      default:
        return; // history and media rows never change
    }
  }
}

const pickKnown = (d: Row, cols: readonly string[]): Row => Object.fromEntries(Object.entries(d).filter(([k]) => cols.includes(k) && k !== 'uuid'));

// ── restore ─────────────────────────────────────────────────────────────────

/**
 * Trees and stems first recorded in this census and created after `t` (ms),
 * by uuid: the ones a restore may remove. A tree another series recorded in
 * the same quadrats since is not this census's to remove (code review H1,
 * 2026-10-04). Through a temp table, as buildSlice: a whole census has more
 * stems than one statement takes parameters (code review M5).
 */
function createdAfter(ctx: { db: SurveyDb }, tbl: 'fw_individuals' | 'fw_stems', surveyId: number, uuids: string[], t: number): Set<string> {
  if (!uuids.length) return new Set();
  fillTemp(ctx, 'temp.slice_new', 'uuid TEXT', uuids);
  return new Set(
    rows<{ uuid: string }>(ctx, `SELECT x.uuid FROM temp.slice_new n CROSS JOIN ${tbl} x ON x.uuid = n.uuid WHERE x.created_at > ? AND x.first_survey_id = ?`, [t, surveyId]).map(
      (r) => r.uuid,
    ),
  );
}

/**
 * The census as restoring `target` reaches it: its quadrats, and its trees
 * wherever they are now — not the quadrats those trees are in now. This is
 * also the version kept before a restore (code review M11, 2026-10-04): it
 * holds a tree that has moved out since, and restoring that version must
 * reach the tree, not the whole quadrat it moved to. A slice from before
 * slices had a scope reaches its trees' quadrats.
 */
export function sliceForRestore(ctx: Ctx, surveyId: number, target: CensusSlice): CensusSlice {
  const quadrats = target.quadrats.map((q) => q.quadrat_code as string);
  const codes = target.scope ? [...target.scope, ...quadrats] : [...quadrats, ...target.trees.map((t) => t.quadrat_code as string)];
  return buildSlice(ctx, surveyId, codes, target.trees.map((t) => t.uuid as string));
}

/**
 * Make the census equal to `target` within its quadrats (and its trees, where
 * they are now). Returns how many operations ran. The caller runs it in a
 * transaction.
 */
export function restoreSlice(ctx: Ctx, surveyId: number, version: CensusSlice): number {
  const current = sliceForRestore(ctx, surveyId, version);
  const target = withJoinedStems(current, version);
  const currentSide = censusSide(current);
  const items = diffSides(currentSide, censusSide(target), baseOf(currentSide), takeVersion(CENSUS_COMBINERS));
  const ops = planOps(items, restoreDecisions(items));
  const targetTrees = new Set(target.trees.map((t) => t.uuid as string));
  const stemTree = new Map(current.stems.map((st) => [st.uuid as string, st.tree_uuid as string]));
  const newTrees = createdAfter(ctx, 'fw_individuals', surveyId, current.trees.map((t) => t.uuid as string), target.taken_at);
  const newStems = createdAfter(ctx, 'fw_stems', surveyId, current.stems.map((st) => st.uuid as string), target.taken_at);
  const ownerOf = (tbl: string, key: string): string | undefined => {
    switch (tbl) {
      case 'measure':
        return stemTree.get(key);
      case 'sval':
        return stemTree.get(key.split('|')[0]);
      case 'ival':
        return key.split('|')[0];
      case 'media':
        return current.media.find((m) => m.uuid === key)?.tree_uuid as string | undefined;
      default:
        return undefined;
    }
  };
  applySliceOps(ctx, surveyId, ops, {
    mayDelete: (tbl, key) => {
      if (tbl === 'tree') return newTrees.has(key);
      if (tbl === 'stem') return newStems.has(key);
      if (tbl === 'fgquadrat') return true;
      const owner = ownerOf(tbl, key);
      return owner == null || targetTrees.has(owner) || newTrees.has(owner);
    },
  });
  return ops.length;
}

/**
 * A version's stems under the uuids they have now. joinStems keeps the smaller
 * uuid of two stems that are one, so a stem of this phone can have taken the
 * other phone's uuid since the version was saved; matched by uuid alone, the
 * version's copy would come back as a third stem (code review M44). A stem
 * whose uuid is gone, standing on the same tree under the same number as a
 * current stem the version does not hold, is that stem.
 */
function withJoinedStems(current: CensusSlice, version: CensusSlice): CensusSlice {
  const now = new Set(current.stems.map((st) => st.uuid as string));
  const inVersion = new Set(version.stems.map((st) => st.uuid as string));
  const byNumber = new Map(current.stems.map((st) => [`${st.tree_uuid}|${st.stem_no}`, st.uuid as string]));
  const to = new Map<string, string>();
  for (const st of version.stems) {
    const uuid = st.uuid as string;
    if (now.has(uuid)) continue;
    const same = byNumber.get(`${st.tree_uuid}|${st.stem_no}`);
    if (same && !inVersion.has(same)) to.set(uuid, same);
  }
  return to.size ? renameStems(version, to) : version;
}

/** A slice with some stems under other uuids (`to`: old → new), their measurements, values and photos with them. */
function renameStems(sl: CensusSlice, to: ReadonlyMap<string, string>): CensusSlice {
  const sm = (v: unknown) => (typeof v === 'string' ? (to.get(v) ?? v) : v);
  return {
    ...sl,
    stems: sl.stems.map((st) => ({ ...st, uuid: sm(st.uuid) })),
    measures: sl.measures.map((m) => ({ ...m, stem_uuid: sm(m.stem_uuid) })),
    stemValues: sl.stemValues.map((v) => ({ ...v, stem_uuid: sm(v.stem_uuid) })),
    media: sl.media.map((md) => ({ ...md, stem_uuid: sm(md.stem_uuid) })),
  };
}

/**
 * Stems another phone added to a tree under a number one of ours already
 * has: one stem, under the smaller uuid on both phones (as a tree fold keeps
 * the smaller uuid). Ours is renamed here when theirs is smaller; theirs in
 * the returned slice when ours is. They used to come in as a duplicate (kept
 * out, its measurement had no stem and the merge threw) or a new stem under
 * the next free number, each phone its own way (code review M9, 2026-10-04).
 * A stem of ours they know under another number is left to the merge.
 */
export function joinStems(ctx: Ctx, surveyId: number, sl: CensusSlice): { slice: CensusSlice; joined: number } {
  const theirStems = new Set(sl.stems.map((st) => st.uuid as string));
  const kept = new Map<string, string>();
  const now = ctx.now();
  let joined = 0;
  for (const st of sl.stems) {
    const theirs = st.uuid as string;
    if (one(ctx, `SELECT id FROM fw_stems WHERE uuid = ?`, [theirs])) continue;
    const ours = one<{ id: number; uuid: string; q: string }>(
      ctx,
      `SELECT st.id, st.uuid, i.quadrat_code AS q FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.uuid = ? AND st.stem_no = ?`,
      [st.tree_uuid as string, Number(st.stem_no)],
    );
    if (!ours || theirStems.has(ours.uuid)) continue;
    const keep = ours.uuid < theirs ? ours.uuid : theirs;
    if (keep !== ours.uuid) {
      run(ctx, `UPDATE fw_stems SET uuid = ?, updated_at = ? WHERE id = ?`, [keep, now, ours.id]);
      touchFgQuadrat(ctx, surveyId, ours.q);
    }
    if (keep !== theirs) kept.set(theirs, keep);
    joined += 1;
  }
  return { slice: kept.size ? renameStems(sl, kept) : sl, joined };
}

/**
 * Add what a slice has and the census lacks, changing and deleting nothing:
 * a census created from a file (censusExportCore.ts). Trees are shared by
 * every census, so the file's copy of a tree already here must not undo a
 * correction made here since. Returns how many rows were added.
 */
export function fillSlice(ctx: Ctx, surveyId: number, file: CensusSlice): number {
  // A stem the file's phone added under a number one of ours has is that stem (M9).
  const target = joinStems(ctx, surveyId, file).slice;
  const codes = [...(target.scope ?? []), ...target.quadrats.map((q) => q.quadrat_code as string), ...target.trees.map((t) => t.quadrat_code as string)];
  const current = censusSide(buildSlice(ctx, surveyId, codes, target.trees.map((t) => t.uuid as string)));
  const items = diffSides(current, censusSide(target), baseOf(current), {}).filter((it) => it.kind === 'added');
  const ops = planOps(items, new Map());
  applySliceOps(ctx, surveyId, ops);
  return ops.length;
}

/** Census uuid and number of a census (for documents and labels). */
export function censusIdentity(ctx: { db: SurveyDb }, surveyId: number): { uuid: string; censusNo: number; frameCode: string; frameName: string | null } | null {
  const r = one<{ uuid: string; census_no: number; code: string; name: string | null }>(
    ctx,
    `SELECT s.uuid, s.census_no, f.code, f.name FROM fw_surveys s JOIN fw_frames f ON f.id = s.frame_id WHERE s.id = ?`,
    [surveyId],
  );
  return r ? { uuid: r.uuid, censusNo: r.census_no, frameCode: r.code, frameName: r.name } : null;
}


// ── a whole census (kept when it is deleted) ────────────────────────────────

/** What a deleted census needs to come back: its plot, series and census
 *  rows, and which quadrats had data (each kept as its own slice). */
export type CensusHeaderDoc = {
  record_type: 'census_header';
  schema: 1;
  frame: Row;
  series: Row;
  survey: Row;
  /** This device's project of the census (projects are local, not in slices). */
  project_id: number;
  quadrats: { uuid: string; quadrat_code: string }[];
};

export function censusHeaderDoc(ctx: { db: SurveyDb }, surveyId: number): CensusHeaderDoc | null {
  const s = getSurvey(ctx, surveyId);
  if (!s) return null;
  const frame = one<Row>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [s.frame_id])!;
  const series = one<Row>(ctx, `SELECT uuid, template_id, series_code FROM fw_frame_series WHERE id = ?`, [s.series_id])!;
  return {
    record_type: 'census_header',
    schema: 1,
    frame: pick(frame, FRAME_COLS),
    series,
    survey: pick(s as unknown as Row, SURVEY_COLS),
    project_id: s.project_id,
    quadrats: rows<{ uuid: string; quadrat_code: string }>(ctx, `SELECT uuid, quadrat_code FROM fw_survey_quadrats WHERE survey_id = ? ORDER BY quadrat_code`, [surveyId]),
  };
}

export function headerSide(h: CensusHeaderDoc): MergeSide {
  return {
    census: [{ key: 'census', data: { ...h.survey, frame: h.frame.uuid, series: h.series.uuid, quadrats: h.quadrats.map((q) => q.uuid) }, label: String(h.survey.census_no) }],
  };
}

export type RecoverError = 'census_no_taken' | 'frame_code_taken' | 'series_code_taken';

export class RecoverCensusError extends Error {
  code: RecoverError;
  constructor(code: RecoverError) {
    super(`recover census: ${code}`);
    this.code = code;
  }
}

/**
 * Rebuild a deleted census under its own uuid: its plot and series if they
 * are gone too (by uuid), then each quadrat's slice. It comes back finished,
 * like other recovered records, so it never takes the active slot; its end
 * time is kept as it was. The caller runs it in a transaction. Returns the
 * census id.
 */
export function recoverCensus(ctx: Ctx, header: CensusHeaderDoc, slices: readonly CensusSlice[]): number {
  const surveyId = insertCensusFromDoc(ctx, header, { status: 'done', projectId: header.project_id });
  for (const sl of slices) restoreSlice(ctx, surveyId, sl);
  return surveyId;
}

/**
 * A census row under its own uuid, with its plot and series (by uuid) if this
 * device lacks them. Shared by recovery and by a census received from a
 * teammate (censusSyncCore.ts). Refuses a plot code another plot holds and a
 * census number its series already has.
 */
export function insertCensusFromDoc(
  ctx: Ctx,
  doc: { frame: Row; series: Row; survey: Row },
  opts: { status: 'active' | 'done'; projectId: number },
): number {
  const header = doc;
  const now = ctx.now();
  let frameId = one<{ id: number }>(ctx, `SELECT id FROM fw_frames WHERE uuid = ?`, [header.frame.uuid as string])?.id;
  if (frameId == null) {
    if (one(ctx, `SELECT id FROM fw_frames WHERE code = ?`, [header.frame.code as string])) throw new RecoverCensusError('frame_code_taken');
    const cols = FRAME_COLS as readonly string[];
    frameId = Number(
      run(ctx, `INSERT INTO fw_frames (${cols.join(', ')}, created_at, updated_at) VALUES (${marks(cols.length)}, ?, ?)`, [...cols.map((c) => header.frame[c] as Scalar), now, now]).insertId,
    );
  }
  let seriesId = one<{ id: number }>(ctx, `SELECT id FROM fw_frame_series WHERE uuid = ?`, [header.series.uuid as string])?.id;
  if (seriesId == null) {
    // Its code taken meanwhile by another template's series on the plot (the
    // template deleted, another census started there): said so, not a raw
    // UNIQUE failure (code review L63).
    if (one(ctx, `SELECT id FROM fw_frame_series WHERE frame_id = ? AND series_code = ?`, [frameId, header.series.series_code as string])) {
      throw new RecoverCensusError('series_code_taken');
    }
    seriesId = Number(
      run(ctx, `INSERT INTO fw_frame_series (uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        header.series.uuid as string,
        frameId,
        header.series.template_id as string,
        header.series.series_code as string,
        now,
        now,
      ]).insertId,
    );
  }
  if (one(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no = ?`, [seriesId, header.survey.census_no as number])) {
    throw new RecoverCensusError('census_no_taken');
  }
  const cols = SURVEY_COLS as readonly string[];
  const project = one(ctx, `SELECT id FROM projects WHERE id = ?`, [opts.projectId]) ? opts.projectId : 0;
  return Number(
    run(ctx, `INSERT INTO fw_surveys (${cols.join(', ')}, style, frame_id, series_id, project_id, created_at, updated_at) VALUES (${marks(cols.length)}, 'individual', ?, ?, ?, ?, ?)`, [
      ...cols.map((c) => (c === 'status' ? opts.status : (header.survey[c] as Scalar))),
      frameId,
      seriesId,
      project,
      now,
      now,
    ]).insertId,
  );
}
