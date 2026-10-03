/**
 * Checklist and plot-style surveys on the database (v83;
 * docs/planned/Modular_survey.md §5.2, §5.5, §7.1; Phase 2A). Same shape as
 * stemmapCore: every function takes a context with the connection, the clock
 * and a uuid source, so scripts/check-survey-core.mjs runs them under
 * node:sqlite on the real migrations; the app binds them in ./surveys.ts.
 * Tree censuses (style 'individual') stay in stemmapCore.
 *
 * Rules kept here, not in the screens:
 *   - a checklist survey has no permanent plot; a plot-style survey may have
 *     one, and then belongs to the frame's series for its template, numbered
 *     1, 2, 3… within it;
 *   - starting or reopening one ends any other open record (single-active;
 *     tree censuses and collection trips are exempt);
 *   - unit levels come from the template snapshot; a unit's parent is a unit
 *     of the same survey on a higher level;
 *   - on a frame, a survey's units are the frame's layout: starting one copies
 *     the frame units on the template's unit levels that are not retired, and
 *     a unit added during the survey is added to the frame too. A frame unit
 *     a survey used keeps its level, code, parent and geometry: it can only be
 *     retired;
 *   - a recheck (a plot-style survey with an earlier one in its series) starts
 *     blind: occurrences are 'blind' until the blind phase is closed and
 *     'recheck' after, and the earlier survey's list is refused until then. A
 *     first survey and a checklist have no phases;
 *   - once the blind phase is closed the blind occurrences are sealed (no
 *     edit, no removal), as in MIREN; it can be opened again only while no
 *     recheck work exists. Every taxon of the previous survey missing from the
 *     blind list of the same unit gets an answer (fw_rechecks, v84): found
 *     (adds a 'recheck' occurrence), not found, or re-identified as an
 *     occurrence of this survey;
 *   - a survey always has a name: the frame code on a frame, else the start
 *     time as a checklist session is named;
 *   - values are stored only when set; clearing one deletes its row;
 *   - deleting a unit keeps its occurrences and sub-units, moved up to its
 *     parent; deleting a survey takes its units, occurrences, values and
 *     media with it.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { closeActiveRecords } from '../../db/activeRecords';
import { parseMultiAttribute, serializeMultiAttribute } from '../../lib/dwcMultiValue';
import { storeBlockers } from '../componentRules';
import { componentDef, type ComponentValues, type FieldValue } from '../registry';
import type { ComponentInstance, SurveyStyle, SurveyTemplate, UnitLevel } from '../template/types';
import { templateHash, validateTemplate } from '../template/validate';
import { recheckCandidates, recheckKey, recheckOpen, type RecheckAnswer, type RecheckOutcome, type Sighting } from '../form/recheck';
import { ensureSeries, getFrame, putValue, SurveyError, type Ctx, type SurveyDb, type ValueInput } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ── surveys ─────────────────────────────────────────────────────────────────

/** An fw_surveys row of any style. A census (style 'individual') is stemmapCore's CensusRow. */
export type FwSurveyRow = {
  id: number;
  uuid: string;
  style: SurveyStyle;
  frame_id: number | null;
  series_id: number | null;
  census_no: number | null;
  template_id: string;
  template_version: number;
  template_snapshot: string;
  template_hash: string;
  status: 'active' | 'done';
  start_ts: number;
  stop_ts: number | null;
  blind_closed_at: number | null;
  /** v84; NULL for a census. */
  name: string | null;
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

export function getFwSurvey(ctx: { db: SurveyDb }, id: number): FwSurveyRow | null {
  return one<FwSurveyRow>(ctx, `SELECT * FROM fw_surveys WHERE id = ?`, [id]) ?? null;
}

/** The checklist / plot-style survey with this id; throws for a census or a missing one. */
export function surveyOf(ctx: { db: SurveyDb }, id: number): FwSurveyRow {
  const s = getFwSurvey(ctx, id);
  if (!s) throw new SurveyError('not_found', 'survey');
  if (s.style === 'individual') throw new SurveyError('wrong_style', 'a tree census');
  return s;
}

export function snapshotOf(s: Pick<FwSurveyRow, 'template_snapshot'>): SurveyTemplate {
  return JSON.parse(s.template_snapshot) as SurveyTemplate;
}

/** The survey's unit levels, top first (empty for a checklist). */
export function unitLevelsOf(s: Pick<FwSurveyRow, 'template_snapshot'>): readonly UnitLevel[] {
  return snapshotOf(s).units ?? [];
}

export type SurveyInput = {
  template: SurveyTemplate;
  /** Default: the frame code, else the start time (`YYYY-MM-DD HH:MM`). */
  name?: string | null;
  /** Plot style only: the permanent plot this survey revisits. */
  frameId?: number | null;
  /** A frame's second and later series need a short code (eventIDs, §7.4). */
  seriesCode?: string;
  investigators?: string | null;
  startTs?: number;
  /** Without a frame; a frame's survey takes the frame's project and site. */
  projectId?: number;
  siteId?: number | null;
};

export function createSurvey(ctx: Ctx, input: SurveyInput): number {
  const t = input.template;
  if (t.style === 'individual') throw new SurveyError('wrong_style', 'start a census with startCensus');
  const problems = validateTemplate(t);
  if (problems.length) throw new SurveyError('template_invalid', problems.join('; '));
  const frameId = input.frameId ?? null;
  if (frameId != null && t.style === 'checklist') throw new SurveyError('frame_not_allowed');
  const frame = frameId == null ? null : getFrame(ctx, frameId);
  if (frameId != null && !frame) throw new SurveyError('not_found', 'frame');
  const seriesId = frame ? ensureSeries(ctx, frame.id, t.id, input.seriesCode) : null;
  const censusNo = seriesId == null ? null : (one<{ n: number | null }>(ctx, `SELECT MAX(census_no) AS n FROM fw_surveys WHERE series_id = ?`, [seriesId])?.n ?? 0) + 1;
  const now = ctx.now();
  const startTs = input.startTs ?? now;
  const name = input.name?.trim() || (frame ? frame.code : defaultSurveyName(startTs));
  closeActiveRecords(ctx.db, now);
  const id = Number(
    run(
      ctx,
      `INSERT INTO fw_surveys (uuid, style, name, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash,
         status, start_ts, investigators, project_id, site_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [
        ctx.uuid(),
        t.style,
        name,
        frameId,
        seriesId,
        censusNo,
        t.id,
        t.version,
        JSON.stringify(t),
        templateHash(t),
        startTs,
        input.investigators ?? null,
        frame ? frame.project_id : (input.projectId ?? 0),
        frame ? frame.site_id : (input.siteId ?? null),
        now,
        now,
      ],
    ).insertId,
  );
  if (frame) copyFrameUnits(ctx, id, frame.id, t.units ?? []);
  return id;
}

/** `YYYY-MM-DD HH:MM` in local time, as a new checklist session is named (sessions.ts). */
export function defaultSurveyName(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The open checklist / plot-style survey, if any (single-active: at most one). */
export function getActiveSurvey(ctx: { db: SurveyDb }): FwSurveyRow | null {
  return one<FwSurveyRow>(ctx, `SELECT * FROM fw_surveys WHERE status = 'active' AND style <> 'individual' ORDER BY start_ts DESC, id DESC LIMIT 1`) ?? null;
}

export type SurveyListRow = FwSurveyRow & {
  frame_code: string | null;
  project_name: string | null;
  occurrence_count: number;
  /** Distinct taxa (with their labels: `sp1` and `sp2` of a genus are two). */
  species_count: number;
};

/** Checklist / plot-style surveys, newest first; `frameId` narrows to one permanent plot. */
export function listSurveys(ctx: { db: SurveyDb }, opts: { frameId?: number } = {}): SurveyListRow[] {
  return rows<SurveyListRow>(
    ctx,
    `SELECT s.*, f.code AS frame_code, p.name AS project_name,
            (SELECT COUNT(*) FROM fw_occurrences o WHERE o.survey_id = s.id) AS occurrence_count,
            (SELECT COUNT(*) FROM (SELECT DISTINCT o.taxon_id, IFNULL(o.verbatim_identification, '') FROM fw_occurrences o WHERE o.survey_id = s.id)) AS species_count
       FROM fw_surveys s
       LEFT JOIN fw_frames f ON f.id = s.frame_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.style <> 'individual' AND (? IS NULL OR s.frame_id = ?)
      ORDER BY s.start_ts DESC, s.id DESC`,
    [opts.frameId ?? null, opts.frameId ?? null],
  );
}

/** Whether starting this template on the frame opens a second (or later) series, which needs a short code (§7.4). */
export function seriesCodeNeeded(ctx: { db: SurveyDb }, frameId: number, templateId: string): boolean {
  if (one(ctx, `SELECT 1 AS x FROM fw_frame_series WHERE frame_id = ? AND template_id = ?`, [frameId, templateId])) return false;
  return one(ctx, `SELECT 1 AS x FROM fw_frame_series WHERE frame_id = ?`, [frameId]) != null;
}

/** A new survey on a frame starts with the frame's layout on the template's unit levels. */
function copyFrameUnits(ctx: Ctx, surveyId: number, frameId: number, levels: readonly UnitLevel[]): void {
  const unitOf = new Map<number, number>();
  const now = ctx.now();
  // Top level first, so a parent is copied before its children.
  for (const level of levels) {
    for (const fu of rows<FrameUnitRow>(ctx, `SELECT * FROM fw_frame_units WHERE frame_id = ? AND level_key = ? AND retired_at IS NULL ORDER BY code`, [frameId, level.key])) {
      const res = run(
        ctx,
        `INSERT INTO fw_units (uuid, survey_id, frame_unit_id, parent_id, level_key, code, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ctx.uuid(), surveyId, fu.id, fu.parent_id == null ? null : (unitOf.get(fu.parent_id) ?? null), fu.level_key, fu.code, fu.label, now, now],
      );
      unitOf.set(fu.id, Number(res.insertId));
    }
  }
}

export type SurveyPatch = {
  name?: string;
  investigators?: string | null;
  notes?: string | null;
  startTs?: number;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
};

const SURVEY_COLUMN: Readonly<Record<keyof SurveyPatch, string>> = {
  name: 'name',
  investigators: 'investigators',
  notes: 'notes',
  startTs: 'start_ts',
  lat: 'lat',
  lng: 'lng',
  accuracy: 'accuracy',
};

export function updateSurvey(ctx: Ctx, id: number, patch: SurveyPatch): void {
  surveyOf(ctx, id);
  if (patch.name !== undefined && !patch.name.trim()) throw new SurveyError('bad_value', 'empty name');
  const keys = (Object.keys(patch) as (keyof SurveyPatch)[]).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  run(ctx, `UPDATE fw_surveys SET ${keys.map((k) => `${SURVEY_COLUMN[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => (k === 'name' ? (patch.name as string).trim() : (patch[k] as Scalar))),
    ctx.now(),
    id,
  ]);
}

/** End a survey. `stopTs`: the end time chosen (chooseEndTime); null keeps the one recorded, or none; omitted, now unless one is recorded. */
export function finishSurvey(ctx: Ctx, id: number, stopTs?: number | null): void {
  surveyOf(ctx, id);
  const now = ctx.now();
  if (stopTs === undefined) run(ctx, `UPDATE fw_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`, [now, now, id]);
  else if (stopTs === null) run(ctx, `UPDATE fw_surveys SET status = 'done', updated_at = ? WHERE id = ?`, [now, id]);
  else run(ctx, `UPDATE fw_surveys SET status = 'done', stop_ts = ?, updated_at = ? WHERE id = ?`, [stopTs, now, id]);
}

export function reopenSurvey(ctx: Ctx, id: number): void {
  surveyOf(ctx, id);
  const now = ctx.now();
  closeActiveRecords(ctx.db, now, { kind: 'modular', id });
  run(ctx, `UPDATE fw_surveys SET status = 'active', stop_ts = NULL, updated_at = ? WHERE id = ?`, [now, id]);
}

/** Delete a survey with everything recorded in it. The frame, its layout and morphospecies stay. */
export function deleteSurvey(ctx: Ctx, id: number): void {
  surveyOf(ctx, id);
  // Children by hand: foreign keys are off during migrations and cleanup.
  run(ctx, `DELETE FROM fw_media WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_rechecks WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_occurrence_values WHERE occurrence_id IN (SELECT id FROM fw_occurrences WHERE survey_id = ?)`, [id]);
  run(ctx, `DELETE FROM fw_occurrences WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_unit_values WHERE unit_id IN (SELECT id FROM fw_units WHERE survey_id = ?)`, [id]);
  run(ctx, `DELETE FROM fw_units WHERE survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_survey_values WHERE survey_id = ?`, [id]);
  run(ctx, `UPDATE fw_frame_labels SET first_survey_id = NULL WHERE first_survey_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_surveys WHERE id = ?`, [id]);
}

// ── frame units (a permanent plot's layout) ─────────────────────────────────

export type FrameUnitRow = {
  id: number;
  uuid: string;
  frame_id: number;
  parent_id: number | null;
  level_key: string;
  code: string;
  label: string | null;
  shape: 'rect' | 'circle' | 'line' | 'point';
  x_m: number | null;
  y_m: number | null;
  width_m: number | null;
  length_m: number | null;
  radius_m: number | null;
  geometry_geojson: string | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
};

/** Where a frame unit lies; fixed once a survey used it. */
export type FrameUnitShape = {
  shape?: FrameUnitRow['shape'];
  xM?: number | null;
  yM?: number | null;
  widthM?: number | null;
  lengthM?: number | null;
  radiusM?: number | null;
  geometry?: string | null;
};

export type FrameUnitInput = FrameUnitShape & { levelKey: string; code: string; label?: string | null; parentId?: number | null };

export function getFrameUnit(ctx: { db: SurveyDb }, id: number): FrameUnitRow | null {
  return one<FrameUnitRow>(ctx, `SELECT * FROM fw_frame_units WHERE id = ?`, [id]) ?? null;
}

export function listFrameUnits(ctx: { db: SurveyDb }, frameId: number, opts: { includeRetired?: boolean } = {}): FrameUnitRow[] {
  return rows<FrameUnitRow>(
    ctx,
    `SELECT * FROM fw_frame_units WHERE frame_id = ? ${opts.includeRetired ? '' : 'AND retired_at IS NULL'} ORDER BY level_key, code`,
    [frameId],
  );
}

/** Whether a survey has used this frame unit (it is locked then). */
export function frameUnitUsed(ctx: { db: SurveyDb }, id: number): boolean {
  return one(ctx, `SELECT 1 AS x FROM fw_units WHERE frame_unit_id = ? LIMIT 1`, [id]) != null;
}

export function addFrameUnit(ctx: Ctx, frameId: number, input: FrameUnitInput): number {
  if (!getFrame(ctx, frameId)) throw new SurveyError('not_found', 'frame');
  const levelKey = input.levelKey.trim();
  const code = input.code.trim();
  if (!levelKey || !code) throw new SurveyError('bad_unit', 'empty level or code');
  if (input.parentId != null && getFrameUnit(ctx, input.parentId)?.frame_id !== frameId) throw new SurveyError('bad_unit', 'parent');
  if (one(ctx, `SELECT 1 AS x FROM fw_frame_units WHERE frame_id = ? AND level_key = ? AND code = ?`, [frameId, levelKey, code])) {
    throw new SurveyError('unit_taken', code);
  }
  const now = ctx.now();
  return Number(
    run(
      ctx,
      `INSERT INTO fw_frame_units (uuid, frame_id, parent_id, level_key, code, label, shape, x_m, y_m, width_m, length_m, radius_m, geometry_geojson, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.uuid(),
        frameId,
        input.parentId ?? null,
        levelKey,
        code,
        input.label ?? null,
        input.shape ?? 'rect',
        input.xM ?? null,
        input.yM ?? null,
        input.widthM ?? null,
        input.lengthM ?? null,
        input.radiusM ?? null,
        input.geometry ?? null,
        now,
        now,
      ],
    ).insertId,
  );
}

const FRAME_UNIT_COLUMN = {
  label: 'label',
  parentId: 'parent_id',
  code: 'code',
  shape: 'shape',
  xM: 'x_m',
  yM: 'y_m',
  widthM: 'width_m',
  lengthM: 'length_m',
  radiusM: 'radius_m',
  geometry: 'geometry_geojson',
} as const;

export type FrameUnitPatch = FrameUnitShape & { code?: string; label?: string | null; parentId?: number | null };

/** The label can always change; code, parent and geometry only until a survey used the unit. */
export function updateFrameUnit(ctx: Ctx, id: number, patch: FrameUnitPatch): void {
  const fu = getFrameUnit(ctx, id);
  if (!fu) throw new SurveyError('not_found', 'frame unit');
  const keys = (Object.keys(patch) as (keyof FrameUnitPatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.some((k) => k !== 'label') && frameUnitUsed(ctx, id)) throw new SurveyError('frame_unit_locked');
  if (patch.parentId != null && (patch.parentId === id || getFrameUnit(ctx, patch.parentId)?.frame_id !== fu.frame_id)) throw new SurveyError('bad_unit', 'parent');
  if (patch.code !== undefined) {
    const code = patch.code.trim();
    if (!code) throw new SurveyError('bad_unit', 'empty code');
    if (one(ctx, `SELECT 1 AS x FROM fw_frame_units WHERE frame_id = ? AND level_key = ? AND code = ? AND id <> ?`, [fu.frame_id, fu.level_key, code, id])) {
      throw new SurveyError('unit_taken', code);
    }
  }
  if (!keys.length) return;
  run(ctx, `UPDATE fw_frame_units SET ${keys.map((k) => `${FRAME_UNIT_COLUMN[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => (k === 'code' ? (patch.code as string).trim() : (patch[k] as Scalar))),
    ctx.now(),
    id,
  ]);
}

/** Retire a frame unit (new surveys leave it out) or bring it back. */
export function setFrameUnitRetired(ctx: Ctx, id: number, retired: boolean): void {
  if (!getFrameUnit(ctx, id)) throw new SurveyError('not_found', 'frame unit');
  const now = ctx.now();
  run(ctx, `UPDATE fw_frame_units SET retired_at = ?, updated_at = ? WHERE id = ?`, [retired ? now : null, now, id]);
}

/** Only a unit no survey used can be deleted; its sub-units move up to its parent. */
export function deleteFrameUnit(ctx: Ctx, id: number): void {
  const fu = getFrameUnit(ctx, id);
  if (!fu) throw new SurveyError('not_found', 'frame unit');
  if (frameUnitUsed(ctx, id)) throw new SurveyError('frame_unit_locked');
  run(ctx, `UPDATE fw_frame_units SET parent_id = ?, updated_at = ? WHERE parent_id = ?`, [fu.parent_id, ctx.now(), id]);
  run(ctx, `DELETE FROM fw_frame_units WHERE id = ?`, [id]);
}

// ── units of one survey ─────────────────────────────────────────────────────

export type UnitRow = {
  id: number;
  uuid: string;
  survey_id: number;
  frame_unit_id: number | null;
  parent_id: number | null;
  level_key: string;
  code: string;
  label: string | null;
  sort: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  geometry_geojson: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export function getUnit(ctx: { db: SurveyDb }, id: number): UnitRow | null {
  return one<UnitRow>(ctx, `SELECT * FROM fw_units WHERE id = ?`, [id]) ?? null;
}

/** A survey's units, top level first, then in their order. */
export function listUnits(ctx: { db: SurveyDb }, surveyId: number): UnitRow[] {
  const s = surveyOf(ctx, surveyId);
  const depth = new Map(unitLevelsOf(s).map((u, i) => [u.key, i]));
  return rows<UnitRow>(ctx, `SELECT * FROM fw_units WHERE survey_id = ? ORDER BY sort, code`, [surveyId]).sort(
    (a, b) => (depth.get(a.level_key) ?? 99) - (depth.get(b.level_key) ?? 99),
  );
}

export type UnitInput = {
  levelKey: string;
  code: string;
  label?: string | null;
  parentId?: number | null;
  sort?: number;
  notes?: string | null;
  /** On a frame: where the new frame unit lies. */
  frameUnit?: FrameUnitShape;
};

export function addUnit(ctx: Ctx, surveyId: number, input: UnitInput): number {
  const s = surveyOf(ctx, surveyId);
  if (s.style !== 'plot') throw new SurveyError('wrong_style', 'units belong to the plot style');
  const levels = unitLevelsOf(s);
  const depth = levels.findIndex((u) => u.key === input.levelKey);
  if (depth < 0) throw new SurveyError('bad_unit', `no unit level ${input.levelKey}`);
  const code = input.code.trim();
  if (!code) throw new SurveyError('bad_unit', 'empty code');
  const parent = input.parentId == null ? null : getUnit(ctx, input.parentId);
  if (input.parentId != null) {
    const parentDepth = parent ? levels.findIndex((u) => u.key === parent.level_key) : -1;
    if (!parent || parent.survey_id !== surveyId || parentDepth < 0 || parentDepth >= depth) throw new SurveyError('bad_unit', 'parent');
  }
  if (one(ctx, `SELECT 1 AS x FROM fw_units WHERE survey_id = ? AND level_key = ? AND code = ?`, [surveyId, input.levelKey, code])) {
    throw new SurveyError('unit_taken', code);
  }
  let frameUnitId: number | null = null;
  if (s.frame_id != null) {
    // The frame's layout grows with the survey; an existing, unretired frame unit of that code is taken over.
    const found = one<FrameUnitRow>(ctx, `SELECT * FROM fw_frame_units WHERE frame_id = ? AND level_key = ? AND code = ?`, [s.frame_id, input.levelKey, code]);
    if (found?.retired_at != null) throw new SurveyError('unit_taken', `${code} (retired)`);
    frameUnitId =
      found?.id ??
      addFrameUnit(ctx, s.frame_id, { ...input.frameUnit, levelKey: input.levelKey, code, label: input.label, parentId: parent?.frame_unit_id ?? null });
  }
  const now = ctx.now();
  return Number(
    run(
      ctx,
      `INSERT INTO fw_units (uuid, survey_id, frame_unit_id, parent_id, level_key, code, label, sort, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.uuid(), surveyId, frameUnitId, parent?.id ?? null, input.levelKey, code, input.label ?? null, input.sort ?? 0, input.notes ?? null, now, now],
    ).insertId,
  );
}

export type UnitPatch = {
  code?: string;
  label?: string | null;
  sort?: number;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  geometry?: string | null;
};

const UNIT_COLUMN: Readonly<Record<keyof UnitPatch, string>> = {
  code: 'code',
  label: 'label',
  sort: 'sort',
  notes: 'notes',
  lat: 'lat',
  lng: 'lng',
  accuracy: 'accuracy',
  geometry: 'geometry_geojson',
};

/** A unit on a frame keeps the frame unit's code; the rest is this survey's. */
export function updateUnit(ctx: Ctx, id: number, patch: UnitPatch): void {
  const u = getUnit(ctx, id);
  if (!u) throw new SurveyError('not_found', 'unit');
  const keys = (Object.keys(patch) as (keyof UnitPatch)[]).filter((k) => patch[k] !== undefined);
  if (patch.code !== undefined) {
    const code = patch.code.trim();
    if (!code) throw new SurveyError('bad_unit', 'empty code');
    if (u.frame_unit_id != null && code !== u.code) throw new SurveyError('frame_unit_locked');
    if (one(ctx, `SELECT 1 AS x FROM fw_units WHERE survey_id = ? AND level_key = ? AND code = ? AND id <> ?`, [u.survey_id, u.level_key, code, id])) {
      throw new SurveyError('unit_taken', code);
    }
  }
  if (!keys.length) return;
  run(ctx, `UPDATE fw_units SET ${keys.map((k) => `${UNIT_COLUMN[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => (k === 'code' ? (patch.code as string).trim() : (patch[k] as Scalar))),
    ctx.now(),
    id,
  ]);
}

/** Delete a unit; its occurrences and sub-units move up to its parent, its values and photos go. */
export function deleteUnit(ctx: Ctx, id: number): void {
  const u = getUnit(ctx, id);
  if (!u) throw new SurveyError('not_found', 'unit');
  const now = ctx.now();
  run(ctx, `UPDATE fw_units SET parent_id = ?, updated_at = ? WHERE parent_id = ?`, [u.parent_id, now, id]);
  run(ctx, `UPDATE fw_occurrences SET unit_id = ?, updated_at = ? WHERE unit_id = ?`, [u.parent_id, now, id]);
  run(ctx, `DELETE FROM fw_unit_values WHERE unit_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_media WHERE unit_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_units WHERE id = ?`, [id]);
}

// ── occurrences ─────────────────────────────────────────────────────────────

export type OccurrenceRow = {
  id: number;
  uuid: string;
  survey_id: number;
  unit_id: number | null;
  taxon_id: string;
  used_name_id: number | null;
  used_scientific_name: string | null;
  verbatim_identification: string | null;
  layer: string | null;
  organism_quantity: string | null;
  organism_quantity_type: string | null;
  freq_cells: string | null;
  freq_count: number | null;
  sex: string | null;
  life_stage: string | null;
  reproductive_condition: string | null;
  leaf_phenology: string | null;
  degree_of_establishment: string | null;
  detection_type: string | null;
  observed_at: number;
  recorded_by: string | null;
  identified_by: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  elevation_m: number | null;
  elevation_source: string | null;
  phase: 'blind' | 'recheck' | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

/** Columns an occurrence is written through (by name: the same names as plot_species_records). */
const OCCURRENCE_FIELDS = [
  'unit_id',
  'taxon_id',
  'used_name_id',
  'used_scientific_name',
  'verbatim_identification',
  'layer',
  'organism_quantity',
  'organism_quantity_type',
  'freq_cells',
  'freq_count',
  'sex',
  'life_stage',
  'reproductive_condition',
  'leaf_phenology',
  'degree_of_establishment',
  'detection_type',
  'observed_at',
  'recorded_by',
  'identified_by',
  'lat',
  'lng',
  'accuracy',
  'elevation_m',
  'elevation_source',
  'notes',
] as const;

export type OccurrenceFields = Partial<Pick<OccurrenceRow, (typeof OCCURRENCE_FIELDS)[number]>>;

export function getOccurrence(ctx: { db: SurveyDb }, id: number): OccurrenceRow | null {
  return one<OccurrenceRow>(ctx, `SELECT * FROM fw_occurrences WHERE id = ?`, [id]) ?? null;
}

/** A survey's occurrences; `unitId` narrows to one unit (null: those outside any unit). */
export function listOccurrences(ctx: { db: SurveyDb }, surveyId: number, opts: { unitId?: number | null } = {}): OccurrenceRow[] {
  if (opts.unitId === undefined) return rows<OccurrenceRow>(ctx, `SELECT * FROM fw_occurrences WHERE survey_id = ? ORDER BY observed_at, id`, [surveyId]);
  return rows<OccurrenceRow>(ctx, `SELECT * FROM fw_occurrences WHERE survey_id = ? AND unit_id IS ? ORDER BY observed_at, id`, [surveyId, opts.unitId]);
}

function checkOccurrenceUnit(ctx: { db: SurveyDb }, s: FwSurveyRow, unitId: number | null | undefined): void {
  if (unitId == null) return;
  if (getUnit(ctx, unitId)?.survey_id !== s.id) throw new SurveyError('bad_unit', 'not a unit of this survey');
}

/** The phase a new occurrence gets: blind / recheck in a recheck, none otherwise. */
function phaseNow(ctx: { db: SurveyDb }, s: FwSurveyRow): 'blind' | 'recheck' | null {
  if (!hasBlindPhase(ctx, s.id)) return null;
  return s.blind_closed_at == null ? 'blind' : 'recheck';
}

export function addOccurrence(ctx: Ctx, surveyId: number, fields: OccurrenceFields & { taxon_id: string }): number {
  const s = surveyOf(ctx, surveyId);
  if (!fields.taxon_id?.trim()) throw new SurveyError('not_found', 'taxon');
  checkOccurrenceUnit(ctx, s, fields.unit_id);
  const now = ctx.now();
  // taxon_id is always among them.
  const cols = OCCURRENCE_FIELDS.filter((c) => c !== 'observed_at' && fields[c] !== undefined);
  return Number(
    run(
      ctx,
      `INSERT INTO fw_occurrences (uuid, survey_id, ${cols.join(', ')}, observed_at, phase, created_at, updated_at)
       VALUES (?, ?, ${marks(cols.length)}, ?, ?, ?, ?)`,
      [ctx.uuid(), surveyId, ...cols.map((c) => fields[c] as Scalar), fields.observed_at ?? now, phaseNow(ctx, s), now, now],
    ).insertId,
  );
}

/** The same taxon and label already recorded in this unit (null: outside any unit), if any. */
export function findOccurrence(ctx: { db: SurveyDb }, surveyId: number, unitId: number | null, taxonId: string, verbatim: string | null): OccurrenceRow | null {
  return (
    one<OccurrenceRow>(
      ctx,
      `SELECT * FROM fw_occurrences WHERE survey_id = ? AND unit_id IS ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ? ORDER BY id LIMIT 1`,
      [surveyId, unitId, taxonId, verbatim?.trim() ?? ''],
    ) ?? null
  );
}

/** A blind occurrence once its survey's blind phase is closed: sealed, as in MIREN. */
export function occurrenceSealed(ctx: { db: SurveyDb }, o: Pick<OccurrenceRow, 'survey_id' | 'phase'>): boolean {
  if (o.phase !== 'blind') return false;
  return getFwSurvey(ctx, o.survey_id)?.blind_closed_at != null;
}

function unsealed(ctx: { db: SurveyDb }, id: number): OccurrenceRow {
  const o = getOccurrence(ctx, id);
  if (!o) throw new SurveyError('not_found', 'occurrence');
  if (occurrenceSealed(ctx, o)) throw new SurveyError('blind_sealed');
  return o;
}

export function updateOccurrence(ctx: Ctx, id: number, patch: OccurrenceFields): void {
  const o = unsealed(ctx, id);
  if (patch.taxon_id !== undefined && !patch.taxon_id.trim()) throw new SurveyError('not_found', 'taxon');
  checkOccurrenceUnit(ctx, surveyOf(ctx, o.survey_id), patch.unit_id);
  const cols = OCCURRENCE_FIELDS.filter((c) => patch[c] !== undefined);
  if (!cols.length) return;
  run(ctx, `UPDATE fw_occurrences SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...cols.map((c) => patch[c] as Scalar),
    ctx.now(),
    id,
  ]);
}

export function deleteOccurrence(ctx: Ctx, id: number): void {
  unsealed(ctx, id);
  // A 'found' answer is the occurrence it added; a re-identification that named it needs answering again.
  run(ctx, `DELETE FROM fw_rechecks WHERE occurrence_id = ? AND outcome = 'found'`, [id]);
  run(ctx, `UPDATE fw_rechecks SET occurrence_id = NULL, updated_at = ? WHERE occurrence_id = ?`, [ctx.now(), id]);
  run(ctx, `DELETE FROM fw_occurrence_values WHERE occurrence_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_media WHERE occurrence_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_occurrences WHERE id = ?`, [id]);
}

// ── component values ────────────────────────────────────────────────────────

export type ValueOwner = { kind: 'survey' | 'unit' | 'occurrence'; id: number };

export type ValueRow = {
  id: number;
  uuid: string;
  component: string;
  field: string;
  idx: number;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  updated_at: number;
};

const VALUE_TABLE = {
  survey: { table: 'fw_survey_values', owner: 'survey_id', parent: 'fw_surveys' },
  unit: { table: 'fw_unit_values', owner: 'unit_id', parent: 'fw_units' },
  occurrence: { table: 'fw_occurrence_values', owner: 'occurrence_id', parent: 'fw_occurrences' },
} as const;

/** Set one component field of a survey, unit or occurrence; null (or an empty value) clears it. */
export function setValue(ctx: Ctx, owner: ValueOwner, component: string, field: string, value: ValueInput | null, idx = 0): void {
  const v = VALUE_TABLE[owner.kind];
  if (!one(ctx, `SELECT 1 AS x FROM ${v.parent} WHERE id = ?`, [owner.id])) throw new SurveyError('not_found', owner.kind);
  if (owner.kind === 'survey') surveyOf(ctx, owner.id);
  if (owner.kind === 'occurrence') unsealed(ctx, owner.id);
  putValue(ctx, v.table, { [v.owner]: owner.id }, component, field, value, idx);
}

export function listValues(ctx: { db: SurveyDb }, owner: ValueOwner): ValueRow[] {
  const v = VALUE_TABLE[owner.kind];
  return rows<ValueRow>(ctx, `SELECT id, uuid, component, field, idx, value_num, value_text, unit, updated_at FROM ${v.table} WHERE ${v.owner} = ? ORDER BY component, field, idx`, [
    owner.id,
  ]);
}

// ── blind phase (rechecks of a permanent plot, §5.5) ────────────────────────

/** The survey before this one in its series, or null (no frame, or the first). */
export function previousSurveyId(ctx: { db: SurveyDb }, surveyId: number): number | null {
  const s = getFwSurvey(ctx, surveyId);
  if (!s || s.series_id == null || s.census_no == null) return null;
  return one<{ id: number }>(ctx, `SELECT id FROM fw_surveys WHERE series_id = ? AND census_no < ? ORDER BY census_no DESC LIMIT 1`, [s.series_id, s.census_no])?.id ?? null;
}

/** A plot-style recheck starts blind; a first survey and a checklist do not. */
export function hasBlindPhase(ctx: { db: SurveyDb }, surveyId: number): boolean {
  const s = getFwSurvey(ctx, surveyId);
  return s?.style === 'plot' && previousSurveyId(ctx, surveyId) != null;
}

/** End the blind phase: from now on new occurrences are 'recheck', and the earlier list can be shown. */
export function closeBlindPhase(ctx: Ctx, surveyId: number): void {
  const s = surveyOf(ctx, surveyId);
  if (!hasBlindPhase(ctx, surveyId)) throw new SurveyError('no_blind_phase');
  if (s.blind_closed_at != null) return;
  const now = ctx.now();
  run(ctx, `UPDATE fw_surveys SET blind_closed_at = ?, updated_at = ? WHERE id = ?`, [now, now, surveyId]);
}

/** Open the blind phase again after a mistaken close; refused once recheck work exists (as MIREN reopenBlind). */
export function reopenBlindPhase(ctx: Ctx, surveyId: number): void {
  const s = surveyOf(ctx, surveyId);
  if (s.blind_closed_at == null) return;
  const begun =
    one(ctx, `SELECT 1 AS x FROM fw_rechecks WHERE survey_id = ? LIMIT 1`, [surveyId]) != null ||
    one(ctx, `SELECT 1 AS x FROM fw_occurrences WHERE survey_id = ? AND phase = 'recheck' LIMIT 1`, [surveyId]) != null;
  if (begun) throw new SurveyError('recheck_begun');
  run(ctx, `UPDATE fw_surveys SET blind_closed_at = NULL, updated_at = ? WHERE id = ?`, [ctx.now(), surveyId]);
}

export type PreviousOccurrence = OccurrenceRow & { unit_level_key: string | null; unit_code: string | null; frame_unit_id: number | null };

/** The earlier survey's occurrences, with their unit for matching; refused while the blind phase is open. */
export function previousOccurrences(ctx: { db: SurveyDb }, surveyId: number): PreviousOccurrence[] {
  const s = surveyOf(ctx, surveyId);
  if (hasBlindPhase(ctx, surveyId) && s.blind_closed_at == null) throw new SurveyError('blind_open');
  const prev = previousSurveyId(ctx, surveyId);
  if (prev == null) return [];
  return rows<PreviousOccurrence>(
    ctx,
    `SELECT o.*, u.level_key AS unit_level_key, u.code AS unit_code, u.frame_unit_id
       FROM fw_occurrences o LEFT JOIN fw_units u ON u.id = o.unit_id
      WHERE o.survey_id = ? ORDER BY o.observed_at, o.id`,
    [prev],
  );
}

// ── recheck answers (v84) ───────────────────────────────────────────────────

export type RecheckRow = {
  id: number;
  uuid: string;
  survey_id: number;
  frame_unit_id: number | null;
  prev_taxon_id: string;
  /** '' for none (the unique key needs a value). */
  prev_verbatim_identification: string;
  outcome: RecheckOutcome;
  occurrence_id: number | null;
  checked_at: number;
  updated_at: number;
};

export function listRechecks(ctx: { db: SurveyDb }, surveyId: number): RecheckRow[] {
  return rows<RecheckRow>(ctx, `SELECT * FROM fw_rechecks WHERE survey_id = ? ORDER BY id`, [surveyId]);
}

export type RecheckCandidate = PreviousOccurrence & Sighting & { key: string; /** This survey's unit at the same place. */ unitId: number | null };

export type RecheckState = { previousId: number; candidates: RecheckCandidate[]; answers: RecheckRow[]; open: number };

const answerOf = (r: RecheckRow): RecheckAnswer => ({
  key: recheckKey({ frameUnitId: r.frame_unit_id, taxonId: r.prev_taxon_id, verbatim: r.prev_verbatim_identification || null }),
  outcome: r.outcome,
  occurrenceId: r.occurrence_id,
});

/**
 * What the recheck shows once the blind phase is closed: the previous
 * survey's taxa missing from the blind list of the same unit, the answers so
 * far, and how many are still open. Null when the survey has no blind phase
 * or it is still open.
 */
export function recheckState(ctx: { db: SurveyDb }, surveyId: number): RecheckState | null {
  const s = surveyOf(ctx, surveyId);
  const previousId = previousSurveyId(ctx, surveyId);
  if (s.style !== 'plot' || previousId == null || s.blind_closed_at == null) return null;
  const units = rows<{ id: number; frame_unit_id: number | null }>(ctx, `SELECT id, frame_unit_id FROM fw_units WHERE survey_id = ?`, [surveyId]);
  const unitAt = new Map<number | null, number | null>([[null, null]]);
  for (const u of units) if (u.frame_unit_id != null) unitAt.set(u.frame_unit_id, u.id);
  // Compared with the blind list only: a taxon found in the recheck stays a candidate, so its answer stays visible.
  const blind = rows<{ frame_unit_id: number | null; taxon_id: string; verbatim_identification: string | null }>(
    ctx,
    `SELECT u.frame_unit_id, o.taxon_id, o.verbatim_identification FROM fw_occurrences o LEFT JOIN fw_units u ON u.id = o.unit_id
      WHERE o.survey_id = ? AND o.phase = 'blind'`,
    [surveyId],
  ).map((r) => ({ frameUnitId: r.frame_unit_id, taxonId: r.taxon_id, verbatim: r.verbatim_identification }));
  const previous = previousOccurrences(ctx, surveyId).map((p) => ({
    ...p,
    frameUnitId: p.frame_unit_id,
    taxonId: p.taxon_id,
    verbatim: p.verbatim_identification,
  }));
  const candidates = recheckCandidates(previous, blind, new Set(unitAt.keys())).map((c) => ({
    ...c,
    key: recheckKey(c),
    unitId: unitAt.get(c.frameUnitId) ?? null,
  }));
  const answers = listRechecks(ctx, surveyId);
  return { previousId, candidates, answers, open: recheckOpen(candidates, answers.map(answerOf)) };
}

/**
 * Answer one recheck candidate (answering again replaces the answer):
 *   found         the taxon is added in the same unit as a 'recheck' occurrence; returns its id
 *   not_found     looked for and not there
 *   reidentified  recorded under another name this time: `occurrenceId` is that occurrence
 * The occurrence an earlier 'found' added goes when the answer changes.
 */
export function answerRecheck(ctx: Ctx, surveyId: number, candidate: Sighting, outcome: RecheckOutcome, occurrenceId: number | null = null): number | null {
  const state = recheckState(ctx, surveyId);
  if (!state) throw new SurveyError(hasBlindPhase(ctx, surveyId) ? 'blind_open' : 'no_blind_phase');
  const key = recheckKey(candidate);
  const c = state.candidates.find((x) => x.key === key);
  if (!c) throw new SurveyError('not_found', 'recheck candidate');
  if (outcome === 'reidentified') {
    const target = occurrenceId == null ? null : getOccurrence(ctx, occurrenceId);
    if (!target || target.survey_id !== surveyId) throw new SurveyError('not_found', 'occurrence');
  }
  const label = c.verbatim?.trim() ?? '';
  const old = one<RecheckRow>(
    ctx,
    `SELECT * FROM fw_rechecks WHERE survey_id = ? AND frame_unit_id IS ? AND prev_taxon_id = ? AND prev_verbatim_identification = ?`,
    [surveyId, c.frameUnitId, c.taxonId, label],
  );
  if (old?.outcome === 'found' && outcome === 'found' && old.occurrence_id != null) return old.occurrence_id;
  if (old?.outcome === 'found' && old.occurrence_id != null) {
    run(ctx, `DELETE FROM fw_occurrence_values WHERE occurrence_id = ?`, [old.occurrence_id]);
    run(ctx, `DELETE FROM fw_media WHERE occurrence_id = ?`, [old.occurrence_id]);
    run(ctx, `DELETE FROM fw_occurrences WHERE id = ? AND phase = 'recheck'`, [old.occurrence_id]);
  }
  const target =
    outcome === 'found'
      ? // One added by hand in the recheck phase is taken as the find.
        (findOccurrence(ctx, surveyId, c.unitId, c.taxonId, c.verbatim)?.id ??
        addOccurrence(ctx, surveyId, { taxon_id: c.taxonId, verbatim_identification: c.verbatim?.trim() || null, unit_id: c.unitId }))
      : outcome === 'reidentified'
        ? occurrenceId
        : null;
  const now = ctx.now();
  if (old) {
    run(ctx, `UPDATE fw_rechecks SET outcome = ?, occurrence_id = ?, checked_at = ?, updated_at = ? WHERE id = ?`, [outcome, target, now, now, old.id]);
  } else {
    run(
      ctx,
      `INSERT INTO fw_rechecks (uuid, survey_id, frame_unit_id, prev_taxon_id, prev_verbatim_identification, outcome, occurrence_id, checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.uuid(), surveyId, c.frameUnitId, c.taxonId, label, outcome, target, now, now],
    );
  }
  run(ctx, `UPDATE fw_surveys SET updated_at = ? WHERE id = ?`, [now, surveyId]);
  return outcome === 'found' ? target : null;
}

// ── morphospecies of a permanent plot (§5.5 #7) ─────────────────────────────

export type FrameLabelRow = {
  id: number;
  uuid: string;
  frame_id: number;
  taxon_id: string;
  verbatim_identification: string;
  note: string | null;
  photo_uri: string | null;
  first_survey_id: number | null;
  created_at: number;
  updated_at: number;
};

export function listFrameLabels(ctx: { db: SurveyDb }, frameId: number): FrameLabelRow[] {
  return rows<FrameLabelRow>(ctx, `SELECT * FROM fw_frame_labels WHERE frame_id = ? ORDER BY verbatim_identification, taxon_id`, [frameId]);
}

export function findFrameLabel(ctx: { db: SurveyDb }, frameId: number, taxonId: string, verbatim: string): FrameLabelRow | null {
  return (
    one<FrameLabelRow>(ctx, `SELECT * FROM fw_frame_labels WHERE frame_id = ? AND taxon_id = ? AND verbatim_identification = ?`, [frameId, taxonId, verbatim.trim()]) ?? null
  );
}

/**
 * Whether a label written in a survey is on its plot's list: 'listed', 'new'
 * (the screen asks before adding it), or 'none' (no frame or no label).
 */
export function frameLabelStatus(ctx: { db: SurveyDb }, surveyId: number, taxonId: string, verbatim: string | null): 'listed' | 'new' | 'none' {
  const s = getFwSurvey(ctx, surveyId);
  if (s?.frame_id == null || !verbatim?.trim()) return 'none';
  return findFrameLabel(ctx, s.frame_id, taxonId, verbatim) ? 'listed' : 'new';
}

export function addFrameLabel(
  ctx: Ctx,
  frameId: number,
  input: { taxonId: string; verbatim: string; note?: string | null; photoUri?: string | null; firstSurveyId?: number | null },
): number {
  if (!getFrame(ctx, frameId)) throw new SurveyError('not_found', 'frame');
  const verbatim = input.verbatim.trim();
  if (!verbatim || !input.taxonId.trim()) throw new SurveyError('not_found', 'label');
  if (findFrameLabel(ctx, frameId, input.taxonId, verbatim)) throw new SurveyError('label_taken', verbatim);
  const now = ctx.now();
  return Number(
    run(
      ctx,
      `INSERT INTO fw_frame_labels (uuid, frame_id, taxon_id, verbatim_identification, note, photo_uri, first_survey_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.uuid(), frameId, input.taxonId, verbatim, input.note ?? null, input.photoUri ?? null, input.firstSurveyId ?? null, now, now],
    ).insertId,
  );
}

/** The note and photo can change; the taxon and label are what occurrences match on, so they cannot. */
export function updateFrameLabel(ctx: Ctx, id: number, patch: { note?: string | null; photoUri?: string | null }): void {
  const sets: string[] = [];
  const vals: Scalar[] = [];
  if (patch.note !== undefined) {
    sets.push('note = ?');
    vals.push(patch.note);
  }
  if (patch.photoUri !== undefined) {
    sets.push('photo_uri = ?');
    vals.push(patch.photoUri);
  }
  if (!sets.length) return;
  run(ctx, `UPDATE fw_frame_labels SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, ctx.now(), id]);
}

// ── component values (2B) ───────────────────────────────────────────────────

/** Where a component's values live: a survey, one of its units, or one of its occurrences. */
export type ComponentOwner = ValueOwner;

const OWNER_TABLE = { survey: 'fw_surveys', unit: 'fw_units', occurrence: 'fw_occurrences' } as const;
const MEDIA_OWNER_COL = { survey: 'survey_id', unit: 'unit_id', occurrence: 'occurrence_id' } as const;

/** The survey an owner belongs to (a checklist / plot-style one), and the owner's unit level when it is a unit. */
function ownerContext(ctx: { db: SurveyDb }, owner: ComponentOwner): { survey: FwSurveyRow; unitLevel: string | null } {
  if (owner.kind === 'survey') return { survey: surveyOf(ctx, owner.id), unitLevel: null };
  if (owner.kind === 'unit') {
    const u = getUnit(ctx, owner.id);
    if (!u) throw new SurveyError('not_found', 'unit');
    return { survey: surveyOf(ctx, u.survey_id), unitLevel: u.level_key };
  }
  const o = getOccurrence(ctx, owner.id);
  if (!o) throw new SurveyError('not_found', 'occurrence');
  return { survey: surveyOf(ctx, o.survey_id), unitLevel: null };
}

/** The template component `key` of the owner's survey, which must sit on the owner's level. */
function placedComponent(ctx: { db: SurveyDb }, owner: ComponentOwner, key: string) {
  const { survey, unitLevel } = ownerContext(ctx, owner);
  const instance = snapshotOf(survey).components.find((c) => c.key === key);
  const def = instance ? componentDef(instance.type) : undefined;
  if (!instance || !def) throw new SurveyError('bad_component', `no component ${key}`);
  if (instance.level !== owner.kind || (owner.kind === 'unit' && instance.unit !== unitLevel)) {
    throw new SurveyError('bad_component', `${key} sits on ${instance.level}${instance.unit ? `:${instance.unit}` : ''}, not here`);
  }
  return { instance, def, survey };
}

const ownerSql = (owner: ComponentOwner) => `${OWNER_TABLE[owner.kind]}`;

/** One stored value as the registry describes it (a 'num' field may hold a marker text). */
function readValue(valueType: 'num' | 'text' | 'json', num: number | null, text: string | null): FieldValue {
  if (valueType === 'num') return num ?? text;
  if (valueType === 'json') {
    if (text == null) return null;
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v.map(String) : null;
    } catch {
      return null;
    }
  }
  return text;
}

/** A component's values on one owner, field by field (media fields list their file URIs). */
export function readComponent(ctx: { db: SurveyDb }, owner: ComponentOwner, key: string): ComponentValues {
  const { instance, def } = placedComponent(ctx, owner, key);
  const out: Record<string, FieldValue> = {};
  const fields = def.fields(instance.params, instance.level, instance.key);
  const cols = fields.filter((f) => 'col' in f.storage);
  if (cols.length) {
    const row = one<Record<string, unknown>>(ctx, `SELECT ${cols.map((f) => f.field).join(', ')} FROM ${ownerSql(owner)} WHERE id = ?`, [owner.id]) ?? {};
    for (const f of cols) {
      const raw = row[f.field] as string | number | null | undefined;
      const s = f.storage as { valueType: 'num' | 'text' | 'json' };
      out[f.field] = s.valueType === 'json' ? (raw == null ? null : parseMultiAttribute(String(raw))) : (raw ?? null);
    }
  }
  const valueFields = fields.filter((f) => 'values' in f.storage);
  if (valueFields.length) {
    const v = VALUE_TABLE[owner.kind];
    const got = rows<{ field: string; idx: number; value_num: number | null; value_text: string | null }>(
      ctx,
      `SELECT field, idx, value_num, value_text FROM ${v.table} WHERE ${v.owner} = ? AND component = ? ORDER BY field, idx`,
      [owner.id, instance.key],
    );
    for (const f of valueFields) {
      const s = f.storage as { valueType: 'num' | 'text' | 'json'; repeat?: boolean };
      const mine = got.filter((r) => r.field === f.field);
      if (s.repeat) {
        const per: Record<number, number | string> = {};
        for (const r of mine) {
          const x = readValue(s.valueType, r.value_num, r.value_text);
          if (x != null && !Array.isArray(x)) per[r.idx] = x as number | string;
        }
        out[f.field] = Object.keys(per).length ? per : null;
      } else {
        const r = mine.find((x) => x.idx === 0);
        out[f.field] = r ? readValue(s.valueType, r.value_num, r.value_text) : null;
      }
    }
  }
  for (const f of fields.filter((x) => 'media' in x.storage)) {
    const kind = (f.storage as { media: 'photo' | 'audio' }).media;
    out[f.field] = listMedia(ctx, owner, instance.key, kind).map((m) => m.uri);
  }
  return out;
}

/**
 * Write some of a component's fields on one owner; null clears a field. Values
 * of the wrong kind or outside what a field accepts are refused (bad_value);
 * missing values and rules across fields are the form's to show. Media go
 * through addMedia / removeMedia.
 */
export function writeComponent(ctx: Ctx, owner: ComponentOwner, key: string, patch: ComponentValues): void {
  const { instance, def } = placedComponent(ctx, owner, key);
  if (owner.kind === 'occurrence') unsealed(ctx, owner.id);
  const fields = def.fields(instance.params, instance.level, instance.key);
  const byName = new Map(fields.map((f) => [f.field, f]));
  for (const name of Object.keys(patch)) {
    const f = byName.get(name);
    if (!f) throw new SurveyError('bad_value', `${key} has no field ${name}`);
    if ('media' in f.storage) throw new SurveyError('bad_value', `${name} is a media field (addMedia)`);
  }
  const blockers = storeBlockers(def, instance.params, instance.level, instance.key, patch);
  if (blockers.length) throw new SurveyError('bad_value', blockers.map((b) => `${b.field}${b.idx != null ? `[${b.idx}]` : ''}: ${b.code}`).join('; '));
  const now = ctx.now();
  const sets: string[] = [];
  const vals: Scalar[] = [];
  for (const [name, value] of Object.entries(patch)) {
    const f = byName.get(name)!;
    const s = f.storage;
    if ('col' in s) {
      sets.push(`${name} = ?`);
      vals.push(s.valueType === 'json' ? serializeMultiAttribute(Array.isArray(value) ? [...value] : null) : ((value as Scalar | undefined) ?? null));
      continue;
    }
    if (!('values' in s)) continue;
    const v = VALUE_TABLE[owner.kind];
    const put = (x: FieldValue | undefined, idx: number) =>
      putValue(
        ctx,
        v.table,
        { [v.owner]: owner.id },
        instance.key,
        name,
        x == null || x === ''
          ? null
          : s.valueType === 'json'
            ? Array.isArray(x) && x.length
              ? { text: JSON.stringify(x) }
              : null
            : typeof x === 'number'
              ? { num: x, unit: s.unit ?? null }
              : { text: String(x), unit: s.unit ?? null },
        idx,
      );
    if (s.repeat) {
      if (value == null) run(ctx, `DELETE FROM ${v.table} WHERE ${v.owner} = ? AND component = ? AND field = ?`, [owner.id, instance.key, name]);
      else for (const [idx, x] of Object.entries(value as Record<number, number | string | null>)) put(x, Number(idx));
    } else {
      put(value, 0);
    }
  }
  if (sets.length) run(ctx, `UPDATE ${ownerSql(owner)} SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, owner.id]);
  else run(ctx, `UPDATE ${ownerSql(owner)} SET updated_at = ? WHERE id = ?`, [now, owner.id]);
}

export type FwMediaRow = {
  id: number;
  uuid: string;
  survey_id: number;
  unit_id: number | null;
  occurrence_id: number | null;
  component: string;
  kind: 'photo' | 'audio';
  uri: string;
  created_at: number;
};

/** Photos or recordings of one owner (of one component, when given), oldest first. */
export function listMedia(ctx: { db: SurveyDb }, owner: ComponentOwner, component?: string, kind?: 'photo' | 'audio'): FwMediaRow[] {
  const where = owner.kind === 'survey' ? 'survey_id = ? AND unit_id IS NULL AND occurrence_id IS NULL' : `${MEDIA_OWNER_COL[owner.kind]} = ?`;
  return rows<FwMediaRow>(
    ctx,
    `SELECT id, uuid, survey_id, unit_id, occurrence_id, component, kind, uri, created_at FROM fw_media
      WHERE ${where} ${component ? 'AND component = ?' : ''} ${kind ? 'AND kind = ?' : ''} ORDER BY id`,
    [owner.id, ...(component ? [component] : []), ...(kind ? [kind] : [])],
  );
}

/** Add a photo or recording to an owner, for the template component `key` (which must be a media field there). */
export function addMedia(ctx: Ctx, owner: ComponentOwner, key: string, uri: string): number {
  const { instance, def, survey } = placedComponent(ctx, owner, key);
  if (owner.kind === 'occurrence') unsealed(ctx, owner.id);
  const media = def.fields(instance.params, instance.level, instance.key).find((f) => 'media' in f.storage);
  if (!media || !('media' in media.storage)) throw new SurveyError('bad_value', `${key} holds no media`);
  const max = Number(instance.params.max);
  if (Number.isInteger(max) && listMedia(ctx, owner, key, media.storage.media).length >= max) throw new SurveyError('bad_value', `${key}: at most ${max}`);
  const res = run(
    ctx,
    `INSERT INTO fw_media (uuid, survey_id, unit_id, occurrence_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      survey.id,
      owner.kind === 'unit' ? owner.id : null,
      owner.kind === 'occurrence' ? owner.id : null,
      key,
      media.storage.media,
      uri,
      ctx.now(),
    ],
  );
  run(ctx, `UPDATE ${ownerSql(owner)} SET updated_at = ? WHERE id = ?`, [ctx.now(), owner.id]);
  return Number(res.insertId);
}

export function removeMedia(ctx: Ctx, owner: ComponentOwner, key: string, uri: string): void {
  if (owner.kind === 'occurrence') unsealed(ctx, owner.id);
  const where = owner.kind === 'survey' ? 'survey_id = ? AND unit_id IS NULL AND occurrence_id IS NULL' : `${MEDIA_OWNER_COL[owner.kind]} = ?`;
  run(ctx, `DELETE FROM fw_media WHERE ${where} AND component = ? AND uri = ?`, [owner.id, key, uri]);
  run(ctx, `UPDATE ${ownerSql(owner)} SET updated_at = ? WHERE id = ?`, [ctx.now(), owner.id]);
}

/** The component instance `key` of a survey's template (what the screens render). */
export function surveyComponent(ctx: { db: SurveyDb }, surveyId: number, key: string): ComponentInstance | null {
  return snapshotOf(surveyOf(ctx, surveyId)).components.find((c) => c.key === key) ?? null;
}
