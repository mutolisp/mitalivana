/**
 * GLORIA persistence (tables from migration v47).
 *
 * A survey is created with all 28 units and 28 measurement points. When the
 * summit has an earlier survey, only plot re-establishment data is carried
 * (points, p5m, walk options — model/prefill); species lists start empty,
 * because resurveys are recorded blind (manual Box 4.5).
 *
 * Every write is immediate; screens never hold unsaved state beyond one
 * gesture (a brush stroke is flushed on release).
 */

import type { Scalar } from '@op-engineering/op-sqlite';
import { getUserDb, withTransaction } from '~/db/init';
import { closeActiveRecords } from '~/db/activeRecords';
import { generateUuid } from '~/db/uuid';
import { ensureTaxonSelfSufficient } from '~/db/taxonCache';
import { defaultSurveyorString } from '~/db/surveyors';
import {
  EMPTY_TAXON_FIELDS,
  applyAdoptedName,
  resolveAdoptedNames,
  resolveTaxa,
  type TaxonFields,
} from '~/db/taxonLookup';
import { ALL_UNITS, DIRECTIONS, POINTS, type Direction, type P5mCorner, type UnitType } from './model/units';
import { planPrefill, nextSerial, type PrevSurvey } from './model/prefill';
import type { WalkOption } from './model/walk';
import { nextMinute, onDay } from './model/quadratTimes';
import { takesRealStart } from './model/surveyDates';
import { bySpeciesOrder } from './model/speciesOrder';
import type { SummitDiff } from './model/summitImport';
import type { GloriaDoc } from './export/yaml';
import { SPECIES_FIELDS, UNIT_FIELDS, buildGloriaDoc } from './export/yaml';
import type { GloriaExportData } from './export/sheetRows';
import { importLoggerVisits, listLoggers, visitsOfSurvey } from './loggerDb';

// ── Row types ─────────────────────────────────────────────────────────────

export type GloriaSummit = {
  id: number;
  full_code: string;
  country: string;
  target_region: string;
  summit: string;
  name: string | null;
  decimal_latitude: number | null;
  decimal_longitude: number | null;
  twd97x: number | null;
  twd97y: number | null;
  elevation_m: number | null;
  veg_zone: string | null;
  created_at: number;
  updated_at: number;
};

export type GloriaSurvey = {
  id: number;
  uuid: string;
  summit_id: number;
  mocy: number;
  year: number | null;
  status: 'active' | 'done';
  start_ts: number;
  stop_ts: number | null;
  recorded_by: string | null;
  prev_survey_id: number | null;
  project_id: number;
  site_id: number | null;
  grid_ok_n: number;
  grid_ok_e: number;
  grid_ok_s: number;
  grid_ok_w: number;
  notes: string | null;
  /** JSON [{ uri, viewpoint }]; see model/overview.ts. */
  overview_photos: string | null;
  starred: number;
  created_at: number;
  updated_at: number;
};

export type GloriaPoint = {
  id: number;
  survey_id: number;
  point_key: string;
  is_p5m: number;
  distance_m: number | null;
  compass_deg: number | null;
  photo_m2: string | null;
  photo_m2f: string | null;
  photo_point: string | null;
  comments: string | null;
  uuid: string;
};

export type GloriaUnit = {
  id: number;
  survey_id: number;
  code: string;
  unit_type: UnitType;
  start_ts: number | null;
  stop_ts: number | null;
  freq_start_ts: number | null;
  freq_stop_ts: number | null;
  /** 1 once the user set freq_stop_ts by hand; edits then stop moving it. */
  freq_stop_manual: number;
  /** 1 while the frequency is marked done and locked against edits. */
  freq_locked: number;
  /** 1 while the unit (a quadrat's cover estimate; a whole SAS / square) is
   *  done and locked (v54). Before v54 done meant `stop_ts` set. */
  done_locked: number;
  /** Point-framing of a 1×1 m quadrat: its own start / end and lock (v53). */
  pf_start_ts: number | null;
  pf_stop_ts: number | null;
  pf_locked: number;
  /** 1 = frequency and point-framing not done here (shrubs; v62). NULL = not skipped, never 0. */
  freq_skipped: number | null;
  /** 1 = start_ts is only a date (filled from the survey's start date; v64). NULL otherwise. */
  date_only: number | null;
  recorded_by: string | null;
  aspect_deg: number | null;
  slope_deg: number | null;
  cov_vascular: number | null;
  cov_solid_rock: number | null;
  cov_scree: number | null;
  cov_lichens: number | null;
  cov_bryophytes: number | null;
  cov_bare_ground: number | null;
  cov_litter: number | null;
  sub_lich_below_vasc: number | null;
  sub_lich_on_rock: number | null;
  sub_lich_on_scree: number | null;
  sub_bry_below_vasc: number | null;
  sub_bry_on_rock: number | null;
  sub_bry_on_scree: number | null;
  dist_hi1: string | null;
  dist_hi2: string | null;
  dist_hi3: string | null;
  /** How frequency was taken: cell masks or counts only (v48). */
  freq_mode: 'cells' | 'count' | null;
  dist_hi1_n: number | null;
  dist_hi2_n: number | null;
  dist_hi3_n: number | null;
  point_surface: string | null;
  walk_option: WalkOption | null;
  legacy_surface_hits: string | null;
  grazing_note: string | null;
  comments: string | null;
  photo_paths: string | null;
  uuid: string;
  updated_at: number;
};

export type GloriaTaxon = {
  id: number;
  survey_id: number;
  taxon_id: string;
  serial: number;
  used_name_id: number | null;
  used_scientific_name: string | null;
  verbatim_identification: string | null;
  created_at: number;
};

export type GloriaUnitSpecies = {
  id: number;
  unit_id: number;
  gloria_taxon_id: number;
  occurrence_id: string;
  cover_pct: number | null;
  abundance: 'r!' | 'r' | 's' | 'c' | 'd' | null;
  layer: string | null;
  cf: 'g' | 's' | 't' | null;
  freq_cells: string | null;
  point_hits: string | null;
  legacy_hits: number | null;
  /** Count-only frequency, 0–100, when the cells were not recorded (v48). */
  freq_count: number | null;
  /** JSON arrays, same encoding as plot records (lib/dwcAttributes). */
  reproductive_condition: string | null;
  leaf_phenology: string | null;
  comments: string | null;
  /** Position in the unit's list, set by dragging (v55); null = never reordered. */
  sort_order: number | null;
  created_at: number;
  updated_at: number;
};

/** Unit species with its roster entry and resolved names, for display. */
export type GloriaUnitSpeciesWithTaxon = GloriaUnitSpecies &
  TaxonFields & {
    taxon_id: string;
    serial: number;
    used_name_id: number | null;
    used_scientific_name: string | null;
    /** Morphospecies label on the roster entry (sp1, sp2), shared by the survey. */
    verbatim_identification: string | null;
  };

const rows = <T>(res: { rows?: unknown[] }): T[] => (res.rows ?? []) as T[];

// ── Summits ───────────────────────────────────────────────────────────────

export type SummitInput = {
  country: string;
  target_region: string;
  summit: string;
  name?: string | null;
  decimal_latitude?: number | null;
  decimal_longitude?: number | null;
  twd97x?: number | null;
  twd97y?: number | null;
  elevation_m?: number | null;
  veg_zone?: string | null;
};

export function summitFullCode(s: Pick<SummitInput, 'country' | 'target_region' | 'summit'>): string {
  return `${s.country}-${s.target_region}-${s.summit}`.toUpperCase();
}

/** Insert or update by full code (TW-DAS-SUN). Returns the summit id. */
export function upsertSummit(input: SummitInput): number {
  const db = getUserDb();
  const now = Date.now();
  const code = summitFullCode(input);
  const found = rows<{ id: number }>(db.executeSync(`SELECT id FROM gloria_summits WHERE full_code = ?`, [code]))[0];
  const vals = [
    input.country.toUpperCase(),
    input.target_region.toUpperCase(),
    input.summit.toUpperCase(),
    input.name ?? null,
    input.decimal_latitude ?? null,
    input.decimal_longitude ?? null,
    input.twd97x ?? null,
    input.twd97y ?? null,
    input.elevation_m ?? null,
    input.veg_zone ?? null,
  ];
  if (found) {
    db.executeSync(
      `UPDATE gloria_summits SET country = ?, target_region = ?, summit = ?, name = ?, decimal_latitude = ?,
         decimal_longitude = ?, twd97x = ?, twd97y = ?, elevation_m = ?, veg_zone = ?, updated_at = ? WHERE id = ?`,
      [...vals, now, found.id],
    );
    return found.id;
  }
  const res = db.executeSync(
    `INSERT INTO gloria_summits (full_code, country, target_region, summit, name, decimal_latitude,
       decimal_longitude, twd97x, twd97y, elevation_m, veg_zone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, ...vals, now, now],
  );
  return Number(res.insertId);
}

/**
 * Write the summits the user ticked on the import review: new ones are
 * created, changed ones get only the fields that differ (a blank cell in the
 * file never clears a stored value — see model/summitImport diffSummits).
 */
export function applySummitImport(chosen: SummitDiff[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  withTransaction(() => {
    for (const d of chosen) {
      if (d.kind === 'new') {
        const { line: _line, full_code: _code, ...input } = d.item;
        upsertSummit(input);
        added += 1;
      } else if (d.kind === 'changed') {
        updateSummit(d.id, Object.fromEntries(d.changes.map((c) => [c.field, c.to])) as SummitPatch);
        updated += 1;
      }
    }
  });
  return { added, updated };
}

export type SummitPatch = Partial<
  Pick<GloriaSummit, 'name' | 'decimal_latitude' | 'decimal_longitude' | 'elevation_m' | 'veg_zone'>
>;

/** Edit a summit's base data. Coordinates are WGS84 only; twd97x/y are kept
 *  for sheet history but not recorded by the app. */
export function updateSummit(id: number, patch: SummitPatch): void {
  patchRow('gloria_summits', id, patch, true);
}

export function getSummit(id: number): GloriaSummit | null {
  return rows<GloriaSummit>(getUserDb().executeSync(`SELECT * FROM gloria_summits WHERE id = ?`, [id]))[0] ?? null;
}

export type SummitWithLast = GloriaSummit & { last_mocy: number | null; last_year: number | null };

export function listSummits(): SummitWithLast[] {
  return rows<SummitWithLast>(
    getUserDb().executeSync(
      `SELECT s.*, MAX(v.mocy) AS last_mocy,
              (SELECT year FROM gloria_surveys WHERE summit_id = s.id ORDER BY mocy DESC LIMIT 1) AS last_year
         FROM gloria_summits s LEFT JOIN gloria_surveys v ON v.summit_id = s.id
        GROUP BY s.id ORDER BY s.target_region, s.summit`,
    ),
  );
}

// ── Surveys ───────────────────────────────────────────────────────────────

export function getGloriaSurvey(id: number): GloriaSurvey | null {
  return rows<GloriaSurvey>(getUserDb().executeSync(`SELECT * FROM gloria_surveys WHERE id = ?`, [id]))[0] ?? null;
}

export function getActiveGloriaSurvey(): GloriaSurvey | null {
  return (
    rows<GloriaSurvey>(
      getUserDb().executeSync(`SELECT * FROM gloria_surveys WHERE status = 'active' ORDER BY start_ts DESC LIMIT 1`),
    )[0] ?? null
  );
}

export function listGloriaSurveys(): Array<GloriaSurvey & { full_code: string }> {
  return rows(
    getUserDb().executeSync(
      `SELECT v.*, s.full_code FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id
        ORDER BY v.start_ts DESC`,
    ),
  );
}

export type GloriaSurveyWithMeta = GloriaSurvey & {
  full_code: string;
  summit_name: string | null;
  project_name: string | null;
  /** Distinct taxa recorded in any unit. */
  species_count: number;
  /** Units with anything recorded. */
  units_started: number;
};

/** One query for the records tab: summit code, project name and counts. */
export function listGloriaSurveysWithMeta(): GloriaSurveyWithMeta[] {
  return rows(
    getUserDb().executeSync(
      `SELECT v.*, s.full_code, s.name AS summit_name, p.name AS project_name,
              (SELECT COUNT(DISTINCT us.gloria_taxon_id) FROM gloria_unit_species us
                 JOIN gloria_units u ON u.id = us.unit_id
                WHERE u.survey_id = v.id) AS species_count,
              (SELECT COUNT(*) FROM gloria_units u
                WHERE u.survey_id = v.id AND ((u.start_ts IS NOT NULL AND u.date_only IS NULL) OR u.point_surface IS NOT NULL
                   OR EXISTS (SELECT 1 FROM gloria_unit_species us WHERE us.unit_id = u.id))
              ) AS units_started
         FROM gloria_surveys v
         JOIN gloria_summits s ON s.id = v.summit_id
         LEFT JOIN projects p ON p.id = v.project_id
        ORDER BY v.start_ts DESC`,
    ),
  );
}

/** The most recent survey of a summit, or null for a first survey. */
export function latestSurveyOf(summitId: number): GloriaSurvey | null {
  return (
    rows<GloriaSurvey>(
      getUserDb().executeSync(`SELECT * FROM gloria_surveys WHERE summit_id = ? ORDER BY mocy DESC LIMIT 1`, [summitId]),
    )[0] ?? null
  );
}

/** What a new survey would carry over, for the "will prefill …" notice. */
export function prefillSummary(summitId: number): { mocy: number; points: number; fromMocy: number | null } {
  const prev = latestSurveyOf(summitId);
  if (!prev) return { mocy: 1, points: 0, fromMocy: null };
  const plan = planPrefill(loadPrev(prev));
  return { mocy: plan.mocy, points: plan.points.filter((p) => p.distance_m != null).length, fromMocy: prev.mocy };
}

function loadPrev(prev: GloriaSurvey): PrevSurvey {
  const db = getUserDb();
  const points = rows<GloriaPoint>(db.executeSync(`SELECT * FROM gloria_points WHERE survey_id = ?`, [prev.id]));
  const units = rows<{ code: string; walk_option: WalkOption | null }>(
    db.executeSync(`SELECT code, walk_option FROM gloria_units WHERE survey_id = ?`, [prev.id]),
  );
  return {
    mocy: prev.mocy,
    p5m: p5mOf(points),
    points: points.map((p) => ({
      key: p.point_key,
      distance_m: p.distance_m,
      compass_deg: p.compass_deg,
      comments: p.comments,
    })),
    walkOptions: units,
  };
}

export type CreateGloriaInput = {
  summitId: number;
  projectId?: number;
  /** Omit to use the default surveyors; null forces empty. */
  recorded_by?: string | null;
};

/** Create (and activate) the next monitoring cycle of a summit. */
export function createGloriaSurvey(input: CreateGloriaInput): number {
  return withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    closeActiveRecords(db, now);

    const prev = latestSurveyOf(input.summitId);
    const plan = planPrefill(prev ? loadPrev(prev) : null);
    const res = db.executeSync(
      `INSERT INTO gloria_surveys (uuid, summit_id, mocy, year, status, start_ts, recorded_by, prev_survey_id,
         project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [
        generateUuid(),
        input.summitId,
        plan.mocy,
        new Date(now).getFullYear(),
        now,
        input.recorded_by === undefined ? defaultSurveyorString() : input.recorded_by,
        prev?.id ?? null,
        input.projectId ?? 0,
        now,
        now,
      ],
    );
    const surveyId = Number(res.insertId);

    // Points: all 28, carried values where the previous survey had them.
    const prevPoint = new Map(plan.points.map((p) => [p.key, p]));
    for (const p of POINTS) {
      const carried = prevPoint.get(p.key);
      const d = p.key[0] as Direction;
      const isP5m = p.quadrat != null && plan.p5m[d] === p.key.slice(1) ? 1 : 0;
      db.executeSync(
        `INSERT INTO gloria_points (survey_id, point_key, is_p5m, distance_m, compass_deg, comments, uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [surveyId, p.key, isP5m, carried?.distance_m ?? null, carried?.compass_deg ?? null, carried?.comments ?? null, generateUuid()],
      );
    }

    // Units: all 28, empty; only the walk option is carried (p.57).
    const walk = new Map(plan.walkOptions.map((w) => [w.code, w.walk_option]));
    for (const u of ALL_UNITS) {
      db.executeSync(
        `INSERT INTO gloria_units (survey_id, code, unit_type, walk_option, uuid, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [surveyId, u.code, u.type, walk.get(u.code) ?? null, generateUuid(), now],
      );
    }
    return surveyId;
  });
}

/**
 * `endTs`: the end time the user chose (src/lib/endTimeChoice) — a time, or
 * null to leave it blank. Omitted (automatic endings): keep an existing time,
 * otherwise now.
 */
export function endGloriaSurvey(id: number, endTs?: number | null): void {
  const now = Date.now();
  getUserDb().executeSync(
    endTs === undefined
      ? `UPDATE gloria_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`
      : `UPDATE gloria_surveys SET status = 'done', stop_ts = ?, updated_at = ? WHERE id = ?`,
    [endTs === undefined ? now : endTs, now, id],
  );
}

export function reopenGloriaSurvey(id: number): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    closeActiveRecords(db, now, { kind: 'gloria', id });
    // The end time stays: finishing again asks whether to keep it or use now.
    db.executeSync(`UPDATE gloria_surveys SET status = 'active', updated_at = ? WHERE id = ?`, [now, id]);
  });
}

/** Delete a survey and everything under it (FK cascades cover points, units, roster, unit species). */
export function deleteGloriaSurvey(id: number): void {
  withTransaction(() => {
    const db = getUserDb();
    // Explicit child deletes as well: cascades are only as good as PRAGMA foreign_keys.
    db.executeSync(
      `DELETE FROM gloria_unit_species WHERE unit_id IN (SELECT id FROM gloria_units WHERE survey_id = ?)`,
      [id],
    );
    db.executeSync(`DELETE FROM gloria_units WHERE survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM gloria_taxa WHERE survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM gloria_points WHERE survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM gloria_photo_checks WHERE survey_id = ?`, [id]);
    db.executeSync(`UPDATE gloria_surveys SET prev_survey_id = NULL WHERE prev_survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM gloria_surveys WHERE id = ?`, [id]);
  });
}

/**
 * Change which monitoring cycle a survey is (mocy). One survey per cycle per
 * summit, so a cycle already taken is refused. The previous-cycle links of the
 * whole summit are then rebuilt in mocy order — they drive the "differs from
 * last time" tint on the measurement points.
 */
export function setSurveyMocy(id: number, mocy: number): 'ok' | 'taken' | 'invalid' {
  if (!Number.isInteger(mocy) || mocy < 1 || mocy > 99) return 'invalid';
  return withTransaction(() => {
    const db = getUserDb();
    const sv = rows<{ summit_id: number }>(db.executeSync(`SELECT summit_id FROM gloria_surveys WHERE id = ?`, [id]))[0];
    if (!sv) return 'invalid';
    const clash = rows(db.executeSync(`SELECT 1 FROM gloria_surveys WHERE summit_id = ? AND mocy = ? AND id != ?`, [sv.summit_id, mocy, id]));
    if (clash.length) return 'taken';
    db.executeSync(`UPDATE gloria_surveys SET mocy = ?, updated_at = ? WHERE id = ?`, [mocy, Date.now(), id]);
    const chain = rows<{ id: number }>(db.executeSync(`SELECT id FROM gloria_surveys WHERE summit_id = ? ORDER BY mocy`, [sv.summit_id]));
    chain.forEach((s, i) =>
      db.executeSync(`UPDATE gloria_surveys SET prev_survey_id = ? WHERE id = ?`, [i > 0 ? chain[i - 1].id : null, s.id]),
    );
    return 'ok';
  });
}

type SurveyPatch = Partial<Pick<GloriaSurvey, 'recorded_by' | 'notes' | 'project_id' | 'site_id' | 'starred' | 'year' | 'overview_photos'>> &
  Partial<Record<'grid_ok_n' | 'grid_ok_e' | 'grid_ok_s' | 'grid_ok_w', number>>;

export function updateGloriaSurvey(id: number, patch: SurveyPatch): void {
  patchRow('gloria_surveys', id, patch, true);
}

// ── Points ────────────────────────────────────────────────────────────────

export function listPoints(surveyId: number): GloriaPoint[] {
  const all = rows<GloriaPoint>(getUserDb().executeSync(`SELECT * FROM gloria_points WHERE survey_id = ?`, [surveyId]));
  const order = new Map(POINTS.map((p, i) => [p.key, i]));
  return all.sort((a, b) => (order.get(a.point_key) ?? 99) - (order.get(b.point_key) ?? 99));
}

export function updatePoint(
  id: number,
  patch: Partial<Pick<GloriaPoint, 'distance_m' | 'compass_deg' | 'photo_m2' | 'photo_m2f' | 'photo_point' | 'comments'>>,
): void {
  patchRow('gloria_points', id, patch, false);
}

// ── Photo checklist (model/photoChecks) ───────────────────────────────────

export type PhotoCheckRow = { id: number; survey_id: number; item: string; checked: number; photo_uri: string | null; updated_at: number };

export function listPhotoChecks(surveyId: number): PhotoCheckRow[] {
  return rows<PhotoCheckRow>(getUserDb().executeSync(`SELECT * FROM gloria_photo_checks WHERE survey_id = ? ORDER BY item`, [surveyId]));
}

/** Tick / untick an item, or set / clear its own photo (a photo also ticks it). */
export function setPhotoCheck(surveyId: number, item: string, patch: { checked?: boolean; photo_uri?: string | null }): void {
  const db = getUserDb();
  const now = Date.now();
  const has = rows(db.executeSync(`SELECT 1 FROM gloria_photo_checks WHERE survey_id = ? AND item = ?`, [surveyId, item])).length > 0;
  const checked = patch.checked ?? (patch.photo_uri ? true : undefined);
  if (!has) {
    db.executeSync(
      `INSERT INTO gloria_photo_checks (survey_id, item, checked, photo_uri, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [surveyId, item, checked ? 1 : 0, patch.photo_uri ?? null, now],
    );
  } else {
    if (checked !== undefined)
      db.executeSync(`UPDATE gloria_photo_checks SET checked = ?, updated_at = ? WHERE survey_id = ? AND item = ?`, [checked ? 1 : 0, now, surveyId, item]);
    if (patch.photo_uri !== undefined)
      db.executeSync(`UPDATE gloria_photo_checks SET photo_uri = ?, updated_at = ? WHERE survey_id = ? AND item = ?`, [patch.photo_uri, now, surveyId, item]);
  }
  touchSurvey(surveyId);
}

/** Write the points and p5m corners ticked on the point-import review, together. */
export function applyPointImport(
  surveyId: number,
  points: Array<{ id: number; patch: Partial<Pick<GloriaPoint, 'distance_m' | 'compass_deg' | 'comments'>> }>,
  p5m: Array<{ direction: Direction; corner: P5mCorner }>,
): void {
  withTransaction(() => {
    for (const p of points) updatePoint(p.id, p.patch);
    for (const x of p5m) setP5m(surveyId, x.direction, x.corner);
    touchSurvey(surveyId);
  });
}

/** Mark which lower corner of a direction is the p5m point (exactly one). */
export function setP5m(surveyId: number, direction: Direction, corner: P5mCorner): void {
  withTransaction(() => {
    const db = getUserDb();
    db.executeSync(
      `UPDATE gloria_points SET is_p5m = CASE WHEN point_key = ? THEN 1 ELSE 0 END
        WHERE survey_id = ? AND point_key IN (?, ?)`,
      [direction + corner, surveyId, `${direction}11`, `${direction}31`],
    );
    touchSurvey(surveyId);
  });
}

export function p5mOf(points: GloriaPoint[]): Partial<Record<Direction, P5mCorner>> {
  const out: Partial<Record<Direction, P5mCorner>> = {};
  for (const d of DIRECTIONS) {
    const p = points.find((x) => x.is_p5m && x.point_key[0] === d);
    if (p) out[d] = p.point_key.slice(1) as P5mCorner;
  }
  return out;
}

// ── Units ─────────────────────────────────────────────────────────────────

export function listUnits(surveyId: number): GloriaUnit[] {
  return rows<GloriaUnit>(getUserDb().executeSync(`SELECT * FROM gloria_units WHERE survey_id = ? ORDER BY id`, [surveyId]));
}

export function getUnit(surveyId: number, code: string): GloriaUnit | null {
  return (
    rows<GloriaUnit>(
      getUserDb().executeSync(`SELECT * FROM gloria_units WHERE survey_id = ? AND code = ?`, [surveyId, code]),
    )[0] ?? null
  );
}

export type UnitPatch = Partial<Omit<GloriaUnit, 'id' | 'survey_id' | 'code' | 'unit_type' | 'uuid' | 'updated_at'>>;

export function updateUnit(id: number, patch: UnitPatch): void {
  patchRow('gloria_units', id, patch, true);
}

// ── Roster and unit species ───────────────────────────────────────────────

/** Roster row for a taxon, created with the next serial when missing. */
/**
 * The roster entry for a taxon and morphospecies label (null = unlabelled),
 * created when missing. The same genus can be on the roster as sp1 and sp2
 * (v63); an empty label is the same as none.
 */
export function ensureRosterTaxon(surveyId: number, taxonId: string, label: string | null = null): number {
  ensureTaxonSelfSufficient(taxonId);
  const db = getUserDb();
  const tag = label?.trim() || null;
  const found = rows<{ id: number }>(
    db.executeSync(
      `SELECT id FROM gloria_taxa WHERE survey_id = ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ?`,
      [surveyId, taxonId, tag ?? ''],
    ),
  )[0];
  if (found) return found.id;
  const serials = rows<{ serial: number }>(db.executeSync(`SELECT serial FROM gloria_taxa WHERE survey_id = ?`, [surveyId]));
  const res = db.executeSync(
    `INSERT INTO gloria_taxa (survey_id, taxon_id, serial, verbatim_identification, created_at) VALUES (?, ?, ?, ?, ?)`,
    [surveyId, taxonId, nextSerial(serials), tag, Date.now()],
  );
  return Number(res.insertId);
}

/** The roster entries of one taxon in a survey, oldest first: its morphospecies. */
export function rosterEntriesOf(surveyId: number, taxonId: string): Array<{ id: number; label: string | null }> {
  return rows<{ id: number; label: string | null }>(
    getUserDb().executeSync(
      `SELECT id, verbatim_identification AS label FROM gloria_taxa WHERE survey_id = ? AND taxon_id = ? ORDER BY serial`,
      [surveyId, taxonId],
    ),
  );
}

/**
 * Relabel a roster entry — every unit listing it follows, since the label
 * belongs to the survey. 'taken' when the same taxon already has that label.
 */
export function setRosterLabel(gid: number, label: string | null): 'ok' | 'taken' {
  return withTransaction(() => {
    const db = getUserDb();
    const t = rows<{ survey_id: number; taxon_id: string }>(
      db.executeSync(`SELECT survey_id, taxon_id FROM gloria_taxa WHERE id = ?`, [gid]),
    )[0];
    if (!t) throw new Error(`gloria taxon ${gid} not found`);
    const tag = label?.trim() || null;
    const clash = rows(
      db.executeSync(
        `SELECT 1 FROM gloria_taxa WHERE survey_id = ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ? AND id != ?`,
        [t.survey_id, t.taxon_id, tag ?? '', gid],
      ),
    ).length;
    if (clash) return 'taken';
    db.executeSync(`UPDATE gloria_taxa SET verbatim_identification = ? WHERE id = ?`, [tag, gid]);
    touchSurvey(t.survey_id);
    return 'ok';
  });
}

/**
 * The position for a species added to a unit now: after every species already
 * there, in the order the user sees them. Without it the list fell back to
 * roster serial, so a species first met in another unit (lower serial) was
 * slotted in above ones added before it. Rows without a position yet (from
 * before v55) get theirs first, in their current order.
 */
export function nextUnitPosition(unitId: number): number {
  const db = getUserDb();
  const have = rows<{ id: number; sort_order: number | null; serial: number }>(
    db.executeSync(
      `SELECT us.id, us.sort_order, t.serial FROM gloria_unit_species us
         JOIN gloria_taxa t ON t.id = us.gloria_taxon_id WHERE us.unit_id = ?`,
      [unitId],
    ),
  ).sort(bySpeciesOrder);
  if (have.some((r) => r.sort_order == null)) {
    have.forEach((r, i) => db.executeSync(`UPDATE gloria_unit_species SET sort_order = ? WHERE id = ?`, [i, r.id]));
    return have.length;
  }
  return have.reduce((m, r) => Math.max(m, (r.sort_order as number) + 1), 0);
}

/**
 * Add a taxon — with its morphospecies label, if any — to a unit (and to the
 * survey roster). An existing row is returned as is.
 */
export function addUnitSpecies(unitId: number, taxonId: string, label: string | null = null): number {
  return withTransaction(() => {
    const db = getUserDb();
    const unit = rows<{ survey_id: number }>(db.executeSync(`SELECT survey_id FROM gloria_units WHERE id = ?`, [unitId]))[0];
    if (!unit) throw new Error(`gloria unit ${unitId} not found`);
    return addRosterSpecies(unitId, ensureRosterTaxon(unit.survey_id, taxonId, label));
  });
}

/** Add a roster entry (taxon + label, as another unit lists it) to a unit. */
export function addRosterSpecies(unitId: number, gid: number): number {
  return withTransaction(() => {
    const db = getUserDb();
    const unit = rows<{ survey_id: number }>(db.executeSync(`SELECT survey_id FROM gloria_units WHERE id = ?`, [unitId]))[0];
    if (!unit) throw new Error(`gloria unit ${unitId} not found`);
    const now = Date.now();
    const existing = rows<{ id: number }>(
      db.executeSync(`SELECT id FROM gloria_unit_species WHERE unit_id = ? AND gloria_taxon_id = ?`, [unitId, gid]),
    )[0];
    if (existing) return existing.id;
    // A species added after a method started is recorded as "not found in any
    // cell / at any point so far", not as "method not done".
    const u = rows<{ freq_start_ts: number | null; point_surface: string | null }>(
      db.executeSync(`SELECT freq_start_ts, point_surface FROM gloria_units WHERE id = ?`, [unitId]),
    )[0];
    const res = db.executeSync(
      `INSERT INTO gloria_unit_species (unit_id, gloria_taxon_id, occurrence_id, freq_cells, point_hits, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        unitId,
        gid,
        generateUuid(),
        u?.freq_start_ts != null ? '0'.repeat(100) : null,
        u?.point_surface != null ? '0'.repeat(u.point_surface.length) : null,
        nextUnitPosition(unitId),
        now,
        now,
      ],
    );
    touchSurvey(unit.survey_id);
    return Number(res.insertId);
  });
}

export function listUnitSpecies(unitId: number): GloriaUnitSpeciesWithTaxon[] {
  const recs = rows<GloriaUnitSpecies & GloriaTaxonJoin>(
    getUserDb().executeSync(
      `SELECT us.*, t.taxon_id, t.serial, t.used_name_id, t.used_scientific_name, t.verbatim_identification
         FROM gloria_unit_species us JOIN gloria_taxa t ON t.id = us.gloria_taxon_id
        WHERE us.unit_id = ? ORDER BY t.serial`,
      [unitId],
    ),
  );
  return withTaxa(recs);
}

/** Every unit-species row of a survey (overview, species matrix, export). */
export function listSurveySpecies(surveyId: number): Array<GloriaUnitSpeciesWithTaxon & { unit_code: string }> {
  const recs = rows<GloriaUnitSpecies & GloriaTaxonJoin & { unit_code: string }>(
    getUserDb().executeSync(
      `SELECT us.*, u.code AS unit_code, t.taxon_id, t.serial, t.used_name_id, t.used_scientific_name, t.verbatim_identification
         FROM gloria_unit_species us
         JOIN gloria_units u ON u.id = us.unit_id
         JOIN gloria_taxa t ON t.id = us.gloria_taxon_id
        WHERE u.survey_id = ? ORDER BY u.id, t.serial`,
      [surveyId],
    ),
  );
  return withTaxa(recs);
}

type GloriaTaxonJoin = {
  taxon_id: string;
  serial: number;
  used_name_id: number | null;
  used_scientific_name: string | null;
  verbatim_identification: string | null;
};

function withTaxa<T extends GloriaUnitSpecies & GloriaTaxonJoin>(recs: T[]): Array<T & TaxonFields> {
  if (recs.length === 0) return [];
  const taxa = resolveTaxa(recs.map((r) => r.taxon_id));
  const adopted = resolveAdoptedNames(recs);
  return recs.map((r) => ({ ...r, ...applyAdoptedName(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS, r, adopted) }));
}

export type UnitSpeciesPatch = Partial<
  Pick<GloriaUnitSpecies, 'cover_pct' | 'abundance' | 'layer' | 'cf' | 'freq_cells' | 'freq_count' | 'point_hits' | 'comments' | 'reproductive_condition' | 'leaf_phenology'>
>;

export function updateUnitSpecies(id: number, patch: UnitSpeciesPatch): void {
  patchRow('gloria_unit_species', id, patch, true);
}

/** One unit-species row with names, for the species detail screen. */
export function getUnitSpecies(id: number): (GloriaUnitSpeciesWithTaxon & { unit_code: string }) | null {
  const recs = rows<GloriaUnitSpecies & GloriaTaxonJoin & { unit_code: string }>(
    getUserDb().executeSync(
      `SELECT us.*, u.code AS unit_code, t.taxon_id, t.serial, t.used_name_id, t.used_scientific_name, t.verbatim_identification
         FROM gloria_unit_species us
         JOIN gloria_units u ON u.id = us.unit_id
         JOIN gloria_taxa t ON t.id = us.gloria_taxon_id
        WHERE us.id = ?`,
      [id],
    ),
  );
  return withTaxa(recs)[0] ?? null;
}

/**
 * Frequency counting has begun on a quadrat: stamp the start, and turn every
 * blank mask (species and the three grazing rows) into "done, nothing yet".
 */
/**
 * Where a quadrat's frequency starts when nothing says otherwise: the minute
 * after the cover estimate ended, or — cover started but not ended — that
 * day at the current clock time; otherwise now (model/quadratTimes).
 */
function frequencyStartDefault(unitId: number, now: number): number {
  const u = rows<{ start_ts: number | null; stop_ts: number | null }>(
    getUserDb().executeSync(`SELECT start_ts, stop_ts FROM gloria_units WHERE id = ?`, [unitId]),
  )[0];
  if (u?.stop_ts != null) return nextMinute(u.stop_ts);
  if (u?.start_ts != null) return onDay(now, u.start_ts);
  return now;
}

export function startFrequency(unitId: number): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    const zero = '0'.repeat(100);
    db.executeSync(
      `UPDATE gloria_units SET freq_mode = 'cells', freq_start_ts = COALESCE(freq_start_ts, ?), dist_hi1 = COALESCE(dist_hi1, ?),
         dist_hi2 = COALESCE(dist_hi2, ?), dist_hi3 = COALESCE(dist_hi3, ?), updated_at = ? WHERE id = ?`,
      [frequencyStartDefault(unitId, now), zero, zero, zero, now, unitId],
    );
    db.executeSync(`UPDATE gloria_unit_species SET freq_cells = ? WHERE unit_id = ? AND freq_cells IS NULL`, [zero, unitId]);
  });
}

/**
 * Switch how a quadrat's frequency is taken. The other method's data is
 * cleared — a quadrat has cells OR counts, never both. Clearing data that is
 * actually there needs `discard` (the user confirmed); without it the switch
 * is refused and `false` returned. This is the safety net for a late write —
 * a count field committing on blur after the screen already went back to the
 * brush once wiped every painted cell of a quadrat.
 */
export function setFrequencyMode(unitId: number, mode: 'cells' | 'count', opts: { discard?: boolean } = {}): boolean {
  return withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    if (!opts.discard) {
      const other =
        mode === 'count'
          ? `SELECT 1 FROM gloria_units WHERE id = ?1 AND (instr(dist_hi1, '1') > 0 OR instr(dist_hi2, '1') > 0 OR instr(dist_hi3, '1') > 0)
             UNION ALL SELECT 1 FROM gloria_unit_species WHERE unit_id = ?1 AND instr(freq_cells, '1') > 0`
          : `SELECT 1 FROM gloria_units WHERE id = ?1 AND (dist_hi1_n IS NOT NULL OR dist_hi2_n IS NOT NULL OR dist_hi3_n IS NOT NULL)
             UNION ALL SELECT 1 FROM gloria_unit_species WHERE unit_id = ?1 AND freq_count IS NOT NULL`;
      if (rows(db.executeSync(`${other} LIMIT 1`, [unitId])).length > 0) return false;
    }
    if (mode === 'count') {
      db.executeSync(
        `UPDATE gloria_units SET freq_mode = 'count', dist_hi1 = NULL, dist_hi2 = NULL, dist_hi3 = NULL,
           freq_start_ts = COALESCE(freq_start_ts, ?), updated_at = ? WHERE id = ?`,
        [frequencyStartDefault(unitId, now), now, unitId],
      );
      db.executeSync(`UPDATE gloria_unit_species SET freq_cells = NULL WHERE unit_id = ?`, [unitId]);
    } else {
      db.executeSync(
        `UPDATE gloria_units SET freq_mode = NULL, dist_hi1_n = NULL, dist_hi2_n = NULL, dist_hi3_n = NULL, updated_at = ? WHERE id = ?`,
        [now, unitId],
      );
      db.executeSync(`UPDATE gloria_unit_species SET freq_count = NULL WHERE unit_id = ?`, [unitId]);
    }
    return true;
  });
}

/** Point recording has begun (1×1 m point-framing: 100, 10×10 m square: 400). */
export function startPoints(unitId: number, size: number): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    // A quadrat's point-framing has its own start; a square's walk is the unit's.
    const type = rows<{ unit_type: string }>(db.executeSync(`SELECT unit_type FROM gloria_units WHERE id = ?`, [unitId]))[0]?.unit_type;
    const startCol = type === 'quadrat' ? 'pf_start_ts' : 'start_ts';
    db.executeSync(
      `UPDATE gloria_units SET point_surface = COALESCE(point_surface, ?), ${startCol} = COALESCE(${startCol}, ?), updated_at = ? WHERE id = ?`,
      ['.'.repeat(size), now, now, unitId],
    );
    db.executeSync(`UPDATE gloria_unit_species SET point_hits = ? WHERE unit_id = ? AND point_hits IS NULL`, ['0'.repeat(size), unitId]);
  });
}

/**
 * Lock / unlock with the end time the user chose (src/lib/endTimeChoice): a
 * time, or null to leave it blank. Unlocking keeps the end time as it is.
 */
export function setUnitDone(unitId: number, locked: boolean, endTs: number | null = null): void {
  updateUnit(unitId, locked ? { done_locked: 1, stop_ts: endTs } : { done_locked: 0 });
}

/**
 * Mark point recording done or reopen it. On a 1×1 m quadrat that is the
 * point-framing (pf_*); on a 10×10 m square the walk is the whole unit, so it
 * is the unit's own done.
 */
export function setPointsLocked(unitId: number, locked: boolean, endTs: number | null = null): void {
  const type = rows<{ unit_type: string }>(getUserDb().executeSync(`SELECT unit_type FROM gloria_units WHERE id = ?`, [unitId]))[0]?.unit_type;
  if (type !== 'quadrat') return setUnitDone(unitId, locked, endTs);
  updateUnit(unitId, locked ? { pf_locked: 1, pf_stop_ts: endTs } : { pf_locked: 0 });
}

/**
 * A unit and its species rows as they are now — the undo step of the unit
 * screen. Restoring puts every column back, re-creates removed species rows
 * with their ids and drops rows added since.
 */
export type UnitSnapshot = { unit: Record<string, unknown>; species: Array<Record<string, unknown>> };

export function snapshotUnit(unitId: number): UnitSnapshot {
  const db = getUserDb();
  return {
    unit: rows<Record<string, unknown>>(db.executeSync(`SELECT * FROM gloria_units WHERE id = ?`, [unitId]))[0] ?? {},
    species: rows<Record<string, unknown>>(db.executeSync(`SELECT * FROM gloria_unit_species WHERE unit_id = ?`, [unitId])),
  };
}

export function restoreUnitSnapshot(snap: UnitSnapshot): void {
  const unitId = snap.unit.id as number;
  withTransaction(() => {
    const db = getUserDb();
    const ucols = Object.keys(snap.unit).filter((c) => c !== 'id');
    db.executeSync(
      `UPDATE gloria_units SET ${ucols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...ucols.map((c) => snap.unit[c] as Scalar), unitId],
    );
    const keep = snap.species.map((s) => s.id as number);
    db.executeSync(
      `DELETE FROM gloria_unit_species WHERE unit_id = ?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
      [unitId, ...keep],
    );
    for (const s of snap.species) {
      const cols = Object.keys(s);
      db.executeSync(
        `INSERT OR REPLACE INTO gloria_unit_species (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => s[c] as Scalar),
      );
    }
  });
}

/**
 * Mark a quadrat's frequency done with the end time the user chose, or reopen
 * it. The chosen time counts as set by hand: later edits no longer move it.
 */
export function setFrequencyLocked(unitId: number, locked: boolean, endTs: number | null = null): void {
  updateUnit(unitId, locked ? { freq_locked: 1, freq_stop_ts: endTs, freq_stop_manual: 1 } : { freq_locked: 0 });
}

/**
 * A frequency edit happened now: move the end time, unless the user fixed it
 * by hand — or the frequency is dated another day (an old sheet being typed
 * in, whose end is not today either).
 */
export function touchFrequency(unitId: number): void {
  const now = Date.now();
  const start = rows<{ freq_start_ts: number | null }>(
    getUserDb().executeSync(`SELECT freq_start_ts FROM gloria_units WHERE id = ?`, [unitId]),
  )[0]?.freq_start_ts;
  if (start != null && onDay(start, now) !== start) return;
  getUserDb().executeSync(`UPDATE gloria_units SET freq_stop_ts = ? WHERE id = ? AND freq_stop_manual = 0`, [now, unitId]);
}

/**
 * First input on a unit: stamp its start. A date-only start (filled from the
 * survey date) takes the real time when recording happens that very day;
 * on any other day it is a date typed from an old sheet and stays.
 */
export function markUnitStarted(unitId: number): void {
  const db = getUserDb();
  const now = Date.now();
  const u = rows<{ start_ts: number | null; date_only: number | null }>(
    db.executeSync(`SELECT start_ts, date_only FROM gloria_units WHERE id = ?`, [unitId]),
  )[0];
  if (!u) return;
  if (u.start_ts == null || (u.date_only === 1 && takesRealStart(u.start_ts, now))) {
    db.executeSync(`UPDATE gloria_units SET start_ts = ?, date_only = NULL WHERE id = ?`, [now, unitId]);
  }
}

/** Survey start / end moved to other days (base data), clock times kept by the caller. */
export function setSurveyDates(surveyId: number, dates: { start_ts: number; stop_ts: number | null }): void {
  patchRow('gloria_surveys', surveyId, dates, true);
}

/**
 * Give every unit of the survey that has no start the given date, as a date
 * without a time (model/surveyDates planUnitDates). Units with a start are
 * left alone. Returns how many were filled.
 */
export function fillUnitDates(surveyId: number, codes: string[], value: number): number {
  if (!codes.length) return 0;
  return withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    let n = 0;
    for (const code of codes) {
      const r = db.executeSync(
        `UPDATE gloria_units SET start_ts = ?, date_only = 1, updated_at = ? WHERE survey_id = ? AND code = ? AND start_ts IS NULL`,
        [value, now, surveyId, code],
      );
      n += r.rowsAffected ?? 0;
    }
    touchSurvey(surveyId);
    return n;
  });
}

/**
 * Re-identify one species row of a unit: it keeps everything recorded for it
 * (cover, abundance, cells, hits, phenology, notes, position, occurrence id)
 * and only points at another taxon. Refused when the unit already lists that
 * taxon — merging two rows would have to pick whose data survives.
 * The old taxon stays on the survey roster (an undo points back to it).
 */
export function replaceUnitSpeciesTaxon(usid: number, taxonId: string): 'ok' | 'exists' | 'same' {
  return withTransaction(() => {
    const db = getUserDb();
    const row = rows<{ unit_id: number; gloria_taxon_id: number; survey_id: number }>(
      db.executeSync(
        `SELECT us.unit_id, us.gloria_taxon_id, u.survey_id FROM gloria_unit_species us
           JOIN gloria_units u ON u.id = us.unit_id WHERE us.id = ?`,
        [usid],
      ),
    )[0];
    if (!row) throw new Error(`gloria unit species ${usid} not found`);
    const gid = ensureRosterTaxon(row.survey_id, taxonId);
    if (gid === row.gloria_taxon_id) return 'same';
    const clash = rows(
      db.executeSync(`SELECT 1 FROM gloria_unit_species WHERE unit_id = ? AND gloria_taxon_id = ? AND id != ?`, [
        row.unit_id,
        gid,
        usid,
      ]),
    ).length;
    if (clash) return 'exists';
    db.executeSync(`UPDATE gloria_unit_species SET gloria_taxon_id = ?, updated_at = ? WHERE id = ?`, [gid, Date.now(), usid]);
    touchSurvey(row.survey_id);
    return 'ok';
  });
}

/**
 * A re-identification asked for from the species page, picked up by the unit
 * screen when it regains focus (its docked search box does the picking).
 */
let pendingReplace: number | null = null;
export function requestSpeciesReplace(usid: number): void {
  pendingReplace = usid;
}
export function takeSpeciesReplace(): number | null {
  const v = pendingReplace;
  pendingReplace = null;
  return v;
}

/** Save a unit's species order: `ids` in their new order. */
export function setUnitSpeciesOrder(ids: number[]): void {
  withTransaction(() => {
    const db = getUserDb();
    ids.forEach((id, i) => db.executeSync(`UPDATE gloria_unit_species SET sort_order = ? WHERE id = ?`, [i, id]));
  });
}

export function removeUnitSpecies(id: number): void {
  getUserDb().executeSync(`DELETE FROM gloria_unit_species WHERE id = ?`, [id]);
}

/** Write one committed point: species bits and the surface char, in one transaction. */
export function commitPoint(
  unitId: number,
  size: number,
  idx: number,
  hits: Array<{ unitSpeciesId: number; on: boolean }>,
  surfaceChar: string,
): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    for (const h of hits) {
      const cur = rows<{ point_hits: string | null }>(
        db.executeSync(`SELECT point_hits FROM gloria_unit_species WHERE id = ?`, [h.unitSpeciesId]),
      )[0];
      const mask = (cur?.point_hits ?? '0'.repeat(size)).split('');
      if ((mask[idx] === '1') === h.on) continue;
      mask[idx] = h.on ? '1' : '0';
      db.executeSync(
        `UPDATE gloria_unit_species SET point_hits = ?, updated_at = ? WHERE id = ?`,
        [mask.join(''), now, h.unitSpeciesId],
      );
    }
    const u = rows<{ point_surface: string | null }>(db.executeSync(`SELECT point_surface FROM gloria_units WHERE id = ?`, [unitId]))[0];
    const surface = (u?.point_surface ?? '.'.repeat(size)).split('');
    surface[idx] = surfaceChar;
    db.executeSync(`UPDATE gloria_units SET point_surface = ?, updated_at = ? WHERE id = ?`, [surface.join(''), now, unitId]);
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

function touchSurvey(surveyId: number): void {
  getUserDb().executeSync(`UPDATE gloria_surveys SET updated_at = ? WHERE id = ?`, [Date.now(), surveyId]);
}

const SAFE_COL = /^[a-z0-9_]+$/;

/** UPDATE only the provided keys. Keys come from typed patches, checked against a plain identifier pattern. */
function patchRow(table: string, id: number, patch: Record<string, unknown>, stamp: boolean): void {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  for (const k of keys) if (!SAFE_COL.test(k)) throw new Error(`bad column ${k}`);
  const sets = keys.map((k) => `${k} = ?`);
  const vals = keys.map((k) => patch[k] as Scalar);
  if (stamp) {
    sets.push('updated_at = ?');
    vals.push(Date.now());
  }
  getUserDb().executeSync(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
}

// ── Export / round-trip ───────────────────────────────────────────────────


/** Everything the sheet export needs, with display names resolved. */
export function loadExportData(surveyId: number): GloriaExportData | null {
  const survey = getGloriaSurvey(surveyId);
  if (!survey) return null;
  const summit = getSummit(survey.summit_id);
  if (!summit) return null;
  const species = listSurveySpecies(surveyId);
  return {
    summit,
    survey,
    points: listPoints(surveyId),
    units: listUnits(surveyId),
    visits: visitsOfSurvey(surveyId).map((v) => ({ ...v, loggers: listLoggers(v.id) })),
    species: species.map((s) => ({
      unit_code: s.unit_code,
      occurrence_id: s.occurrence_id,
      serial: s.serial,
      sort_order: s.sort_order,
      cover_pct: s.cover_pct,
      abundance: s.abundance,
      freq_cells: s.freq_cells,
      freq_count: s.freq_count,
      point_hits: s.point_hits,
      legacy_hits: s.legacy_hits,
      comments: s.comments,
      morpho_label: s.verbatim_identification,
      scientific_name: [s.simple_name || s.used_scientific_name || s.taxon_id, s.name_author].filter(Boolean).join(' '),
      vernacular_name: s.common_name_c ?? '',
      taxon_rank: (s.rank ?? '').toLowerCase(),
      family: s.family ?? '',
    })),
  };
}

export function loadGloriaDoc(surveyId: number): GloriaDoc | null {
  const survey = getGloriaSurvey(surveyId);
  if (!survey) return null;
  const summit = getSummit(survey.summit_id);
  if (!summit) return null;
  const db = getUserDb();
  const project = rows<{ name: string }>(db.executeSync(`SELECT name FROM projects WHERE id = ?`, [survey.project_id]))[0];
  const taxa = rows<GloriaTaxon>(db.executeSync(`SELECT * FROM gloria_taxa WHERE survey_id = ? ORDER BY serial`, [surveyId]));
  const names = resolveTaxa(taxa.map((t) => t.taxon_id));
  const species = rows<GloriaUnitSpecies>(
    db.executeSync(
      `SELECT us.* FROM gloria_unit_species us JOIN gloria_units u ON u.id = us.unit_id WHERE u.survey_id = ? ORDER BY us.id`,
      [surveyId],
    ),
  );
  return buildGloriaDoc({
    summit,
    survey,
    projectName: project?.name ?? null,
    points: listPoints(surveyId),
    units: listUnits(surveyId),
    taxa,
    species,
    photoChecks: listPhotoChecks(surveyId),
    loggerVisits: visitsOfSurvey(surveyId).map((v) => ({ ...v, loggers: listLoggers(v.id) })),
    displayName: (id) => names.get(id)?.simple_name || undefined,
  });
}

export function gloriaSurveyUuidExists(uuid: string): boolean {
  return rows(getUserDb().executeSync(`SELECT 1 FROM gloria_surveys WHERE uuid = ?`, [uuid])).length > 0;
}

export type GloriaImportResult = { surveyId: number; replaced: boolean };

/**
 * Restore a survey from its yml. Keyed on the survey uuid: an existing survey
 * with that uuid is replaced wholesale. The import always lands as 'done' so
 * it never takes the single-active slot.
 */
export function importGloriaDoc(doc: GloriaDoc, projectId = 0): GloriaImportResult {
  return withTransaction(() => {
    const db = getUserDb();
    const summitId = upsertSummit(doc.summit);
    const existing = rows<{ id: number }>(db.executeSync(`SELECT id FROM gloria_surveys WHERE uuid = ?`, [doc.survey.uuid]))[0];
    if (existing) deleteGloriaSurvey(existing.id);
    // Another survey may already hold this summit + mocy under a different uuid.
    const clash = rows<{ id: number }>(
      db.executeSync(`SELECT id FROM gloria_surveys WHERE summit_id = ? AND mocy = ?`, [summitId, doc.survey.mocy]),
    )[0];
    if (clash) throw new Error(`${doc.summit.full_code} mocy ${doc.survey.mocy} already exists`);
    const prev = rows<{ id: number }>(
      db.executeSync(
        `SELECT id FROM gloria_surveys WHERE summit_id = ? AND mocy < ? ORDER BY mocy DESC LIMIT 1`,
        [summitId, doc.survey.mocy],
      ),
    )[0];
    const sv = doc.survey;
    const res = db.executeSync(
      `INSERT INTO gloria_surveys (uuid, summit_id, mocy, year, status, start_ts, stop_ts, recorded_by, prev_survey_id,
         project_id, grid_ok_n, grid_ok_e, grid_ok_s, grid_ok_w, notes, overview_photos, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sv.uuid, summitId, sv.mocy, sv.year, sv.start_ts, sv.stop_ts ?? sv.start_ts, sv.recorded_by, prev?.id ?? null,
        projectId, sv.grid_ok?.N ?? 0, sv.grid_ok?.E ?? 0, sv.grid_ok?.S ?? 0, sv.grid_ok?.W ?? 0, sv.notes, sv.overview_photos ?? null,
        sv.created_at ?? sv.start_ts, sv.updated_at ?? sv.start_ts],
    );
    const surveyId = Number(res.insertId);
    // A later survey of this summit that pointed at nothing (or an older one) now follows this one.
    db.executeSync(
      `UPDATE gloria_surveys SET prev_survey_id = ? WHERE summit_id = ? AND mocy = (
         SELECT MIN(mocy) FROM gloria_surveys WHERE summit_id = ? AND mocy > ?)`,
      [surveyId, summitId, summitId, sv.mocy],
    );

    for (const p of doc.points) {
      db.executeSync(
        `INSERT INTO gloria_points (survey_id, point_key, is_p5m, distance_m, compass_deg, photo_m2, photo_m2f,
           photo_point, comments, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [surveyId, p.point_key, p.is_p5m, p.distance_m, p.compass_deg, p.photo_m2, p.photo_m2f, p.photo_point, p.comments, p.uuid],
      );
    }
    const unitId = new Map<string, number>();
    for (const u of doc.units) {
      const cols = UNIT_FIELDS.filter((k) => k in u);
      const r = db.executeSync(
        `INSERT INTO gloria_units (survey_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
        [surveyId, ...cols.map((k) => (u[k] ?? null) as Scalar)],
      );
      unitId.set(u.code, Number(r.insertId));
      // Files from before v54 say "done" only through stop_ts.
      if (!('done_locked' in u) && u.stop_ts != null) {
        db.executeSync(`UPDATE gloria_units SET done_locked = 1 WHERE id = ?`, [Number(r.insertId)]);
      }
    }
    const taxonRow = new Map<number, number>();
    for (const t of doc.taxa) {
      ensureTaxonSelfSufficient(t.taxon_id);
      const r = db.executeSync(
        `INSERT INTO gloria_taxa (survey_id, taxon_id, serial, used_name_id, used_scientific_name, verbatim_identification, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [surveyId, t.taxon_id, t.serial, t.used_name_id, t.used_scientific_name, t.verbatim_identification, t.created_at ?? sv.start_ts],
      );
      taxonRow.set(t.serial, Number(r.insertId));
    }
    for (const s of doc.species) {
      const uid = unitId.get(s.unit);
      const gid = taxonRow.get(s.serial);
      if (uid == null || gid == null) throw new Error(`species ${s.occurrence_id} refers to a missing unit or taxon`);
      // The same column list the export writes (SPECIES_FIELDS), so a column
      // added there is restored here too; missing keys (older yml) become NULL.
      const cols = SPECIES_FIELDS as readonly string[];
      const rec = s as unknown as Record<string, unknown>;
      const val = (k: string): Scalar =>
        (k === 'created_at' || k === 'updated_at' ? (rec[k] ?? sv.start_ts) : (rec[k] ?? null)) as Scalar;
      db.executeSync(
        `INSERT INTO gloria_unit_species (unit_id, gloria_taxon_id, ${cols.join(', ')})
         VALUES (?, ?, ${cols.map(() => '?').join(', ')})`,
        [uid, gid, ...cols.map(val)],
      );
    }
    for (const c of doc.photo_checks ?? []) {
      db.executeSync(
        `INSERT INTO gloria_photo_checks (survey_id, item, checked, photo_uri, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [surveyId, c.item, c.checked ? 1 : 0, c.photo_uri ?? null, c.updated_at ?? sv.start_ts],
      );
    }
    // Logger visits belong to the summit: upserted by uuid, never removed by
    // replacing a survey (a visit may have been entered outside it).
    importLoggerVisits(summitIdOf(surveyId), doc.logger_visits ?? []);
    return { surveyId, replaced: !!existing };
  });
}

function summitIdOf(surveyId: number): number {
  const r = rows<{ summit_id: number }>(getUserDb().executeSync(`SELECT summit_id FROM gloria_surveys WHERE id = ?`, [surveyId]))[0];
  if (!r) throw new Error(`gloria survey ${surveyId} not found`);
  return r.summit_id;
}
