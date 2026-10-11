/**
 * Editing a 地理樣區's shape on the map one part at a time (asked 2026-10-07):
 * a Multi* site — four subplots merged into one — is edited part by part, in
 * the order geometryToPrimitives draws them, so part `i` is primitive `i` on
 * the map. A polygon part is edited as its outer ring without the closing
 * vertex; its holes are kept as they are.
 *
 * Pure, for scripts/check-site-edit.mjs.
 */
import type { GeoJSONGeometry } from '../db/sites';
import { dimensionOf, type SiteDimension } from './siteMerge';

type LngLat = [number, number];

export type EditablePart = { kind: SiteDimension; vertices: LngLat[] };

/** Fewest vertices a part of each kind may keep. */
export const MIN_VERTICES: Readonly<Record<SiteDimension, number>> = { point: 1, line: 2, area: 3 };

/** An outer ring without its closing vertex. */
const openRing = (ring: LngLat[]): LngLat[] => {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1])
    return ring.slice(0, -1);
  return ring;
};

const closeRing = (vertices: LngLat[]): LngLat[] =>
  vertices.length ? [...vertices, vertices[0]] : [];

/** Every part of `g` as the vertices the map lets the user drag. */
export function editableParts(g: GeoJSONGeometry): EditablePart[] {
  const kind = dimensionOf(g.type);
  switch (g.type) {
    case 'Point':
      return [{ kind, vertices: [g.coordinates] }];
    case 'MultiPoint':
      return g.coordinates.map((p) => ({ kind, vertices: [p] }));
    case 'LineString':
      return [{ kind, vertices: g.coordinates }];
    case 'MultiLineString':
      return g.coordinates.map((line) => ({ kind, vertices: line }));
    case 'Polygon':
      return [{ kind, vertices: openRing(g.coordinates[0] ?? []) }];
    case 'MultiPolygon':
      return g.coordinates.map((poly) => ({ kind, vertices: openRing(poly[0] ?? []) }));
  }
}

/** `g` with part `index` replaced by `vertices`: a ring is closed again and keeps its holes. */
export function replacePart(
  g: GeoJSONGeometry,
  index: number,
  vertices: LngLat[],
): GeoJSONGeometry {
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: vertices[0] };
    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: g.coordinates.map((p, i) => (i === index ? vertices[0] : p)),
      };
    case 'LineString':
      return { type: 'LineString', coordinates: vertices };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: g.coordinates.map((l, i) => (i === index ? vertices : l)),
      };
    case 'Polygon':
      return { type: 'Polygon', coordinates: [closeRing(vertices), ...g.coordinates.slice(1)] };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: g.coordinates.map((poly, i) =>
          i === index ? [closeRing(vertices), ...poly.slice(1)] : poly,
        ),
      };
  }
}

/** `g` without part `index`; one part left is the single type again. Null when nothing would be left. */
export function removePart(g: GeoJSONGeometry, index: number): GeoJSONGeometry | null {
  switch (g.type) {
    case 'MultiPoint': {
      const rest = g.coordinates.filter((_, i) => i !== index);
      if (!rest.length) return null;
      return rest.length === 1
        ? { type: 'Point', coordinates: rest[0] }
        : { type: 'MultiPoint', coordinates: rest };
    }
    case 'MultiLineString': {
      const rest = g.coordinates.filter((_, i) => i !== index);
      if (!rest.length) return null;
      return rest.length === 1
        ? { type: 'LineString', coordinates: rest[0] }
        : { type: 'MultiLineString', coordinates: rest };
    }
    case 'MultiPolygon': {
      const rest = g.coordinates.filter((_, i) => i !== index);
      if (!rest.length) return null;
      return rest.length === 1
        ? { type: 'Polygon', coordinates: rest[0] }
        : { type: 'MultiPolygon', coordinates: rest };
    }
    default:
      return null;
  }
}

/**
 * Where a new vertex can go in: the middle of each edge, with the index the
 * new vertex takes. A ring has the closing edge back to the first vertex too.
 */
export function edgeMidpoints(
  vertices: LngLat[],
  closed: boolean,
): { insertAt: number; at: LngLat }[] {
  const n = vertices.length;
  const edges = closed && n >= 3 ? n : n - 1;
  const out: { insertAt: number; at: LngLat }[] = [];
  for (let i = 0; i < edges; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    out.push({ insertAt: i + 1, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return out;
}

/**
 * What the part picker calls each part: the merged names when a site made by
 * merging (names joined with `sep`, in part order) still has one per part,
 * else null so the caller numbers them.
 */
export function partNames(siteName: string, sep: string, count: number): string[] | null {
  const names = siteName.split(sep);
  return names.length === count && names.every((x) => x.trim()) ? names : null;
}
