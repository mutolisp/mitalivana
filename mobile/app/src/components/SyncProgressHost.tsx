/**
 * The team-sync progress strip, on every screen while a sync runs
 * (stores/syncProgress.ts): which record, and while files move, which file and
 * how many bytes, with a bar. Touches pass through it, so the user can keep
 * working; the screen is kept awake while it shows, because an upload stops
 * when the phone locks (the app is suspended). Rendered before ToastHost, so a
 * toast still wins.
 */
import { useKeepAwake } from 'expo-keep-awake';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes } from '~/lib/exportSize';
import { useSyncProgress } from '~/stores/syncProgress';

function KeepAwake() {
  useKeepAwake('team-sync');
  return null;
}

export function SyncProgressHost() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const p = useSyncProgress((s) => s.current);
  if (!p) return null;

  const record = p.record ?? t('teamSync.progress.unnamed');
  const head =
    p.recordIndex != null && p.recordCount != null
      ? t('teamSync.progress.batch', { i: p.recordIndex, n: p.recordCount, name: record })
      : t('teamSync.progress.one', { name: record });
  const files = p.stage !== 'record' && p.fileCount != null;
  const line = files
    ? t(p.stage === 'upload' ? 'teamSync.progress.upload' : 'teamSync.progress.download', {
        i: p.fileIndex ?? 0,
        n: p.fileCount ?? 0,
        done: formatBytes(p.bytesDone),
        total: formatBytes(p.bytesTotal),
      })
    : null;
  const ratio = files && p.bytesTotal > 0 ? Math.min(1, p.bytesDone / p.bytesTotal) : null;

  return (
    <View pointerEvents="none" className="absolute inset-x-0 top-0" style={{ paddingTop: insets.top }}>
      <KeepAwake />
      <View className="mx-4 mt-2 gap-1 rounded-lg bg-[#00797b] px-3 py-2 shadow-lg" accessibilityLiveRegion="polite">
        <Text className="text-xs font-semibold text-white" numberOfLines={1}>
          {head}
        </Text>
        {line ? (
          <Text className="text-[11px] text-white/90" numberOfLines={1}>
            {line}
          </Text>
        ) : null}
        {ratio != null ? (
          <View className="h-1 overflow-hidden rounded-full bg-white/30">
            <View className="h-1 rounded-full bg-white" style={{ width: `${Math.round(ratio * 100)}%` }} />
          </View>
        ) : null}
        {files ? <Text className="text-[10px] text-white/80">{t('teamSync.progress.keepOpen')}</Text> : null}
      </View>
    </View>
  );
}
