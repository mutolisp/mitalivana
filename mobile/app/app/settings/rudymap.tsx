/**
 * 離線地圖（魯地圖）—— 下載、續傳、刪除。
 *
 * 下載迴圈住在 `src/lib/rudymapInstall.ts` 的 module-level store，不在這個畫面裡：
 * 幾 GB 的下載跑十幾分鐘，使用者早就離開了。這裡只負責訂閱與按鈕。
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { SettingsPage } from '~/components/settings/SettingsPage';
import {
  deleteRudyPack,
  installedBytes,
  rudyAttribution,
  type RudyInstalled,
} from '~/lib/rudymap';
import {
  cancelRudyInstall,
  formatBytes,
  refreshRudyInstalled,
  startRudyInstall,
  useRudyInstall,
  type RudyProgress,
} from '~/lib/rudymapInstall';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between px-4 py-2">
      <Text className="text-sm text-gray-500 dark:text-gray-400">{label}</Text>
      <Text className="text-sm text-gray-900 dark:text-gray-100">{value}</Text>
    </View>
  );
}

export default function RudyMapScreen() {
  const { t, i18n } = useTranslation();
  const progress = useRudyInstall((s) => s.progress);
  const installed = useRudyInstall((s) => s.installed);
  const ready = useRudyInstall((s) => s.ready);

  const running = progress != null;
  const manifest = installed?.manifest;
  const totalBytes = manifest?.totalBytes ?? 0;
  const haveBytes = installedBytes(installed);

  const confirmRemove = () => {
    Alert.alert(
      t('rudymap.remove'),
      t('rudymap.removeConfirm', { size: formatBytes(totalBytes) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('rudymap.remove'),
          style: 'destructive',
          onPress: () => {
            deleteRudyPack();
            refreshRudyInstalled();
          },
        },
      ],
    );
  };

  return (
    <SettingsPage title={t('rudymap.title')}>
      <ScrollView contentContainerClassName="pb-8">
        <View className="mt-3 bg-white px-4 py-3 dark:bg-gray-900">
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('rudymap.heading')}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-gray-600 dark:text-gray-400">
            {t('rudymap.description')}
          </Text>
        </View>

        <View className="mt-3 bg-white dark:bg-gray-900">
          <Row label={t('rudymap.title')} value={statusText(t, installed, ready)} />
          {manifest ? (
            <>
              <Row label={t('rudymap.version', { version: '' }).trim()} value={manifest.packVersion} />
              <Row
                label={t('rudymap.downloadSize', { size: '' }).trim()}
                value={
                  ready
                    ? formatBytes(totalBytes)
                    : `${formatBytes(haveBytes)} / ${formatBytes(totalBytes)}`
                }
              />
            </>
          ) : null}
        </View>

        {running ? (
          <View className="mt-3 flex-row items-center gap-3 bg-white px-4 py-3 dark:bg-gray-900">
            <ActivityIndicator />
            <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">
              {progressText(t, progress)}
            </Text>
          </View>
        ) : null}

        <View className="mt-4 gap-3 px-4">
          {running ? (
            <Pressable
              onPress={cancelRudyInstall}
              className="items-center rounded-xl bg-gray-200 px-4 py-3 active:bg-gray-300 dark:bg-gray-800"
            >
              <Text className="font-medium text-gray-900 dark:text-gray-100">
                {t('rudymap.cancel')}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={startRudyInstall}
              className="flex-row items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 active:bg-emerald-700"
            >
              <Ionicons name="cloud-download-outline" size={18} color="#fff" />
              <Text className="font-medium text-white">
                {installed && !ready ? t('rudymap.resume') : t('rudymap.download')}
              </Text>
            </Pressable>
          )}

          {!running && installed ? (
            <Pressable
              onPress={confirmRemove}
              className="items-center rounded-xl border border-red-300 px-4 py-3 active:bg-red-50 dark:border-red-800 dark:active:bg-red-950"
            >
              <Text className="font-medium text-red-600 dark:text-red-400">
                {t('rudymap.remove')}
              </Text>
            </Pressable>
          ) : null}

          {!running && !ready ? (
            <Text className="px-1 text-xs text-gray-500 dark:text-gray-400">
              {t('rudymap.wifiHint')}
            </Text>
          ) : null}
        </View>

        <View className="mt-6 bg-white px-4 py-3 dark:bg-gray-900">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('rudymap.sourceTitle')}
          </Text>
          <Text className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-400">
            {rudyAttribution(installed, i18n.language) || DEFAULT_ATTRIBUTION}
          </Text>
        </View>
      </ScrollView>
    </SettingsPage>
  );
}

/** 圖磚包還沒下載時 manifest 也還沒有，但版權標示該先看得到。 */
const DEFAULT_ATTRIBUTION =
  '© OpenStreetMap 貢獻者（ODbL）・魯地圖 Taiwan TOPO・內政部 20 公尺網格 DTM・JAXA AW3D30';

function statusText(
  t: (k: string, o?: Record<string, unknown>) => string,
  installed: RudyInstalled | null,
  ready: boolean,
): string {
  if (!installed) return t('rudymap.notInstalled');
  if (!ready) {
    return t('rudymap.incomplete', {
      done: installed.doneChunks.length,
      total: installed.manifest.chunks.length,
    });
  }
  return t('rudymap.installedAt', {
    date: new Date(installed.installedAt).toLocaleDateString(),
  });
}

function progressText(
  t: (k: string, o?: Record<string, unknown>) => string,
  p: RudyProgress,
): string {
  switch (p.phase) {
    case 'manifest':
      return t('rudymap.progressManifest');
    case 'downloading':
      return t('rudymap.progressDownloading', {
        chunk: p.chunk + 1,
        count: p.chunkCount,
        received: formatBytes(p.receivedBytes),
        total: p.totalBytes != null ? formatBytes(p.totalBytes) : '—',
      });
    case 'verifying':
      return t('rudymap.progressVerifying', { chunk: p.chunk + 1, count: p.chunkCount });
    case 'extracting':
      return t('rudymap.progressExtracting', {
        chunk: p.chunk + 1,
        count: p.chunkCount,
        done: p.done,
        total: p.total,
      });
    case 'cleanup':
      return t('rudymap.progressCleanup');
  }
}
