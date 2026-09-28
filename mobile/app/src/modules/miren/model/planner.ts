/**
 * MIREN site / transect planning along a route profile — pure.
 *
 * Road (Road protocol §2.3, p. 2): the road's elevation range, from the
 * bottom to the highest point the road reaches, is divided into 19 equal
 * bands, giving 20 sites numbered 01 (lowest) to 20.
 *
 * Trail (Trail protocol, Placing transects, p. 3): either fixed distance
 * intervals along the trail, or elevation bands placed where the trail first
 * crosses each contour line. Transects must be at least 50 m apart in
 * elevation and/or 100 m apart in distance, at least 10 per trail.
 *
 * Distances reuse the app's haversine (`trackLengthMeters`), so a planned
 * distance and a recorded track's length agree.
 */

import { trackLengthMeters } from '../../../lib/track';

export type ProfilePoint = { lng: number; lat: number; ele: number };
export type Stop = ProfilePoint & { /** metres along the route from its start */ along: number };

export const ROAD_SITE_COUNT = 20;
export const TRAIL_MIN_TRANSECTS = 10;
export const TRAIL_MIN_ELEVATION_GAP_M = 50;
export const TRAIL_MIN_DISTANCE_GAP_M = 100;

export function segmentMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  return trackLengthMeters([[[a.lng, a.lat], [b.lng, b.lat]]]);
}

/** Routes are planned from the bottom; a track recorded top-down is reversed. */
export function orientUphill(points: readonly ProfilePoint[]): ProfilePoint[] {
  if (points.length < 2) return [...points];
  return points[0].ele > points[points.length - 1].ele ? [...points].reverse() : [...points];
}

/** Highest elevation, without spreading a long track into arguments. */
export function topElevation(points: readonly ProfilePoint[]): number {
  let top = -Infinity;
  for (const p of points) if (p.ele > top) top = p.ele;
  return top;
}

export function cumulativeMeters(points: readonly ProfilePoint[]): number[] {
  const out: number[] = [];
  let total = 0;
  points.forEach((p, i) => {
    if (i > 0) total += segmentMeters(points[i - 1], p);
    out.push(total);
  });
  return out;
}

/** `n` target elevations from `bottom` to `top`, equally spaced (n − 1 bands). */
export function targetElevations(bottom: number, top: number, n = ROAD_SITE_COUNT): number[] {
  if (n < 2) return [bottom];
  const step = (top - bottom) / (n - 1);
  return Array.from({ length: n }, (_, i) => bottom + i * step);
}

/**
 * Where the route first reaches `target`, searching forward from `fromIndex`.
 * Interpolated between the two profile points that straddle it; null when
 * the rest of the route never gets there.
 */
export function firstCrossing(
  points: readonly ProfilePoint[],
  along: readonly number[],
  target: number,
  fromIndex = 0,
): (Stop & { index: number }) | null {
  for (let i = Math.max(0, fromIndex); i < points.length; i++) {
    const p = points[i];
    if (p.ele === target) return { ...p, along: along[i], index: i };
    if (i + 1 >= points.length) break;
    const q = points[i + 1];
    if ((p.ele < target && q.ele > target) || (p.ele > target && q.ele < target)) {
      const t = (target - p.ele) / (q.ele - p.ele);
      return {
        lng: p.lng + t * (q.lng - p.lng),
        lat: p.lat + t * (q.lat - p.lat),
        ele: target,
        along: along[i] + t * (along[i + 1] - along[i]),
        index: i,
      };
    }
  }
  return null;
}

/** Stops at each target elevation in turn, each searched after the previous
 *  one, so the stops keep the route's order. A target the route never
 *  reaches comes back as null. */
function stopsAtElevations(points: ProfilePoint[], targets: readonly number[]): (Stop | null)[] {
  const along = cumulativeMeters(points);
  let from = 0;
  return targets.map((target) => {
    const hit = firstCrossing(points, along, target, from);
    if (!hit) return null;
    from = hit.index;
    const { index: _index, ...stop } = hit;
    return stop;
  });
}

/** The 20 road sites. Bottom = the start of the (uphill) profile; top = the
 *  highest point the road reaches. */
export function planRoadSites(profile: readonly ProfilePoint[]): (Stop | null)[] {
  const points = orientUphill(profile);
  if (points.length < 2) return [];
  const bottom = points[0].ele;
  const top = topElevation(points);
  return stopsAtElevations(points, targetElevations(bottom, top));
}

/** Trail transects where the trail first crosses each contour that is a
 *  multiple of `bandM`, above the trail head up to the highest point. */
export function planTrailByElevation(profile: readonly ProfilePoint[], bandM: number): Stop[] {
  const points = orientUphill(profile);
  if (points.length < 2 || bandM <= 0) return [];
  const start = points[0].ele;
  const top = topElevation(points);
  const contours: number[] = [];
  for (let c = Math.floor(start / bandM) * bandM + bandM; c <= top; c += bandM) contours.push(c);
  return stopsAtElevations(points, contours).filter((s): s is Stop => s != null);
}

/** Trail transects every `intervalM` metres along the trail from the head. */
export function planTrailByDistance(profile: readonly ProfilePoint[], intervalM: number): Stop[] {
  const points = orientUphill(profile);
  if (points.length < 2 || intervalM <= 0) return [];
  const along = cumulativeMeters(points);
  const total = along[along.length - 1];
  const out: Stop[] = [];
  let i = 0;
  for (let d = 0; d <= total; d += intervalM) {
    while (i + 1 < along.length && along[i + 1] < d) i++;
    const p = points[i];
    const q = points[Math.min(i + 1, points.length - 1)];
    const span = along[Math.min(i + 1, along.length - 1)] - along[i];
    const t = span > 0 ? (d - along[i]) / span : 0;
    out.push({
      lng: p.lng + t * (q.lng - p.lng),
      lat: p.lat + t * (q.lat - p.lat),
      ele: p.ele + t * (q.ele - p.ele),
      along: d,
    });
  }
  return out;
}

export type SpacingIssue =
  | { kind: 'too-few'; count: number }
  | { kind: 'too-close'; index: number; elevationGap: number; distanceGap: number };

/**
 * Trail spacing rule: consecutive transects need ≥ 50 m of elevation OR
 * ≥ 100 m of distance between them ("and/or"); and ≥ 10 transects. Warnings
 * only — the planner never drops a stop on its own.
 */
export function checkTrailSpacing(stops: readonly Pick<Stop, 'ele' | 'along'>[]): SpacingIssue[] {
  const issues: SpacingIssue[] = [];
  if (stops.length < TRAIL_MIN_TRANSECTS) issues.push({ kind: 'too-few', count: stops.length });
  for (let i = 1; i < stops.length; i++) {
    const elevationGap = Math.abs(stops[i].ele - stops[i - 1].ele);
    const distanceGap = Math.abs(stops[i].along - stops[i - 1].along);
    if (elevationGap < TRAIL_MIN_ELEVATION_GAP_M && distanceGap < TRAIL_MIN_DISTANCE_GAP_M) {
      issues.push({ kind: 'too-close', index: i, elevationGap, distanceGap });
    }
  }
  return issues;
}

/** Road §2.3 a: the farthest measurement must be ≥ 100 m from all roads. */
export const ROAD_CLEARANCE_M = 100;
export function clearanceOk(measuredM: number | null | undefined): boolean | null {
  return measuredM == null ? null : measuredM >= ROAD_CLEARANCE_M;
}

type LineGeometry = { type: string; coordinates: unknown };

/**
 * The elevation profile of an imported track (GPX / KML / GeoJSON, parsed by
 * lib/geoConverters): the line with the most points, a MultiLineString's
 * segments joined in order. Planning needs elevations, so points without a
 * third coordinate are dropped; a track with none is refused.
 */
export function profileFromGeometries(
  geoms: readonly LineGeometry[],
): { ok: true; points: ProfilePoint[] } | { ok: false; error: 'no-line' | 'no-elevation' } {
  const lines: number[][][] = [];
  for (const g of geoms) {
    if (g.type === 'LineString') lines.push(g.coordinates as number[][]);
    if (g.type === 'MultiLineString') lines.push((g.coordinates as number[][][]).flat());
  }
  if (lines.length === 0) return { ok: false, error: 'no-line' };
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const points = longest
    .filter((c) => c.length >= 3 && Number.isFinite(c[2]))
    .map(([lng, lat, ele]) => ({ lng, lat, ele }));
  if (points.length < 2) return { ok: false, error: 'no-elevation' };
  return { ok: true, points };
}

/** Stored on the route (`track_geojson`) as a LineString with elevations, so
 *  planning can be redone without the file. */
export function profileToGeoJson(points: readonly ProfilePoint[]): string {
  return JSON.stringify({ type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat, p.ele]) });
}

export function profileFromGeoJson(s: string | null): ProfilePoint[] {
  if (!s) return [];
  try {
    const r = profileFromGeometries([JSON.parse(s)]);
    return r.ok ? r.points : [];
  } catch {
    return [];
  }
}
