/**
 * Turn "centre + radius in metres" into a geodesic polygon.
 *
 * Why it is needed: the neutral interface's `circle` is in **metres** (a plot's
 * `point_radius_m`, `RecordLocationMap`'s `reference.radiusM`), and
 * react-native-maps' `<Circle>` takes metres directly — but MapLibre's
 * `circle-radius` is in **screen pixels**, so the circle grows and shrinks with
 * zoom, which is entirely different semantics. The MapLibre side therefore has
 * to build the circle as a polygon itself.
 *
 * Uses a spherical model (mean Earth radius), not the WGS84 ellipsoid. Plot
 * radii are usually tens to hundreds of metres, and at that scale the difference
 * is far below GPS error.
 */

/** IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_M = 6_371_008.8;

/** Default number of sides. 72 shows no corners on a phone screen without
 *  bloating the geometry. */
const DEFAULT_STEPS = 72;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Returns the outer ring of a GeoJSON Polygon (`[lng, lat]`, first point
 * repeated last).
 *
 * Uses the standard "destination point given bearing and distance along a great
 * circle" formula, so it holds at high latitudes and across the 180th meridian —
 * simply dividing `radiusM / 111320` into degrees looks fine over Taiwan but
 * draws the circle as an ellipse.
 */
export function geodesicCircle(
  lat: number,
  lng: number,
  radiusM: number,
  steps: number = DEFAULT_STEPS,
): [number, number][] {
  const angular = radiusM / EARTH_RADIUS_M;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angular);
  const cosAng = Math.cos(angular);

  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(bearing));
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2),
      );
    // Normalise to -180..180 so crossing the meridian does not yield values like
    // 190
    ring.push([((toDeg(lng2) + 540) % 360) - 180, toDeg(lat2)]);
  }
  ring.push(ring[0]!);
  return ring;
}
