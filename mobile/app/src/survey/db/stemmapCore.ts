/**
 * Tree census on the database (v80 tables; docs/ForestGEO/Stem_mapping.md,
 * docs/planned/Modular_survey.md §5). Every function takes a context with the
 * connection, the clock and a uuid source, so scripts/check-survey-db.mjs runs
 * them under node:sqlite against the real migrations; the app binds them in
 * ./stemmap.ts.
 *
 * Rules kept here, not in the screens:
 *   - a frame's grid, DBH threshold and tag blocks are fixed once a census
 *     exists; a frame with censuses cannot be deleted;
 *   - census numbers run 1, 2, 3… within a series; only the latest census of
 *     a series can be deleted, taking with it the trees and stems it added;
 *   - a new tree's tag comes from its tag block's range unless one is given,
 *     and a tag is unique within the frame; a number a tree gave up in a tag
 *     correction is never given to another tree; positions outside the plot
 *     are refused;
 *   - species, position and tag corrections leave a history row;
 *   - stem numbers never change; the main-stem flag moves per census;
 *   - a stem's POM sequence number is the previous census's plus one when
 *     the census code C (POM changed) is recorded;
 *   - census codes are validated per level, and recensus-only codes are
 *     refused in a first census;
 *   - every write stamps its quadrat row, so versions and sync see it.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { censusCode } from '../codesets/forestgeoCensus1998';
import {
  fromGps,
  fromGrid,
  fromPolar,
  locate,
  stakeXY,
  validateGeometry,
  type FrameGeometry,
  type StakeCorner,
  type XY,
} from '../stemmap/coords';
import { nextFreeTag, tagBlockIndex, tagRange } from '../stemmap/tags';
import type { SurveyTemplate } from '../template/types';
import { templateHash, validateTemplate } from '../template/validate';

export type SurveyDb = {
  executeSync: (sql: string, params?: Scalar[]) => { rows?: unknown[]; insertId?: number; rowsAffected?: number };
};

export type Ctx = { db: SurveyDb; now: () => number; uuid: () => string };

export type SurveyErrorCode =
  | 'not_found'
  | 'frame_code_taken'
  | 'geometry_invalid'
  | 'frame_locked'
  | 'frame_has_surveys'
  | 'series_code_required'
  | 'template_invalid'
  | 'not_latest_census'
  | 'outside_plot'
  | 'tag_taken'
  | 'tag_retired'
  | 'tag_range_full'
  | 'bad_reference'
  | 'bad_code'
  | 'recensus_only'
  | 'not_recruit';

export class SurveyError extends Error {
  code: SurveyErrorCode;
  detail?: string;
  constructor(code: SurveyErrorCode, detail?: string) {
    super(`survey: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);

// ── frames ──────────────────────────────────────────────────────────────────

export type FrameRow = {
  id: number;
  uuid: string;
  code: string;
  name: string | null;
  project_id: number;
  site_id: number | null;
  size_x_m: number;
  size_y_m: number;
  quadrat_m: number;
  subquadrat_m: number;
  tag_block_quadrats: number;
  tag_block_size: number;
  origin_lat: number | null;
  origin_lng: number | null;
  origin_accuracy_m: number | null;
  origin_datum: string;
  bearing_deg: number;
  bearing_ref: 'true' | 'magnetic';
  declination_deg: number;
  dbh_min_cm: number;
  extreme_pct: number;
  extreme_min: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export function frameGeometry(f: FrameRow): FrameGeometry {
  return {
    sizeXM: f.size_x_m,
    sizeYM: f.size_y_m,
    quadratM: f.quadrat_m,
    subquadratM: f.subquadrat_m,
    originLat: f.origin_lat,
    originLng: f.origin_lng,
    bearingDeg: f.bearing_deg,
    bearingRef: f.bearing_ref,
    declinationDeg: f.declination_deg,
  };
}

export function getFrame(ctx: { db: SurveyDb }, id: number): FrameRow | null {
  return one<FrameRow>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [id]) ?? null;
}

export function listFrames(ctx: { db: SurveyDb }): FrameRow[] {
  return rows<FrameRow>(ctx, `SELECT * FROM fw_frames ORDER BY code`);
}

export type FrameInput = {
  code: string;
  name?: string | null;
  projectId?: number;
  sizeXM: number;
  sizeYM: number;
  quadratM?: number;
  subquadratM?: number;
  tagBlockQuadrats?: number;
  tagBlockSize?: number;
  originLat?: number | null;
  originLng?: number | null;
  originAccuracyM?: number | null;
  bearingDeg?: number;
  bearingRef?: 'true' | 'magnetic';
  declinationDeg?: number;
  dbhMinCm?: 1 | 5;
  /** Extreme-growth list: share of each dbh class per end (0–0.5], and the least per end. */
  extremePct?: number;
  extremeMin?: number;
  notes?: string | null;
};

function checkGeometry(g: { sizeXM: number; sizeYM: number; quadratM: number; subquadratM: number }): void {
  const problems = validateGeometry({ ...g, originLat: null, originLng: null, bearingDeg: 0, bearingRef: 'true', declinationDeg: 0 });
  if (problems.length) throw new SurveyError('geometry_invalid', problems.join(','));
}

export function createFrame(ctx: Ctx, input: FrameInput): number {
  const code = input.code.trim();
  if (!code) throw new SurveyError('frame_code_taken', 'empty');
  if (one(ctx, `SELECT id FROM fw_frames WHERE code = ?`, [code])) throw new SurveyError('frame_code_taken', code);
  const quadratM = input.quadratM ?? 20;
  const subquadratM = input.subquadratM ?? 5;
  checkGeometry({ sizeXM: input.sizeXM, sizeYM: input.sizeYM, quadratM, subquadratM });
  const now = ctx.now();
  const res = run(
    ctx,
    `INSERT INTO fw_frames (uuid, code, name, project_id, size_x_m, size_y_m, quadrat_m, subquadrat_m, tag_block_quadrats, tag_block_size,
       origin_lat, origin_lng, origin_accuracy_m, bearing_deg, bearing_ref, declination_deg, dbh_min_cm, extreme_pct, extreme_min, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      code,
      input.name ?? null,
      input.projectId ?? 0,
      input.sizeXM,
      input.sizeYM,
      quadratM,
      subquadratM,
      input.tagBlockQuadrats ?? 5,
      input.tagBlockSize ?? 10000,
      input.originLat ?? null,
      input.originLng ?? null,
      input.originAccuracyM ?? null,
      input.bearingDeg ?? 0,
      input.bearingRef ?? 'true',
      input.declinationDeg ?? 0,
      input.dbhMinCm ?? 1,
      input.extremePct ?? 0.05,
      input.extremeMin ?? 3,
      input.notes ?? null,
      now,
      now,
    ],
  );
  return Number(res.insertId);
}

export function frameHasSurveys(ctx: { db: SurveyDb }, frameId: number): boolean {
  return one(ctx, `SELECT 1 AS x FROM fw_surveys WHERE frame_id = ? LIMIT 1`, [frameId]) != null;
}

export type FramePatch = Partial<Omit<FrameInput, 'code'>> & { code?: string; siteId?: number | null };

/** Fields that define the grid, the threshold and the tag ranges. */
const LOCKED_FIELDS: readonly (keyof FramePatch)[] = ['sizeXM', 'sizeYM', 'quadratM', 'subquadratM', 'tagBlockQuadrats', 'tagBlockSize', 'dbhMinCm'];

const FRAME_COLUMN: Readonly<Record<keyof FramePatch, string>> = {
  code: 'code',
  name: 'name',
  projectId: 'project_id',
  siteId: 'site_id',
  sizeXM: 'size_x_m',
  sizeYM: 'size_y_m',
  quadratM: 'quadrat_m',
  subquadratM: 'subquadrat_m',
  tagBlockQuadrats: 'tag_block_quadrats',
  tagBlockSize: 'tag_block_size',
  originLat: 'origin_lat',
  originLng: 'origin_lng',
  originAccuracyM: 'origin_accuracy_m',
  bearingDeg: 'bearing_deg',
  bearingRef: 'bearing_ref',
  declinationDeg: 'declination_deg',
  dbhMinCm: 'dbh_min_cm',
  extremePct: 'extreme_pct',
  extremeMin: 'extreme_min',
  notes: 'notes',
};

export function updateFrame(ctx: Ctx, id: number, patch: FramePatch): void {
  const frame = getFrame(ctx, id);
  if (!frame) throw new SurveyError('not_found', 'frame');
  const keys = (Object.keys(patch) as (keyof FramePatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.some((k) => LOCKED_FIELDS.includes(k)) && frameHasSurveys(ctx, id)) throw new SurveyError('frame_locked');
  if (patch.code !== undefined) {
    const code = patch.code.trim();
    if (!code || one(ctx, `SELECT id FROM fw_frames WHERE code = ? AND id <> ?`, [code, id])) throw new SurveyError('frame_code_taken', code);
  }
  checkGeometry({
    sizeXM: patch.sizeXM ?? frame.size_x_m,
    sizeYM: patch.sizeYM ?? frame.size_y_m,
    quadratM: patch.quadratM ?? frame.quadrat_m,
    subquadratM: patch.subquadratM ?? frame.subquadrat_m,
  });
  if (!keys.length) return;
  const sets = keys.map((k) => `${FRAME_COLUMN[k]} = ?`);
  const vals = keys.map((k) => (k === 'code' ? (patch.code as string).trim() : (patch[k] as Scalar)));
  run(ctx, `UPDATE fw_frames SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, ctx.now(), id]);
}

export function deleteFrame(ctx: Ctx, id: number): void {
  if (frameHasSurveys(ctx, id)) throw new SurveyError('frame_has_surveys');
  run(ctx, `DELETE FROM fw_individuals WHERE frame_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_frame_series WHERE frame_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_frames WHERE id = ?`, [id]);
}

// ── series and censuses ─────────────────────────────────────────────────────

export function ensureSeries(ctx: Ctx, frameId: number, templateId: string, seriesCode?: string): number {
  const found = one<{ id: number }>(ctx, `SELECT id FROM fw_frame_series WHERE frame_id = ? AND template_id = ?`, [frameId, templateId]);
  if (found) return found.id;
  const first = !one(ctx, `SELECT 1 AS x FROM fw_frame_series WHERE frame_id = ?`, [frameId]);
  const code = first ? '' : (seriesCode ?? '').trim();
  if (!first && !code) throw new SurveyError('series_code_required');
  const now = ctx.now();
  const res = run(
    ctx,
    `INSERT INTO fw_frame_series (uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [ctx.uuid(), frameId, templateId, code, now, now],
  );
  return Number(res.insertId);
}

export type SurveyRow = {
  id: number;
  uuid: string;
  frame_id: number;
  series_id: number;
  census_no: number;
  template_id: string;
  template_version: number;
  template_snapshot: string;
  template_hash: string;
  status: 'active' | 'done';
  start_ts: number;
  stop_ts: number | null;
  investigators: string | null;
  notes: string | null;
  project_id: number;
  site_id: number | null;
  sync_block_quadrats: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  starred: number;
  created_at: number;
  updated_at: number;
};

export function getSurvey(ctx: { db: SurveyDb }, id: number): SurveyRow | null {
  return one<SurveyRow>(ctx, `SELECT * FROM fw_surveys WHERE id = ?`, [id]) ?? null;
}

export function startCensus(
  ctx: Ctx,
  input: { frameId: number; template: SurveyTemplate; seriesCode?: string; investigators?: string | null; syncBlockQuadrats?: number | null; startTs?: number },
): number {
  const frame = getFrame(ctx, input.frameId);
  if (!frame) throw new SurveyError('not_found', 'frame');
  const problems = validateTemplate(input.template);
  if (problems.length) throw new SurveyError('template_invalid', problems.join('; '));
  const seriesId = ensureSeries(ctx, input.frameId, input.template.id, input.seriesCode);
  const last = one<{ n: number | null }>(ctx, `SELECT MAX(census_no) AS n FROM fw_surveys WHERE series_id = ?`, [seriesId]);
  const now = ctx.now();
  const res = run(
    ctx,
    `INSERT INTO fw_surveys (uuid, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash,
       status, start_ts, investigators, project_id, site_id, sync_block_quadrats, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      input.frameId,
      seriesId,
      (last?.n ?? 0) + 1,
      input.template.id,
      input.template.version,
      JSON.stringify(input.template),
      templateHash(input.template),
      input.startTs ?? now,
      input.investigators ?? null,
      frame.project_id,
      frame.site_id,
      input.syncBlockQuadrats ?? null,
      now,
      now,
    ],
  );
  return Number(res.insertId);
}

export type CensusListRow = SurveyRow & {
  frame_code: string;
  frame_name: string | null;
  project_name: string | null;
  /** Trees this census sees. */
  tree_count: number;
};

/** Censuses with what the record list and the plot screen show. */
export function listCensuses(ctx: { db: SurveyDb }, frameId: number | null = null): CensusListRow[] {
  return rows<CensusListRow>(
    ctx,
    `SELECT s.*, f.code AS frame_code, f.name AS frame_name, p.name AS project_name,
            (SELECT COUNT(*) FROM fw_individuals i LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
              WHERE i.frame_id = s.frame_id AND (fi.id IS NULL OR fi.series_id <> s.series_id OR fi.census_no <= s.census_no)) AS tree_count
       FROM fw_surveys s
       JOIN fw_frames f ON f.id = s.frame_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE ? IS NULL OR s.frame_id = ?
      ORDER BY s.start_ts DESC, s.id DESC`,
    [frameId, frameId],
  );
}

/** Census-level fields (Investigators, Comments). */
export function updateCensus(ctx: Ctx, id: number, patch: { investigators?: string | null; notes?: string | null }): void {
  const sets: string[] = [];
  const vals: Scalar[] = [];
  if (patch.investigators !== undefined) {
    sets.push('investigators = ?');
    vals.push(patch.investigators);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    vals.push(patch.notes);
  }
  if (!sets.length) return;
  run(ctx, `UPDATE fw_surveys SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, ctx.now(), id]);
}

export function setCensusProject(ctx: Ctx, id: number, projectId: number): void {
  run(ctx, `UPDATE fw_surveys SET project_id = ?, updated_at = ? WHERE id = ?`, [projectId, ctx.now(), id]);
}

/** Delete several censuses, newest first within each series, so a series'
 *  last censuses can go together. Throws not_latest_census otherwise. */
export function deleteCensuses(ctx: Ctx, ids: readonly number[]): void {
  const list = ids.map((id) => getSurvey(ctx, id)).filter((x): x is SurveyRow => x != null);
  list.sort((a, b) => b.census_no - a.census_no);
  for (const c of list) deleteCensus(ctx, c.id);
}

export function finishCensus(ctx: Ctx, id: number, stopTs?: number): void {
  const now = ctx.now();
  run(ctx, `UPDATE fw_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`, [stopTs ?? now, now, id]);
}

export function reopenCensus(ctx: Ctx, id: number): void {
  run(ctx, `UPDATE fw_surveys SET status = 'active', stop_ts = NULL, updated_at = ? WHERE id = ?`, [ctx.now(), id]);
}

/** The census before this one in its series, or null for a first census. */
export function previousCensusId(ctx: { db: SurveyDb }, surveyId: number): number | null {
  const s = getSurvey(ctx, surveyId);
  if (!s) return null;
  return (
    one<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no < ? ORDER BY census_no DESC LIMIT 1`, [s.series_id, s.census_no])?.id ?? null
  );
}

export function isFirstCensus(ctx: { db: SurveyDb }, surveyId: number): boolean {
  return previousCensusId(ctx, surveyId) == null;
}

/** Throws unless this is the latest census of its series (the only one that can be deleted). */
export function assertDeletableCensus(ctx: { db: SurveyDb }, id: number): void {
  const s = getSurvey(ctx, id);
  if (!s) throw new SurveyError('not_found', 'survey');
  const later = one(ctx, `SELECT 1 AS x FROM fw_surveys WHERE series_id = ? AND census_no > ?`, [s.series_id, s.census_no]);
  if (later) throw new SurveyError('not_latest_census');
}

/** Throws unless these censuses can go together: in each series, only its last ones. */
export function assertDeletableCensuses(ctx: { db: SurveyDb }, ids: readonly number[]): void {
  const picked = new Set(ids);
  for (const id of ids) {
    const s = getSurvey(ctx, id);
    if (!s) throw new SurveyError('not_found', 'survey');
    const later = rows<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no > ?`, [s.series_id, s.census_no]);
    if (later.some((r) => !picked.has(r.id))) throw new SurveyError('not_latest_census');
  }
}

/** Delete the latest census of its series, with the trees and stems it added. */
export function deleteCensus(ctx: Ctx, id: number): void {
  assertDeletableCensus(ctx, id);
  const s = getSurvey(ctx, id)!;
  run(
    ctx,
    `DELETE FROM fw_stems WHERE first_survey_id = ? AND id NOT IN (SELECT stem_id FROM fw_stem_measures WHERE survey_id <> ?)`,
    [id, id],
  );
  run(
    ctx,
    `DELETE FROM fw_individuals WHERE first_survey_id = ? AND id NOT IN (
       SELECT st.individual_id FROM fw_stems st JOIN fw_stem_measures m ON m.stem_id = st.id WHERE m.survey_id <> ?)`,
    [id, id],
  );
  run(ctx, `DELETE FROM fw_media WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_individual_values WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_stem_values WHERE measure_id IN (SELECT id FROM fw_stem_measures WHERE survey_id = ?)`, [id]);
  run(ctx, `DELETE FROM fw_stem_measures WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_survey_quadrats WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_surveys WHERE id = ?`, [id]);
}

// ── quadrats ────────────────────────────────────────────────────────────────

export type FgQuadratRow = {
  id: number;
  uuid: string;
  survey_id: number;
  quadrat_code: string;
  status: 'open' | 'done';
  started_at: number | null;
  ended_at: number | null;
  recorded_by: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

/** The census's row for a quadrat, created on first use; stamps it. */
export function touchFgQuadrat(ctx: Ctx, surveyId: number, code: string): number {
  const now = ctx.now();
  const found = one<{ id: number }>(ctx, `SELECT id FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = ?`, [surveyId, code]);
  if (found) {
    run(ctx, `UPDATE fw_survey_quadrats SET updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, now, found.id]);
    return found.id;
  }
  const res = run(
    ctx,
    `INSERT INTO fw_survey_quadrats (uuid, survey_id, quadrat_code, status, started_at, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)`,
    [ctx.uuid(), surveyId, code, now, now, now],
  );
  return Number(res.insertId);
}

export function setFgQuadratStatus(ctx: Ctx, surveyId: number, code: string, status: 'open' | 'done'): void {
  const id = touchFgQuadrat(ctx, surveyId, code);
  run(ctx, `UPDATE fw_survey_quadrats SET status = ?, ended_at = ? WHERE id = ?`, [status, status === 'done' ? ctx.now() : null, id]);
}

/** Who records in a quadrat this census (Workers component, recorder role). */
export function setFgQuadratRecorder(ctx: Ctx, surveyId: number, code: string, recordedBy: string | null): void {
  const id = touchFgQuadrat(ctx, surveyId, code);
  run(ctx, `UPDATE fw_survey_quadrats SET recorded_by = ? WHERE id = ?`, [recordedBy, id]);
}

export function listFgQuadrats(ctx: { db: SurveyDb }, surveyId: number): FgQuadratRow[] {
  return rows<FgQuadratRow>(ctx, `SELECT * FROM fw_survey_quadrats WHERE survey_id = ? ORDER BY quadrat_code`, [surveyId]);
}

// ── individuals ─────────────────────────────────────────────────────────────

export type IndividualRow = {
  id: number;
  uuid: string;
  frame_id: number;
  tag: string;
  taxon_id: string;
  used_name_id: string | null;
  used_scientific_name: string | null;
  verbatim_identification: string | null;
  x_m: number;
  y_m: number;
  quadrat_code: string;
  coord_method: 'grid' | 'xy' | 'polar' | 'gps';
  local_x_m: number | null;
  local_y_m: number | null;
  ref_kind: 'stake' | 'tree' | null;
  ref_code: string | null;
  distance_m: number | null;
  azimuth_deg: number | null;
  azimuth_ref: 'magnetic' | 'true' | null;
  slope_deg: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  first_survey_id: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type LocationInput =
  | { method: 'grid'; quadrat: string; localX: number; localY: number }
  | { method: 'xy'; x: number; y: number }
  | {
      method: 'polar';
      ref: { kind: 'stake'; quadrat: string; corner: StakeCorner } | { kind: 'tree'; tag: string };
      distanceM: number;
      azimuthDeg: number;
      azimuthRef: 'magnetic' | 'true';
      slopeDeg?: number | null;
    }
  | { method: 'gps'; lat: number; lng: number; accuracy: number | null };

type ResolvedLocation = XY & { columns: Record<string, Scalar> };

const RAW_LOCATION_COLUMNS = [
  'local_x_m',
  'local_y_m',
  'ref_kind',
  'ref_code',
  'distance_m',
  'azimuth_deg',
  'azimuth_ref',
  'slope_deg',
  'lat',
  'lng',
  'accuracy',
] as const;

function resolveLocation(ctx: { db: SurveyDb }, frame: FrameRow, loc: LocationInput): ResolvedLocation {
  const g = frameGeometry(frame);
  const blank: Record<string, Scalar> = Object.fromEntries(RAW_LOCATION_COLUMNS.map((c) => [c, null]));
  let p: XY | null;
  switch (loc.method) {
    case 'grid': {
      const r = fromGrid(loc.quadrat, loc.localX, loc.localY, g);
      if (!r || r.warnings.length) throw new SurveyError('outside_plot', r?.warnings.join(',') ?? 'bad quadrat code');
      p = r;
      blank.local_x_m = loc.localX;
      blank.local_y_m = loc.localY;
      break;
    }
    case 'xy':
      p = { x: loc.x, y: loc.y };
      break;
    case 'polar': {
      let ref: XY | null;
      if (loc.ref.kind === 'stake') {
        ref = stakeXY(loc.ref.quadrat, loc.ref.corner, g);
        blank.ref_code = `${loc.ref.quadrat}${loc.ref.corner}`;
      } else {
        const t = one<{ x_m: number; y_m: number }>(ctx, `SELECT x_m, y_m FROM fw_individuals WHERE frame_id = ? AND tag = ?`, [frame.id, loc.ref.tag]);
        ref = t ? { x: t.x_m, y: t.y_m } : null;
        blank.ref_code = loc.ref.tag;
      }
      if (!ref) throw new SurveyError('bad_reference');
      p = fromPolar(ref, loc.distanceM, loc.azimuthDeg, loc.azimuthRef, loc.slopeDeg ?? null, g);
      blank.ref_kind = loc.ref.kind;
      blank.distance_m = loc.distanceM;
      blank.azimuth_deg = loc.azimuthDeg;
      blank.azimuth_ref = loc.azimuthRef;
      blank.slope_deg = loc.slopeDeg ?? null;
      break;
    }
    case 'gps':
      p = fromGps(loc.lat, loc.lng, g);
      if (!p) throw new SurveyError('bad_reference', 'no origin');
      blank.lat = loc.lat;
      blank.lng = loc.lng;
      blank.accuracy = loc.accuracy;
      break;
  }
  if (!locate(p, g).inside) throw new SurveyError('outside_plot');
  return { ...p, columns: blank };
}

export type TaxonInput = {
  taxonId: string;
  usedNameId?: string | null;
  usedScientificName?: string | null;
  verbatimIdentification?: string | null;
};

export function getIndividual(ctx: { db: SurveyDb }, id: number): IndividualRow | null {
  return one<IndividualRow>(ctx, `SELECT * FROM fw_individuals WHERE id = ?`, [id]) ?? null;
}

/** Tags trees gave up in tag corrections (decided 2026-10-01: never reused),
 *  and in team merges that found two trees to be one (`merge` rows: the tag
 *  of the tree folded in, and the kept tree's own tag if another was kept).
 *  A tree's own former tags are not counted against it, so a wrong
 *  correction can be undone. */
export function retiredTags(ctx: { db: SurveyDb }, frameId: number, exceptIndividualId: number | null = null): Set<string> {
  const old = rows<{ field: string; o: string | null; n: string | null }>(
    ctx,
    // From the history (corrections only, small); joined the other way the
    // planner walked every tree of the plot on each save (1E).
    `SELECT h.field, h.old_value AS o, h.new_value AS n FROM fw_individual_history h CROSS JOIN fw_individuals i ON i.id = h.individual_id
      WHERE i.frame_id = ? AND h.field IN ('tag', 'merge') AND h.individual_id IS NOT ?`,
    [frameId, exceptIndividualId],
  );
  const out = new Set<string>();
  const parse = (v: string | null): unknown => {
    try {
      return v == null ? null : JSON.parse(v);
    } catch {
      return null; // a malformed history row retires nothing
    }
  };
  for (const r of old) {
    if (r.field === 'tag') {
      const t = parse(r.o);
      if (typeof t === 'string') out.add(t);
      continue;
    }
    const from = parse(r.o) as { tag?: unknown } | null;
    const kept = parse(r.n) as { tag?: unknown; was?: unknown } | null;
    for (const t of [from?.tag, kept?.was]) if (typeof t === 'string' && t !== kept?.tag) out.add(t);
  }
  return out;
}

/**
 * The tag a new tree at this position would get: the next free number of
 * its tag block, or — when this phone carries its own roll of tags in a team
 * (`rollStart`, decided 2026-10-01) — the lowest free number from the roll's
 * first one on, wherever the tree stands. Used and retired numbers are skipped.
 */
export function suggestTag(ctx: { db: SurveyDb }, frame: FrameRow, p: XY, rollStart: number | null = null): string {
  if (rollStart != null) {
    const retired = retiredTags(ctx, frame.id);
    // Upward from the roll's first number, ten thousand at a time.
    for (let from = rollStart; ; from += 10_000) {
      const taken = usedTagNumbers(ctx, frame.id, from, from + 9_999);
      for (let n = from; n < from + 10_000; n++) if (!taken.has(n) && !retired.has(String(n))) return String(n);
    }
  }
  const block = tagBlockIndex(p, frameGeometry(frame), frame.tag_block_quadrats);
  const { first, last } = tagRange(block, frame.tag_block_size);
  // Only this block's range: a frame holds tens of thousands of tags.
  const used = [...usedTagNumbers(ctx, frame.id, first, last)];
  const n = nextFreeTag(block, frame.tag_block_size, [...used, ...retiredTags(ctx, frame.id)]);
  if (n == null) throw new SurveyError('tag_range_full');
  return String(n);
}

/**
 * Numbers in [first, last] used as tags in a frame. Tags are text, and a
 * numeric range on text cannot use the (frame_id, tag) index — the form asks
 * for a suggestion as the position is typed, so on a large plot each keystroke
 * read every tag (1E). Digit strings of one length sort like the numbers they
 * are, so the range is asked length by length, each an index range. A tag
 * written with leading zeros ("007") does not hold its number.
 */
function usedTagNumbers(ctx: { db: SurveyDb }, frameId: number, first: number, last: number): Set<number> {
  const out = new Set<number>();
  for (let len = String(first).length; len <= String(last).length; len++) {
    const lo = Math.max(first, len === 1 ? 0 : 10 ** (len - 1));
    const hi = Math.min(last, 10 ** len - 1);
    if (lo > hi) continue;
    for (const r of rows<{ tag: string }>(ctx, `SELECT tag FROM fw_individuals WHERE frame_id = ? AND tag BETWEEN ? AND ? AND length(tag) = ?`, [frameId, String(lo), String(hi), len])) {
      const n = Number(r.tag);
      if (Number.isInteger(n) && String(n) === r.tag) out.add(n);
    }
  }
  return out;
}

/** A tree first recorded in this census, with its first stem. Returns ids and tag. */
export function addIndividual(
  ctx: Ctx,
  input: { surveyId: number; tag?: string | null; taxon: TaxonInput; location: LocationInput; notes?: string | null },
): { id: number; tag: string; stemId: number } {
  const survey = getSurvey(ctx, input.surveyId);
  if (!survey) throw new SurveyError('not_found', 'survey');
  const frame = getFrame(ctx, survey.frame_id)!;
  const loc = resolveLocation(ctx, frame, input.location);
  const tag = input.tag?.trim() || suggestTag(ctx, frame, loc);
  if (one(ctx, `SELECT id FROM fw_individuals WHERE frame_id = ? AND tag = ?`, [frame.id, tag])) throw new SurveyError('tag_taken', tag);
  if (retiredTags(ctx, frame.id).has(tag)) throw new SurveyError('tag_retired', tag);
  const code = locate(loc, frameGeometry(frame)).code;
  const now = ctx.now();
  const cols = Object.keys(loc.columns);
  const res = run(
    ctx,
    `INSERT INTO fw_individuals (uuid, frame_id, tag, taxon_id, used_name_id, used_scientific_name, verbatim_identification,
       x_m, y_m, quadrat_code, coord_method, ${cols.join(', ')}, first_survey_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      frame.id,
      tag,
      input.taxon.taxonId,
      input.taxon.usedNameId ?? null,
      input.taxon.usedScientificName ?? null,
      input.taxon.verbatimIdentification ?? null,
      loc.x,
      loc.y,
      code,
      input.location.method,
      ...cols.map((c) => loc.columns[c]),
      input.surveyId,
      input.notes ?? null,
      now,
      now,
    ],
  );
  const id = Number(res.insertId);
  touchFgQuadrat(ctx, input.surveyId, code);
  const stemId = addStem(ctx, id, input.surveyId);
  return { id, tag, stemId };
}

function addHistory(ctx: Ctx, individualId: number, surveyId: number | null, field: 'taxon' | 'position' | 'tag', oldValue: unknown, newValue: unknown, reason: string | null, by: string | null): void {
  run(
    ctx,
    `INSERT INTO fw_individual_history (uuid, individual_id, survey_id, field, old_value, new_value, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.uuid(), individualId, surveyId, field, JSON.stringify(oldValue), JSON.stringify(newValue), reason, by, ctx.now()],
  );
}

/** Correct a tree's species, position or tag; each change leaves a history row. */
export function correctIndividual(
  ctx: Ctx,
  id: number,
  change: { taxon?: TaxonInput; location?: LocationInput; tag?: string },
  meta: { surveyId: number | null; reason: string | null; by: string | null },
): void {
  const ind = getIndividual(ctx, id);
  if (!ind) throw new SurveyError('not_found', 'individual');
  const frame = getFrame(ctx, ind.frame_id)!;
  const now = ctx.now();
  if (change.taxon) {
    const t = change.taxon;
    addHistory(ctx, id, meta.surveyId, 'taxon', { taxon_id: ind.taxon_id, verbatim: ind.verbatim_identification }, { taxon_id: t.taxonId, verbatim: t.verbatimIdentification ?? null }, meta.reason, meta.by);
    run(ctx, `UPDATE fw_individuals SET taxon_id = ?, used_name_id = ?, used_scientific_name = ?, verbatim_identification = ?, updated_at = ? WHERE id = ?`, [
      t.taxonId,
      t.usedNameId ?? null,
      t.usedScientificName ?? null,
      t.verbatimIdentification ?? null,
      now,
      id,
    ]);
  }
  if (change.location) {
    const loc = resolveLocation(ctx, frame, change.location);
    const code = locate(loc, frameGeometry(frame)).code;
    addHistory(ctx, id, meta.surveyId, 'position', { x: ind.x_m, y: ind.y_m }, { x: loc.x, y: loc.y }, meta.reason, meta.by);
    const cols = Object.keys(loc.columns);
    run(
      ctx,
      `UPDATE fw_individuals SET x_m = ?, y_m = ?, quadrat_code = ?, coord_method = ?, ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [loc.x, loc.y, code, change.location.method, ...cols.map((c) => loc.columns[c]), now, id],
    );
    if (meta.surveyId != null) touchFgQuadrat(ctx, meta.surveyId, code);
  }
  if (change.tag !== undefined) {
    const tag = change.tag.trim();
    if (!tag || one(ctx, `SELECT id FROM fw_individuals WHERE frame_id = ? AND tag = ? AND id <> ?`, [frame.id, tag, id])) throw new SurveyError('tag_taken', tag);
    if (retiredTags(ctx, frame.id, id).has(tag)) throw new SurveyError('tag_retired', tag);
    addHistory(ctx, id, meta.surveyId, 'tag', ind.tag, tag, meta.reason, meta.by);
    run(ctx, `UPDATE fw_individuals SET tag = ?, updated_at = ? WHERE id = ?`, [tag, now, id]);
  }
  if (meta.surveyId != null) touchFgQuadrat(ctx, meta.surveyId, ind.quadrat_code);
}

// ── stems and measurements ──────────────────────────────────────────────────

export type StemRow = { id: number; uuid: string; individual_id: number; stem_no: number; first_survey_id: number | null; notes: string | null };

export type MeasureRow = {
  id: number;
  uuid: string;
  survey_id: number;
  stem_id: number;
  dbh_cm: number | null;
  pom_m: number;
  pom_seq: number;
  is_main: number;
  stem_dead: number;
  pending: 'big_tree' | null;
  measured_at: number | null;
  recorded_by: string | null;
  notes: string | null;
  updated_at: number;
};

function fgQuadratOfStem(ctx: { db: SurveyDb }, stemId: number): string {
  return one<{ q: string }>(ctx, `SELECT i.quadrat_code AS q FROM fw_stems s JOIN fw_individuals i ON i.id = s.individual_id WHERE s.id = ?`, [stemId])?.q ?? '';
}

/** A new stem (next number) of a tree, with its measurement row in this census. */
export function addStem(ctx: Ctx, individualId: number, surveyId: number): number {
  const last = one<{ n: number | null }>(ctx, `SELECT MAX(stem_no) AS n FROM fw_stems WHERE individual_id = ?`, [individualId]);
  const now = ctx.now();
  const res = run(ctx, `INSERT INTO fw_stems (uuid, individual_id, stem_no, first_survey_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    ctx.uuid(),
    individualId,
    (last?.n ?? 0) + 1,
    surveyId,
    now,
    now,
  ]);
  const stemId = Number(res.insertId);
  ensureMeasure(ctx, surveyId, stemId);
  return stemId;
}

/** The previous census's measurement of a stem, if any. */
export function previousMeasure(ctx: { db: SurveyDb }, surveyId: number, stemId: number): MeasureRow | null {
  const prev = previousCensusId(ctx, surveyId);
  if (prev == null) return null;
  return one<MeasureRow>(ctx, `SELECT * FROM fw_stem_measures WHERE survey_id = ? AND stem_id = ?`, [prev, stemId]) ?? null;
}

/** This census's measurement row of a stem, created blank (POM, its number and
 *  the main-stem flag carried from the previous census). */
export function ensureMeasure(ctx: Ctx, surveyId: number, stemId: number): number {
  const found = one<{ id: number }>(ctx, `SELECT id FROM fw_stem_measures WHERE survey_id = ? AND stem_id = ?`, [surveyId, stemId]);
  if (found) return found.id;
  const prev = previousMeasure(ctx, surveyId, stemId);
  const stem = one<StemRow>(ctx, `SELECT * FROM fw_stems WHERE id = ?`, [stemId]);
  if (!stem) throw new SurveyError('not_found', 'stem');
  const isMain = prev
    ? prev.is_main
    : one(ctx, `SELECT 1 AS x FROM fw_stems WHERE individual_id = ? AND id <> ?`, [stem.individual_id, stemId])
      ? 0
      : 1;
  const now = ctx.now();
  const res = run(
    ctx,
    `INSERT INTO fw_stem_measures (uuid, survey_id, stem_id, pom_m, pom_seq, is_main, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.uuid(), surveyId, stemId, prev?.pom_m ?? 1.3, prev?.pom_seq ?? 1, isMain, now, now],
  );
  touchFgQuadrat(ctx, surveyId, fgQuadratOfStem(ctx, stemId));
  return Number(res.insertId);
}

export type MeasurePatch = {
  dbhCm?: number | null;
  pomM?: number;
  stemDead?: boolean;
  pending?: 'big_tree' | null;
  recordedBy?: string | null;
  notes?: string | null;
};

export function getMeasure(ctx: { db: SurveyDb }, id: number): MeasureRow | null {
  return one<MeasureRow>(ctx, `SELECT * FROM fw_stem_measures WHERE id = ?`, [id]) ?? null;
}

export function updateMeasure(ctx: Ctx, measureId: number, patch: MeasurePatch): void {
  const m = getMeasure(ctx, measureId);
  if (!m) throw new SurveyError('not_found', 'measure');
  const now = ctx.now();
  const sets: string[] = [];
  const vals: Scalar[] = [];
  const put = (col: string, v: Scalar) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.dbhCm !== undefined) {
    put('dbh_cm', patch.dbhCm);
    put('measured_at', now);
  }
  if (patch.pomM !== undefined) put('pom_m', patch.pomM);
  if (patch.stemDead !== undefined) put('stem_dead', patch.stemDead ? 1 : 0);
  if (patch.pending !== undefined) put('pending', patch.pending);
  if (patch.recordedBy !== undefined) put('recorded_by', patch.recordedBy);
  if (patch.notes !== undefined) put('notes', patch.notes);
  if (!sets.length) return;
  run(ctx, `UPDATE fw_stem_measures SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, measureId]);
  touchFgQuadrat(ctx, m.survey_id, fgQuadratOfStem(ctx, m.stem_id));
}

/** Move the main-stem flag of a tree, in this census, to one stem. */
export function setMainStem(ctx: Ctx, surveyId: number, individualId: number, stemId: number): void {
  const stems = rows<{ id: number }>(ctx, `SELECT id FROM fw_stems WHERE individual_id = ?`, [individualId]);
  if (!stems.some((s) => s.id === stemId)) throw new SurveyError('not_found', 'stem');
  const now = ctx.now();
  for (const s of stems) {
    const mid = ensureMeasure(ctx, surveyId, s.id);
    run(ctx, `UPDATE fw_stem_measures SET is_main = ?, updated_at = ? WHERE id = ?`, [s.id === stemId ? 1 : 0, now, mid]);
  }
}

// ── values: codes and height ────────────────────────────────────────────────

const parseCodes = (v: string | null | undefined): string[] => {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

function putValue(ctx: Ctx, table: 'fw_stem_values' | 'fw_individual_values', owner: Record<string, number>, component: string, field: string, value: { num?: number | null; text?: string | null; unit?: string | null } | null): void {
  const ownerCols = Object.keys(owner);
  const where = [...ownerCols.map((c) => `${c} = ?`), 'component = ?', 'field = ?', 'idx = 0'].join(' AND ');
  const keyVals: Scalar[] = [...ownerCols.map((c) => owner[c]), component, field];
  if (value == null || (value.num == null && (value.text == null || value.text === ''))) {
    run(ctx, `DELETE FROM ${table} WHERE ${where}`, keyVals);
    return;
  }
  const now = ctx.now();
  const found = one<{ id: number }>(ctx, `SELECT id FROM ${table} WHERE ${where}`, keyVals);
  if (found) {
    run(ctx, `UPDATE ${table} SET value_num = ?, value_text = ?, unit = ?, updated_at = ? WHERE id = ?`, [value.num ?? null, value.text ?? null, value.unit ?? null, now, found.id]);
  } else {
    run(
      ctx,
      `INSERT INTO ${table} (uuid, ${ownerCols.join(', ')}, component, field, idx, value_num, value_text, unit, updated_at) VALUES (?, ${ownerCols.map(() => '?').join(', ')}, ?, ?, 0, ?, ?, ?, ?)`,
      [ctx.uuid(), ...ownerCols.map((c) => owner[c]), component, field, value.num ?? null, value.text ?? null, value.unit ?? null, now],
    );
  }
}

export function stemCodes(ctx: { db: SurveyDb }, measureId: number): string[] {
  return parseCodes(one<{ v: string | null }>(ctx, `SELECT value_text AS v FROM fw_stem_values WHERE measure_id = ? AND component = 'health' AND field = 'census_codes' AND idx = 0`, [measureId])?.v);
}

/** A stem's census codes in this census. Recording C (POM changed) makes the
 *  POM number the previous census's plus one; removing it puts it back. */
export function setStemCodes(ctx: Ctx, measureId: number, codes: readonly string[]): void {
  const m = getMeasure(ctx, measureId);
  if (!m) throw new SurveyError('not_found', 'measure');
  const first = isFirstCensus(ctx, m.survey_id);
  const unique = [...new Set(codes)];
  for (const c of unique) {
    const def = censusCode(c);
    if (!def || def.level !== 'stem') throw new SurveyError('bad_code', c);
    if (first && def.recensusOnly) throw new SurveyError('recensus_only', c);
  }
  putValue(ctx, 'fw_stem_values', { measure_id: measureId }, 'health', 'census_codes', unique.length ? { text: JSON.stringify(unique) } : null);
  const prev = previousMeasure(ctx, m.survey_id, m.stem_id);
  const seq = (prev?.pom_seq ?? 1) + (prev && unique.includes('C') ? 1 : 0);
  run(ctx, `UPDATE fw_stem_measures SET pom_seq = ?, updated_at = ? WHERE id = ?`, [seq, ctx.now(), measureId]);
  touchFgQuadrat(ctx, m.survey_id, fgQuadratOfStem(ctx, m.stem_id));
}

export function treeCodes(ctx: { db: SurveyDb }, surveyId: number, individualId: number): string[] {
  return parseCodes(
    one<{ v: string | null }>(ctx, `SELECT value_text AS v FROM fw_individual_values WHERE survey_id = ? AND individual_id = ? AND component = 'health' AND field = 'census_tree_codes' AND idx = 0`, [surveyId, individualId])?.v,
  );
}

/** Whole-tree census codes (DS / DC / DT / DN) — recensus only. */
export function setTreeCodes(ctx: Ctx, surveyId: number, individualId: number, codes: readonly string[]): void {
  const unique = [...new Set(codes)];
  for (const c of unique) {
    const def = censusCode(c);
    if (!def || def.level !== 'tree') throw new SurveyError('bad_code', c);
  }
  if (unique.length && isFirstCensus(ctx, surveyId)) throw new SurveyError('recensus_only', unique[0]);
  putValue(ctx, 'fw_individual_values', { survey_id: surveyId, individual_id: individualId }, 'health', 'census_tree_codes', unique.length ? { text: JSON.stringify(unique) } : null);
  const ind = getIndividual(ctx, individualId);
  if (ind) touchFgQuadrat(ctx, surveyId, ind.quadrat_code);
}

export function heightOf(ctx: { db: SurveyDb }, surveyId: number, individualId: number): number | null {
  return (
    one<{ v: number | null }>(ctx, `SELECT value_num AS v FROM fw_individual_values WHERE survey_id = ? AND individual_id = ? AND component = 'height' AND field = 'height_m' AND idx = 0`, [surveyId, individualId])?.v ?? null
  );
}

export function setHeight(ctx: Ctx, surveyId: number, individualId: number, heightM: number | null): void {
  putValue(ctx, 'fw_individual_values', { survey_id: surveyId, individual_id: individualId }, 'height', 'height_m', heightM == null ? null : { num: heightM, unit: 'm' });
  const ind = getIndividual(ctx, individualId);
  if (ind) touchFgQuadrat(ctx, surveyId, ind.quadrat_code);
}

// ── photos ──────────────────────────────────────────────────────────────────

export type MediaRow = { id: number; uuid: string; survey_id: number; individual_id: number | null; measure_id: number | null; component: string; kind: 'photo' | 'audio'; uri: string; created_at: number };

/** A tree's photos taken in this census (component 'photos'). */
export function listTreeMedia(ctx: { db: SurveyDb }, surveyId: number, individualId: number): MediaRow[] {
  return rows<MediaRow>(ctx, `SELECT * FROM fw_media WHERE survey_id = ? AND individual_id = ? AND component = 'photos' ORDER BY id`, [surveyId, individualId]);
}

export function addTreeMedia(ctx: Ctx, surveyId: number, individualId: number, uri: string): number {
  const res = run(ctx, `INSERT INTO fw_media (uuid, survey_id, individual_id, component, kind, uri, created_at) VALUES (?, ?, ?, 'photos', 'photo', ?, ?)`, [
    ctx.uuid(),
    surveyId,
    individualId,
    uri,
    ctx.now(),
  ]);
  const ind = getIndividual(ctx, individualId);
  if (ind) touchFgQuadrat(ctx, surveyId, ind.quadrat_code);
  return Number(res.insertId);
}

export function removeTreeMedia(ctx: Ctx, surveyId: number, individualId: number, uri: string): void {
  run(ctx, `DELETE FROM fw_media WHERE survey_id = ? AND individual_id = ? AND uri = ?`, [surveyId, individualId, uri]);
  const ind = getIndividual(ctx, individualId);
  if (ind) touchFgQuadrat(ctx, surveyId, ind.quadrat_code);
}

// ── saving the tree form ────────────────────────────────────────────────────

/**
 * Fix a tree first recorded in this census (data entry, not a correction):
 * no history row, and a changed tag is not retired — the old number was never
 * published, and may be a real tag elsewhere. Older trees go through
 * correctIndividual().
 */
export function editRecruit(ctx: Ctx, id: number, surveyId: number, change: { taxon?: TaxonInput; location?: LocationInput; tag?: string }): void {
  const ind = getIndividual(ctx, id);
  if (!ind) throw new SurveyError('not_found', 'individual');
  if (ind.first_survey_id !== surveyId) throw new SurveyError('not_recruit');
  const frame = getFrame(ctx, ind.frame_id)!;
  const now = ctx.now();
  if (change.taxon) {
    const t = change.taxon;
    run(ctx, `UPDATE fw_individuals SET taxon_id = ?, used_name_id = ?, used_scientific_name = ?, verbatim_identification = ?, updated_at = ? WHERE id = ?`, [
      t.taxonId,
      t.usedNameId ?? null,
      t.usedScientificName ?? null,
      t.verbatimIdentification ?? null,
      now,
      id,
    ]);
  }
  if (change.location) {
    const loc = resolveLocation(ctx, frame, change.location);
    const code = locate(loc, frameGeometry(frame)).code;
    const cols = Object.keys(loc.columns);
    run(
      ctx,
      `UPDATE fw_individuals SET x_m = ?, y_m = ?, quadrat_code = ?, coord_method = ?, ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [loc.x, loc.y, code, change.location.method, ...cols.map((c) => loc.columns[c]), now, id],
    );
    touchFgQuadrat(ctx, surveyId, code);
  }
  if (change.tag !== undefined) {
    const tag = change.tag.trim();
    if (!tag || one(ctx, `SELECT id FROM fw_individuals WHERE frame_id = ? AND tag = ? AND id <> ?`, [frame.id, tag, id])) throw new SurveyError('tag_taken', tag);
    if (retiredTags(ctx, frame.id, id).has(tag)) throw new SurveyError('tag_retired', tag);
    run(ctx, `UPDATE fw_individuals SET tag = ?, updated_at = ? WHERE id = ?`, [tag, now, id]);
  }
  touchFgQuadrat(ctx, surveyId, ind.quadrat_code);
}

export type StemDraft = {
  /** null: a new stem (next number). */
  stemNo: number | null;
  dbhCm: number | null;
  pomM: number;
  stemDead: boolean;
  codes: string[];
  notes: string | null;
};

export type TreeDraft = {
  /** null: a tree first recorded now. */
  individualId: number | null;
  /** New tree: empty takes the tag block's next number. Recruit: a changed tag. */
  tag: string | null;
  /** Required for a new tree; for a recruit, a change. Older trees: null (correctIndividual). */
  taxon: TaxonInput | null;
  location: LocationInput | null;
  notes: string | null;
  heightM: number | null;
  treeCodes: string[];
  /** Number of the main stem; for a new tree, the position in `stems` (1-based). */
  mainStemNo: number;
  stems: StemDraft[];
  recordedBy: string | null;
};

/** Anything entered on a stem; the POM counts when it differs from where it was. */
const stemTouched = (d: StemDraft, basePomM: number) => d.dbhCm != null || d.stemDead || d.codes.length > 0 || !!d.notes || d.pomM !== basePomM;

/**
 * Write the tree form of one census in one go; the caller runs it in a
 * transaction. Stems the form left untouched get no measurement row. Code B
 * (large buttress, ladder needed) marks the stem as waiting for the big-tree
 * team until a DBH is entered. Returns the tree id.
 */
export function saveTreeDraft(ctx: Ctx, surveyId: number, d: TreeDraft): number {
  let id: number;
  const stemIds = new Map<number, number>();
  if (d.individualId == null) {
    if (!d.taxon || !d.location) throw new SurveyError('bad_reference', 'new tree needs a taxon and a position');
    const res = addIndividual(ctx, { surveyId, tag: d.tag, taxon: d.taxon, location: d.location, notes: d.notes });
    id = res.id;
    stemIds.set(1, res.stemId);
    for (let i = 1; i < d.stems.length; i++) stemIds.set(i + 1, addStem(ctx, id, surveyId));
  } else {
    id = d.individualId;
    const ind = getIndividual(ctx, id);
    if (!ind) throw new SurveyError('not_found', 'individual');
    const change: { taxon?: TaxonInput; location?: LocationInput; tag?: string } = {};
    if (d.taxon) change.taxon = d.taxon;
    if (d.location) change.location = d.location;
    if (d.tag != null && d.tag.trim() !== ind.tag) change.tag = d.tag;
    if (Object.keys(change).length) editRecruit(ctx, id, surveyId, change);
    if (d.notes !== ind.notes) run(ctx, `UPDATE fw_individuals SET notes = ?, updated_at = ? WHERE id = ?`, [d.notes, ctx.now(), id]);
    for (const st of rows<{ id: number; stem_no: number }>(ctx, `SELECT id, stem_no FROM fw_stems WHERE individual_id = ?`, [id])) stemIds.set(st.stem_no, st.id);
  }
  d.stems.forEach((sd, i) => {
    const no = d.individualId == null ? i + 1 : sd.stemNo;
    let stemId = no == null ? undefined : stemIds.get(no);
    if (stemId == null) {
      stemId = addStem(ctx, id, surveyId);
      stemIds.set(one<{ n: number }>(ctx, `SELECT stem_no AS n FROM fw_stems WHERE id = ?`, [stemId])!.n, stemId);
    } else if (
      !stemTouched(sd, previousMeasure(ctx, surveyId, stemId)?.pom_m ?? 1.3) &&
      !one(ctx, `SELECT id FROM fw_stem_measures WHERE survey_id = ? AND stem_id = ?`, [surveyId, stemId])
    ) {
      return;
    }
    const mid = ensureMeasure(ctx, surveyId, stemId);
    const before = getMeasure(ctx, mid)!;
    updateMeasure(ctx, mid, {
      // Only a changed DBH moves the measurement date (growth intervals).
      dbhCm: before.dbh_cm === sd.dbhCm ? undefined : sd.dbhCm,
      pomM: sd.pomM,
      stemDead: sd.stemDead,
      pending: sd.codes.includes('B') && sd.dbhCm == null && !sd.stemDead ? 'big_tree' : null,
      recordedBy: d.recordedBy,
      notes: sd.notes,
    });
    setStemCodes(ctx, mid, sd.codes);
  });
  setTreeCodes(ctx, surveyId, id, d.treeCodes);
  setHeight(ctx, surveyId, id, d.heightM);
  const mainId = stemIds.get(d.mainStemNo);
  if (mainId != null && stemIds.size > 1 && mainStemId(ctx, surveyId, id) !== mainId) setMainStem(ctx, surveyId, id, mainId);
  return id;
}

/** The tree's main stem in this census, else as the previous census left it. */
export function mainStemId(ctx: { db: SurveyDb }, surveyId: number, individualId: number): number | null {
  const at = (sid: number) =>
    // From the tree's stems (CROSS JOIN fixes the order): by survey_id alone the
    // planner walked every measurement of the census (1E: grows with the plot).
    one<{ id: number }>(
      ctx,
      `SELECT m.stem_id AS id FROM fw_stems st CROSS JOIN fw_stem_measures m ON m.stem_id = st.id AND m.survey_id = ? WHERE st.individual_id = ? AND m.is_main = 1`,
      [sid, individualId],
    )?.id ?? null;
  const prev = previousCensusId(ctx, surveyId);
  return at(surveyId) ?? (prev == null ? null : at(prev));
}

// ── census overview ─────────────────────────────────────────────────────────

/**
 * Each tree of a census in one row, for the progress counts, the quadrat list
 * and the whole-plot map — one aggregate query, no per-stem rows in memory.
 *
 * A stem is handled when it has a DBH, is dead or waits for the big-tree
 * team. `prev` is the tree's state in the previous census: 'dead' (death code
 * or every stem dead), 'missing' (it existed but nothing was recorded — in a
 * finished census that is a tree already dead before it, which the crew did
 * not visit), 'alive', or null (first census, or new in this one). Dead and
 * missing trees are listed but not counted as work (Modular_survey.md §8.4).
 */
export type TreeState = {
  id: number;
  tag: string;
  quadratCode: string;
  x: number;
  y: number;
  taxonId: string;
  usedScientificName: string | null;
  verbatimIdentification: string | null;
  isNew: boolean;
  stems: number;
  done: boolean;
  deadNow: boolean;
  pending: boolean;
  /** Σ dbh² (cm²) of the live stems measured in this census, else of the previous one. */
  d2: number;
  prev: 'alive' | 'dead' | 'missing' | null;
};

export function censusTreeStates(ctx: { db: SurveyDb }, surveyId: number): TreeState[] {
  const s = getSurvey(ctx, surveyId);
  if (!s) return [];
  const prev = previousCensusId(ctx, surveyId) ?? -1;
  const HANDLED = (a: string) => `(${a}.dbh_cm IS NOT NULL OR ${a}.stem_dead = 1 OR ${a}.pending IS NOT NULL)`;
  const TREE_CODED = (sid: string) =>
    `EXISTS (SELECT 1 FROM fw_individual_values v WHERE v.survey_id = ${sid} AND v.individual_id = i.id AND v.component = 'health' AND v.field = 'census_tree_codes')`;
  const out = rows<{
    id: number;
    tag: string;
    quadrat_code: string;
    x_m: number;
    y_m: number;
    taxon_id: string;
    used_scientific_name: string | null;
    verbatim_identification: string | null;
    first_survey_id: number | null;
    first_no: number | null;
    first_series: number | null;
    stems: number;
    handled: number;
    dead_stems: number;
    pending: number;
    d2: number;
    prev_rows: number;
    prev_handled: number;
    prev_dead_stems: number;
    prev_d2: number;
    tree_dead: number;
    prev_tree_dead: number;
  }>(
    ctx,
    `SELECT i.id, i.tag, i.quadrat_code, i.x_m, i.y_m, i.taxon_id, i.used_scientific_name, i.verbatim_identification,
            i.first_survey_id, fi.census_no AS first_no, fi.series_id AS first_series,
            COUNT(st.id) AS stems,
            COALESCE(SUM(CASE WHEN ${HANDLED('m')} THEN 1 ELSE 0 END), 0) AS handled,
            COALESCE(SUM(CASE WHEN m.stem_dead = 1 THEN 1 ELSE 0 END), 0) AS dead_stems,
            COALESCE(SUM(CASE WHEN m.pending IS NOT NULL THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN m.stem_dead = 0 AND m.dbh_cm > 0 THEN m.dbh_cm * m.dbh_cm ELSE 0 END), 0) AS d2,
            COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS prev_rows,
            COALESCE(SUM(CASE WHEN ${HANDLED('p')} THEN 1 ELSE 0 END), 0) AS prev_handled,
            COALESCE(SUM(CASE WHEN p.stem_dead = 1 THEN 1 ELSE 0 END), 0) AS prev_dead_stems,
            COALESCE(SUM(CASE WHEN p.stem_dead = 0 AND p.dbh_cm > 0 THEN p.dbh_cm * p.dbh_cm ELSE 0 END), 0) AS prev_d2,
            ${TREE_CODED('?')} AS tree_dead,
            ${TREE_CODED('?')} AS prev_tree_dead
       FROM fw_individuals i
       LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
       LEFT JOIN fw_stems st ON st.individual_id = i.id
         AND (st.first_survey_id IS NULL OR st.first_survey_id IN (SELECT id FROM fw_surveys WHERE series_id <> ? OR census_no <= ?))
       LEFT JOIN fw_stem_measures m ON m.stem_id = st.id AND m.survey_id = ?
       LEFT JOIN fw_stem_measures p ON p.stem_id = st.id AND p.survey_id = ?
      WHERE i.frame_id = ? AND (fi.id IS NULL OR fi.series_id <> ? OR fi.census_no <= ?)
      GROUP BY i.id
      ORDER BY i.quadrat_code, i.tag`,
    [surveyId, prev, s.series_id, s.census_no, surveyId, prev, s.frame_id, s.series_id, s.census_no],
  );
  return out.map((r) => {
    const isNew = r.first_survey_id === surveyId;
    const existedBefore = prev !== -1 && !isNew && (r.first_series !== s.series_id || (r.first_no != null && r.first_no < s.census_no));
    let prevState: TreeState['prev'] = null;
    if (existedBefore) {
      if (r.prev_tree_dead || (r.prev_rows > 0 && r.prev_dead_stems === r.prev_rows)) prevState = 'dead';
      else if (r.prev_handled === 0) prevState = 'missing';
      else prevState = 'alive';
    }
    return {
      id: r.id,
      tag: r.tag,
      quadratCode: r.quadrat_code,
      x: r.x_m,
      y: r.y_m,
      taxonId: r.taxon_id,
      usedScientificName: r.used_scientific_name,
      verbatimIdentification: r.verbatim_identification,
      isNew,
      stems: r.stems,
      done: !!r.tree_dead || (r.stems > 0 && r.handled === r.stems),
      deadNow: !!r.tree_dead || (r.stems > 0 && r.dead_stems === r.stems),
      pending: r.pending > 0,
      d2: r.handled > 0 ? r.d2 : r.prev_d2,
      prev: prevState,
    };
  });
}

// ── reading a quadrat ───────────────────────────────────────────────────────

export type StemView = {
  stem: StemRow;
  measure: MeasureRow | null;
  previous: MeasureRow | null;
  codes: string[];
  previousCodes: string[];
};

export type TreeView = {
  individual: IndividualRow;
  stems: StemView[];
  treeCodes: string[];
  previousTreeCodes: string[];
  heightM: number | null;
};

/**
 * The trees of one quadrat as this census sees them: every tree of the frame
 * recorded in this census or an earlier one of the series, with this and the
 * previous census's measurements. One query per table, grouped in memory.
 */
export function loadFgQuadrat(ctx: { db: SurveyDb }, surveyId: number, quadratCode: string): TreeView[] {
  return treeViews(ctx, surveyId, { sql: 'i.quadrat_code = ?', params: [quadratCode] });
}

/** The quadrats the plot has trees in, for reading a whole census in pieces (loadCensusQuadrats). */
export function treeQuadratCodes(ctx: { db: SurveyDb }, surveyId: number): string[] {
  const s = getSurvey(ctx, surveyId);
  if (!s) return [];
  return rows<{ q: string }>(ctx, `SELECT DISTINCT quadrat_code AS q FROM fw_individuals WHERE frame_id = ? ORDER BY quadrat_code`, [s.frame_id]).map((r) => r.q);
}

/**
 * The trees of some quadrats, as loadCensus sees them. Pieces of
 * treeQuadratCodes, joined and put in TAG_ORDER, give loadCensus — read a
 * few at a time, a screen can show how far it is (the checks list, 1E).
 */
export function loadCensusQuadrats(ctx: { db: SurveyDb }, surveyId: number, codes: readonly string[]): TreeView[] {
  if (!codes.length) return [];
  return treeViews(ctx, surveyId, { sql: `i.quadrat_code IN (${codes.map(() => '?').join(', ')})`, params: [...codes] });
}

/** loadCensus's order: tags as text. */
export const TAG_ORDER = (a: TreeView, b: TreeView) => (a.individual.tag < b.individual.tag ? -1 : a.individual.tag > b.individual.tag ? 1 : 0);

/** One tree as this census sees it (null when the census does not see it). */
export function loadTree(ctx: { db: SurveyDb }, surveyId: number, individualId: number): TreeView | null {
  return treeViews(ctx, surveyId, { sql: 'i.id = ?', params: [individualId] })[0] ?? null;
}

/** Every tree of a census (the checks screen). Grouped in memory with maps:
 *  no id lists are bound, so plot size is not limited by SQL variables. */
export function loadCensus(ctx: { db: SurveyDb }, surveyId: number): TreeView[] {
  return treeViews(ctx, surveyId, { sql: '1', params: [] });
}

/** Rows (trees or stems, joined to their first census as `fs`) a census sees:
 *  added in it or an earlier census of its series. Binds series id, census no. */
const SEEN_BY_CENSUS = '(fs.id IS NULL OR fs.series_id <> ? OR fs.census_no <= ?)';

type Scope = { sql: string; params: Scalar[] };

function treeViews(ctx: { db: SurveyDb }, surveyId: number, scope: Scope): TreeView[] {
  const s = getSurvey(ctx, surveyId);
  if (!s) return [];
  const prev = previousCensusId(ctx, surveyId);
  const surveys = prev == null ? [surveyId] : [surveyId, prev];
  const inSurveys = surveys.map(() => '?').join(', ');
  // Trees of the frame in scope that this census sees; every query below
  // repeats the same filter through joins.
  const treeFrom = `fw_individuals i LEFT JOIN fw_surveys fi ON fi.id = i.first_survey_id
    WHERE i.frame_id = ? AND (fi.id IS NULL OR fi.series_id <> ? OR fi.census_no <= ?) AND ${scope.sql}`;
  const treeParams: Scalar[] = [s.frame_id, s.series_id, s.census_no, ...scope.params];
  // Sorted here, not ORDER BY i.tag: that made the planner walk the plot's
  // whole (frame_id, tag) index for one quadrat (1E). Text order, as before.
  const inds = rows<IndividualRow>(ctx, `SELECT i.* FROM ${treeFrom}`, treeParams).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  if (!inds.length) return [];
  // Everything below starts from these trees (CROSS JOIN fixes the order):
  // by survey_id the planner walked every measurement of the census.
  const trees = `(SELECT i.id FROM ${treeFrom}) t`;
  const stems = rows<StemRow>(
    ctx,
    `SELECT st.* FROM ${trees}
       CROSS JOIN fw_stems st ON st.individual_id = t.id
       LEFT JOIN fw_surveys fs ON fs.id = st.first_survey_id
      WHERE ${SEEN_BY_CENSUS} ORDER BY st.individual_id, st.stem_no`,
    [...treeParams, s.series_id, s.census_no],
  );
  const measures = rows<MeasureRow>(
    ctx,
    `SELECT m.* FROM ${trees}
       CROSS JOIN fw_stems st ON st.individual_id = t.id
       CROSS JOIN fw_stem_measures m ON m.stem_id = st.id
      WHERE m.survey_id IN (${inSurveys})`,
    [...treeParams, ...surveys],
  );
  const codes = rows<{ measure_id: number; v: string }>(
    ctx,
    `SELECT v.measure_id, v.value_text AS v FROM ${trees}
       CROSS JOIN fw_stems st ON st.individual_id = t.id
       CROSS JOIN fw_stem_measures m ON m.stem_id = st.id
       CROSS JOIN fw_stem_values v ON v.measure_id = m.id
      WHERE m.survey_id IN (${inSurveys}) AND v.component = 'health' AND v.field = 'census_codes'`,
    [...treeParams, ...surveys],
  );
  const ivals = rows<{ survey_id: number; individual_id: number; component: string; field: string; value_num: number | null; value_text: string | null }>(
    ctx,
    `SELECT v.survey_id, v.individual_id, v.component, v.field, v.value_num, v.value_text FROM ${trees}
       CROSS JOIN fw_individual_values v ON v.individual_id = t.id
      WHERE v.survey_id IN (${inSurveys}) AND v.idx = 0`,
    [...treeParams, ...surveys],
  );
  const codeBy = new Map(codes.map((c) => [c.measure_id, parseCodes(c.v)]));
  const measureBy = new Map(measures.map((m) => [`${m.survey_id}:${m.stem_id}`, m]));
  const stemsBy = new Map<number, StemRow[]>();
  for (const st of stems) {
    const list = stemsBy.get(st.individual_id);
    if (list) list.push(st);
    else stemsBy.set(st.individual_id, [st]);
  }
  const valueBy = new Map(ivals.map((v) => [`${v.survey_id}:${v.individual_id}:${v.component}:${v.field}`, v]));
  const pick = (sid: number | null, id: number, comp: string, field: string) => (sid == null ? undefined : valueBy.get(`${sid}:${id}:${comp}:${field}`));
  return inds.map((individual) => ({
    individual,
    stems: (stemsBy.get(individual.id) ?? []).map((stem) => {
      const measure = measureBy.get(`${surveyId}:${stem.id}`) ?? null;
      const previous = prev == null ? null : (measureBy.get(`${prev}:${stem.id}`) ?? null);
      return {
        stem,
        measure,
        previous,
        codes: measure ? (codeBy.get(measure.id) ?? []) : [],
        previousCodes: previous ? (codeBy.get(previous.id) ?? []) : [],
      };
    }),
    treeCodes: parseCodes(pick(surveyId, individual.id, 'health', 'census_tree_codes')?.value_text),
    previousTreeCodes: parseCodes(pick(prev, individual.id, 'health', 'census_tree_codes')?.value_text),
    heightM: pick(surveyId, individual.id, 'height', 'height_m')?.value_num ?? null,
  }));
}
