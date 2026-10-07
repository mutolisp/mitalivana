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
import { AppState, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import i18n from '~/i18n';
import { isPreviewId } from '~/db/previewDb';
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
import { useSettings, type TrackAccuracy } from '~/stores/settings';
import { getFwSurvey, noteTrackAltitude, updateSurvey } from '~/survey/db/surveys';

/** How often the in-progress segment is written to the DB. The whole track
 *  is one GeoJSON column, so every write re-serialises all of it; a crash
 *  loses at most this much. Also flushed on pause and when backgrounded. */
const FLUSH_INTERVAL_MS = 60_000;

/**
 * Settings → track accuracy. expo-location 19 maps accuracy to
 * CLLocationAccuracy on iOS (BestForNavigation / NearestTenMeters /
 * HundredMeters) and ignores `timeInterval` there; on Android High and
 * BestForNavigation are both PRIORITY_HIGH_ACCURACY, so spacing is what
 * separates high from medium.
 */
const TRACK_PROFILES: Record<TrackAccuracy, Location.LocationOptions> = {
  high: { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 4000 },
  medium: { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 10_000 },
  low: { accuracy: Location.Accuracy.Balanced, distanceInterval: 20, timeInterval: 30_000 },
};

/** 'modular': a checklist or plot-style survey built from a template (fw_surveys, v88). */
export type RecordTarget = { kind: 'plot' | 'session' | 'modular'; id: number };

type RecorderAdapter = {
  /** Persisted segments at start, used to resume (append a new segment). */
  loadPriorSegments: () => TrackSegment[];
  /** Persist the full segment list (called on batch flush + on pause). */
  writeTrack: (segments: TrackSegment[]) => void;
  /** Once, when recording starts (plot stamps start_ts; session no-op). */
  onStart?: () => void;
  /** On the first fix of a fresh recording (plot co-opts gate fields). */
  onFirstFix?: (lat: number, lng: number, accuracy: number | null) => void;
  /** Every fix that states an altitude (a modular survey keeps its elevation range). */
  onAltitude?: (altitude: number) => void;
  /** Whether the record is still open. Once it has been ended — by any path,
   *  including the DB-level single-active safety nets that cannot reach the
   *  recorder — the recorder pauses itself (see `LIVE_CHECK_MS`). */
  isLive: () => boolean;
};

/** How often a recording checks that its record is still open, besides on
 *  every point: a phone standing still gets no position callbacks at all. */
const LIVE_CHECK_MS = 30_000;
let liveTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: NativeEventSubscription | null = null;
/** Points in `currentSegment` already written, and when. */
let flushedCount = 0;
let lastFlushAt = 0;

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
  if (target.kind === 'modular') {
    // As a session: track only, its located point untouched. Each fix's
    // altitude widens the survey's elevation range and fills an empty
    // elevation (noteTrackAltitude; asked 2026-10-04).
    const survey = getFwSurvey(target.id);
    return {
      loadPriorSegments: () => parseTrackSegments(survey?.track_geojson ?? null),
      writeTrack: (segs) => updateSurvey(target.id, { trackGeojson: buildTrackGeoJSON(segs), gpsMode: 'full_track' }),
      isLive: () => getFwSurvey(target.id)?.status === 'active',
      onAltitude: (altitude) => noteTrackAltitude(target.id, altitude),
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
  // A builder preview (previewDb.ts) is gone when the preview closes: nothing to record into.
  if (target.kind === 'modular' && isPreviewId(target.id)) throw new Error(i18n.t('builder.previewNoTrack'));
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
  flushedCount = 0;
  lastFlushAt = Date.now();
  priorSegmentsSnapshot = adapter.loadPriorSegments();
  useTrackRecorder.setState({ recordingTarget: target, livePoints: [] });

  adapter.onStart?.();

  const sub = await Location.watchPositionAsync(
    TRACK_PROFILES[useSettings.getState().track_accuracy] ?? TRACK_PROFILES.high,
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
      if (pos.coords.altitude != null) adapter.onAltitude?.(pos.coords.altitude);

      if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) flushSegment();
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
  // Foreground-only watch: the app may be killed once suspended.
  appStateSub = AppState.addEventListener('change', (s) => {
    if (s !== 'active') flushSegment();
  });
}

/** Write the track if the current segment has points not yet persisted. */
function flushSegment(): void {
  lastFlushAt = Date.now();
  if (currentAdapter == null || currentSegment.length === flushedCount) return;
  currentAdapter.writeTrack([...priorSegmentsSnapshot, currentSegment.slice()]);
  flushedCount = currentSegment.length;
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
  appStateSub?.remove();
  appStateSub = null;
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

/** The track of `t` as walked up to now — written and not yet written alike —
 *  or null when `t` is not the one recording. */
export function liveTrack(t: RecordTarget): TrackSegment[] | null {
  if (!isRecordingTarget(t)) return null;
  return currentSegment.length > 0 ? [...priorSegmentsSnapshot, currentSegment] : priorSegmentsSnapshot;
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
  // Reopening a builder preview makes nothing active outside its scratch file.
  if (keep?.kind === 'modular' && isPreviewId(keep.id)) return;
  const rt = useTrackRecorder.getState().recordingTarget;
  if (rt && (!keep || rt.kind !== keep.kind || rt.id !== keep.id)) {
    pauseRecording();
  }
}
