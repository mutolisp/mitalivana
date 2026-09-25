/**
 * Transect track recording control (transect plot only).
 *
 * State machine driven by plot.track_geojson + plot.track_finalized + the
 * `useTrackRecorder` store (module-level so it survives tab unmounts):
 *
 *   idle      : segments=[]      , finalized=0, recording=false
 *   recording : (any)            , finalized=0, recording=true
 *   paused    : segments.length>0, finalized=0, recording=false
 *   stopped   : (any)            , finalized=1, recording=false
 *
 * Two fixed controls: one toggle — ▶ start / resume while not recording,
 * ⏸ pause while recording — and ⏹ stop. The live track is drawn on the mini
 * map underneath, so there is no separate preview.
 * Pause and stop both end the GNSS watch and close the current segment; stop
 * also marks the track as stopped. Stopping is NOT final: ▶ reopens the track
 * and records a new segment. (It used to be final, with no way back — a
 * transect stopped by mistake could never be continued.)
 * The plot itself stays active for species entry either way.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import { Alert, Pressable, Text, View } from 'react-native';
import {
  finalizePlotTrack,
  parseTrackSegments,
  trackLengthMeters,
  unfinalizePlotTrack,
  type PlotSurvey,
} from '~/db';
import {
  pauseRecording,
  startRecording,
  useTrackRecorder,
} from '~/lib/trackRecorder';
import { TrackMiniMap } from './TrackMiniMap';
import { useTranslation } from 'react-i18next';

type Props = {
  plot: PlotSurvey;
  onUpdated: () => void;
};

export function TransectTrackControl({ plot, onUpdated }: Props) {
  const { t } = useTranslation();
  const persistedSegments = parseTrackSegments(plot.track_geojson);
  const finalized = plot.track_finalized === 1;
  const plotDone = plot.status === 'done';

  const recordingTarget = useTrackRecorder((s) => s.recordingTarget);
  const livePoints = useTrackRecorder((s) => s.livePoints);
  const recording = recordingTarget?.kind === 'plot' && recordingTarget.id === plot.id;

  const handleStart = async () => {
    if (plotDone) return;
    // Block double-recording if some other record is already capturing.
    if (recordingTarget && !(recordingTarget.kind === 'plot' && recordingTarget.id === plot.id)) {
      Alert.alert(t('transect.busyTitle'), t('transect.busyMsg'));
      return;
    }
    try {
      // Restarting a stopped track: reopen it first; the recorder then appends
      // a new segment after the saved ones.
      if (finalized) unfinalizePlotTrack(plot.id);
      await startRecording({ kind: 'plot', id: plot.id });
      // Refresh upstream so plot.start_ts (just stamped by startRecording)
      // reaches plotCanAcceptSpecies and unblocks the species tab.
      onUpdated();
    } catch (e) {
      Alert.alert(t('transect.startFail'), errText(e));
    }
  };

  const handlePause = () => {
    pauseRecording();
    onUpdated();
  };

  // No confirmation: stopping can be undone with ▶.
  const handleStop = () => {
    pauseRecording();
    finalizePlotTrack(plot.id);
    onUpdated();
  };

  // Visual state
  const persistedPointCount = persistedSegments.reduce((n, s) => n + s.length, 0);
  const totalPoints = persistedPointCount + (recording ? livePoints.length : 0);
  const totalSegments = persistedSegments.length + (recording && livePoints.length > 0 ? 1 : 0);
  const previewSegments = recording && livePoints.length > 0
    ? [...persistedSegments, livePoints]
    : persistedSegments;
  const lengthM = trackLengthMeters(previewSegments);
  const lengthStr = lengthM > 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${lengthM.toFixed(0)} m`;

  return (
    <View className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('transect.label')} <Text className="text-red-500">*</Text>
        </Text>
        {recording ? (
          <View className="flex-row items-center">
            <View className="mr-1.5 h-2 w-2 rounded-full bg-red-500" />
            <Text className="text-xs font-medium text-red-600 dark:text-red-400">{t('records.recording')}</Text>
          </View>
        ) : finalized ? (
          <Text className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('transect.stopped')}</Text>
        ) : totalSegments > 0 ? (
          <Text className="text-xs font-medium text-amber-600">{t('transect.paused')}</Text>
        ) : null}
      </View>

      {totalPoints > 0 ? (
        <Text className="mt-1 text-sm text-gray-900 dark:text-gray-100">
          {t('transect.summary', { count: totalSegments, points: totalPoints, length: lengthStr })}
        </Text>
      ) : (
        <Text className="mt-1 text-xs text-gray-400 dark:text-gray-500">{t('transect.notStarted')}</Text>
      )}

      <View className="mt-3 flex-row gap-2">
        {recording ? (
          <ControlButton icon="pause" label={t('transect.pause')} tone="amber" onPress={handlePause} />
        ) : (
          <ControlButton
            icon="play"
            label={totalSegments > 0 ? t('transect.resume') : t('transect.start')}
            tone="emerald"
            onPress={handleStart}
            disabled={plotDone}
          />
        )}
        <ControlButton
          icon="stop"
          label={t('transect.stop')}
          tone="red"
          onPress={handleStop}
          // Stoppable while recording or paused; not before anything was
          // recorded, and not twice.
          disabled={finalized || (!recording && totalSegments === 0)}
        />
      </View>

      <TrackMiniMap segments={previewSegments} follow={recording} />
    </View>
  );
}

function ControlButton({
  icon,
  label,
  tone,
  onPress,
  disabled,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  tone: 'emerald' | 'amber' | 'red';
  onPress: () => void;
  disabled?: boolean;
}) {
  const bg =
    tone === 'emerald'
      ? 'bg-emerald-500 active:bg-emerald-600'
      : tone === 'amber'
        ? 'bg-amber-500 active:bg-amber-600'
        : 'bg-red-500 active:bg-red-600';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      className={`flex-1 flex-row items-center justify-center rounded-md px-3 py-2 ${bg} ${disabled ? 'opacity-40' : ''}`}
    >
      <Ionicons name={icon} size={14} color="white" />
      <Text className="ml-1.5 text-xs font-medium text-white">{label}</Text>
    </Pressable>
  );
}
