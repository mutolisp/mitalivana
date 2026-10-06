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
 * Projection: a local equirectangular plane around the track's mean latitude.
 * Over the few kilometres of a transect its error is far below GNSS error.
 *
 * Pure, for scripts/check-along-track.mjs.
 */
import type { TrackSegment } from './track';

export type AlongInput = { id: number; lat: number | null; lng: number | null };

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

export function alongTrackSegments(
  track: TrackSegment[],
  records: AlongInput[],
  stretchM?: number,
  maxOffM = 200,
): AlongResult {
  const segs = track.filter((s) => s.length > 0);
  const empty: AlongResult = { totalM: 0, stretchM: 0, stretches: [], stretchOf: new Map(), alongM: new Map() };
  if (segs.length === 0) return empty;

  let latSum = 0;
  let n = 0;
  for (const s of segs) for (const p of s) (latSum += p[1]), n++;
  const k = Math.cos(toRad(latSum / n));
  const xy = (lng: number, lat: number): [number, number] => [R * toRad(lng) * k, R * toRad(lat)];

  // Cumulative distance at every vertex, segment by segment.
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

  const stretchOf = new Map<number, number>();
  const alongM = new Map<number, number>();
  for (const r of records) {
    if (r.lat == null || r.lng == null) continue;
    const [px, py] = xy(r.lng, r.lat);
    let best = Infinity;
    let bestAlong = 0;
    pts.forEach((q, si) => {
      const c = cum[si];
      if (q.length === 1) {
        const d = Math.hypot(px - q[0][0], py - q[0][1]);
        if (d < best) (best = d), (bestAlong = c[0]);
        return;
      }
      for (let i = 1; i < q.length; i++) {
        const [ax, ay] = q[i - 1];
        const [bx, by] = q[i];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d < best) (best = d), (bestAlong = c[i - 1] + t * (c[i] - c[i - 1]));
      }
    });
    if (best > maxOffM) continue;
    alongM.set(r.id, bestAlong);
    stretchOf.set(r.id, indexAt(bestAlong));
  }

  return { totalM: total, stretchM: len, stretches, stretchOf, alongM };
}
