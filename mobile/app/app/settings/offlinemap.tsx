/**
 * Offline map settings.
 *
 * Two downloads, independent of each other:
 *
 * - **RudyMap** (466 MB): usable without downloading, since online mode reads
 *   the remote .pmtiles directly — which is why the button says "download for
 *   offline use" rather than "install map".
 * - **Mountain landmarks** (66 MB): unrelated to the basemap and shown over any
 *   of them, so it is not tied into the map's download flow.
 *
 * Replaces the old raster tile-package screen — that one needed 1.46 GB where
 * the vector edition needs a third of it, so there was no reason to keep both.
 */
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { SettingsPage } from '~/components/settings/SettingsPage';
import { formatBytes } from '~/lib/exportSize';
import { deletePoi } from '~/lib/poi';
import {
  cancelPoiInstall,
  refreshPoiInstalled,
  startPoiInstall,
  usePoiInstall,
} from '~/lib/poiInstall';
import { deleteVectorMap } from '~/lib/vectormap';
import {
  cancelVectorInstall,
  checkVectorRemote,
  refreshVectorInstalled,
  refreshVectorStyle,
  startVectorInstall,
  useVectorInstall,
  type VectorRemoteState,
} from '~/lib/vectormapInstall';

/** Before the map data is downloaded there is no manifest either, but the
 *  attribution should already be visible. */
const DEFAULT_ATTRIBUTION =
  '資料基於魯地圖 Taiwan TOPO・© OpenStreetMap 貢獻者（ODbL）・內政部 20 公尺網格 DTM';

export default function OfflineMapScreen() {
  const { t } = useTranslation();
  const [remote, setRemote] = useState<VectorRemoteState>({ kind: 'idle' });

  useEffect(() => {
    void checkVectorRemote().then((state) => {
      setRemote(state);
      // The style is only a few KB, so an unchanged version gets it refreshed in
      // passing — otherwise every styling change after install would mean asking for
  // 466 MB again. With no signal it simply fails quietly.
      if (state.kind === 'ready') void refreshVectorStyle(state.manifest);
    });
  }, []);

  const attribution =
    remote.kind === 'ready' ? remote.manifest.attribution : DEFAULT_ATTRIBUTION;

  return (
    <SettingsPage>
      <Stack.Screen options={{ title: t('offlinemap.title') }} />
      <ScrollView>
        <VectorSection remote={remote} />
        <PoiSection remote={remote} />

        <View className="mt-6 bg-card px-4 py-3 dark:bg-gray-900">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('offlinemap.sourceTitle')}
          </Text>
          <Text className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-400">
            {attribution}
          </Text>
        </View>
      </ScrollView>
    </SettingsPage>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-6 gap-3 bg-card px-4 py-3 dark:bg-gray-900">
      <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</Text>
      {children}
    </View>
  );
}

/** Label left, value right. Same layout as the raster-era screen. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between py-0.5">
      <Text className="text-sm text-gray-500 dark:text-gray-400">{label}</Text>
      <Text className="text-sm text-gray-900 dark:text-gray-100">{value}</Text>
    </View>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="items-center rounded-xl bg-emerald-600 px-4 py-3 active:bg-emerald-700"
    >
      <Text className="font-medium text-white">{label}</Text>
    </Pressable>
  );
}

function OutlineButton({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const border = danger
    ? 'border-red-300 active:bg-red-50 dark:border-red-800 dark:active:bg-red-950'
    : 'border-gray-300 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800';
  const text = danger
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-700 dark:text-gray-300';
  return (
    <Pressable onPress={onPress} className={`items-center rounded-xl border px-4 py-3 ${border}`}>
      <Text className={`font-medium ${text}`}>{label}</Text>
    </Pressable>
  );
}

function VectorSection({ remote }: { remote: VectorRemoteState }) {
  const { t } = useTranslation();
  const installed = useVectorInstall((s) => s.installed);
  const ready = useVectorInstall((s) => s.ready);
  const progress = useVectorInstall((s) => s.progress);
  const error = useVectorInstall((s) => s.error);

  const running = progress != null && progress.phase !== 'done';

  const status = () => {
    if (progress == null || progress.phase === 'done') return null;
    if (progress.phase === 'assets') {
      return t('vectormap.downloadingAssets', { done: progress.done, total: progress.total });
    }
    const key =
      progress.phase === 'hillshade'
        ? 'vectormap.downloadingHillshade'
        : 'vectormap.downloadingTiles';
    return t(key, {
      received: formatBytes(progress.receivedBytes),
      total: formatBytes(progress.totalBytes),
    });
  };

  const confirmRemove = () =>
    Alert.alert(
      t('vectormap.remove'),
      t('vectormap.removeConfirm', { size: formatBytes(installed?.bytes ?? 0) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('vectormap.remove'),
          style: 'destructive',
          onPress: () => {
            deleteVectorMap();
            refreshVectorInstalled();
          },
        },
      ],
    );

  // 沒裝的時候顯示遠端那份的版號與大小 —— 使用者要先知道會拿到什麼。
  const version = installed?.version ?? (remote.kind === 'ready' ? remote.manifest.version : null);
  const bytes = installed?.bytes ?? (remote.kind === 'ready' ? remote.manifest.bytes : null);
  // 圖磚換版只能整份重抓（樣式可以單獨更新，圖磚不行），所以要講清楚。
  const newVersion =
    ready && installed && remote.kind === 'ready' && installed.version !== remote.manifest.version
      ? remote.manifest.version
      : null;

  return (
    <Section title={t('vectormap.heading')}>
      <Text className="text-sm text-gray-700 dark:text-gray-300">
        {ready && installed
          ? t('vectormap.installedAt', {
              date: new Date(installed.installedAt).toLocaleDateString(),
            })
          : t('vectormap.notInstalled')}
      </Text>
      {/* 包一層，讓 Section 的 gap 作用在整組上而不是把兩列拉開。 */}
      <View>
        {version ? <Row label={t('vectormap.version')} value={version} /> : null}
        {bytes != null ? <Row label={t('vectormap.size')} value={formatBytes(bytes)} /> : null}
      </View>

      {running ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator />
          <Text className="text-sm text-gray-700 dark:text-gray-300">{status()}</Text>
        </View>
      ) : null}

      {error ? (
        <Text className="text-sm text-red-600 dark:text-red-400">
          {t('vectormap.error', { message: error })}
        </Text>
      ) : null}

      {newVersion ? (
        <Text className="text-sm text-amber-700 dark:text-amber-400">
          {t('vectormap.newVersion', { version: newVersion })}
        </Text>
      ) : null}

      {!running && (!ready || newVersion) && remote.kind === 'ready' ? (
        <PrimaryButton
          label={t(newVersion ? 'vectormap.update' : 'vectormap.download', {
            size: formatBytes(remote.manifest.bytes),
          })}
          onPress={() => void startVectorInstall(remote.manifest)}
        />
      ) : null}
      {running ? (
        <OutlineButton label={t('vectormap.cancel')} onPress={cancelVectorInstall} />
      ) : null}
      {!running && ready ? (
        <OutlineButton label={t('vectormap.remove')} onPress={confirmRemove} danger />
      ) : null}
      {!ready ? (
        <Text className="px-1 text-xs text-gray-500 dark:text-gray-400">
          {t('vectormap.onlineNote')}
        </Text>
      ) : null}
    </Section>
  );
}

function PoiSection({ remote }: { remote: VectorRemoteState }) {
  const { t } = useTranslation();
  const installed = usePoiInstall((s) => s.installed);
  const ready = usePoiInstall((s) => s.ready);
  const progress = usePoiInstall((s) => s.progress);
  const error = usePoiInstall((s) => s.error);

  const meta = remote.kind === 'ready' ? remote.manifest.poi : undefined;
  const running = progress != null && progress.phase !== 'done';

  const status = () => {
    if (progress == null || progress.phase === 'done') return null;
    if (progress.phase === 'extract') {
      return t('offlinemap.poiExtracting', {
        written: formatBytes(progress.writtenBytes),
        total: formatBytes(progress.totalBytes),
      });
    }
    return t('offlinemap.poiDownloading', {
      received: formatBytes(progress.receivedBytes),
      total: formatBytes(progress.totalBytes),
    });
  };

  const confirmRemove = () =>
    Alert.alert(
      t('offlinemap.poiRemove'),
      t('offlinemap.poiRemoveConfirm', { size: formatBytes(installed?.bytes ?? 0) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('offlinemap.poiRemove'),
          style: 'destructive',
          onPress: () => {
            deletePoi();
            refreshPoiInstalled();
          },
        },
      ],
    );

  return (
    <Section title={t('offlinemap.poiHeading')}>
      <Text className="text-xs leading-5 text-gray-600 dark:text-gray-400">
        {t('offlinemap.poiDescription', {
          count: (meta?.poiCount ?? installed?.poiCount ?? 0).toLocaleString(),
        })}
      </Text>
      <Text className="text-sm text-gray-700 dark:text-gray-300">
        {ready && installed
          ? t('offlinemap.poiInstalledAt', {
              date: new Date(installed.installedAt).toLocaleDateString(),
              count: installed.poiCount.toLocaleString(),
            })
          : t('offlinemap.poiNotInstalled')}
      </Text>

      {running ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator />
          <Text className="text-sm text-gray-700 dark:text-gray-300">{status()}</Text>
        </View>
      ) : null}

      {error ? (
        <Text className="text-sm text-red-600 dark:text-red-400">
          {t('offlinemap.poiError', { message: error })}
        </Text>
      ) : null}

      {!running && !ready && meta ? (
        <PrimaryButton
          label={t('offlinemap.poiDownload', { size: formatBytes(meta.bytes) })}
          onPress={() => void startPoiInstall(meta)}
        />
      ) : null}
      {running ? (
        <OutlineButton label={t('vectormap.cancel')} onPress={cancelPoiInstall} />
      ) : null}
      {!running && ready ? (
        <OutlineButton label={t('offlinemap.poiRemove')} onPress={confirmRemove} danger />
      ) : null}

      <Text className="px-1 text-xs text-gray-500 dark:text-gray-400">
        {t('offlinemap.wifiHint')}
      </Text>
    </Section>
  );
}
