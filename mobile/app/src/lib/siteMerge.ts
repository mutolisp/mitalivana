/**
 * Several 地理樣區 as one: a record takes a single site, while a plot made of
 * four subplots imports as four polygons (asked 2026-10-07). Only shapes of
 * one dimension merge — points, lines or areas — because a site has one
 * geometry type (sites.geometry_type CHECK). Polygons that overlap make a
 * MultiPolygon GeoJSON calls invalid; subplots do not overlap, so they are
 * joined as they are rather than unioned.
 *
 * Pure, for scripts/check-site-merge.mjs.
 */
import type { GeoJSONGeometry } from '../db/sites';

export type SiteDimension = 'point' | 'line' | 'area';

export function dimensionOf(type: GeoJSONGeometry['type']): SiteDimension {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  return 'area';
}

/** One geometry holding all of `geoms`, or null when they are of different dimensions (or none). */
export function mergeGeometries(geoms: GeoJSONGeometry[]): GeoJSONGeometry | null {
  if (geoms.length === 0) return null;
  const dim = dimensionOf(geoms[0].type);
  if (geoms.some((g) => dimensionOf(g.type) !== dim)) return null;
  if (geoms.length === 1) return geoms[0];
  if (dim === 'point') {
    return {
      type: 'MultiPoint',
      coordinates: geoms.flatMap((g) =>
        g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [],
      ),
    };
  }
  if (dim === 'line') {
    return {
      type: 'MultiLineString',
      coordinates: geoms.flatMap((g) =>
        g.type === 'LineString'
          ? [g.coordinates]
          : g.type === 'MultiLineString'
            ? g.coordinates
            : [],
      ),
    };
  }
  return {
    type: 'MultiPolygon',
    coordinates: geoms.flatMap((g) =>
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [],
    ),
  };
}

/**
 * The middle of the shape's bounding box, or null when it holds no point.
 * Where a record with no centre of its own is placed when it takes this shape
 * as its boundary (asked 2026-10-07): picking a plot's subplots should not
 * leave the plot shut out of species entry for want of a centre. Hand-placed,
 * so the caller stores no accuracy with it.
 */
export function boundaryCentre(g: GeoJSONGeometry): { lat: number; lng: number } | null {
  const points: [number, number][] =
    g.type === 'Point'
      ? [g.coordinates]
      : g.type === 'MultiPoint' || g.type === 'LineString'
        ? g.coordinates
        : g.type === 'MultiLineString' || g.type === 'Polygon'
          ? g.coordinates.flat()
          : g.coordinates.flat(2);
  const ok = points.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (!ok.length) return null;
  const lngs = ok.map((p) => p[0]);
  const lats = ok.map((p) => p[1]);
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
}
