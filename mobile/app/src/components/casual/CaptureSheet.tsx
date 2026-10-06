/**
 * 記一筆觀察 — casual mode's ＋ (design 18d): photograph, record, pick from
 * the library, or only a name. Whichever it is, 這是什麼？ (app/observe.tsx)
 * comes next with the time and place filled in.
 *
 * Recording happens here, in the sheet (a second page). The camera and the
 * library are system screens: the sheet closes first and they open once it
 * has gone, as in the 建立新記錄 sheet (iOS will not present over a Modal
 * that is still leaving).
 */
import { Ionicons } from '@expo/vector-icons';
import { RecordingPresets, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';

import { showActionSheet } from '~/components/ActionSheet';
import { ChoiceSheetFrame, ChoiceSheetHeader, DISMISS_MS } from '~/components/ChoiceSheet';
import {
  beginRecordingMode,
  endRecordingMode,
  ensureMicPermission,
  persistRecording,
} from '~/lib/audioCapture';
import i18n from '~/i18n';
import { useCaptureSheet } from '~/lib/captureSheet';
import { errText } from '~/lib/errText';
import { draftFromPhotos, draftNow, startObserve } from '~/lib/observeDraft';
import { pickPhotosWithExif, takePhotoWithExif } from '~/lib/photoCapture';
import { useThemeColors } from '~/theme/colors';

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function fromCamera(): Promise<void> {
  const photos = await takePhotoWithExif();
  if (photos.length) startObserve([await draftFromPhotos(photos, true)]);
}

async function fromLibrary(): Promise<void> {
  const t = i18n.t;
  let photos;
  try {
    photos = await pickPhotosWithExif();
  } catch (e) {
    Alert.alert(t('casual.libraryFail'), errText(e));
    return;
  }
  if (photos.length === 0) return;
  if (photos.length === 1) {
    startObserve([await draftFromPhotos(photos)]);
    return;
  }
  // Several: one observation each, or one species in all of them.
  const idx = await showActionSheet({
    title: t('casual.manyPhotosTitle', { count: photos.length }),
    options: [
      { label: t('casual.eachPhoto', { count: photos.length }), icon: 'images-outline' },
      { label: t('casual.onePhotoSet'), icon: 'albums-outline' },
    ],
    cancelLabel: t('common.cancel'),
  });
  if (idx < 0) return;
  startObserve(
    idx === 0
      ? await Promise.all(photos.map((p) => draftFromPhotos([p])))
      : [await draftFromPhotos(photos)],
  );
}

export function CaptureSheetHost() {
  const open = useCaptureSheet((s) => s.open);
  const setOpen = useCaptureSheet((s) => s.setOpen);
  const [page, setPage] = useState<'choose' | 'record'>('choose');

  useEffect(() => {
    if (open) setPage('choose');
  }, [open]);

  // Closing on the recording page unmounts it, which drops the take.
  const close = () => setOpen(false);

  const choose = (run: () => unknown) => {
    setOpen(false);
    setTimeout(() => void run(), DISMISS_MS);
  };

  const startRecording = async () => {
    if (!(await ensureMicPermission())) {
      Alert.alert(i18n.t('species.micDenied'));
      return;
    }
    setPage('record');
  };

  return (
    <ChoiceSheetFrame
      visible={open}
      onBack={page === 'record' ? () => setPage('choose') : close}
      onClose={close}
    >
      {page === 'choose' ? (
        <ChoosePage
          onClose={close}
          onCamera={() => choose(fromCamera)}
          onRecord={() => void startRecording()}
          onLibrary={() => choose(fromLibrary)}
          onNameOnly={() => choose(() => startObserve([draftNow()]))}
        />
      ) : (
        <RecordPage
          onDiscard={() => setPage('choose')}
          onKept={(uri) => choose(() => startObserve([draftNow({ audio: [uri] })]))}
          onClose={close}
        />
      )}
    </ChoiceSheetFrame>
  );
}

function ChoosePage({
  onClose,
  onCamera,
  onRecord,
  onLibrary,
  onNameOnly,
}: {
  onClose: () => void;
  onCamera: () => void;
  onRecord: () => void;
  onLibrary: () => void;
  onNameOnly: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <View className="px-4 pb-4 pt-2">
      <ChoiceSheetHeader title={t('casual.captureTitle')} onClose={onClose} />
      <View className="flex-row gap-2.5">
        <Pressable
          onPress={onCamera}
          accessibilityRole="button"
          className="flex-1 items-center justify-center gap-2.5 rounded-2xl bg-accent-600 active:bg-accent-700 dark:bg-accent-400"
          style={{ height: 136 }}
        >
          <Ionicons name="camera-outline" size={40} color={c.onAccent} />
          <Text className="text-lg font-bold text-white dark:text-gray-950">
            {t('casual.takePhoto')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onRecord}
          accessibilityRole="button"
          className="flex-1 items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-accent-600 bg-accent-tint active:bg-accent-100 dark:border-accent-400 dark:bg-accent-950/40"
          style={{ height: 136 }}
        >
          <Ionicons name="mic-outline" size={40} color={c.accent} />
          <Text className="text-lg font-bold text-accent-700 dark:text-accent-300">
            {t('casual.record')}
          </Text>
        </Pressable>
      </View>
      <View className="mt-3 overflow-hidden rounded-2xl border border-line dark:border-line-dark">
        <ChoiceRow
          icon="images-outline"
          title={t('casual.fromLibrary')}
          desc={t('casual.fromLibraryDesc')}
          onPress={onLibrary}
        />
        <View className="h-px bg-disc dark:bg-gray-800" />
        <ChoiceRow
          icon="search-outline"
          title={t('casual.nameOnly')}
          desc={t('casual.nameOnlyDesc')}
          onPress={onNameOnly}
        />
      </View>
      <Text className="mt-3 text-center text-[13px] text-gray-500 dark:text-gray-400">
        {t('casual.autoTimePlace')}
      </Text>
    </View>
  );
}

function ChoiceRow({
  icon,
  title,
  desc,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  desc: string;
  onPress: () => void;
}) {
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 bg-card px-3.5 active:bg-gray-100 dark:bg-card-dark dark:active:bg-gray-800"
      style={{ minHeight: 56 }}
    >
      <Ionicons name={icon} size={22} color={c.ink2} />
      <View className="flex-1 py-2">
        <Text className="text-base font-medium text-gray-900 dark:text-gray-100">{title}</Text>
        <Text className="text-[13px] text-gray-500 dark:text-gray-400">{desc}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The recording page. It owns the recorder, which exists only while this page
 * is up: recording starts when it mounts, and leaving it any way but 停止並加入
 * (捨棄, ✕, Android back, the dim) drops the take, as the record sheets' tile
 * does.
 */
function RecordPage({
  onDiscard,
  onKept,
  onClose,
}: {
  onDiscard: () => void;
  onKept: (uri: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const busy = useRef(false);
  const kept = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await beginRecordingMode();
        await recorder.prepareToRecordAsync();
        if (!cancelled) recorder.record();
      } catch (e) {
        await endRecordingMode();
        Alert.alert(i18n.t('species.audioFailTitle'), errText(e));
        onDiscard();
      }
    })();
    return () => {
      cancelled = true;
      if (kept.current) return;
      try {
        if (recorder.getStatus().isRecording) void recorder.stop();
      } catch {
        // already released
      }
      void endRecordingMode();
    };
    // Once per page: the recorder is this page's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  const keep = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      await endRecordingMode();
      kept.current = true;
      if (uri) onKept(await persistRecording(uri));
      else onClose();
    } catch (e) {
      Alert.alert(i18n.t('species.audioFailTitle'), errText(e));
    } finally {
      busy.current = false;
    }
  };

  return (
    <View className="px-4 pb-4 pt-2">
      <ChoiceSheetHeader title={t('casual.record')} onClose={onClose} />
      <View className="items-center gap-3 rounded-2xl border border-accent-100 bg-accent-tint px-4 py-5 dark:border-accent-900 dark:bg-accent-950/40">
        <View className="flex-row items-center gap-2">
          <View className="h-2.5 w-2.5 rounded-full bg-alert dark:bg-alert-dark" />
          <Text className="text-sm font-bold text-alert dark:text-alert-dark">
            {t('casual.recording')}
          </Text>
        </View>
        {/* Sized here: the app's type scale stops at 3xl. */}
        <Text
          className="font-bold text-gray-900 dark:text-gray-100"
          style={{ fontSize: 44, lineHeight: 52, fontVariant: ['tabular-nums'] }}
        >
          {mmss(rec.durationMillis)}
        </Text>
        <Text className="text-[13px] text-gray-600 dark:text-gray-400">
          {t('casual.recordHint')}
        </Text>
      </View>
      <View className="mt-3 flex-row gap-2.5">
        <Pressable
          onPress={onDiscard}
          accessibilityRole="button"
          className="flex-1 items-center justify-center rounded-full border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
          style={{ height: 52 }}
        >
          <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
            {t('casual.discard')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void keep()}
          accessibilityRole="button"
          className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-accent-600 active:bg-accent-700 dark:bg-accent-400"
          style={{ height: 52 }}
        >
          <Ionicons name="stop" size={14} color={c.onAccent} />
          <Text className="text-base font-bold text-white dark:text-gray-950">
            {t('casual.stopAndAdd')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
