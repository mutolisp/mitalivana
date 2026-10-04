/**
 * Audio clips for a record, in two pieces so screens can lay them out:
 *
 *   <AudioRecordTile onAdd />   an 88×88 dashed square, the audio twin of
 *                               PhotoGrid's camera tile (mic → red stop + timer
 *                               while recording)
 *   <AudioClipRows clips onRemove />  one row per clip: play / stop, timer,
 *                               long-press to remove
 *   <AudioClipList …>           the two stacked — what the session and
 *                               specimen sheets use
 *
 * All plain Views: the sheets that host them are Modals, and iOS will not
 * stack a Modal on a Modal. Recording: `useAudioRecorder` (expo-audio) → on
 * stop the temp file is moved to documentDirectory/audio/ and handed to
 * `onAdd`; the parent owns the DB write, exactly like PhotoGrid's `onAdd`.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import {
  RecordingPresets,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { rebaseAppFileUri } from '~/lib/appFiles';
import {
  beginRecordingMode,
  endRecordingMode,
  ensureMicPermission,
  persistRecording,
} from '~/lib/audioCapture';
import { useThemeColors } from '~/theme/colors';

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The square 「錄音」 tile. Same box as PhotoGrid's add tile so the two can
 *  sit side by side. */
export function AudioRecordTile({ onAdd }: { onAdd: (uri: string) => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 500);
  const [busy, setBusy] = useState(false);

  // Sheet closed mid-recording: drop the take and put the audio session back.
  useEffect(
    () => () => {
      try {
        if (recorder.getStatus().isRecording) void recorder.stop();
      } catch {
        // already released
      }
      void endRecordingMode();
    },
    [recorder],
  );

  const toggleRecord = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (rec.isRecording) {
        await recorder.stop();
        const uri = recorder.uri;
        await endRecordingMode();
        if (uri) onAdd(await persistRecording(uri));
      } else {
        if (!(await ensureMicPermission())) {
          Alert.alert(t('species.micDenied'));
          return;
        }
        await beginRecordingMode();
        await recorder.prepareToRecordAsync();
        recorder.record();
      }
    } catch (e) {
      await endRecordingMode();
      Alert.alert(t('species.audioFailTitle'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={toggleRecord}
      disabled={busy}
      className={`mt-2 items-center justify-center rounded-lg border border-dashed ${
        rec.isRecording
          ? 'border-red-400 bg-red-50 dark:bg-red-900/30'
          : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-950 active:bg-gray-100 dark:active:bg-gray-700'
      }`}
      style={{ width: 88, height: 88 }}
    >
      <Ionicons name={rec.isRecording ? 'stop' : 'mic-outline'} size={24} color={rec.isRecording ? c.alert : c.ink2} />
      <Text className={`mt-1 text-xs ${rec.isRecording ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
        {rec.isRecording ? mmss(rec.durationMillis / 1000) : t('species.recordAudio')}
      </Text>
    </Pressable>
  );
}

/** Recorded clips, one row each. Renders nothing when there are none. */
/** `onRemove` left out: the clips play but are not removed (a locked record). */
export function AudioClipRows({ clips, onRemove }: { clips: string[]; onRemove?: (uri: string) => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [playingUri, setPlayingUri] = useState<string | null>(null);

  if (clips.length === 0) return null;

  const confirmRemove = (uri: string) => {
    if (!onRemove) return;
    Alert.alert(t('species.removeAudio'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => {
          if (playingUri === uri) setPlayingUri(null);
          onRemove(uri);
        },
      },
    ]);
  };

  return (
    <View className="mt-2">
      {clips.map((uri, i) => {
        const playing = playingUri === uri;
        return (
          <Pressable
            key={uri}
            onPress={() => setPlayingUri(playing ? null : uri)}
            onLongPress={() => confirmRemove(uri)}
            className="mb-1 flex-row items-center rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 active:bg-gray-50 dark:active:bg-gray-800"
          >
            <Ionicons name={playing ? 'stop-circle' : 'play-circle-outline'} size={22} color={c.accent} />
            <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">
              {t('species.audioClipN', { n: i + 1 })}
            </Text>
            {playing ? (
              <ClipProgress uri={uri} onFinished={() => setPlayingUri(null)} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Owns the player for exactly as long as one clip is playing.
 *
 * The player used to live in AudioClipRows and exist whether or not anything
 * was playing, with `useAudioPlayer(playing ? {…} : null)`. That crashed:
 * `useReleasingSharedObject` frees the native player when the source changes or
 * the component unmounts, while `useAudioPlayerStatus` reads `player.currentStatus`
 * — a native `getStatus` call — during render. Stop a clip or leave the screen
 * at the wrong moment and that read lands on a freed object:
 *
 *     FunctionCallException: Calling the 'getStatus' function has failed
 *     → NativeSharedObjectNotFoundException
 *
 * Mounting the player with the playback instead of around it means there is no
 * player to read when nothing is playing, and its lifetime is exactly this
 * component's. No guard needed, because the unsafe window no longer exists.
 */
function ClipProgress({ uri, onFinished }: { uri: string; onFinished: () => void }) {
  const player = useAudioPlayer({ uri: rebaseAppFileUri(uri) });
  const status = useAudioPlayerStatus(player);

  // Latest callback without making it an effect dependency — re-running on the
  // parent's every render would fire `onFinished` repeatedly while
  // `didJustFinish` stays true. Assigned in an effect, not during render:
  // mutating a ref while rendering is what makes React Compiler bail out of the
  // whole component.
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    player.play();
  }, [player]);

  useEffect(() => {
    if (status.didJustFinish) finishedRef.current();
  }, [status.didJustFinish]);

  return (
    <Text className="text-xs text-gray-500 dark:text-gray-400">
      {mmss(status.currentTime)} / {mmss(status.duration)}
    </Text>
  );
}

/** Without `onAdd` / `onRemove` (a locked record) the clips still play. */
export function AudioClipList({
  clips,
  onAdd,
  onRemove,
}: {
  clips: string[];
  onAdd?: (uri: string) => void;
  onRemove?: (uri: string) => void;
}) {
  return (
    <View>
      {onAdd ? <AudioRecordTile onAdd={onAdd} /> : null}
      <AudioClipRows clips={clips} onRemove={onRemove} />
    </View>
  );
}
