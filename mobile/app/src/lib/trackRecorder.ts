/**
 * Persistent track-recording state, lifted out of any React component so it
 * survives unmounts (e.g. switching between Env/Species tabs inside a plot, or
 * leaving the session screen for the map tab).
 *
 * Layout:
 *   - module-scope `watchSub` holds the actual expo-location subscription
 *   - module-scope `currentSegment` holds the in-progress live points
 *   - zustand store exposes the bits the UI needs to render
 *
 * Why not put the subscription in the zustand store? Subscriptions are
 * opaque native handles; storing them in a state container can interact
 * weirdly with shallow equality checks. Plain module refs are simpler.
 *
 * Both record kinds (quick-checklist session / plot survey) share the same core
 * loop. The only per-kind differences — how a batch is persisted, how prior
 * points are loaded for resume, and the plot-only gate-stamping — live in a
 * small `RecorderAdapter` built from the target at startRecording().
 */
import * as Location from 'expo-location';
import { create } from 'zustand';
import i18n from '~/i18n';
import {
  buildTrackGeoJSON,
  getPlotSurvey,
  getSession,
  parseTrackSegments,
  updatePlotSurvey,
  updateSession,
  writePlotTrack,
  type TrackSegment,
} from '~/db';

const BATCH_FLUSH_POINTS = 5;
const MIN_DISTANCE_M = 5;
const MIN_TIME_MS = 4000;

export type RecordTarget = { kind: 'plot' | 'session'; id: number };

type RecorderAdapter = {
  /** Persisted segments at start, used to resume (append a new segment). */
  loadPriorSegments: () => TrackSegment[];
  /** Persist the full segment list (called on batch flush + on pause). */
  writeTrack: (segments: TrackSegment[]) => void;
  /** Once, when recording starts (plot stamps start_ts; session no-op). */
  onStart?: () => void;
  /** On the first fix of a fresh recording (plot co-opts gate fields). */
  onFirstFix?: (lat: number, lng: number, accuracy: number | null) => void;
  /** Whether the record is still open. Once it has been ended — by any path,
   *  including the DB-level single-active safety nets that cannot reach the
   *  recorder — the recorder pauses itself (see `LIVE_CHECK_MS`). */
  isLive: () => boolean;
};

/** How often a recording checks that its record is still open, besides on
 *  every point: a phone standing still gets no position callbacks at all. */
const LIVE_CHECK_MS = 30_000;
let liveTimer: ReturnType<typeof setInterval> | null = null;

// Module-scope mutable refs
let watchSub: Location.LocationSubscription | null = null;
let currentTarget: RecordTarget | null = null;
let currentAdapter: RecorderAdapter | null = null;
let currentSegment: TrackSegment = [];
let priorSegmentsSnapshot: TrackSegment[] = [];
/** A start is in flight (between the first await and `watchSub` being set).
 *  Checking `watchSub` alone left that window open: a second tap started a
 *  second watch, the first was overwritten and could never be removed — GPS
 *  stayed on for good. */
let starting = false;
/** A pause arrived while a start was in flight; the start drops its watch. */
let startCancelled = false;

type RecorderState = {
  /** target currently being recorded into, or null when idle. */
  recordingTarget: RecordTarget | null;
  /** Live points of the current (not-yet-committed) segment. */
  livePoints: TrackSegment;
};

export const useTrackRecorder = create<RecorderState>(() => ({
  recordingTarget: null,
  livePoints: [],
}));

/** Build the per-kind adapter, fetching what it needs from the DB. */
function buildAdapter(target: RecordTarget): RecorderAdapter {
  if (target.kind === 'plot') {
    const plot = getPlotSurvey(target.id);
    return {
      loadPriorSegments: () => parseTrackSegments(plot?.track_geojson ?? null),
      writeTrack: (segs) => writePlotTrack(target.id, segs),
      onStart: () => {
        // Stamp start_ts immediately so species entry can begin before the
        // first GNSS fix arrives (transect plotCanAcceptSpecies keys off it).
        if (plot && plot.start_ts == null) {
          updatePlotSurvey(target.id, { start_ts: Date.now() });
        }
      },
      isLive: () => getPlotSurvey(target.id)?.status === 'active',
      onFirstFix: (lat, lng, accuracy) => {
        // Transect plots have no static GNSS field; co-opt the first track
        // point to satisfy the hard-gate for species entry. Only when the
        // gate fields are still empty.
        if (
          plot &&
          (plot.decimal_latitude === null ||
            plot.decimal_longitude === null ||
            plot.coord_uncertainty_m === null)
        ) {
          updatePlotSurvey(target.id, {
            decimal_latitude: lat,
            decimal_longitude: lng,
            coord_uncertainty_m: accuracy,
            start_ts: plot.start_ts ?? Date.now(),
          });
        }
      },
    };
  }
  // session: track only; start_lat/start_lng are a separate "drop point"
  // feature and must NOT be overwritten by the track.
  const session = getSession(target.id);
  return {
    loadPriorSegments: () => parseTrackSegments(session?.track_geojson ?? null),
    writeTrack: (segs) =>
      updateSession(target.id, {
        track_geojson: buildTrackGeoJSON(segs),
        gps_mode: 'full_track',
      }),
    // A session is open while it has no end time.
    isLive: () => {
      const s = getSession(target.id);
      return s != null && s.status === 'active';
    },
  };
}

/** Start watching GNSS and appending to a new segment on the given target. */
export async function startRecording(target: RecordTarget): Promise<void> {
  if (watchSub || starting) return; // already recording, or about to be
  starting = true;
  startCancelled = false;
  try {
    await beginWatch(target);
  } finally {
    starting = false;
  }
}

async function beginWatch(target: RecordTarget): Promise<void> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    throw new Error(i18n.t('gnss.permTitle'));
  }
  if (startCancelled) return;

  const adapter = buildAdapter(target);
  currentTarget = target;
  currentAdapter = adapter;
  currentSegment = [];
  priorSegmentsSnapshot = adapter.loadPriorSegments();
  useTrackRecorder.setState({ recordingTarget: target, livePoints: [] });

  adapter.onStart?.();

  const sub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.BestForNavigation,
      distanceInterval: MIN_DISTANCE_M,
      timeInterval: MIN_TIME_MS,
    },
    (pos) => {
      if (currentTarget == null) return;
      // The record was ended while recording: stop here, keep what we have.
      if (!adapter.isLive()) {
        pauseRecording();
        return;
      }
      const pt: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      currentSegment.push(pt);
      useTrackRecorder.setState({ livePoints: [...currentSegment] });

      // First fix of a fresh recording (no prior segments).
      if (priorSegmentsSnapshot.length === 0 && currentSegment.length === 1) {
        adapter.onFirstFix?.(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      }

      // Persist every BATCH_FLUSH_POINTS points to avoid loss on crash.
      if (currentSegment.length % BATCH_FLUSH_POINTS === 0) {
        adapter.writeTrack([...priorSegmentsSnapshot, currentSegment.slice()]);
      }
    },
  );
  // Paused while the watch was being set up: pauseRecording found nothing to
  // remove, so this watch would otherwise run with no owner.
  if (startCancelled) {
    sub.remove();
    return;
  }
  watchSub = sub;
  liveTimer = setInterval(() => {
    if (currentAdapter && !currentAdapter.isLive()) pauseRecording();
  }, LIVE_CHECK_MS);
}

/** Stop the watch and commit the in-progress segment back to the target. */
export function pauseRecording(): void {
  if (starting) startCancelled = true;
  if (watchSub) {
    watchSub.remove();
    watchSub = null;
  }
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  if (currentAdapter != null && currentSegment.length > 0) {
    const next = [...priorSegmentsSnapshot, currentSegment.slice()];
    currentAdapter.writeTrack(next);
    priorSegmentsSnapshot = next;
  }
  currentSegment = [];
  currentTarget = null;
  currentAdapter = null;
  useTrackRecorder.setState({ recordingTarget: null, livePoints: [] });
}

/** Whether the recorder currently owns a GNSS subscription. */
export function isRecording(): boolean {
  return watchSub != null;
}

/** Whether the recorder is recording into this exact target. */
export function isRecordingTarget(t: RecordTarget): boolean {
  const rt = useTrackRecorder.getState().recordingTarget;
  return rt != null && rt.kind === t.kind && rt.id === t.id;
}

/** Stop the watch if it is recording into something other than `keep`.
 *  Used at single-active switch points (create/reopen/end of either kind)
 *  that bypass recordCreate.ts, so the GNSS always belongs to the active
 *  record and never writes to a now-ended one. */
export function pauseIfNot(keep: RecordTarget | null): void {
  const rt = useTrackRecorder.getState().recordingTarget;
  if (rt && (!keep || rt.kind !== keep.kind || rt.id !== keep.id)) {
    pauseRecording();
  }
}
