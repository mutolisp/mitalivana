/**
 * Give a species just entered into a quick checklist (session) or a plot its
 * own GNSS fix — coordinate, accuracy and altitude.
 *
 * When: the settings `record_gps_session` / `record_gps_plot` (both on by
 * default), and ALWAYS while that record's track is being recorded — the
 * receiver is on for the track anyway, so the fix costs nothing and the
 * position comes from the same stream (`getLastKnownPositionAsync`).
 *
 * How: the record is inserted first and stamped when the fix arrives, so
 * adding a species never waits on the GNSS. The stamp only lands on a record
 * that still has no coordinate (`stampRecordFix` / `stampPlotSpeciesFix`),
 * so a point placed by hand, or read off a photo, in the meantime wins.
 *
 * Never asks for permission: a system prompt on every species added would be
 * unusable, and the record detail's 📍 is where permission is asked for. No
 * permission, no fix, no error — the record simply stays unlocated.
 *
 * Only for species entered one at a time. Batch paths (batch import, bulk add
 * from the taxonomy tree, merged or duplicated records) do not call this: they
 * are not observations made where the phone is now.
 */
import * as Location from 'expo-location';
import { stampPlotSpeciesAlong, stampPlotSpeciesFix, stampRecordAlong, stampRecordFix } from '~/db';
import { useSettings } from '~/stores/settings';
import { occurrencesLocated } from '~/survey/db/surveyCore';
import { getFwSurvey, stampOccurrenceFix } from '~/survey/db/surveys';
import { trackLengthM } from './alongTrack';
import { isRecordingTarget, liveTrack, useTrackRecorder } from './trackRecorder';

/** 'modular': an occurrence of a checklist / plot-style survey (2G-b), under the setting of the record it matches. */
export type RecordKind = 'session' | 'plot' | 'modular';

export type Fix = { lat: number; lng: number; accuracy: number | null; elevation_m: number | null };

/** A track fix older than this is not "where the species was entered". */
const TRACK_FIX_MAX_AGE_MS = 15_000;
const FIX_TIMEOUT_MS = 15_000;

export function wantsRecordFix(kind: RecordKind, parentId: number): boolean {
  if (kind === 'modular') {
    // Only where the template shows a species' own position; a checklist-style
    // survey follows 快速名錄's setting, a plot-style one the plot's.
    const survey = getFwSurvey(parentId);
    if (!survey || !occurrencesLocated(survey)) return false;
    if (isRecordingTarget({ kind, id: parentId })) return true;
    const s = useSettings.getState();
    return survey.style === 'plot' ? s.record_gps_plot : s.record_gps_session;
  }
  if (isRecordingTarget({ kind, id: parentId })) return true;
  const s = useSettings.getState();
  return kind === 'session' ? s.record_gps_session : s.record_gps_plot;
}

function toFix(pos: Location.LocationObject): Fix {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    // Rounded to the metre, like the plot and specimen altitude.
    elevation_m: pos.coords.altitude != null ? Math.round(pos.coords.altitude) : null,
  };
}

/**
 * The current position, without asking for permission (null when none, or
 * after 15 s): a casual observation recorded without a photo to read one off.
 * While a track is recording, the track's last point serves.
 */
export function takeFixNow(): Promise<Fix | null> {
  return takeFix(useTrackRecorder.getState().recordingTarget != null).catch(() => null);
}

async function takeFix(tracking: boolean): Promise<Fix | null> {
  const perm = await Location.getForegroundPermissionsAsync();
  if (!perm.granted) return null;
  if (tracking) {
    const last = await Location.getLastKnownPositionAsync({ maxAge: TRACK_FIX_MAX_AGE_MS });
    if (last) return toFix(last);
  }
  const pos = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
  ]);
  return pos ? toFix(pos) : null;
}

/**
 * Fire-and-forget: stamp record `recordId` of `kind` (in session / plot
 * `parentId`) with the current fix when the rules above want one.
 * `onStamped` runs only when a coordinate was actually written — the caller's
 * cue to reload.
 */
export function stampNewRecord(
  kind: RecordKind,
  recordId: number,
  parentId: number,
  onStamped?: () => void,
  /** Stamp even where the settings say not to: the split map's 「記在這裡」. */
  force = false,
): void {
  if (!recordId || (!force && !wantsRecordFix(kind, parentId))) return;
  const tracking = isRecordingTarget({ kind, id: parentId });
  // How far along the track it was entered, taken now rather than when the fix
  // arrives (code review L47). Surveys have no split map to use it.
  const track = tracking && kind !== 'modular' ? liveTrack({ kind, id: parentId }) : null;
  if (track) {
    const m = trackLengthM(track);
    if (kind === 'session') stampRecordAlong(recordId, m);
    else stampPlotSpeciesAlong(recordId, m);
  }
  void (async () => {
    try {
      const fix = await takeFix(tracking);
      if (!fix) return;
      const wrote =
        kind === 'session' ? stampRecordFix(recordId, fix) : kind === 'modular' ? stampOccurrenceFix(recordId, fix) : stampPlotSpeciesFix(recordId, fix);
      if (wrote) onStamped?.();
    } catch {
      // No fix (receiver off, timeout, record deleted) — it stays unlocated,
      // exactly as it would have before per-record fixes existed.
    }
  })();
}
