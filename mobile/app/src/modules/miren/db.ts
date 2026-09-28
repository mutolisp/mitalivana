/**
 * MIREN persistence (tables from migration v68; design in
 * docs/planned/MIREN.md).
 *
 * Reference data — regions, routes, sites and each region's native / alien
 * table — is shared across years. A survey is one route in one year and is
 * created with every plot (current site × plot number, visit 1). Only where
 * the plots were laid out is carried from the previous survey (model/survey);
 * species lists start empty, because resurveys are recorded blind.
 *
 * Blind recording and recheck (Road protocol §2.5.3, §2.5.3.2):
 *   - species added before `blind_closed_at` are phase 'blind', after it
 *     'recheck' — decided here, not by the caller;
 *   - once closed, blind rows can no longer be edited or removed;
 *   - a plot is finished (`compared_at`) only when every previous-survey
 *     taxon missing from it has a recheck answer (model/compare).
 *
 * Every write is immediate, as in the GLORIA module.
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
import { isoDate } from '~/lib/datetime';
import { validRegionCode, validRouteCode, type RouteKind } from './model/codes';
import { planSurveyPlots, type PrevPlot } from './model/survey';
import { statusFromTaicol, type MirenStatus } from './model/status';
import { recheckCandidates, recheckComplete, taxonKey, type RecheckOutcome, type TaxonKey } from './model/compare';
import type { Stop } from './model/planner';

// ── Row types ─────────────────────────────────────────────────────────────

export type MirenRegion = {
  id: number;
  uuid: string;
  code_road: string | null;
  code_trail: string | null;
  name: string | null;
  country: string | null;
  default_literature: string | null;
  regional_description: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type MirenRoute = {
  id: number;
  uuid: string;
  region_id: number;
  kind: RouteKind;
  code: string;
  name: string | null;
  traffic_intensity: number | null;
  road_open_months: number | null;
  road_type: string | null;
  length_m: number | null;
  category: 'formal' | 'informal' | null;
  substrate: string | null;
  /** JSON array of activity strings. */
  activities: string | null;
  history: string | null;
  width_m: number | null;
  track_geojson: string | null;
  focal_points_geojson: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type MirenSite = {
  id: number;
  uuid: string;
  route_id: number;
  site_no: number;
  suffix: '' | 'a';
  planned_lat: number | null;
  planned_lon: number | null;
  planned_elev: number | null;
  side: 'left' | 'right' | null;
  marker_note: string | null;
  photo_point: string | null;
  road_clearance_m: number | null;
  clearance_checked_at: number | null;
  mountain_zone: 'lowland' | 'montane' | 'alpine' | 'nival' | null;
  verge_width_m: number | null;
  herbivores: string | null;
  dist_trailhead_along_m: number | null;
  dist_trailhead_direct_m: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type MirenSurvey = {
  id: number;
  uuid: string;
  route_id: number;
  year: number;
  status: 'active' | 'done';
  start_ts: number;
  stop_ts: number | null;
  recorded_by: string | null;
  prev_survey_id: number | null;
  project_id: number;
  site_id: number | null;
  literature: string | null;
  notes: string | null;
  starred: number;
  created_at: number;
  updated_at: number;
};

export type MirenPlot = {
  id: number;
  uuid: string;
  survey_id: number;
  site_id: number;
  plot_no: number;
  visit: number;
  sampled: number;
  not_sampled_reason: string | null;
  lat: number | null;
  lon: number | null;
  elev: number | null;
  /** ISO 8601 `YYYY-MM-DD`. */
  date: string | null;
  observers: string | null;
  start_ts: number | null;
  stop_ts: number | null;
  tree_cover_pct: number | null;
  bare_ground_pct: number | null;
  litter_pct: number | null;
  additional_data: string | null;
  protected_area: number | null;
  literature: string | null;
  habitat: string | null;
  disturbance_type: string | null;
  disturbance_intensity: number | null;
  cls_bare_ground: number | null;
  cls_bare_rock: number | null;
  cls_vegetation: number | null;
  cls_canopy: number | null;
  cls_shrub: number | null;
  cls_herb: number | null;
  riparian: number | null;
  fenced: number | null;
  herbivore_rating: number | null;
  herbivore_type: string | null;
  trampling_rating: number | null;
  trampling_type: string | null;
  comments: string | null;
  blind_closed_at: number | null;
  compared_at: number | null;
  photo_paths: string | null;
  created_at: number;
  updated_at: number;
};

export type MirenPlotWithSite = MirenPlot & { site_no: number; suffix: '' | 'a'; species_count: number };

export type MirenPlotSpecies = {
  id: number;
  plot_id: number;
  miren_taxon_id: number;
  occurrence_id: string;
  cover_class: number | null;
  abundance_class: number | null;
  presence: number | null;
  phase: 'blind' | 'recheck';
  note: string | null;
  created_at: number;
  updated_at: number;
};

type TaxonJoin = {
  taxon_id: string;
  used_name_id: number | null;
  used_scientific_name: string | null;
  verbatim_identification: string | null;
};

export type MirenPlotSpeciesWithTaxon = MirenPlotSpecies & TaxonJoin & TaxonFields;

const rows = <T>(res: { rows?: unknown[] }): T[] => (res.rows ?? []) as T[];

// ── Regions ───────────────────────────────────────────────────────────────

export type RegionInput = {
  code_road: string | null;
  code_trail: string | null;
  name?: string | null;
  country?: string | null;
};

export type CodeResult = { ok: true; id: number } | { ok: false; error: 'invalid' | 'taken' };

function normCode(c: string | null | undefined): string | null {
  const v = c?.trim().toUpperCase();
  return v ? v : null;
}

export function createRegion(input: RegionInput): CodeResult {
  const road = normCode(input.code_road);
  const trail = normCode(input.code_trail);
  if (!road && !trail) return { ok: false, error: 'invalid' };
  if ((road && !validRegionCode('road', road)) || (trail && !validRegionCode('trail', trail))) {
    return { ok: false, error: 'invalid' };
  }
  const db = getUserDb();
  const clash = rows(
    db.executeSync(`SELECT 1 FROM miren_regions WHERE code_road = ? OR code_trail = ?`, [road ?? '', trail ?? '']),
  );
  if (clash.length) return { ok: false, error: 'taken' };
  const now = Date.now();
  const res = db.executeSync(
    `INSERT INTO miren_regions (uuid, code_road, code_trail, name, country, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateUuid(), road, trail, input.name?.trim() || null, normCode(input.country), now, now],
  );
  return { ok: true, id: Number(res.insertId) };
}

export type RegionPatch = Partial<
  Pick<MirenRegion, 'name' | 'country' | 'default_literature' | 'regional_description' | 'notes'>
>;

export function updateRegion(id: number, patch: RegionPatch): void {
  patchRow('miren_regions', id, patch, true);
}

/** Change one of the region's codes; the other kind's code is untouched. */
export function setRegionCode(id: number, kind: RouteKind, code: string | null): 'ok' | 'invalid' | 'taken' | 'in-use' {
  const v = normCode(code);
  if (v && !validRegionCode(kind, v)) return 'invalid';
  const col = kind === 'road' ? 'code_road' : 'code_trail';
  const db = getUserDb();
  const r = getRegion(id);
  if (!r) return 'invalid';
  if (!v) {
    // A code routes of that kind depend on cannot be removed; and one code must remain.
    const used = rows(db.executeSync(`SELECT 1 FROM miren_routes WHERE region_id = ? AND kind = ? LIMIT 1`, [id, kind]));
    if (used.length) return 'in-use';
    if (!(kind === 'road' ? r.code_trail : r.code_road)) return 'invalid';
  }
  if (v && rows(db.executeSync(`SELECT 1 FROM miren_regions WHERE ${col} = ? AND id != ?`, [v, id])).length) return 'taken';
  db.executeSync(`UPDATE miren_regions SET ${col} = ?, updated_at = ? WHERE id = ?`, [v, Date.now(), id]);
  return 'ok';
}

export function getRegion(id: number): MirenRegion | null {
  return rows<MirenRegion>(getUserDb().executeSync(`SELECT * FROM miren_regions WHERE id = ?`, [id]))[0] ?? null;
}

export type RegionWithCounts = MirenRegion & { routes: number; surveys: number };

export function listRegions(): RegionWithCounts[] {
  return rows<RegionWithCounts>(
    getUserDb().executeSync(
      `SELECT g.*,
              (SELECT COUNT(*) FROM miren_routes r WHERE r.region_id = g.id) AS routes,
              (SELECT COUNT(*) FROM miren_surveys v JOIN miren_routes r ON r.id = v.route_id WHERE r.region_id = g.id) AS surveys
         FROM miren_regions g ORDER BY COALESCE(g.code_road, g.code_trail)`,
    ),
  );
}

/** Only an empty region (no surveys) can be deleted; its routes and sites go with it. */
export function deleteRegion(id: number): boolean {
  return withTransaction(() => {
    const db = getUserDb();
    const used = rows(
      db.executeSync(`SELECT 1 FROM miren_surveys v JOIN miren_routes r ON r.id = v.route_id WHERE r.region_id = ? LIMIT 1`, [id]),
    );
    if (used.length) return false;
    db.executeSync(`DELETE FROM miren_sites WHERE route_id IN (SELECT id FROM miren_routes WHERE region_id = ?)`, [id]);
    db.executeSync(`DELETE FROM miren_routes WHERE region_id = ?`, [id]);
    db.executeSync(`DELETE FROM miren_region_status WHERE region_id = ?`, [id]);
    db.executeSync(`DELETE FROM miren_regions WHERE id = ?`, [id]);
    return true;
  });
}

export function regionCodeFor(region: Pick<MirenRegion, 'code_road' | 'code_trail'>, kind: RouteKind): string | null {
  return kind === 'road' ? region.code_road : region.code_trail;
}

// ── Region native / alien status (S2 table B) ─────────────────────────────

export type RegionStatusRow = {
  id: number;
  region_id: number;
  taxon_id: string;
  verbatim_identification: string | null;
  status: MirenStatus;
  status_source: string | null;
  comments: string | null;
  updated_at: number;
};

export function getRegionStatus(regionId: number, t: TaxonKey): RegionStatusRow | null {
  return (
    rows<RegionStatusRow>(
      getUserDb().executeSync(
        `SELECT * FROM miren_region_status WHERE region_id = ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ?`,
        [regionId, t.taxonId, t.verbatim?.trim() ?? ''],
      ),
    )[0] ?? null
  );
}

/**
 * The region's status row for a taxon, created when missing. The default:
 * for a Taiwan region, TaiCOL's `alien_type`; otherwise unknown
 * (model/status). An existing row — perhaps set by hand — is never touched.
 */
export function ensureRegionStatus(regionId: number, t: TaxonKey): RegionStatusRow {
  const have = getRegionStatus(regionId, t);
  if (have) return have;
  const region = getRegion(regionId);
  const fields = resolveTaxa([t.taxonId]).get(t.taxonId);
  const status: MirenStatus = region?.country === 'TW' && !t.verbatim?.trim() ? statusFromTaicol(fields?.alien_type) : 'unknown';
  getUserDb().executeSync(
    `INSERT INTO miren_region_status (region_id, taxon_id, verbatim_identification, status, status_source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [regionId, t.taxonId, t.verbatim?.trim() || null, status, status !== 'unknown' ? 'TaiCOL' : null, Date.now()],
  );
  return getRegionStatus(regionId, t) as RegionStatusRow;
}

export function setRegionStatus(
  regionId: number,
  t: TaxonKey,
  patch: Partial<Pick<RegionStatusRow, 'status' | 'status_source' | 'comments'>>,
): void {
  const row = ensureRegionStatus(regionId, t);
  patchRow('miren_region_status', row.id, patch, true);
}

export function listRegionStatus(regionId: number): Array<RegionStatusRow & TaxonFields> {
  const recs = rows<RegionStatusRow>(
    getUserDb().executeSync(`SELECT * FROM miren_region_status WHERE region_id = ?`, [regionId]),
  );
  const taxa = resolveTaxa(recs.map((r) => r.taxon_id));
  return recs
    .map((r) => ({ ...(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS), ...r }))
    .sort((a, b) => (a.simple_name || '').localeCompare(b.simple_name || ''));
}

// ── Routes ────────────────────────────────────────────────────────────────

export function createRoute(regionId: number, kind: RouteKind, code: string, name?: string | null): CodeResult | { ok: false; error: 'no-region-code' } {
  const v = normCode(code);
  if (!v || !validRouteCode(v)) return { ok: false, error: 'invalid' };
  const region = getRegion(regionId);
  if (!region || !regionCodeFor(region, kind)) return { ok: false, error: 'no-region-code' };
  const db = getUserDb();
  if (rows(db.executeSync(`SELECT 1 FROM miren_routes WHERE region_id = ? AND kind = ? AND code = ?`, [regionId, kind, v])).length) {
    return { ok: false, error: 'taken' };
  }
  const now = Date.now();
  const res = db.executeSync(
    `INSERT INTO miren_routes (uuid, region_id, kind, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateUuid(), regionId, kind, v, name?.trim() || null, now, now],
  );
  return { ok: true, id: Number(res.insertId) };
}

export type RoutePatch = Partial<
  Pick<
    MirenRoute,
    | 'name'
    | 'traffic_intensity'
    | 'road_open_months'
    | 'road_type'
    | 'length_m'
    | 'category'
    | 'substrate'
    | 'activities'
    | 'history'
    | 'width_m'
    | 'track_geojson'
    | 'focal_points_geojson'
    | 'notes'
  >
>;

export function updateRoute(id: number, patch: RoutePatch): void {
  patchRow('miren_routes', id, patch, true);
}

export function getRoute(id: number): MirenRoute | null {
  return rows<MirenRoute>(getUserDb().executeSync(`SELECT * FROM miren_routes WHERE id = ?`, [id]))[0] ?? null;
}

export type RouteWithCounts = MirenRoute & { sites: number; last_year: number | null };

export function listRoutes(regionId: number): RouteWithCounts[] {
  return rows<RouteWithCounts>(
    getUserDb().executeSync(
      `SELECT r.*,
              (SELECT COUNT(*) FROM miren_sites s WHERE s.route_id = r.id) AS sites,
              (SELECT MAX(year) FROM miren_surveys v WHERE v.route_id = r.id) AS last_year
         FROM miren_routes r WHERE r.region_id = ? ORDER BY r.kind, r.code`,
      [regionId],
    ),
  );
}

/** Only a route without surveys can be deleted; its sites go with it. */
export function deleteRoute(id: number): boolean {
  return withTransaction(() => {
    const db = getUserDb();
    if (rows(db.executeSync(`SELECT 1 FROM miren_surveys WHERE route_id = ? LIMIT 1`, [id])).length) return false;
    db.executeSync(`DELETE FROM miren_sites WHERE route_id = ?`, [id]);
    db.executeSync(`DELETE FROM miren_routes WHERE id = ?`, [id]);
    return true;
  });
}

// ── Sites ─────────────────────────────────────────────────────────────────

export function listSites(routeId: number): MirenSite[] {
  return rows<MirenSite>(
    getUserDb().executeSync(`SELECT * FROM miren_sites WHERE route_id = ? ORDER BY site_no, suffix`, [routeId]),
  );
}

export function getSite(id: number): MirenSite | null {
  return rows<MirenSite>(getUserDb().executeSync(`SELECT * FROM miren_sites WHERE id = ?`, [id]))[0] ?? null;
}

/**
 * Write planned positions for sites 1…n from the planner (model/planner).
 * Existing sites keep everything but their planned point; a stop the route
 * never reached (null) leaves that site as it is.
 */
export function applyPlannedSites(routeId: number, stops: ReadonlyArray<Stop | null>): number {
  return withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    let written = 0;
    stops.forEach((stop, i) => {
      if (!stop) return;
      const siteNo = i + 1;
      const have = rows<{ id: number }>(
        db.executeSync(`SELECT id FROM miren_sites WHERE route_id = ? AND site_no = ? AND suffix = ''`, [routeId, siteNo]),
      )[0];
      const elev = Math.round(stop.ele * 10) / 10;
      if (have) {
        db.executeSync(
          `UPDATE miren_sites SET planned_lat = ?, planned_lon = ?, planned_elev = ?, updated_at = ? WHERE id = ?`,
          [stop.lat, stop.lng, elev, now, have.id],
        );
      } else {
        db.executeSync(
          `INSERT INTO miren_sites (uuid, route_id, site_no, planned_lat, planned_lon, planned_elev, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [generateUuid(), routeId, siteNo, stop.lat, stop.lng, elev, now, now],
        );
      }
      written += 1;
    });
    return written;
  });
}

/** Add one site by number (''), when not planned from a track. */
export function addSite(routeId: number, siteNo: number): number | null {
  const db = getUserDb();
  if (rows(db.executeSync(`SELECT 1 FROM miren_sites WHERE route_id = ? AND site_no = ? AND suffix = ''`, [routeId, siteNo])).length) {
    return null;
  }
  const now = Date.now();
  const res = db.executeSync(
    `INSERT INTO miren_sites (uuid, route_id, site_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [generateUuid(), routeId, siteNo, now, now],
  );
  return Number(res.insertId);
}

/**
 * A replacement site nearby (Road §2.5.3, p. 5): same number, suffix `a`.
 * The original stays for its earlier surveys; later surveys use the new one.
 */
export function relocateSite(siteId: number): number | null {
  const s = getSite(siteId);
  if (!s || s.suffix === 'a') return null;
  const db = getUserDb();
  if (rows(db.executeSync(`SELECT 1 FROM miren_sites WHERE route_id = ? AND site_no = ? AND suffix = 'a'`, [s.route_id, s.site_no])).length) {
    return null;
  }
  const now = Date.now();
  const res = db.executeSync(
    `INSERT INTO miren_sites (uuid, route_id, site_no, suffix, side, created_at, updated_at) VALUES (?, ?, ?, 'a', ?, ?, ?)`,
    [generateUuid(), s.route_id, s.site_no, s.side, now, now],
  );
  return Number(res.insertId);
}

export type SitePatch = Partial<
  Pick<
    MirenSite,
    | 'planned_lat'
    | 'planned_lon'
    | 'planned_elev'
    | 'side'
    | 'marker_note'
    | 'photo_point'
    | 'road_clearance_m'
    | 'clearance_checked_at'
    | 'mountain_zone'
    | 'verge_width_m'
    | 'herbivores'
    | 'dist_trailhead_along_m'
    | 'dist_trailhead_direct_m'
    | 'notes'
  >
>;

export function updateSite(id: number, patch: SitePatch): void {
  patchRow('miren_sites', id, patch, true);
}

/** Record the measured distance to the nearest other road (measure tool). */
export function setSiteClearance(id: number, meters: number): void {
  updateSite(id, { road_clearance_m: Math.round(meters * 10) / 10, clearance_checked_at: Date.now() });
}

/** Only a site no survey has used can be deleted. */
export function deleteSite(id: number): boolean {
  const db = getUserDb();
  if (rows(db.executeSync(`SELECT 1 FROM miren_plots WHERE site_id = ? LIMIT 1`, [id])).length) return false;
  db.executeSync(`DELETE FROM miren_sites WHERE id = ?`, [id]);
  return true;
}

// ── Surveys ───────────────────────────────────────────────────────────────

export function getMirenSurvey(id: number): MirenSurvey | null {
  return rows<MirenSurvey>(getUserDb().executeSync(`SELECT * FROM miren_surveys WHERE id = ?`, [id]))[0] ?? null;
}

export function getActiveMirenSurvey(): MirenSurvey | null {
  return (
    rows<MirenSurvey>(
      getUserDb().executeSync(`SELECT * FROM miren_surveys WHERE status = 'active' ORDER BY start_ts DESC LIMIT 1`),
    )[0] ?? null
  );
}

export function listSurveysOfRoute(routeId: number): MirenSurvey[] {
  return rows<MirenSurvey>(
    getUserDb().executeSync(`SELECT * FROM miren_surveys WHERE route_id = ? ORDER BY year DESC`, [routeId]),
  );
}

/** The route, region and code prefix a survey belongs to — for headings. */
export type SurveyContext = { survey: MirenSurvey; route: MirenRoute; region: MirenRegion; regionCode: string };

export function surveyContext(surveyId: number): SurveyContext | null {
  const survey = getMirenSurvey(surveyId);
  const route = survey ? getRoute(survey.route_id) : null;
  const region = route ? getRegion(route.region_id) : null;
  const regionCode = route && region ? regionCodeFor(region, route.kind) : null;
  if (!survey || !route || !region || !regionCode) return null;
  return { survey, route, region, regionCode };
}

export type CreateMirenInput = {
  routeId: number;
  year: number;
  projectId?: number;
  /** Omit to use the default surveyors; null forces empty. */
  recorded_by?: string | null;
};

/** Create (and activate) a route's survey for a year. 'taken' when that year exists. */
export function createMirenSurvey(input: CreateMirenInput): { ok: true; id: number } | { ok: false; error: 'taken' | 'no-sites' | 'invalid' } {
  const route = getRoute(input.routeId);
  if (!route || !Number.isInteger(input.year) || input.year < 1900 || input.year > 2999) return { ok: false, error: 'invalid' };
  const sites = listSites(route.id);
  if (sites.length === 0) return { ok: false, error: 'no-sites' };
  return withTransaction(() => {
    const db = getUserDb();
    if (rows(db.executeSync(`SELECT 1 FROM miren_surveys WHERE route_id = ? AND year = ?`, [route.id, input.year])).length) {
      return { ok: false as const, error: 'taken' as const };
    }
    const now = Date.now();
    closeActiveRecords(db, now);
    const prev = rows<MirenSurvey>(
      db.executeSync(`SELECT * FROM miren_surveys WHERE route_id = ? AND year < ? ORDER BY year DESC LIMIT 1`, [route.id, input.year]),
    )[0];
    const prevPlots = prev
      ? rows<PrevPlot>(
          db.executeSync(
            `SELECT site_id, plot_no, sampled, lat, lon, elev, protected_area FROM miren_plots WHERE survey_id = ? AND visit = 1`,
            [prev.id],
          ),
        )
      : [];
    const res = db.executeSync(
      `INSERT INTO miren_surveys (uuid, route_id, year, status, start_ts, recorded_by, prev_survey_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [
        generateUuid(),
        route.id,
        input.year,
        now,
        input.recorded_by === undefined ? defaultSurveyorString() : input.recorded_by,
        prev?.id ?? null,
        input.projectId ?? 0,
        now,
        now,
      ],
    );
    const surveyId = Number(res.insertId);
    for (const p of planSurveyPlots(route.kind, sites, prevPlots)) {
      db.executeSync(
        `INSERT INTO miren_plots (uuid, survey_id, site_id, plot_no, visit, sampled, lat, lon, elev, protected_area, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [generateUuid(), surveyId, p.site_id, p.plot_no, p.sampled, p.lat, p.lon, p.elev, p.protected_area, now, now],
      );
    }
    return { ok: true as const, id: surveyId };
  });
}

/** `endTs`: as endGloriaSurvey — a chosen time, null for blank, omitted for now. */
export function endMirenSurvey(id: number, endTs?: number | null): void {
  const now = Date.now();
  getUserDb().executeSync(
    endTs === undefined
      ? `UPDATE miren_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`
      : `UPDATE miren_surveys SET status = 'done', stop_ts = ?, updated_at = ? WHERE id = ?`,
    [endTs === undefined ? now : endTs, now, id],
  );
}

export function reopenMirenSurvey(id: number): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    closeActiveRecords(db, now, { kind: 'miren', id });
    db.executeSync(`UPDATE miren_surveys SET status = 'active', updated_at = ? WHERE id = ?`, [now, id]);
  });
}

export type SurveyPatch = Partial<Pick<MirenSurvey, 'recorded_by' | 'literature' | 'notes' | 'project_id' | 'site_id' | 'starred'>>;

export function updateMirenSurvey(id: number, patch: SurveyPatch): void {
  patchRow('miren_surveys', id, patch, true);
}

/** Delete a survey and everything under it. Reference data (sites, region status) stays. */
export function deleteMirenSurvey(id: number): void {
  withTransaction(() => {
    const db = getUserDb();
    // Explicit child deletes as well: cascades are only as good as PRAGMA foreign_keys.
    const plots = `SELECT id FROM miren_plots WHERE survey_id = ?`;
    db.executeSync(`DELETE FROM miren_rechecks WHERE plot_id IN (${plots})`, [id]);
    db.executeSync(`DELETE FROM miren_plot_species WHERE plot_id IN (${plots})`, [id]);
    db.executeSync(`DELETE FROM miren_plots WHERE survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM miren_taxa WHERE survey_id = ?`, [id]);
    db.executeSync(`UPDATE miren_surveys SET prev_survey_id = NULL WHERE prev_survey_id = ?`, [id]);
    db.executeSync(`DELETE FROM miren_surveys WHERE id = ?`, [id]);
  });
}

// ── Plots ─────────────────────────────────────────────────────────────────

export function listPlots(surveyId: number): MirenPlotWithSite[] {
  return rows<MirenPlotWithSite>(
    getUserDb().executeSync(
      `SELECT p.*, s.site_no, s.suffix,
              (SELECT COUNT(*) FROM miren_plot_species ps WHERE ps.plot_id = p.id) AS species_count
         FROM miren_plots p JOIN miren_sites s ON s.id = p.site_id
        WHERE p.survey_id = ? ORDER BY s.site_no, p.plot_no, p.visit`,
      [surveyId],
    ),
  );
}

export function getPlot(id: number): MirenPlotWithSite | null {
  return (
    rows<MirenPlotWithSite>(
      getUserDb().executeSync(
        `SELECT p.*, s.site_no, s.suffix,
                (SELECT COUNT(*) FROM miren_plot_species ps WHERE ps.plot_id = p.id) AS species_count
           FROM miren_plots p JOIN miren_sites s ON s.id = p.site_id WHERE p.id = ?`,
        [id],
      ),
    )[0] ?? null
  );
}

export type PlotPatch = Partial<
  Omit<MirenPlot, 'id' | 'uuid' | 'survey_id' | 'site_id' | 'plot_no' | 'visit' | 'blind_closed_at' | 'compared_at' | 'created_at' | 'updated_at'>
>;

export function updatePlot(id: number, patch: PlotPatch): void {
  withTransaction(() => {
    patchRow('miren_plots', id, patch, true);
    touchSurveyOfPlot(id);
  });
}

/**
 * First touch of a plot: date (today, ISO) and observers (the survey's)
 * filled when empty, the start time set. Never overwrites what is there.
 */
export function markPlotStarted(id: number): void {
  const p = getPlot(id);
  if (!p) return;
  const survey = getMirenSurvey(p.survey_id);
  const now = Date.now();
  getUserDb().executeSync(
    `UPDATE miren_plots SET date = COALESCE(date, ?), observers = COALESCE(observers, ?), start_ts = COALESCE(start_ts, ?), updated_at = ?
      WHERE id = ?`,
    [isoDate(now), survey?.recorded_by ?? null, now, now, id],
  );
}

// ── Roster and plot species ───────────────────────────────────────────────

/**
 * The survey roster entry for a taxon and region-specific name (null = none),
 * created when missing, with the region's status row made sure of.
 */
export function ensureRosterTaxon(surveyId: number, taxonId: string, label: string | null = null): number {
  ensureTaxonSelfSufficient(taxonId);
  const db = getUserDb();
  const tag = label?.trim() || null;
  const found = rows<{ id: number }>(
    db.executeSync(
      `SELECT id FROM miren_taxa WHERE survey_id = ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ?`,
      [surveyId, taxonId, tag ?? ''],
    ),
  )[0];
  const ctx = surveyContext(surveyId);
  if (ctx) ensureRegionStatus(ctx.region.id, { taxonId, verbatim: tag });
  if (found) return found.id;
  const res = db.executeSync(
    `INSERT INTO miren_taxa (survey_id, taxon_id, verbatim_identification, created_at) VALUES (?, ?, ?, ?)`,
    [surveyId, taxonId, tag, Date.now()],
  );
  return Number(res.insertId);
}

/** Every region-specific name already used in a region, for model/morpho. */
export function regionMorphoNames(regionId: number): string[] {
  return rows<{ v: string }>(
    getUserDb().executeSync(
      `SELECT verbatim_identification AS v FROM miren_region_status WHERE region_id = ? AND verbatim_identification IS NOT NULL`,
      [regionId],
    ),
  ).map((r) => r.v);
}

export type AddSpeciesResult = { ok: true; id: number; existed: boolean } | { ok: false; error: 'not-sampled' | 'finished' };

/**
 * Add a taxon to a plot. The phase follows the plot: 'blind' until blind
 * recording is closed, 'recheck' after. A finished plot takes no additions.
 * Trail plot 1 (presence only) records presence = 1.
 */
export function addPlotSpecies(plotId: number, taxonId: string, label: string | null = null): AddSpeciesResult {
  return withTransaction(() => {
    const plot = getPlot(plotId);
    if (!plot) throw new Error(`miren plot ${plotId} not found`);
    if (!plot.sampled) return { ok: false as const, error: 'not-sampled' as const };
    if (plot.compared_at != null) return { ok: false as const, error: 'finished' as const };
    const db = getUserDb();
    const mid = ensureRosterTaxon(plot.survey_id, taxonId, label);
    const existing = rows<{ id: number }>(
      db.executeSync(`SELECT id FROM miren_plot_species WHERE plot_id = ? AND miren_taxon_id = ?`, [plotId, mid]),
    )[0];
    if (existing) return { ok: true as const, id: existing.id, existed: true };
    const kind = surveyContext(plot.survey_id)?.route.kind;
    const now = Date.now();
    const res = db.executeSync(
      `INSERT INTO miren_plot_species (plot_id, miren_taxon_id, occurrence_id, presence, phase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [plotId, mid, generateUuid(), kind === 'trail' && plot.plot_no === 1 ? 1 : null, plot.blind_closed_at == null ? 'blind' : 'recheck', now, now],
    );
    markPlotStarted(plotId);
    touchSurveyOfPlot(plotId);
    return { ok: true as const, id: Number(res.insertId), existed: false };
  });
}

export function listPlotSpecies(plotId: number): MirenPlotSpeciesWithTaxon[] {
  const recs = rows<MirenPlotSpecies & TaxonJoin>(
    getUserDb().executeSync(
      `SELECT ps.*, t.taxon_id, t.used_name_id, t.used_scientific_name, t.verbatim_identification
         FROM miren_plot_species ps JOIN miren_taxa t ON t.id = ps.miren_taxon_id
        WHERE ps.plot_id = ? ORDER BY ps.phase, ps.created_at, ps.id`,
      [plotId],
    ),
  );
  if (recs.length === 0) return [];
  const taxa = resolveTaxa(recs.map((r) => r.taxon_id));
  const adopted = resolveAdoptedNames(recs);
  return recs.map((r) => ({ ...r, ...applyAdoptedName(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS, r, adopted) }));
}

/** Blind rows are sealed once blind recording is closed; recheck rows stay
 *  editable until the plot is finished. */
function speciesEditable(id: number): boolean {
  const r = rows<{ phase: string; blind_closed_at: number | null; compared_at: number | null }>(
    getUserDb().executeSync(
      `SELECT ps.phase, p.blind_closed_at, p.compared_at FROM miren_plot_species ps JOIN miren_plots p ON p.id = ps.plot_id WHERE ps.id = ?`,
      [id],
    ),
  )[0];
  if (!r || r.compared_at != null) return false;
  return r.phase === 'recheck' || r.blind_closed_at == null;
}

export type PlotSpeciesPatch = Partial<Pick<MirenPlotSpecies, 'cover_class' | 'abundance_class' | 'presence' | 'note'>>;

export function updatePlotSpecies(id: number, patch: PlotSpeciesPatch): boolean {
  if (!speciesEditable(id)) return false;
  patchRow('miren_plot_species', id, patch, true);
  return true;
}

export function removePlotSpecies(id: number): boolean {
  if (!speciesEditable(id)) return false;
  getUserDb().executeSync(`DELETE FROM miren_plot_species WHERE id = ?`, [id]);
  return true;
}

// ── Blind recording, recheck, finishing ───────────────────────────────────

/** Seal the blind list. */
export function closeBlind(plotId: number): void {
  const now = Date.now();
  getUserDb().executeSync(
    `UPDATE miren_plots SET blind_closed_at = COALESCE(blind_closed_at, ?), stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`,
    [now, now, now, plotId],
  );
  touchSurveyOfPlot(plotId);
}

/** Undo a mistaken close — only while the recheck has not begun. */
export function reopenBlind(plotId: number): boolean {
  const db = getUserDb();
  const begun =
    rows(db.executeSync(`SELECT 1 FROM miren_rechecks WHERE plot_id = ? LIMIT 1`, [plotId])).length > 0 ||
    rows(db.executeSync(`SELECT 1 FROM miren_plot_species WHERE plot_id = ? AND phase = 'recheck' LIMIT 1`, [plotId])).length > 0;
  if (begun) return false;
  db.executeSync(`UPDATE miren_plots SET blind_closed_at = NULL, compared_at = NULL, updated_at = ? WHERE id = ?`, [Date.now(), plotId]);
  return true;
}

export type PrevSpecies = TaxonKey & {
  cover_class: number | null;
  abundance_class: number | null;
  presence: number | null;
  used_name_id: number | null;
  used_scientific_name: string | null;
} & TaxonFields;

/**
 * The same plot (site number, plot number, first visit) in the previous
 * survey, with its species — only for a plot whose blind list is closed.
 * That condition is the blind rule: there is no other way to read it.
 */
export function previousPlotSpecies(plotId: number): { year: number; species: PrevSpecies[] } | null {
  const plot = getPlot(plotId);
  if (!plot || plot.blind_closed_at == null) return null;
  const survey = getMirenSurvey(plot.survey_id);
  if (!survey?.prev_survey_id) return null;
  const prev = getMirenSurvey(survey.prev_survey_id);
  if (!prev) return null;
  const recs = rows<{
    taxon_id: string;
    verbatim_identification: string | null;
    used_name_id: number | null;
    used_scientific_name: string | null;
    cover_class: number | null;
    abundance_class: number | null;
    presence: number | null;
  }>(
    getUserDb().executeSync(
      `SELECT t.taxon_id, t.verbatim_identification, t.used_name_id, t.used_scientific_name, ps.cover_class, ps.abundance_class, ps.presence
         FROM miren_plot_species ps
         JOIN miren_plots p ON p.id = ps.plot_id
         JOIN miren_sites s ON s.id = p.site_id
         JOIN miren_taxa t ON t.id = ps.miren_taxon_id
        WHERE p.survey_id = ? AND s.site_no = ? AND p.plot_no = ? AND p.visit = 1
        ORDER BY ps.id`,
      [prev.id, plot.site_no, plot.plot_no],
    ),
  );
  const taxa = resolveTaxa(recs.map((r) => r.taxon_id));
  const adopted = resolveAdoptedNames(recs);
  return {
    year: prev.year,
    species: recs.map((r) => ({
      ...applyAdoptedName(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS, r, adopted),
      taxonId: r.taxon_id,
      verbatim: r.verbatim_identification,
      cover_class: r.cover_class,
      abundance_class: r.abundance_class,
      presence: r.presence,
      used_name_id: r.used_name_id,
      used_scientific_name: r.used_scientific_name,
    })),
  };
}

export type RecheckRow = {
  id: number;
  uuid: string;
  plot_id: number;
  prev_taxon_id: string;
  prev_verbatim_identification: string | null;
  outcome: RecheckOutcome;
  new_miren_taxon_id: number | null;
  checked_at: number;
};

export function listRechecks(plotId: number): RecheckRow[] {
  return rows<RecheckRow>(getUserDb().executeSync(`SELECT * FROM miren_rechecks WHERE plot_id = ?`, [plotId]));
}

/** What the recheck screen shows: previous taxa missing from the plot, and the answers so far. */
export function recheckState(plotId: number): { year: number; candidates: PrevSpecies[]; answers: RecheckRow[]; complete: boolean } | null {
  const prev = previousPlotSpecies(plotId);
  const plot = getPlot(plotId);
  if (!plot || plot.blind_closed_at == null) return null;
  const answers = listRechecks(plotId);
  // A taxon found in the recheck is now on the plot; it stays a candidate so
  // its answer remains visible, so compare against the blind rows only.
  const blind = rows<TaxonKey & { verbatim_identification: string | null }>(
    getUserDb().executeSync(
      `SELECT t.taxon_id AS taxonId, t.verbatim_identification AS verbatim FROM miren_plot_species ps
         JOIN miren_taxa t ON t.id = ps.miren_taxon_id WHERE ps.plot_id = ? AND ps.phase = 'blind'`,
      [plotId],
    ),
  );
  const candidates = prev ? recheckCandidates(prev.species, blind) : [];
  const complete = recheckComplete(
    candidates,
    answers.map((a) => ({
      key: taxonKey({ taxonId: a.prev_taxon_id, verbatim: a.prev_verbatim_identification }),
      outcome: a.outcome,
      newTaxon: a.new_miren_taxon_id != null ? { taxonId: String(a.new_miren_taxon_id), verbatim: null } : null,
    })),
  );
  return { year: prev?.year ?? 0, candidates, answers, complete };
}

/**
 * Answer one recheck candidate.
 *   found         the taxon is added to the plot as a recheck row (its cover
 *                 and abundance are then filled in); returns that row's id
 *   not_found     looked for and not there
 *   reidentified  the plant was recorded under another name this time;
 *                 `newRosterId` is that roster entry (already on the plot or
 *                 added by the caller)
 * Answering again replaces the earlier answer; a 'found' row added before is
 * removed when the answer changes.
 */
export function answerRecheck(
  plotId: number,
  prev: TaxonKey,
  outcome: RecheckOutcome,
  newRosterId: number | null = null,
): { plotSpeciesId: number | null } {
  return withTransaction(() => {
    const db = getUserDb();
    const plot = getPlot(plotId);
    if (!plot || plot.blind_closed_at == null || plot.compared_at != null) throw new Error('miren recheck: plot not open for recheck');
    const tag = prev.verbatim?.trim() || null;
    const old = rows<RecheckRow>(
      db.executeSync(
        `SELECT * FROM miren_rechecks WHERE plot_id = ? AND prev_taxon_id = ? AND IFNULL(prev_verbatim_identification, '') = ?`,
        [plotId, prev.taxonId, tag ?? ''],
      ),
    )[0];
    // The recheck row added for an earlier 'found' goes when the answer changes.
    if (old?.outcome === 'found' && outcome !== 'found') {
      db.executeSync(
        `DELETE FROM miren_plot_species WHERE plot_id = ? AND phase = 'recheck' AND miren_taxon_id IN
           (SELECT id FROM miren_taxa WHERE survey_id = ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ?)`,
        [plotId, plot.survey_id, prev.taxonId, tag ?? ''],
      );
    }
    let plotSpeciesId: number | null = null;
    if (outcome === 'found') {
      const r = addPlotSpecies(plotId, prev.taxonId, tag);
      plotSpeciesId = r.ok ? r.id : null;
    }
    const now = Date.now();
    if (old) {
      db.executeSync(`UPDATE miren_rechecks SET outcome = ?, new_miren_taxon_id = ?, checked_at = ? WHERE id = ?`, [
        outcome,
        outcome === 'reidentified' ? newRosterId : null,
        now,
        old.id,
      ]);
    } else {
      db.executeSync(
        `INSERT INTO miren_rechecks (uuid, plot_id, prev_taxon_id, prev_verbatim_identification, outcome, new_miren_taxon_id, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [generateUuid(), plotId, prev.taxonId, tag, outcome, outcome === 'reidentified' ? newRosterId : null, now],
      );
    }
    touchSurveyOfPlot(plotId);
    return { plotSpeciesId };
  });
}

/** Finish a plot: blind list closed and every recheck candidate answered. */
export function finishPlot(plotId: number): boolean {
  const plot = getPlot(plotId);
  if (!plot) return false;
  if (plot.blind_closed_at == null) closeBlind(plotId);
  const state = recheckState(plotId);
  if (!state?.complete) return false;
  const now = Date.now();
  getUserDb().executeSync(`UPDATE miren_plots SET compared_at = ?, updated_at = ? WHERE id = ?`, [now, now, plotId]);
  touchSurveyOfPlot(plotId);
  return true;
}

/** Open a finished plot again (recheck rows become editable). */
export function unfinishPlot(plotId: number): void {
  getUserDb().executeSync(`UPDATE miren_plots SET compared_at = NULL, updated_at = ? WHERE id = ?`, [Date.now(), plotId]);
  touchSurveyOfPlot(plotId);
}

// ── helpers ───────────────────────────────────────────────────────────────

function touchSurveyOfPlot(plotId: number): void {
  getUserDb().executeSync(
    `UPDATE miren_surveys SET updated_at = ? WHERE id = (SELECT survey_id FROM miren_plots WHERE id = ?)`,
    [Date.now(), plotId],
  );
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
