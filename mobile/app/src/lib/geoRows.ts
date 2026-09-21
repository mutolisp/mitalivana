/**
 * The rows 地理樣區管理 shows: the real `sites` rows, plus every plot survey
 * that carries coordinates of its own.
 *
 * A plot with a GPS fix already IS a place on the map, so it belongs in the
 * list of places — but it is DERIVED here, never stored. A shadow `sites` row
 * per plot would draw a second marker on top of the plot's own, drift the
 * moment a plotid is renamed, and grow back after the user deleted it from
 * this screen. Reading both tables and merging for display has none of that.
 *
 * A plot whose `site_id` is set is deliberately skipped: that boundary is
 * already a site row of its own (the plot-boundary feature), so listing the
 * plot as well would show the same place twice.
 */
import { parseGeometry, usesTrack } from '~/db';
import { parseTrackSegments } from './track';
import type {
  GeoJSONGeometry,
  PlotSurveyWithMeta,
  Site,
  SiteGeometryType,
  SiteWithProject,
} from '~/db';

/**
 * Project bucket for a row whose `project_id` points nowhere.
 *
 * `listPlotSurveysWithMeta` COALESCEs to this literal in SQL while `listSites`
 * LEFT JOINs and yields null, so both are normalised here — otherwise an
 * orphaned site and an orphaned plot would land in two groups, one of them
 * with a blank header and a null React key.
 */
const UNASSIGNED_PROJECT = '未指定';

export type GeoRowKind = 'site' | 'plot';

export type GeoRow = {
  /** Kind-qualified, so one selection Set can hold both kinds without a
   *  `sites.id` colliding with a `plot_surveys.id`. */
  key: string;
  kind: GeoRowKind;
  id: number;
  name: string;
  projectId: number;
  projectName: string;
  geometryType: SiteGeometryType;
  geometry: GeoJSONGeometry;
  notes: string | null;
  updatedAt: number;
  /** plotid of the plot survey this geometry belongs to, when it belongs to
   *  one. A derived row leaves this null — its `name` already IS the plotid.
   *  Set on a real site row that a plot bound as its boundary, so the list
   *  says whose it is and the search box can find it by plotid even though
   *  the site carries a name of its own. */
  ownerPlotid: string | null;
  /** True when this row is a 樣區 — either derived from one, or a site a plot
   *  bound as its boundary. Drives the 樣區 glyph. */
  isPlot: boolean;
  /** True when some record owns this geometry: a plot, a 名錄, or the 名錄
   *  that created it. Mirrors `countSiteReferences() > 0`, computed in bulk so
   *  the list does not run one query per row. False = a standalone place the
   *  user drew or imported, which is what the second tint marks. */
  boundToRecord: boolean;
};

/** Just enough of a session to know which site it holds. */
type SessionBinding = { site_id: number | null };

/**
 * The shape a plot's own coordinates make, or null when it has none.
 *
 * A transect's shape is the walked track; its `decimal_*` pair is only the
 * first fix copied out of that same track, so the track wins whenever it has
 * a drawable segment. Everything else is the static fix.
 */
export function plotGeometry(plot: PlotSurveyWithMeta): GeoJSONGeometry | null {
  // Gated on plot_type, like the map's own layer: only a transect is a line.
  // A fixed plot's track column, if anything ever wrote one, is not its shape.
  if (usesTrack(plot)) {
    const segments = parseTrackSegments(plot.track_geojson).filter((s) => s.length >= 2);
    if (segments.length > 0) return { type: 'MultiLineString', coordinates: segments };
  }
  if (plot.decimal_latitude != null && plot.decimal_longitude != null) {
    return { type: 'Point', coordinates: [plot.decimal_longitude, plot.decimal_latitude] };
  }
  return null;
}

/** Merge both sources into one list, newest first. */
export function buildGeoRows(
  sites: SiteWithProject[],
  plots: PlotSurveyWithMeta[],
  sessions: SessionBinding[] = [],
): GeoRow[] {
  const rows: GeoRow[] = [];
  const plotidBySite = new Map<number, string>();
  for (const p of plots) {
    if (p.site_id != null) plotidBySite.set(p.site_id, p.plotid.trim() || `#${p.id}`);
  }
  const sessionSiteIds = new Set<number>();
  for (const s of sessions) {
    if (s.site_id != null) sessionSiteIds.add(s.site_id);
  }

  for (const s of sites) {
    let geometry: GeoJSONGeometry;
    try {
      geometry = parseGeometry(s);
    } catch {
      // parseGeometry is a bare JSON.parse — one corrupt row must not empty
      // the whole screen.
      continue;
    }
    rows.push({
      key: `site-${s.id}`,
      kind: 'site',
      id: s.id,
      name: s.name,
      projectId: s.project_id,
      projectName: s.project_name || UNASSIGNED_PROJECT,
      geometryType: s.geometry_type,
      geometry,
      notes: s.notes,
      updatedAt: s.updated_at,
      ownerPlotid: plotidBySite.get(s.id) ?? null,
      isPlot: plotidBySite.has(s.id),
      // The third term is the site's own back-reference, set when a 名錄
      // created it; the same three sources countSiteReferences() sums.
      boundToRecord: plotidBySite.has(s.id) || sessionSiteIds.has(s.id) || s.session_id != null,
    });
  }

  for (const p of plots) {
    if (p.site_id != null) continue;
    const geometry = plotGeometry(p);
    if (!geometry) continue;
    rows.push({
      key: `plot-${p.id}`,
      kind: 'plot',
      id: p.id,
      // plotid is NOT NULL but may be blank; a nameless row is unusable.
      name: p.plotid.trim() || `#${p.id}`,
      projectId: p.project_id,
      projectName: p.project_name || UNASSIGNED_PROJECT,
      geometryType: geometry.type,
      geometry,
      // Exported as the KML <description> / GPX <desc>, so the plot's field
      // note is the right thing to carry over.
      notes: p.field_note,
      updatedAt: p.updated_at,
      ownerPlotid: null,
      isPlot: true,
      boundToRecord: true,
    });
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export type GeoRowGroup = {
  projectId: number;
  projectName: string;
  rows: GeoRow[];
};

/**
 * Group rows by project, preserving the newest-first order of both the groups
 * and the rows inside them.
 *
 * Keyed by project id, not name: the id is what a collapsed-group setting can
 * store, and two projects are allowed to share a display name.
 */
export function groupGeoRows(rows: GeoRow[]): GeoRowGroup[] {
  const byProject = new Map<number, GeoRowGroup>();
  for (const r of rows) {
    const g = byProject.get(r.projectId);
    if (g) g.rows.push(r);
    else
      byProject.set(r.projectId, { projectId: r.projectId, projectName: r.projectName, rows: [r] });
  }
  return [...byProject.values()];
}

/**
 * Project a row into the `Site` shape the geo writers expect.
 *
 * `geoExporters` never emits an id, so a derived row can borrow a negative one
 * — the object exists only for the duration of the export and is never stored.
 */
export function geoRowToSite(r: GeoRow): Site {
  return {
    id: r.kind === 'site' ? r.id : -r.id,
    project_id: r.projectId,
    session_id: null,
    name: r.name,
    geometry_type: r.geometryType,
    geometry_geojson: JSON.stringify(r.geometry),
    color: null,
    notes: r.notes,
    created_at: r.updatedAt,
    updated_at: r.updatedAt,
  };
}
