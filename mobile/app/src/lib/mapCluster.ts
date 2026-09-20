/**
 * Screen-grid clustering for the map's record points — pure, no Expo imports
 * (scripts/check-cluster.mjs loads this under plain Node).
 *
 * A fixed pixel grid rather than supercluster: the counts here are plot surveys,
 * checklists and geographic sites in one user's database — hundreds, not the
 * hundreds of thousands supercluster exists for — and a grid needs no
 * dependency, no index to rebuild, and behaves identically on both platforms.
 * Bucketing by SCREEN pixels (not degrees) is what makes it feel right: two
 * points a kilometre apart are one dot at country zoom and clearly separate at
 * plot zoom, with no thresholds to tune per latitude.
 *
 * The projection is deliberately the flat one the viewport already implies
 * (linear in lat/lng across the visible span). Mercator's vertical stretch
 * matters for drawing tiles, not for deciding which points land in the same
 * 64 px box.
 *
 * The grid is anchored to the WORLD, not to the viewport, and its cell size is
 * snapped to a power-of-two ladder. Both exist for the same reason: panning at
 * one zoom level must not change which cell a point falls in. An earlier
 * version measured cells from the viewport's west/north edge, so every pan
 * shifted the whole grid — every bubble got a new key, every marker remounted,
 * and the map visibly blanked and rebuilt itself at the end of each drag. The
 * ladder covers the same problem in the other axis: react-native-maps reports
 * slightly different deltas after each gesture, and an unsnapped cell size
 * would wobble points across boundaries for no visible reason.
 */

export type ClusterPoint = {
  /** Stable identity of the feature this point stands for, e.g. `plot-12`. */
  key: string;
  latitude: number;
  longitude: number;
};

export type PointCluster = {
  /** The cell, and nothing else: stable across pans so React keeps the marker
   *  mounted. The count is deliberately NOT part of it — a key that changed
   *  with the count is what made bubbles flicker. Callers that cache a rendered
   *  view must re-capture it when `memberKeys.length` changes instead. */
  key: string;
  /** Mean of the members — where the bubble is drawn. */
  latitude: number;
  longitude: number;
  memberKeys: string[];
  /** Bounds of the members, for zooming in when the bubble is tapped. */
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
};

export type ClusterViewport = {
  /** Region centre and span, as react-native-maps reports it. */
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
  /** Map size in points. */
  width: number;
  height: number;
};

/** Grid cell size. Roughly two marker widths: close enough to merge pins that
 *  visually overlap, far enough not to swallow neighbours that read as separate. */
export const CLUSTER_CELL_PX = 64;

/** Nearest power of two, so the grid changes in visible steps rather than
 *  drifting with every reported region. */
function snapToPowerOfTwo(deg: number): number {
  if (!(deg > 0) || !Number.isFinite(deg)) return 0;
  return Math.pow(2, Math.round(Math.log2(deg)));
}

function singletons(points: ClusterPoint[]): PointCluster[] {
  return points.map((p) => ({
    key: `c:${p.key}`,
    latitude: p.latitude,
    longitude: p.longitude,
    memberKeys: [p.key],
    minLatitude: p.latitude,
    maxLatitude: p.latitude,
    minLongitude: p.longitude,
    maxLongitude: p.longitude,
  }));
}

/**
 * Group points that land in the same grid cell.
 *
 * Every point comes back in exactly one cluster, including the lone ones —
 * the caller decides what to do with `memberKeys.length === 1` (draw the real
 * feature) versus more (draw a bubble). Points outside the viewport are kept,
 * not dropped: a transect whose centre is just off-screen still has a line
 * crossing it, and silently discarding it would make that line disappear.
 */
export function clusterPoints(
  points: ClusterPoint[],
  vp: ClusterViewport,
  cellPx: number = CLUSTER_CELL_PX,
): PointCluster[] {
  if (points.length === 0) return [];
  // A degenerate viewport (zero span, or a map that has not been laid out yet)
  // would divide by zero and collapse everything into one bubble.
  if (
    !(vp.latitudeDelta > 0) ||
    !(vp.longitudeDelta > 0) ||
    !(vp.width > 0) ||
    !(vp.height > 0) ||
    !(cellPx > 0)
  ) {
    return singletons(points);
  }

  // Degrees one cell covers at this zoom, snapped so a pan that reports a
  // marginally different delta keeps the same grid.
  const cellLng = snapToPowerOfTwo((cellPx / vp.width) * vp.longitudeDelta);
  const cellLat = snapToPowerOfTwo((cellPx / vp.height) * vp.latitudeDelta);
  if (!(cellLng > 0) || !(cellLat > 0)) return singletons(points);

  const cells = new Map<string, ClusterPoint[]>();
  for (const p of points) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    // Anchored at (0, 0) in world coordinates, so the cell a point belongs to
    // depends only on the zoom — never on where the camera happens to be.
    const cx = Math.floor(p.longitude / cellLng);
    const cy = Math.floor(p.latitude / cellLat);
    const id = `${cx},${cy}`;
    const bucket = cells.get(id);
    if (bucket) bucket.push(p);
    else cells.set(id, [p]);
  }

  const out: PointCluster[] = [];
  for (const [id, bucket] of cells) {
    // Sorted so the key and centroid do not depend on input order — otherwise
    // a reload in a different order remounts every bubble.
    bucket.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let latSum = 0;
    let lngSum = 0;
    let minLatitude = Infinity;
    let maxLatitude = -Infinity;
    let minLongitude = Infinity;
    let maxLongitude = -Infinity;
    for (const p of bucket) {
      latSum += p.latitude;
      lngSum += p.longitude;
      if (p.latitude < minLatitude) minLatitude = p.latitude;
      if (p.latitude > maxLatitude) maxLatitude = p.latitude;
      if (p.longitude < minLongitude) minLongitude = p.longitude;
      if (p.longitude > maxLongitude) maxLongitude = p.longitude;
    }
    out.push({
      key: `c:${id}`,
      latitude: latSum / bucket.length,
      longitude: lngSum / bucket.length,
      memberKeys: bucket.map((p) => p.key),
      minLatitude,
      maxLatitude,
      minLongitude,
      maxLongitude,
    });
  }
  return out;
}

/**
 * Would zooming to `vp` actually break this cluster apart?
 *
 * Tapping a bubble zooms to `clusterRegion`, which is useless when the members
 * share a coordinate — the same cell still holds all of them, so the bubble
 * survives the zoom and the records underneath can never be opened. Same dead
 * end for members a metre apart, since `clusterRegion`'s floor stops zooming
 * well before that distance separates them.
 *
 * Callers use this to choose between zooming and listing the members. It
 * re-runs the real grouping rather than comparing spans to a threshold, so the
 * answer cannot drift away from what the map will actually draw.
 */
export function clusterSplits(
  c: PointCluster,
  vp: ClusterViewport,
  cellPx: number = CLUSTER_CELL_PX,
): boolean {
  if (c.memberKeys.length < 2) return false;
  const members: ClusterPoint[] = [
    // Only the bounds are known per member, so the corners stand in for them:
    // two points split at some zoom exactly when the box around them does.
    { key: 'a', latitude: c.minLatitude, longitude: c.minLongitude },
    { key: 'b', latitude: c.maxLatitude, longitude: c.maxLongitude },
  ];
  return clusterPoints(members, vp, cellPx).length > 1;
}

/**
 * Region that frames a cluster's members, for zooming in on a tap.
 *
 * `geometryBounds` is not reused here: its 1.4× padding and 0.005° floor are
 * tuned for framing one shape, and applied to a tight cluster they zoom out
 * far enough that the same bubble reappears — tapping would do nothing.
 */
export function clusterRegion(c: PointCluster): {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
} {
  const latSpan = c.maxLatitude - c.minLatitude;
  const lngSpan = c.maxLongitude - c.minLongitude;
  return {
    latitude: (c.minLatitude + c.maxLatitude) / 2,
    longitude: (c.minLongitude + c.maxLongitude) / 2,
    // Members stacked on one spot still have to end up somewhere useful, hence
    // the floor; 0.002° is roughly a 200 m box.
    latitudeDelta: Math.max(latSpan * 1.6, 0.002),
    longitudeDelta: Math.max(lngSpan * 1.6, 0.002),
  };
}
