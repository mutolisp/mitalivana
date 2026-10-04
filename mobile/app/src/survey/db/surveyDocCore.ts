/**
 * A checklist / plot-style survey as one document (Phase 2C-b): the unit of
 * its record versions, team merge and team sync (Modular_survey.md §7.2: a
 * whole survey, small next to a census). A permanent plot's unit layout and
 * morphospecies list travel with each of its surveys (§5.5 #9).
 *
 * - buildSurveyDoc: rows by uuid; links as keys (a unit by level + code, an
 *   occurrence by uuid, a frame unit by level + code).
 * - surveyDocSide: the rows as the merge engine compares them. Rows the
 *   schema makes unique by something other than their uuid are keyed by it,
 *   so two copies meet: a unit and a frame unit by level + code (two phones
 *   that each added quadrat Q3 added the same place), a morphospecies by taxon
 *   + label, a value by owner + component + field + idx, a recheck answer by
 *   place + taxon + label. `frame: false` (record versions) leaves the plot's
 *   tables out: restoring one survey must not undo what another added to the
 *   plot.
 * - applySurveyDocOps: writes merge operations back. The plot's layout and
 *   morphospecies are only added to or updated (a used frame unit cannot be
 *   deleted; retiring it is an update).
 * - insertSurveyFromDoc: a survey this device does not have (a recovered one,
 *   a teammate's), with its plot and series by uuid when they are missing.
 *
 * Photo and recording rows travel in the document but are not compared, as
 * in a census: files reach a teammate through file sync, and a restore puts
 * back only rows whose file is still on the device (the caller checks).
 *
 * Interactions (v87, Phase 2F-b) are rows of their own, keyed by uuid, their
 * sides by occurrence uuid; an occurrence made only as an interaction's
 * other side carries `via_interaction: 1` (left out when 0, so a document of
 * a survey without interactions is the one an earlier version wrote).
 *
 * Takes a context (db, clock, uuid) like surveyCore; check:survey-doc runs it
 * under node:sqlite.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { unionSurveyors } from '../../db/merge';
import type { Combiners, MergeOp, MergeRow, MergeSide, Row, TitlePart } from '../../lib/mergeEngine';
import { trackUnion } from '../../lib/track';
import { FRAME_COLS, pick } from './sliceCore';
import { OCCURRENCE_FIELDS, previousSurveyId, snapshotOf, surveyOf } from './surveyCore';
import { SurveyError, type Ctx, type SurveyDb } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ── the document ────────────────────────────────────────────────────────────

const SERIES_COLS = ['uuid', 'template_id', 'series_code'] as const;
export const SURVEY_DOC_COLS = [
  'uuid', 'style', 'name', 'census_no', 'template_id', 'template_version', 'template_snapshot', 'template_hash', 'status',
  'start_ts', 'stop_ts', 'blind_closed_at', 'investigators', 'notes', 'lat', 'lng', 'accuracy',
] as const;
/**
 * v88 (2G-b): the track, its GPS mode and the elevations — written into the
 * document only when set, so a survey without them keeps the document (and
 * the team's sync base) it had before.
 */
export const SURVEY_DOC_OPTIONAL_COLS = ['track_geojson', 'gps_mode', 'elevation_m', 'elevation_source', 'elevation_min_m', 'elevation_max_m'] as const;
const present = (o: Row, keys: readonly string[]): Row => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
const FRAME_UNIT_COLS = ['uuid', 'level_key', 'code', 'label', 'shape', 'x_m', 'y_m', 'width_m', 'length_m', 'radius_m', 'geometry_geojson', 'retired_at'] as const;
const FRAME_LABEL_COLS = ['uuid', 'taxon_id', 'verbatim_identification', 'note', 'photo_uri'] as const;
const UNIT_COLS = ['uuid', 'level_key', 'code', 'label', 'sort', 'lat', 'lng', 'accuracy', 'geometry_geojson', 'notes'] as const;
/** v89 (2G-d): a subplot's size and a quadrat's 完成, written only when set (the document of a survey without them is as before). */
export const UNIT_DOC_OPTIONAL_COLS = ['width_m', 'length_m', 'done_at'] as const;
const OCC_COLS = ['uuid', ...OCCURRENCE_FIELDS.filter((c) => c !== 'unit_id'), 'phase'] as const;
const VALUE_COLS = ['uuid', 'component', 'field', 'idx', 'value_num', 'value_text', 'unit'] as const;
const RECHECK_COLS = ['uuid', 'prev_taxon_id', 'prev_verbatim_identification', 'outcome', 'checked_at'] as const;
const MEDIA_COLS = ['uuid', 'component', 'kind', 'uri', 'created_at'] as const;
const INTER_COLS = ['uuid', 'type_code', 'mutual', 'count', 'observed_at', 'recorded_by', 'notes', 'phase'] as const;

export type SurveyDoc = {
  record_type: 'fw_survey';
  schema: 1;
  /** This device's project for it (a recovered survey goes back there); a teammate's copy ignores it. */
  project_id?: number;
  /** The permanent plot (identity and geometry) and the template's series on it; null without one. */
  frame: Row | null;
  series: Row | null;
  /** The plot's layout (`parent`: a frame unit key) and morphospecies (`first_survey`: a survey uuid). */
  frame_units: Row[];
  frame_labels: Row[];
  survey: Row;
  /** Parents before their sub-units; `parent` is a unit key, `on_frame` 1 when it is the plot's. */
  units: Row[];
  /** `unit`: a unit key or null. */
  occurrences: Row[];
  survey_values: Row[];
  /** `unit`: its unit key. */
  unit_values: Row[];
  /** `occurrence`: its occurrence uuid. */
  occurrence_values: Row[];
  /** `place`: a frame unit key or null; `occurrence`: an occurrence uuid or null. */
  rechecks: Row[];
  /** `unit` / `occurrence` / `interaction`: the owner, all null for the survey's own. */
  media: Row[];
  /**
   * v87: `subject` / `object`: occurrence uuids; `unit`: a unit key or null.
   * Absent in a document written before interactions (read as none).
   */
  interactions?: Row[];
  /**
   * Team sync only: the survey before this one on its plot, so a teammate who
   * does not have it can still do the recheck against its list. Never in a
   * record version (restoring one survey must not touch another).
   */
  previous?: PreviousDoc;
};

/** A carried previous survey: its own rows; the plot's are the document's. No photo rows. */
export type PreviousDoc = Pick<SurveyDoc, 'survey' | 'units' | 'occurrences' | 'survey_values' | 'unit_values' | 'occurrence_values' | 'rechecks'>;

export function isSurveyDoc(doc: unknown): doc is SurveyDoc {
  const d = doc as Partial<SurveyDoc> | null;
  return !!d && d.record_type === 'fw_survey' && d.schema === 1 && typeof d.survey === 'object' && Array.isArray(d.occurrences);
}

/** A unit's key: level + code, unique in a survey and in a plot (UNIQUE level_key, code). */
export const unitKey = (levelKey: unknown, code: unknown) => `${String(levelKey)}:${String(code)}`;
const labelKey = (taxonId: unknown, verbatim: unknown) => `${String(taxonId)}|${String(verbatim ?? '')}`;

/** `previous`: carry the survey before this one (team sync; see SurveyDoc.previous). */
export function buildSurveyDoc(ctx: { db: SurveyDb }, surveyId: number, opts: { previous?: boolean } = {}): SurveyDoc {
  const s = surveyOf(ctx, surveyId);
  const prevId = opts.previous ? previousSurveyId(ctx, surveyId) : null;
  const frame = s.frame_id == null ? null : one<Row>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [s.frame_id]);
  const series = s.series_id == null ? null : one<Row>(ctx, `SELECT * FROM fw_frame_series WHERE id = ?`, [s.series_id]);
  const fUnits = s.frame_id == null ? [] : rows<Row & { id: number; parent_id: number | null }>(ctx, `SELECT * FROM fw_frame_units WHERE frame_id = ? ORDER BY id`, [s.frame_id]);
  const fKey = new Map(fUnits.map((u) => [u.id, unitKey(u.level_key, u.code)]));
  const fLabels = s.frame_id == null
    ? []
    : rows<Row>(
        ctx,
        `SELECT l.*, fs.uuid AS first_survey FROM fw_frame_labels l LEFT JOIN fw_surveys fs ON fs.id = l.first_survey_id WHERE l.frame_id = ? ORDER BY l.id`,
        [s.frame_id],
      );
  const depth = new Map((snapshotOf(s).units ?? []).map((u, i) => [u.key, i]));
  const units = rows<Row & { id: number; parent_id: number | null; frame_unit_id: number | null }>(ctx, `SELECT * FROM fw_units WHERE survey_id = ? ORDER BY sort, code, id`, [surveyId]).sort(
    (a, b) => (depth.get(a.level_key as string) ?? 99) - (depth.get(b.level_key as string) ?? 99),
  );
  const uKey = new Map(units.map((u) => [u.id, unitKey(u.level_key, u.code)]));
  const occs = rows<Row & { id: number; unit_id: number | null; via_interaction: number }>(ctx, `SELECT * FROM fw_occurrences WHERE survey_id = ? ORDER BY id`, [surveyId]);
  const oUuid = new Map(occs.map((o) => [o.id, o.uuid as string]));
  const inters = rows<Row & { id: number; unit_id: number | null; subject_occurrence_id: number; object_occurrence_id: number }>(
    ctx,
    `SELECT * FROM fw_interactions WHERE survey_id = ? ORDER BY id`,
    [surveyId],
  );
  const iUuid = new Map(inters.map((i) => [i.id, i.uuid as string]));
  return {
    record_type: 'fw_survey',
    schema: 1,
    project_id: s.project_id,
    frame: frame ? pick(frame, FRAME_COLS) : null,
    series: series ? pick(series, SERIES_COLS) : null,
    frame_units: fUnits.map((u) => ({ ...pick(u, FRAME_UNIT_COLS), parent: u.parent_id == null ? null : (fKey.get(u.parent_id) ?? null) })),
    frame_labels: fLabels.map((l) => ({ ...pick(l, FRAME_LABEL_COLS), first_survey: l.first_survey ?? null })),
    survey: { ...pick(s as unknown as Row, SURVEY_DOC_COLS), ...present(s as unknown as Row, SURVEY_DOC_OPTIONAL_COLS) },
    units: units.map((u) => ({ ...pick(u, UNIT_COLS), ...present(u, UNIT_DOC_OPTIONAL_COLS), parent: u.parent_id == null ? null : (uKey.get(u.parent_id) ?? null), on_frame: u.frame_unit_id == null ? null : 1 })),
    occurrences: occs.map((o) => ({ ...pick(o, OCC_COLS), unit: o.unit_id == null ? null : (uKey.get(o.unit_id) ?? null), ...(o.via_interaction ? { via_interaction: 1 } : {}) })),
    survey_values: rows<Row>(ctx, `SELECT * FROM fw_survey_values WHERE survey_id = ? ORDER BY id`, [surveyId]).map((v) => pick(v, VALUE_COLS)),
    unit_values: rows<Row & { unit_id: number }>(ctx, `SELECT v.* FROM fw_unit_values v JOIN fw_units u ON u.id = v.unit_id WHERE u.survey_id = ? ORDER BY v.id`, [surveyId]).map((v) => ({
      ...pick(v, VALUE_COLS),
      unit: uKey.get(v.unit_id) ?? null,
    })),
    occurrence_values: rows<Row & { occurrence_id: number }>(
      ctx,
      `SELECT v.* FROM fw_occurrence_values v JOIN fw_occurrences o ON o.id = v.occurrence_id WHERE o.survey_id = ? ORDER BY v.id`,
      [surveyId],
    ).map((v) => ({ ...pick(v, VALUE_COLS), occurrence: oUuid.get(v.occurrence_id) ?? null })),
    rechecks: rows<Row & { frame_unit_id: number | null; occurrence_id: number | null }>(ctx, `SELECT * FROM fw_rechecks WHERE survey_id = ? ORDER BY id`, [surveyId]).map((r) => ({
      ...pick(r, RECHECK_COLS),
      place: r.frame_unit_id == null ? null : (fKey.get(r.frame_unit_id) ?? null),
      occurrence: r.occurrence_id == null ? null : (oUuid.get(r.occurrence_id) ?? null),
    })),
    media: rows<Row & { unit_id: number | null; occurrence_id: number | null; interaction_id: number | null }>(ctx, `SELECT * FROM fw_media WHERE survey_id = ? ORDER BY id`, [surveyId]).map((m) => ({
      ...pick(m, MEDIA_COLS),
      unit: m.unit_id == null ? null : (uKey.get(m.unit_id) ?? null),
      occurrence: m.occurrence_id == null ? null : (oUuid.get(m.occurrence_id) ?? null),
      interaction: m.interaction_id == null ? null : (iUuid.get(m.interaction_id) ?? null),
    })),
    interactions: inters.map((i) => ({
      ...pick(i, INTER_COLS),
      subject: oUuid.get(i.subject_occurrence_id) ?? null,
      object: oUuid.get(i.object_occurrence_id) ?? null,
      unit: i.unit_id == null ? null : (uKey.get(i.unit_id) ?? null),
    })),
    ...(prevId == null ? {} : { previous: carried(buildSurveyDoc(ctx, prevId)) }),
  };
}

const carried = (d: SurveyDoc): PreviousDoc => ({
  survey: d.survey,
  units: d.units,
  occurrences: d.occurrences,
  survey_values: d.survey_values,
  unit_values: d.unit_values,
  occurrence_values: d.occurrence_values,
  rechecks: d.rechecks,
});

// ── as merge rows ───────────────────────────────────────────────────────────

const omit = (o: Row, keys: readonly string[]): Row => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const valueKey = (owner: unknown, v: Row) => `${owner}|${v.component}|${v.field}|${v.idx}`;
const nums = (a: unknown, b: unknown) => [a, b].filter((v): v is number => typeof v === 'number');

/** The newer template of the two (an additive upgrade on either phone). */
const newerTemplate = (a: unknown, b: unknown) => {
  const va = Number((a as Row | null)?.template_version ?? 0);
  const vb = Number((b as Row | null)?.template_version ?? 0);
  return vb > va ? b : a;
};

/**
 * Combined, never asked about: investigators pooled, the earlier start, the
 * later end (still open here stays open), the blind phase closed on either
 * phone (then it is closed for the team), and the newer template.
 */
export const SURVEY_DOC_COMBINERS: Combiners = {
  survey: {
    investigators: (a, b) => unionSurveyors([(a as string) ?? null, (b as string) ?? null]),
    start_ts: (a, b) => (nums(a, b).length ? Math.min(...nums(a, b)) : null),
    stop_ts: (a, b) => (a == null ? null : nums(a, b).length ? Math.max(...nums(a, b)) : null),
    blind_closed_at: (a, b) => (nums(a, b).length ? Math.min(...nums(a, b)) : null),
    template: newerTemplate,
    // Each phone's walk is kept (as on 快速名錄); a track on either makes it a tracked survey.
    track_geojson: trackUnion,
    gps_mode: (a, b) => (a === 'full_track' || b === 'full_track' ? 'full_track' : ((a ?? b ?? null) as string | null)),
    // The range of altitudes walked through, on either phone.
    elevation_min_m: (a, b) => (nums(a, b).length ? Math.min(...nums(a, b)) : null),
    elevation_max_m: (a, b) => (nums(a, b).length ? Math.max(...nums(a, b)) : null),
  },
};
const SURVEY_COMBINED = ['investigators', 'start_ts', 'stop_ts', 'blind_closed_at', 'track_geojson', 'gps_mode', 'elevation_min_m', 'elevation_max_m'] as const;
/** Identity and per-device state, not compared. */
const SURVEY_OUT = ['uuid', 'style', 'census_no', 'status', 'template_id', 'template_version', 'template_snapshot', 'template_hash', ...SURVEY_COMBINED];
/** Columns a document never writes on its own: identity, owner, state, template (applySurveyDocOps.clean). */
const DOC_KEPT = new Set(['id', 'uuid', 'survey_id', 'frame_id', 'series_id', 'project_id', 'status', 'style', 'census_no', 'template_id', 'template_version', 'template_snapshot', 'template_hash', 'created_at', 'updated_at']);
const templateOf = (s: Row): Row => pick(s, ['template_id', 'template_version', 'template_snapshot', 'template_hash']);

/** Names for row labels (the review screen): an occurrence's taxon, if known. */
export type SideNames = (taxonId: string) => string | null;
/** A taxon's rank and kingdom, so the review can italicise its name by rank. */
export type SideRanks = (taxonId: string) => { rank: string | null; kingdom: string | null } | null;

/** A unit key as the review shows it: its code (the level is the template's key, not a word). */
const codeOf = (key: unknown) => (key == null ? undefined : String(key).slice(String(key).indexOf(':') + 1));

export function surveyDocSide(doc: SurveyDoc, opts: { frame?: boolean; names?: SideNames; ranks?: SideRanks } = {}): MergeSide {
  const name = (o: Row) => (o.verbatim_identification as string | null) || (o.used_scientific_name as string | null) || opts.names?.(o.taxon_id as string) || String(o.taxon_id);
  const occName = new Map(doc.occurrences.map((o) => [o.uuid as string, name(o)]));
  /** The name as a title part: a label as it is, else the scientific name with its rank. */
  const part = (taxonId: unknown, verbatim: unknown, used?: unknown): TitlePart => {
    if (verbatim) return String(verbatim);
    const r = opts.ranks?.(String(taxonId));
    return { sci: (used as string | null) || opts.names?.(String(taxonId)) || String(taxonId), rank: r?.rank ?? null, kingdom: r?.kingdom ?? null };
  };
  const occPart = new Map(doc.occurrences.map((o) => [o.uuid as string, part(o.taxon_id, o.verbatim_identification, o.used_scientific_name)]));
  const side: MergeSide = {
    survey: [
      {
        key: 'survey',
        data: omit(doc.survey, SURVEY_OUT),
        extra: { ...pick(doc.survey, SURVEY_COMBINED), template: templateOf(doc.survey) },
        label: String(doc.survey.name ?? ''),
      },
    ],
    sunit: doc.units.map((u) => ({
      key: unitKey(u.level_key, u.code),
      data: omit(u, ['uuid', 'level_key', 'code', 'sort', 'on_frame']),
      extra: { uuid: u.uuid, sort: u.sort ?? 0, on_frame: u.on_frame ?? null },
      label: String(u.code),
    })),
    occ: doc.occurrences.map((o) => ({
      key: o.uuid as string,
      data: omit(o, ['uuid']),
      dupKey: `${o.unit ?? ''}|${o.taxon_id}|${o.verbatim_identification ?? ''}`,
      label: name(o),
      title: [occPart.get(o.uuid as string)!],
      group: codeOf(o.unit),
    })),
    surveyval: doc.survey_values.map((v) => ({ key: valueKey('survey', v), data: omit(v, ['uuid']), extra: { uuid: v.uuid }, label: `${v.component} ${v.field}` })),
    unitval: doc.unit_values.map((v) => ({
      key: valueKey(v.unit, v),
      data: omit(v, ['uuid', 'unit']),
      extra: { uuid: v.uuid },
      label: `${v.component} ${v.field}`,
      group: codeOf(v.unit),
    })),
    occval: doc.occurrence_values.map((v) => ({
      key: valueKey(v.occurrence, v),
      data: omit(v, ['uuid', 'occurrence']),
      extra: { uuid: v.uuid },
      label: `${occName.get(v.occurrence as string) ?? '?'} ${v.field}`,
      title: [occPart.get(v.occurrence as string) ?? '?', ` ${v.field}`],
    })),
    inter: (doc.interactions ?? []).map((i) => ({
      key: i.uuid as string,
      data: omit(i, ['uuid']),
      label: `${occName.get(i.subject as string) ?? '?'} ${i.mutual ? '↔' : '→'} ${occName.get(i.object as string) ?? '?'}`,
      title: [occPart.get(i.subject as string) ?? '?', ` ${i.mutual ? '↔' : '→'} `, occPart.get(i.object as string) ?? '?'],
      group: codeOf(i.unit),
    })),
    recheck: doc.rechecks.map((r) => ({
      key: `${r.place ?? ''}|${labelKey(r.prev_taxon_id, r.prev_verbatim_identification)}`,
      data: { outcome: r.outcome, occurrence: r.occurrence ?? null },
      extra: { uuid: r.uuid, checked_at: r.checked_at },
      label: (r.prev_verbatim_identification as string) || opts.names?.(r.prev_taxon_id as string) || String(r.prev_taxon_id),
      title: [part(r.prev_taxon_id, r.prev_verbatim_identification)],
      group: codeOf(r.place),
    })),
  };
  if (opts.frame === false) return side;
  return {
    funit: doc.frame_units.map((u) => ({
      key: unitKey(u.level_key, u.code),
      data: omit(u, ['uuid', 'level_key', 'code']),
      extra: { uuid: u.uuid },
      label: String(u.code),
    })),
    flabel: doc.frame_labels.map((l) => ({
      key: labelKey(l.taxon_id, l.verbatim_identification),
      data: { note: l.note ?? null },
      extra: { uuid: l.uuid, photo_uri: l.photo_uri ?? null, first_survey: l.first_survey ?? null },
      label: String(l.verbatim_identification),
    })),
    ...side,
  };
}

// ── writing operations back ─────────────────────────────────────────────────

/** Insert order; deletes run the other way. The plot's tables come first; deleteRow never deletes from them or the survey. */
const ORDER = ['funit', 'flabel', 'survey', 'sunit', 'surveyval', 'unitval', 'occ', 'occval', 'inter', 'recheck'] as const;
const VALUE_TABLE = {
  surveyval: { table: 'fw_survey_values', owner: 'survey_id' },
  unitval: { table: 'fw_unit_values', owner: 'unit_id' },
  occval: { table: 'fw_occurrence_values', owner: 'occurrence_id' },
} as const;

const splitValueKey = (key: string) => {
  // owner|component|field|idx, where the owner may itself hold '|' (never: unit keys and uuids do not).
  const [owner, component, field, idx] = key.split('|');
  return { owner, component, field, idx: Number(idx) };
};
const splitUnitKey = (key: string) => {
  const at = key.indexOf(':');
  return { level: key.slice(0, at), code: key.slice(at + 1) };
};

/**
 * Write merge operations onto a survey, parents before children. Returns the
 * number of rows written. Keys that do not resolve here (a value of an
 * occurrence that is not here) are skipped: the next merge brings them.
 */
export function applySurveyDocOps(ctx: Ctx, surveyId: number, ops: readonly MergeOp[]): number {
  const s = surveyOf(ctx, surveyId);
  const now = ctx.now();
  const frameUnitId = (key: string | null | undefined): number | null => {
    if (key == null || s.frame_id == null) return null;
    const { level, code } = splitUnitKey(key);
    return one<{ id: number }>(ctx, `SELECT id FROM fw_frame_units WHERE frame_id = ? AND level_key = ? AND code = ?`, [s.frame_id, level, code])?.id ?? null;
  };
  const unitId = (key: string | null | undefined): number | null => {
    if (key == null) return null;
    const { level, code } = splitUnitKey(key);
    return one<{ id: number }>(ctx, `SELECT id FROM fw_units WHERE survey_id = ? AND level_key = ? AND code = ?`, [surveyId, level, code])?.id ?? null;
  };
  const occId = (uuid: string | null | undefined): number | null =>
    uuid == null ? null : (one<{ id: number }>(ctx, `SELECT id FROM fw_occurrences WHERE survey_id = ? AND uuid = ?`, [surveyId, uuid])?.id ?? null);
  const surveyIdOf = (uuid: string | null | undefined): number | null =>
    uuid == null ? null : (one<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE uuid = ?`, [uuid])?.id ?? null);
  // A document's keys come from a file or a teammate, and become column names
  // here: only a table's own data columns pass — not its identity, owner,
  // state or template, and not the references this code works out itself
  // (`drop`). A key that is not a column at all was SQL in the statement
  // (code review M3, 2026-10-04).
  const columns = new Map<string, Set<string>>();
  const known = (table: string): Set<string> => {
    let c = columns.get(table);
    if (!c) columns.set(table, (c = new Set(rows<{ name: string }>(ctx, `PRAGMA table_info(${table})`).map((r) => r.name))));
    return c;
  };
  const clean = (table: string, data: Row, drop: readonly string[] = []): Row =>
    Object.fromEntries(Object.entries(data).filter(([k]) => known(table).has(k) && !DOC_KEPT.has(k) && !drop.includes(k)));
  const columnsOnly = (table: string, keys: readonly string[]) => {
    const bad = keys.find((k) => !known(table).has(k));
    if (bad !== undefined) throw new Error(`${table} has no column ${JSON.stringify(bad)}`);
  };
  const set = (table: string, id: number, cols: Row) => {
    const keys = Object.keys(cols);
    if (!keys.length) return;
    columnsOnly(table, keys);
    run(ctx, `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => cols[k] as Scalar), now, id]);
  };
  const insert = (table: string, cols: Row) => {
    const keys = Object.keys(cols);
    columnsOnly(table, keys);
    return Number(run(ctx, `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${marks(keys.length)})`, keys.map((k) => cols[k] as Scalar)).insertId);
  };
  let written = 0;
  const byTable = (tbl: string) => ops.filter((o) => o.tbl === tbl);

  // Deletes first, children before parents.
  for (const tbl of [...ORDER].reverse()) {
    for (const op of byTable(tbl)) {
      if (op.op !== 'delete') continue;
      written += deleteRow(ctx, surveyId, tbl, op.key, { unitId, occId, frameUnitId });
    }
  }
  for (const tbl of ORDER) {
    for (const op of byTable(tbl)) {
      if (op.op === 'delete') continue;
      const data: Row = op.op === 'insert' ? op.row.data : op.data;
      const extra: Row = (op.op === 'insert' ? op.row.extra : op.extra) ?? {};
      const key = op.op === 'insert' ? op.row.key : op.key;
      switch (tbl) {
        case 'funit': {
          if (s.frame_id == null) break;
          const { level, code } = splitUnitKey(key);
          const cols: Row = { ...clean('fw_frame_units', data, ['parent_id']), parent_id: data.parent === undefined ? undefined : frameUnitId(data.parent as string | null) };
          if (cols.parent_id === undefined) delete cols.parent_id;
          const id = frameUnitId(key);
          if (id != null) set('fw_frame_units', id, cols);
          else
            insert('fw_frame_units', {
              uuid: (extra.uuid as string) ?? ctx.uuid(),
              frame_id: s.frame_id,
              level_key: level,
              code,
              shape: 'rect',
              ...cols,
              created_at: now,
              updated_at: now,
            });
          written += 1;
          break;
        }
        case 'flabel': {
          if (s.frame_id == null) break;
          const at = key.indexOf('|');
          const taxonId = key.slice(0, at);
          const verbatim = key.slice(at + 1);
          const found = one<{ id: number; photo_uri: string | null }>(ctx, `SELECT id, photo_uri FROM fw_frame_labels WHERE frame_id = ? AND taxon_id = ? AND verbatim_identification = ?`, [
            s.frame_id,
            taxonId,
            verbatim,
          ]);
          if (found) set('fw_frame_labels', found.id, clean('fw_frame_labels', data, ['taxon_id', 'verbatim_identification', 'photo_uri', 'first_survey_id']));
          else
            insert('fw_frame_labels', {
              uuid: (extra.uuid as string) ?? ctx.uuid(),
              frame_id: s.frame_id,
              taxon_id: taxonId,
              verbatim_identification: verbatim,
              note: (data.note as string | null) ?? null,
              // A photo arrives through file sync; the uri is the sender's.
              photo_uri: null,
              first_survey_id: surveyIdOf(extra.first_survey as string | null),
              created_at: now,
              updated_at: now,
            });
          written += 1;
          break;
        }
        case 'survey': {
          const cols: Row = clean('fw_surveys', data, ['site_id']);
          for (const f of SURVEY_COMBINED) if (f in extra) cols[f] = extra[f];
          // A closed blind phase stays closed: the previous list has been seen (reopenBlindPhase has its own rule).
          if (cols.blind_closed_at == null && s.blind_closed_at != null) delete cols.blind_closed_at;
          const t = extra.template as Row | undefined;
          if (t && Number(t.template_version) > s.template_version && t.template_id === s.template_id) Object.assign(cols, templateOf(t));
          set('fw_surveys', surveyId, cols);
          written += 1;
          break;
        }
        case 'sunit': {
          const { level, code } = splitUnitKey(key);
          const cols: Row = clean('fw_units', data, ['parent_id', 'frame_unit_id', 'level_key', 'code']);
          if ('parent' in data) cols.parent_id = unitId(data.parent as string | null);
          if ('sort' in extra) cols.sort = extra.sort;
          const id = unitId(key);
          if (id != null) set('fw_units', id, cols);
          else {
            // On a plot, a unit is the plot's: its frame unit came with the plot's rows (funit, above).
            let fu = frameUnitId(key);
            if (s.frame_id != null && fu == null)
              fu = insert('fw_frame_units', { uuid: ctx.uuid(), frame_id: s.frame_id, level_key: level, code, shape: 'rect', created_at: now, updated_at: now });
            insert('fw_units', { uuid: (extra.uuid as string) ?? ctx.uuid(), survey_id: surveyId, frame_unit_id: fu, level_key: level, code, ...cols, created_at: now, updated_at: now });
          }
          written += 1;
          break;
        }
        case 'occ': {
          const cols: Row = clean('fw_occurrences', data, ['unit_id']);
          if ('unit' in data) cols.unit_id = unitId(data.unit as string | null);
          // Left out of the document when 0, so a field-by-field update may bring null.
          if ('via_interaction' in cols) cols.via_interaction = cols.via_interaction ? 1 : 0;
          const id = occId(key);
          if (id != null) set('fw_occurrences', id, cols);
          else insert('fw_occurrences', { uuid: key, survey_id: surveyId, ...cols, observed_at: (cols.observed_at as number | null) ?? now, created_at: now, updated_at: now });
          written += 1;
          break;
        }
        case 'surveyval':
        case 'unitval':
        case 'occval': {
          const v = VALUE_TABLE[tbl];
          const k = splitValueKey(key);
          const owner = tbl === 'surveyval' ? surveyId : tbl === 'unitval' ? unitId(k.owner) : occId(k.owner);
          if (owner == null) break;
          const found = one<{ id: number }>(ctx, `SELECT id FROM ${v.table} WHERE ${v.owner} = ? AND component = ? AND field = ? AND idx = ?`, [owner, k.component, k.field, k.idx]);
          const cols = clean(v.table, data, ['component', 'field', 'idx', v.owner]);
          if (found) set(v.table, found.id, cols);
          else insert(v.table, { uuid: (extra.uuid as string) ?? ctx.uuid(), [v.owner]: owner, component: k.component, field: k.field, idx: k.idx, ...cols, updated_at: now });
          written += 1;
          break;
        }
        case 'inter': {
          const cols: Row = clean('fw_interactions', data, ['subject_occurrence_id', 'object_occurrence_id', 'unit_id']);
          if ('subject' in data) cols.subject_occurrence_id = occId(data.subject as string | null);
          if ('object' in data) cols.object_occurrence_id = occId(data.object as string | null);
          if ('unit' in data) cols.unit_id = unitId(data.unit as string | null);
          if ('mutual' in cols) cols.mutual = cols.mutual ? 1 : 0;
          // A side that is not here (yet): the next merge brings it.
          if (cols.subject_occurrence_id === null || cols.object_occurrence_id === null) break;
          const found = one<{ id: number }>(ctx, `SELECT id FROM fw_interactions WHERE survey_id = ? AND uuid = ?`, [surveyId, key]);
          if (found) set('fw_interactions', found.id, cols);
          else {
            if (cols.subject_occurrence_id === undefined || cols.object_occurrence_id === undefined || !cols.type_code) break;
            insert('fw_interactions', { uuid: key, survey_id: surveyId, mutual: 0, ...cols, observed_at: (cols.observed_at as number | null) ?? now, created_at: now, updated_at: now });
          }
          written += 1;
          break;
        }
        case 'recheck': {
          const bar = key.indexOf('|');
          const place = key.slice(0, bar) || null;
          const rest = key.slice(bar + 1);
          const at = rest.indexOf('|');
          const taxonId = rest.slice(0, at);
          const verbatim = rest.slice(at + 1);
          const fu = place == null ? null : frameUnitId(place);
          if (place != null && fu == null) break;
          const cols: Row = {};
          if ('outcome' in data) cols.outcome = data.outcome;
          if ('occurrence' in data) cols.occurrence_id = occId(data.occurrence as string | null);
          const found = one<{ id: number }>(
            ctx,
            `SELECT id FROM fw_rechecks WHERE survey_id = ? AND frame_unit_id IS ? AND prev_taxon_id = ? AND prev_verbatim_identification = ?`,
            [surveyId, fu, taxonId, verbatim],
          );
          if (found) set('fw_rechecks', found.id, cols);
          else
            insert('fw_rechecks', {
              uuid: (extra.uuid as string) ?? ctx.uuid(),
              survey_id: surveyId,
              frame_unit_id: fu,
              prev_taxon_id: taxonId,
              prev_verbatim_identification: verbatim,
              ...cols,
              checked_at: (extra.checked_at as number | null) ?? now,
              updated_at: now,
            });
          written += 1;
          break;
        }
      }
    }
  }
  run(ctx, `UPDATE fw_surveys SET updated_at = ? WHERE id = ?`, [now, surveyId]);
  return written;
}

function deleteRow(
  ctx: Ctx,
  surveyId: number,
  tbl: string,
  key: string,
  ids: { unitId: (k: string) => number | null; occId: (u: string) => number | null; frameUnitId: (k: string) => number | null },
): number {
  switch (tbl) {
    case 'sunit': {
      const id = ids.unitId(key);
      if (id == null) return 0;
      // As deleteUnit: its occurrences and sub-units move up, its own values and photos go.
      const parent = one<{ parent_id: number | null }>(ctx, `SELECT parent_id FROM fw_units WHERE id = ?`, [id])?.parent_id ?? null;
      run(ctx, `UPDATE fw_units SET parent_id = ? WHERE parent_id = ?`, [parent, id]);
      run(ctx, `UPDATE fw_occurrences SET unit_id = ? WHERE unit_id = ?`, [parent, id]);
      run(ctx, `DELETE FROM fw_unit_values WHERE unit_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_media WHERE unit_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_units WHERE id = ?`, [id]);
      return 1;
    }
    case 'inter': {
      const id = one<{ id: number }>(ctx, `SELECT id FROM fw_interactions WHERE survey_id = ? AND uuid = ?`, [surveyId, key])?.id;
      if (id == null) return 0;
      run(ctx, `DELETE FROM fw_media WHERE interaction_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_interactions WHERE id = ?`, [id]);
      return 1;
    }
    case 'occ': {
      const id = ids.occId(key);
      if (id == null) return 0;
      // Its interactions go with it (foreign keys are off during cleanup).
      run(ctx, `DELETE FROM fw_media WHERE interaction_id IN (SELECT id FROM fw_interactions WHERE subject_occurrence_id = ? OR object_occurrence_id = ?)`, [id, id]);
      run(ctx, `DELETE FROM fw_interactions WHERE subject_occurrence_id = ? OR object_occurrence_id = ?`, [id, id]);
      run(ctx, `DELETE FROM fw_rechecks WHERE occurrence_id = ? AND outcome = 'found'`, [id]);
      run(ctx, `UPDATE fw_rechecks SET occurrence_id = NULL WHERE occurrence_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_occurrence_values WHERE occurrence_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_media WHERE occurrence_id = ?`, [id]);
      run(ctx, `DELETE FROM fw_occurrences WHERE id = ?`, [id]);
      return 1;
    }
    case 'surveyval':
    case 'unitval':
    case 'occval': {
      const v = VALUE_TABLE[tbl];
      const k = splitValueKey(key);
      const owner = tbl === 'surveyval' ? surveyId : tbl === 'unitval' ? ids.unitId(k.owner) : ids.occId(k.owner);
      if (owner == null) return 0;
      run(ctx, `DELETE FROM ${v.table} WHERE ${v.owner} = ? AND component = ? AND field = ? AND idx = ?`, [owner, k.component, k.field, k.idx]);
      return 1;
    }
    case 'recheck': {
      const bar = key.indexOf('|');
      const place = key.slice(0, bar) || null;
      const rest = key.slice(bar + 1);
      const at = rest.indexOf('|');
      const fu = place == null ? null : ids.frameUnitId(place);
      run(ctx, `DELETE FROM fw_rechecks WHERE survey_id = ? AND frame_unit_id IS ? AND prev_taxon_id = ? AND prev_verbatim_identification = ?`, [
        surveyId,
        fu,
        rest.slice(0, at),
        rest.slice(at + 1),
      ]);
      return 1;
    }
    default:
      return 0;
  }
}

/** Every row of a document as insert operations (a survey new on this device). */
export function fillOps(side: MergeSide): MergeOp[] {
  return ORDER.flatMap((tbl) => (side[tbl] ?? []).map((row: MergeRow): MergeOp => (tbl === 'survey' ? { op: 'update', tbl, key: row.key, data: row.data, extra: row.extra } : { op: 'insert', tbl, row })));
}

export type InsertError = 'frame_code_taken' | 'number_taken';

export class InsertSurveyError extends Error {
  code: InsertError;
  constructor(code: InsertError) {
    super(`survey doc: ${code}`);
    this.code = code;
  }
}

/**
 * A survey this device does not have, under the document's uuid, with its
 * permanent plot and series (by uuid) when they are missing; then every row.
 * `status`: a recovered survey comes back finished, so it never takes the
 * single-active slot. Refuses a plot code another plot holds and a number its
 * series already has. The caller runs it in a transaction. Returns the id.
 */
export function insertSurveyFromDoc(ctx: Ctx, doc: SurveyDoc, opts: { status: 'active' | 'done'; projectId: number }): number {
  const now = ctx.now();
  let frameId: number | null = null;
  let seriesId: number | null = null;
  if (doc.frame) {
    frameId = one<{ id: number }>(ctx, `SELECT id FROM fw_frames WHERE uuid = ?`, [doc.frame.uuid as string])?.id ?? null;
    if (frameId == null) {
      if (one(ctx, `SELECT id FROM fw_frames WHERE code = ?`, [doc.frame.code as string])) throw new InsertSurveyError('frame_code_taken');
      const cols = FRAME_COLS as readonly string[];
      frameId = Number(run(ctx, `INSERT INTO fw_frames (${cols.join(', ')}, created_at, updated_at) VALUES (${marks(cols.length)}, ?, ?)`, [...cols.map((c) => doc.frame![c] as Scalar), now, now]).insertId);
    }
  }
  if (doc.series && frameId != null) {
    seriesId =
      one<{ id: number }>(ctx, `SELECT id FROM fw_frame_series WHERE uuid = ?`, [doc.series.uuid as string])?.id ??
      one<{ id: number }>(ctx, `SELECT id FROM fw_frame_series WHERE frame_id = ? AND template_id = ?`, [frameId, doc.series.template_id as string])?.id ??
      null;
    if (seriesId == null)
      seriesId = Number(
        run(ctx, `INSERT INTO fw_frame_series (uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
          doc.series.uuid as string,
          frameId,
          doc.series.template_id as string,
          doc.series.series_code as string,
          now,
          now,
        ]).insertId,
      );
    if (one(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no = ?`, [seriesId, doc.survey.census_no as number])) throw new InsertSurveyError('number_taken');
  }
  // The v88 columns come with applySurveyDocOps below (data and combined fields).
  const cols = SURVEY_DOC_COLS as readonly string[];
  const project = one(ctx, `SELECT id FROM projects WHERE id = ?`, [opts.projectId]) ? opts.projectId : 0;
  const surveyId = Number(
    run(ctx, `INSERT INTO fw_surveys (${cols.join(', ')}, frame_id, series_id, project_id, created_at, updated_at) VALUES (${marks(cols.length)}, ?, ?, ?, ?, ?)`, [
      ...cols.map((c) => (c === 'status' ? opts.status : c === 'census_no' && seriesId == null ? null : (doc.survey[c] as Scalar))),
      frameId,
      seriesId,
      project,
      now,
      now,
    ]).insertId,
  );
  applySurveyDocOps(ctx, surveyId, fillOps(surveyDocSide(doc)));
  return surveyId;
}

/**
 * Put back the document's photo and recording rows that are missing here and
 * whose file is still on this device (`present`), adding only; and a
 * morphospecies' photo where its label here has none. Returns how many came
 * back.
 */
export function putBackMediaRows(ctx: Ctx, surveyId: number, doc: SurveyDoc, present: (uri: string) => boolean, sealed: ReadonlySet<string> = new Set()): number {
  let n = 0;
  for (const m of doc.media) {
    if (one(ctx, `SELECT 1 AS x FROM fw_media WHERE uuid = ?`, [m.uuid as string])) continue;
    if (m.occurrence != null && sealed.has(String(m.occurrence))) continue;
    if (m.interaction != null && sealed.has(String(m.interaction))) continue;
    if (!present(String(m.uri))) continue;
    const unit = m.unit == null ? null : (() => {
      const { level, code } = splitUnitKey(String(m.unit));
      return one<{ id: number }>(ctx, `SELECT id FROM fw_units WHERE survey_id = ? AND level_key = ? AND code = ?`, [surveyId, level, code])?.id ?? null;
    })();
    const occ = m.occurrence == null ? null : (one<{ id: number }>(ctx, `SELECT id FROM fw_occurrences WHERE survey_id = ? AND uuid = ?`, [surveyId, m.occurrence as string])?.id ?? null);
    const inter = m.interaction == null ? null : (one<{ id: number }>(ctx, `SELECT id FROM fw_interactions WHERE survey_id = ? AND uuid = ?`, [surveyId, m.interaction as string])?.id ?? null);
    // Its owner is gone: the photo has nowhere to go.
    if ((m.unit != null && unit == null) || (m.occurrence != null && occ == null) || (m.interaction != null && inter == null)) continue;
    run(ctx, `INSERT INTO fw_media (uuid, survey_id, unit_id, occurrence_id, interaction_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      m.uuid as string,
      surveyId,
      unit,
      occ,
      inter,
      m.component as string,
      m.kind as string,
      m.uri as string,
      (m.created_at as number | null) ?? ctx.now(),
    ]);
    n += 1;
  }
  const frameId = one<{ f: number | null }>(ctx, `SELECT frame_id AS f FROM fw_surveys WHERE id = ?`, [surveyId])?.f ?? null;
  if (frameId != null) {
    for (const l of doc.frame_labels) {
      const uri = l.photo_uri == null ? '' : String(l.photo_uri);
      if (!uri || !present(uri)) continue;
      const res = run(
        ctx,
        `UPDATE fw_frame_labels SET photo_uri = ?, updated_at = ? WHERE frame_id = ? AND taxon_id = ? AND verbatim_identification = ? AND photo_uri IS NULL`,
        [uri, ctx.now(), frameId, l.taxon_id as string, l.verbatim_identification as string],
      );
      n += res.rowsAffected ?? 0;
    }
  }
  return n;
}

/** What a closed blind phase seals: blind occurrences and interactions (uuid) and the units the occurrences sit in (level:code). */
export type Sealed = { occ: Set<string>; unit: Set<string>; inter: Set<string> };

/** The owners a sealed record's photos hang on (occurrence and interaction uuids), for putBackMediaRows. */
export const sealedOwners = (s: Sealed | null | undefined): Set<string> => new Set(s ? [...s.occ, ...s.inter] : []);

/**
 * The blind records a closed blind phase has sealed (§5.5): every blind
 * occurrence of either document, once the survey here has closed it, and the
 * units holding one here (with their parents). A restore leaves them as they
 * are — undoing a blind record after the previous list was seen is what
 * sealing prevents — and does not remove such a unit (that would move the
 * record). A merge does not use this: a teammate still blind may add or
 * correct theirs.
 */
export function sealedOccurrences(here: SurveyDoc, other: SurveyDoc): Sealed {
  const out: Sealed = { occ: new Set(), unit: new Set(), inter: new Set() };
  if (here.survey.blind_closed_at == null) return out;
  for (const o of [...here.occurrences, ...other.occurrences]) if (o.phase === 'blind') out.occ.add(String(o.uuid));
  for (const i of [...(here.interactions ?? []), ...(other.interactions ?? [])]) if (i.phase === 'blind') out.inter.add(String(i.uuid));
  const parentOf = new Map(here.units.map((u) => [unitKey(u.level_key, u.code), (u.parent as string | null) ?? null]));
  for (const o of here.occurrences) {
    if (o.phase !== 'blind') continue;
    for (let u = (o.unit as string | null) ?? null; u != null && !out.unit.has(u); u = parentOf.get(u) ?? null) out.unit.add(u);
  }
  return out;
}

/** Restore items without those that would touch a sealed record: its row, its values, its interactions, removing its unit. */
export function withoutSealed<T extends { tbl: string; key: string; dup?: { key: string }; remote: unknown }>(items: readonly T[], sealed: Sealed): T[] {
  if (!sealed.occ.size && !sealed.inter.size) return [...items];
  const hit = (key: string | undefined, tbl: string) => key != null && sealed.occ.has(tbl === 'occval' ? key.split('|')[0] : key);
  return items.filter((it) => {
    if (it.tbl === 'occ' || it.tbl === 'occval') return !(hit(it.key, it.tbl) || hit(it.dup?.key, it.tbl));
    if (it.tbl === 'inter') return !sealed.inter.has(it.key);
    if (it.tbl === 'sunit') return !(it.remote == null && sealed.unit.has(it.key));
    return true;
  });
}

/**
 * The document as a teammate gets it: without this device's project and
 * without file paths (photos travel by file sync, each with its place).
 */
export function surveyDocForPeer(doc: SurveyDoc): SurveyDoc {
  const { project_id: _p, ...rest } = doc;
  return { ...rest, frame_labels: doc.frame_labels.map((l) => ({ ...l, photo_uri: null })), media: [] };
}

/**
 * The previous survey a teammate's document carries, made here when this
 * device does not have it (the recheck needs its list): finished, without a
 * project. Run before the document's own survey, in the same transaction.
 * Returns its id, or null when there is none to make.
 */
export function insertPreviousFromDoc(ctx: Ctx, doc: SurveyDoc): number | null {
  if (!doc.previous || !doc.frame) return null;
  const full: SurveyDoc = {
    record_type: 'fw_survey',
    schema: 1,
    frame: doc.frame,
    series: doc.series,
    frame_units: doc.frame_units,
    frame_labels: doc.frame_labels,
    ...doc.previous,
    media: [],
  };
  if (surveyByIdent(ctx, full) != null) return null;
  return insertSurveyFromDoc(ctx, full, { status: 'done', projectId: 0 });
}

/** A survey's identity for team sync: on a plot, plot + template + number (two phones that each started it meet); else its uuid. */
export function surveyIdent(doc: Pick<SurveyDoc, 'frame' | 'survey'>): string {
  return doc.frame ? `${doc.frame.uuid}|${doc.survey.template_id}|${doc.survey.census_no}` : String(doc.survey.uuid);
}

/** The local survey a document's identity names, if any. */
export function surveyByIdent(ctx: { db: SurveyDb }, doc: Pick<SurveyDoc, 'frame' | 'survey'>): number | null {
  if (!doc.frame) return one<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE uuid = ? AND style <> 'individual'`, [doc.survey.uuid as string])?.id ?? null;
  return (
    one<{ id: number }>(
      ctx,
      `SELECT s.id FROM fw_surveys s JOIN fw_frames f ON f.id = s.frame_id WHERE f.uuid = ? AND s.template_id = ? AND s.census_no = ? AND s.style <> 'individual'`,
      [doc.frame.uuid as string, doc.survey.template_id as string, doc.survey.census_no as number],
    )?.id ?? null
  );
}

export { SurveyError };
