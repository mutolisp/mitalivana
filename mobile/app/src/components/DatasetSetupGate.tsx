/**
 * 首次啟動的名錄下載精靈。
 *
 * 名錄不再隨 app 出貨，所以全新安裝（以及剛把舊合併檔退場的升級）會有一段「一個
 * 名錄模組都沒有」的狀態。這時進主畫面只會看到一個搜不到任何東西的搜尋框，所以
 * 先擋在前面把事情講清楚。
 *
 * **保留「稍後再說」是刻意的**：剛換手機的人第一件事往往是還原備份，不該被強迫
 * 先下載 34 MB；沒有名錄時記錄、匯入、還原都還能用，只有物種搜尋不行。跳過只存
 * 在這次啟動（module-level 變數，不寫進 settings），下次開 app 還是會問。
 *
 * 掛在 `DBProvider` 之內、`Stack` 之外：DB 一定已經開好，而且不必碰 router，
 * 避免「導向一個還沒掛載的路由」那類時序問題。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hasAnyNamesDataset } from '~/db';
import {
  fetchDatasetManifest,
  startDatasetInstall,
  useDatasetInstall,
  useInstalledDatasets,
  type DatasetManifestEntry,
} from '~/lib/datasetInstall';
import { formatBytes } from '~/lib/exportSize';

/** 這次啟動已經按過「稍後再說」。不持久化——下次啟動仍然會問。 */
let skippedThisLaunch = false;

export function DatasetSetupGate({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  // 安裝完成會透過 registry 的變更事件更新這個 store，門就自己讓開。
  const installs = useInstalledDatasets((s) => s.installs);
  const [skipped, setSkipped] = useState(skippedThisLaunch);
  const [entries, setEntries] = useState<DatasetManifestEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const activeId = useDatasetInstall((s) => s.activeId);
  const progress = useDatasetInstall((s) => s.progress);
  const installError = useDatasetInstall((s) => s.error);

  const blocked = installs.length === 0 && !hasAnyNamesDataset() && !skipped;

  useEffect(() => {
    if (!blocked || entries !== null) return;
    let alive = true;
    void (async () => {
      try {
        const { entries: list } = await fetchDatasetManifest();
        if (alive) setEntries(list);
      } catch {
        if (alive) setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [blocked, entries]);

  if (!blocked) return <>{children}</>;

  const titleOf = (e: DatasetManifestEntry) =>
    e.title?.[i18n.language] ?? e.title?.['zh-TW'] ?? e.id;
  // 只列名錄模組；檢索表相依臺灣名錄，裝完名錄後再從「資料來源」頁下載即可。
  const offered = (entries ?? []).filter((e) => e.region !== null);
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

  const retry = () => {
    setLoadError(false);
    setEntries(null);
  };

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900">
      <ScrollView contentContainerClassName="grow justify-center px-6 py-10">
        <Text className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          {t('datasets.setupTitle')}
        </Text>
        <Text className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
          {t('datasets.setupIntro')}
        </Text>
        <Text className="mt-1 text-xs text-gray-500 dark:text-gray-500">
          {t('datasets.setupNeedNetwork')}
        </Text>

        <View className="mt-6">
          {loadError ? (
            <View>
              <Text className="text-sm text-amber-700 dark:text-amber-400">
                {t('datasets.setupOffline')}
              </Text>
              <Pressable onPress={retry} className="mt-3 self-start" hitSlop={8}>
                <Text className="text-base font-medium text-blue-600 dark:text-blue-400">
                  {t('datasets.setupRetry')}
                </Text>
              </Pressable>
            </View>
          ) : entries === null ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator />
              <Text className="text-sm text-gray-500 dark:text-gray-400">
                {t('datasets.checking')}
              </Text>
            </View>
          ) : (
            offered.map((e) => {
              const busy = activeId === e.id;
              return (
                <View
                  key={e.id}
                  className="mb-3 rounded-2xl border border-gray-200 px-4 py-3 dark:border-gray-700"
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {titleOf(e)}
                        {/* 臺灣名錄是這個 app 的主場，預設就該先裝它 */}
                        {e.region === 'TW' ? (
                          <Text className="text-xs text-gray-400">
                            {' '}
                            {t('datasets.setupRecommended')}
                          </Text>
                        ) : null}
                      </Text>
                      <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {busy && progress?.phase === 'download'
                          ? t('datasets.downloading', {
                              percent: pct(progress.receivedBytes, progress.totalBytes),
                            })
                          : busy && progress?.phase === 'extract'
                            ? t('datasets.extracting', {
                                percent: pct(progress.writtenBytes, progress.totalBytes),
                              })
                            : busy
                              ? t('datasets.installing')
                              : `${formatBytes(e.bytes)}`}
                      </Text>
                    </View>
                    {busy ? (
                      <ActivityIndicator />
                    ) : (
                      <Pressable
                        onPress={() => void startDatasetInstall(e)}
                        disabled={activeId !== null}
                        hitSlop={8}
                        className="rounded-full bg-blue-600 px-4 py-2 active:bg-blue-700"
                      >
                        <Text className="text-sm font-medium text-white">
                          {t('datasets.setupStart')}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {busy && progress ? (
                    <View className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                      <View
                        className="h-1.5 rounded-full bg-blue-500"
                        style={{
                          width: `${
                            progress.phase === 'download'
                              ? pct(progress.receivedBytes, progress.totalBytes)
                              : progress.phase === 'extract'
                                ? pct(progress.writtenBytes, progress.totalBytes)
                                : 100
                          }%`,
                        }}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
          {installError ? (
            <Text className="mt-1 text-xs text-red-600 dark:text-red-400">
              {installError === 'no-space'
                ? t('datasets.errorNoSpace')
                : t('datasets.errorFailed', { error: installError })}
            </Text>
          ) : null}
        </View>

        <View className="mt-8">
          <Pressable
            onPress={() => {
              skippedThisLaunch = true;
              setSkipped(true);
            }}
            hitSlop={8}
            disabled={activeId !== null}
          >
            <Text className="text-base text-gray-600 dark:text-gray-400">
              {t('datasets.setupLater')}
            </Text>
          </Pressable>
          <Text className="mt-1 text-xs text-gray-500 dark:text-gray-500">
            {t('datasets.setupLaterHint')}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
