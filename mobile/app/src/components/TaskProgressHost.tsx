/**
 * The panel for a long operation the person waits for (stores/taskProgress.ts):
 * the step, a bar and count when the work can be counted, and a native
 * spinner that keeps turning while the JS thread is busy. It covers the app
 * and takes the touches and the Android back button, since the data is being
 * changed underneath; the screen stays awake (a locked phone suspends the app).
 *
 * A plain overlay, not a Modal: the import asks a question (ActionSheet)
 * between its steps, and iOS will not present over a Modal. Mounted after
 * SyncProgressHost and before ToastHost, so a toast still shows above it.
 */
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, BackHandler, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { formatBytes } from '~/lib/exportSize';
import { useTaskProgress } from '~/stores/taskProgress';
import { useThemeColors } from '~/theme/colors';

function Hold() {
  useKeepAwake('task-progress');
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);
  return null;
}

export function TaskProgressHost() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const p = useTaskProgress((s) => s.current);
  if (!p) return null;
  const counted = p.total != null && p.total > 0 && p.done != null;
  const ratio = counted ? Math.min(1, p.done! / p.total!) : null;
  const count = counted ? (p.bytes ? `${formatBytes(p.done!)} / ${formatBytes(p.total!)}` : `${p.done} / ${p.total}`) : null;

  return (
    <Animated.View entering={FadeIn.duration(150)} className="absolute inset-0 items-center justify-center bg-black/40 px-10" accessibilityViewIsModal>
      <Hold />
      <View className="w-full max-w-xs items-center rounded-2xl bg-card px-6 py-6 dark:bg-card-dark" accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color={c.accent} />
        <Text className="mt-4 text-center text-base font-medium text-ink dark:text-gray-100">{p.label ?? t(p.key, p.params)}</Text>
        {ratio != null ? (
          <>
            <View className="mt-4 h-2 w-full overflow-hidden rounded-full bg-line dark:bg-line-dark">
              <View className="h-2 rounded-full bg-accent-600 dark:bg-accent-400" style={{ width: `${Math.round(ratio * 100)}%` }} />
            </View>
            <Text style={{ fontVariant: ['tabular-nums'] }} className="mt-2 text-center text-xs text-ink-3 dark:text-gray-400">
              {count}
            </Text>
          </>
        ) : null}
        <Text className="mt-3 text-center text-xs text-ink-3 dark:text-gray-400">{t('task.keepOpen')}</Text>
      </View>
    </Animated.View>
  );
}
