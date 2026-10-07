/**
 * Cut a walked track into stretches and say which stretch each record was made
 * on (split map, docs/planned/UI_modes_impl.md M3): tapping a stretch of the
 * track lists only what was recorded along it.
 *
 * Distances are along the track as walked. Pausing and resuming somewhere else
 * starts a new segment; the jump between the two is not walked, so it adds no
 * distance, and a stretch that spans a pause is drawn as one part per segment.
 *
 * A record belongs to the stretch of the nearest point on the track, if that
 * point is within `maxOffM`. Records without a position, or found far off the
 * track, belong to none: they are still in the full list, never in a stretch.
 *
 * A record entered while its track was recording knows how far along it was
 * (`alongM`, checklist_records / plot_species_records.along_m, v93): that
 * wins over the nearest point, which on a trail walked out and back is as
 * likely to be on the way back (code review L47). It is checked first: the
 * track at that distance must lie within `maxOffM` of the record's position
 * (a track replaced or merged since), or, with no position, the distance must
 * fit on the track; otherwise the nearest point decides as before.
 *
 * Projection: a local equirectangular plane around the track's mean latitude.
 * Over the few kilometres of a transect its error is far below GNSS error.
 *
 * Pure, for scripts/check-along-track.mjs.
 */
import type { TrackSegment } from './track';

export type AlongInput = { id: number; lat: number | null; lng: number | null; alongM?: number | null };

export type Stretch = {
  index: number;
  fromM: number;
  toM: number;
  /** One polyline per track segment the stretch crosses, as [lng, lat]. */
  parts: TrackSegment[];
};

export type AlongResult = {
  totalM: number;
  stretchM: number;
  stretches: Stretch[];
  /** Record id → stretch index. */
  stretchOf: Map<number, number>;
  /** Record id → metres along the track. */
  alongM: Map<number, number>;
};

const R = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Stretch lengths to choose from: round numbers a surveyor can read off. */
const NICE_M = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
/** At most this many stretches by default: each must stay big enough to tap. */
const MAX_STRETCHES = 8;

/** The default stretch length for a track `totalM` long. */
export function stretchLengthFor(totalM: number): number {
  for (const m of NICE_M) if (totalM / m <= MAX_STRETCHES) return m;
  return Math.ceil(totalM / MAX_STRETCHES);
}

/**
 * The track on a local plane: every vertex projected, and the distance walked
 * at each, segment by segment. The one measure of distance along a track —
 * the stretches and the distance stamped on a record (`trackLengthM`) both
 * come from it, so the two agree.
 */
function walked(segs: TrackSegment[]) {
  let latSum = 0;
  let n = 0;
  for (const s of segs) for (const p of s) (latSum += p[1]), n++;
  const k = Math.cos(toRad(n ? latSum / n : 0));
  const xy = (lng: number, lat: number): [number, number] => [R * toRad(lng) * k, R * toRad(lat)];
  const cum: number[][] = [];
  const pts: [number, number][][] = [];
  let total = 0;
  for (const s of segs) {
    const c: number[] = [];
    const q: [number, number][] = [];
    for (let i = 0; i < s.length; i++) {
      const p = xy(s[i][0], s[i][1]);
      if (i > 0) {
        const prev = q[i - 1];
        total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      }
      c.push(total);
      q.push(p);
    }
    cum.push(c);
    pts.push(q);
  }
  return { xy, cum, pts, total };
}

/** Metres walked along `track` so far: what a record entered now is stamped with (src/lib/recordFix.ts). */
export function trackLengthM(track: TrackSegment[]): number {
  return walked(track.filter((s) => s.length > 0)).total;
}

export function alongTrackSegments(
  track: TrackSegment[],
  records: AlongInput[],
  stretchM?: number,
  maxOffM = 200,
): AlongResult {
  const segs = track.filter((s) => s.length > 0);
  const empty: AlongResult = { totalM: 0, stretchM: 0, stretches: [], stretchOf: new Map(), alongM: new Map() };
  if (segs.length === 0) return empty;

  const { xy, cum, pts, total } = walked(segs);
  if (total <= 0) return { ...empty, totalM: 0 };

  const len = stretchM && stretchM > 0 ? stretchM : stretchLengthFor(total);
  const count = Math.max(1, Math.ceil(total / len - 1e-9));

  // Stretch geometry: walk each segment, cutting at multiples of `len`.
  const parts: TrackSegment[][] = Array.from({ length: count }, () => []);
  const indexAt = (m: number) => Math.min(count - 1, Math.floor(m / len));
  segs.forEach((s, si) => {
    const c = cum[si];
    let cur: TrackSegment = [s[0]];
    let at = indexAt(c[0]);
    for (let i = 1; i < s.length; i++) {
      const a = c[i - 1];
      const b = c[i];
      // Every cut between the two vertices.
      for (let cut = (at + 1) * len; cut < b && at < count - 1; cut = (at + 1) * len) {
        const t = b > a ? (cut - a) / (b - a) : 0;
        const p: [number, number] = [s[i - 1][0] + (s[i][0] - s[i - 1][0]) * t, s[i - 1][1] + (s[i][1] - s[i - 1][1]) * t];
        cur.push(p);
        parts[at].push(cur);
        cur = [p];
        at += 1;
      }
      cur.push(s[i]);
    }
    if (cur.length > 1 || (cur.length === 1 && s.length === 1)) parts[at].push(cur);
  });

  const stretches: Stretch[] = parts.map((p, index) => ({
    index,
    fromM: index * len,
    toM: Math.min(total, (index + 1) * len),
    parts: p,
  }));

  // Nearest point per record through a grid of edges, cells `maxOffM` wide:
  // an edge within maxOffM of a record has a point in the record's cell or
  // one of the 8 around it, so only those are searched. A record farther off
  // than that belongs to no stretch either way, so the result is what testing
  // every edge gives — at a cost that no longer grows as records × vertices,
  // which ran on every GPS fix while recording (code review M37).
  const cell = maxOffM > 0 ? maxOffM : 1;
  const grid = new Map<string, number[]>(); // cell → edge ids
  const edges: Array<{ si: number; i: number }> = []; // i = end vertex; i = 0 for a lone point
  const cellOf = (v: number) => Math.floor(v / cell);
  const put = (e: number, x0: number, y0: number, x1: number, y1: number) => {
    for (let cx = cellOf(Math.min(x0, x1)); cx <= cellOf(Math.max(x0, x1)); cx++) {
      for (let cy = cellOf(Math.min(y0, y1)); cy <= cellOf(Math.max(y0, y1)); cy++) {
        const key = `${cx}:${cy}`;
        const list = grid.get(key);
        if (list) list.push(e);
        else grid.set(key, [e]);
      }
    }
  };
  pts.forEach((q, si) => {
    if (q.length === 1) {
      edges.push({ si, i: 0 });
      put(edges.length - 1, q[0][0], q[0][1], q[0][0], q[0][1]);
      return;
    }
    for (let i = 1; i < q.length; i++) {
      edges.push({ si, i });
      put(edges.length - 1, q[i - 1][0], q[i - 1][1], q[i][0], q[i][1]);
    }
  });

  // Every vertex in walking order, for finding the track at a stored distance.
  const flat: Array<{ m: number; p: [number, number]; si: number }> = [];
  pts.forEach((q, si) => q.forEach((p, i) => flat.push({ m: cum[si][i], p, si })));
  /** How far the track `m` metres along lies from (px, py). */
  const offTrackAt = (m: number, px: number, py: number): number => {
    let lo = 0;
    let hi = flat.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (flat[mid].m < m) lo = mid + 1;
      else hi = mid;
    }
    const b = flat[lo];
    const a = lo > 0 ? flat[lo - 1] : b;
    if (a.si !== b.si || b.m <= a.m) {
      // A pause: both ends of the jump are the same distance along.
      return Math.min(Math.hypot(px - a.p[0], py - a.p[1]), Math.hypot(px - b.p[0], py - b.p[1]));
    }
    const t = Math.max(0, Math.min(1, (m - a.m) / (b.m - a.m)));
    return Math.hypot(px - (a.p[0] + t * (b.p[0] - a.p[0])), py - (a.p[1] + t * (b.p[1] - a.p[1])));
  };

  const stretchOf = new Map<number, number>();
  const alongM = new Map<number, number>();
  for (const r of records) {
    const stored = r.alongM != null && Number.isFinite(r.alongM) && r.alongM >= 0 ? r.alongM : null;
    if (stored != null && stored <= total + maxOffM) {
      const m = Math.min(stored, total);
      if (r.lat == null || r.lng == null || offTrackAt(m, ...xy(r.lng, r.lat)) <= maxOffM) {
        alongM.set(r.id, m);
        stretchOf.set(r.id, indexAt(m));
        continue;
      }
    }
    if (r.lat == null || r.lng == null) continue;
    const [px, py] = xy(r.lng, r.lat);
    let best = Infinity;
    let bestAlong = 0;
    // Lowest edge id on a tie, as testing the edges in order did.
    let bestEdge = Infinity;
    const cx = cellOf(px);
    const cy = cellOf(py);
    // The record's own cell first: an edge not listed there lies wholly
    // outside it, so no farther than the cell's nearest side — once the best
    // is within that, the cells around cannot beat it.
    const margin = Math.min(
      px - cx * cell,
      (cx + 1) * cell - px,
      py - cy * cell,
      (cy + 1) * cell - py,
    );
    for (let ring = 0; ring <= 1; ring++) {
      if (ring === 1 && best <= margin) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (ring === 1 && dx === 0 && dy === 0) continue;
          for (const e of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
            const { si, i } = edges[e];
            const q = pts[si];
            const c = cum[si];
            let d: number;
            let along: number;
            if (q.length === 1) {
              d = Math.hypot(px - q[0][0], py - q[0][1]);
              along = c[0];
            } else {
              const [ax, ay] = q[i - 1];
              const [bx, by] = q[i];
              const ex = bx - ax;
              const ey = by - ay;
              const l2 = ex * ex + ey * ey;
              const t =
                l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
              d = Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
              along = c[i - 1] + t * (c[i] - c[i - 1]);
            }
            if (d < best || (d === best && e < bestEdge))
              ((best = d), (bestAlong = along), (bestEdge = e));
          }
        }
      }
    }
    if (best > maxOffM) continue;
    alongM.set(r.id, bestAlong);
    stretchOf.set(r.id, indexAt(bestAlong));
  }

  return { totalM: total, stretchM: len, stretches, stretchOf, alongM };
}
