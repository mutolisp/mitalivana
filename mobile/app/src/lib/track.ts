/**
 * The stored representation of a recorded track: a GeoJSON MultiLineString,
 * JSON-stringified into `plot_surveys.track_geojson` / `sessions.track_geojson`.
 *
 * Split out of `src/db/plots.ts` (which re-exports it) so the import parsers
 * can build the same canonical shape without pulling in the DB — a track
 * rebuilt from a `track.gpx` sidecar must be byte-identical to one the
 * recorder wrote, and two definitions would drift.
 */
export type TrackSegment = [number, number][]; // [[lng, lat], ...]

type MultiLineString = {
  type: 'MultiLineString';
  coordinates: TrackSegment[];
};

/** Parse a stored track into segments. Returns [] if missing/invalid. */
export function parseTrackSegments(geojson: string | null): TrackSegment[] {
  if (!geojson) return [];
  try {
    const obj = JSON.parse(geojson);
    if (obj && obj.type === 'MultiLineString' && Array.isArray(obj.coordinates)) {
      return obj.coordinates as TrackSegment[];
    }
    // Backward-compat: a legacy LineString gets wrapped as one segment.
    if (obj && obj.type === 'LineString' && Array.isArray(obj.coordinates)) {
      return [obj.coordinates as TrackSegment];
    }
  } catch {
    // ignore
  }
  return [];
}

export function buildTrackGeoJSON(segments: TrackSegment[]): string {
  const obj: MultiLineString = { type: 'MultiLineString', coordinates: segments };
  return JSON.stringify(obj);
}

/** Haversine length in meters; sums per-segment distances. */
export function trackLengthMeters(segments: TrackSegment[]): number {
  let total = 0;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const [lng1, lat1] = seg[i - 1];
      const [lng2, lat2] = seg[i];
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      total += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
  }
  return total;
}

/**
 * The track as it stands while recording: the saved segments plus the live
 * points of the segment being recorded.
 *
 * The recorder writes the segment in progress to the record every minute
 * (trackRecorder.ts `flushSegment`), so once it has, the saved track already
 * ends with an earlier copy of the live segment. Appending the live points
 * then counted that stretch twice — twice the length, twice the points. The
 * saved copy is recognised by starting at the same point as the live one and
 * being no longer, and is replaced.
 */
export function withLiveSegment(saved: TrackSegment[], live: TrackSegment): TrackSegment[] {
  if (live.length === 0) return saved;
  const last = saved[saved.length - 1];
  const sameStart = !!last && last.length > 0 && last[0][0] === live[0][0] && last[0][1] === live[0][1];
  return sameStart && last.length <= live.length ? [...saved.slice(0, -1), live] : [...saved, live];
}

/** Segment union without repeats, so merging the same file twice adds nothing. */
export function trackUnion(a: unknown, b: unknown): string | null {
  const seen = new Set<string>();
  const segs = [...parseTrackSegments((a as string) ?? null), ...parseTrackSegments((b as string) ?? null)].filter((s) => {
    const k = JSON.stringify(s);
    if (s.length === 0 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return segs.length ? buildTrackGeoJSON(segs) : null;
}
