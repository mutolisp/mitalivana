/**
 * First-run checklist download wizard.
 *
 * Checklists no longer ship with the app, so a fresh install (and an upgrade
 * that has just retired the legacy merged file) passes through a state with **no
 * checklist module at all**. Reaching the main screen then shows nothing but a
 * search box that finds nothing, so this gate goes in front and explains.
 *
 * **Keeping "later" is deliberate**: the first thing someone with a new phone
 * does is usually restore a backup, and they should not be forced to download
 * 34 MB first; without a checklist, recording, importing and restoring all still
 * work, and only species search does not. Skipping lasts for this launch only (a
 * module-level variable, never written to settings), so the next launch asks
 * again.
 *
 * Mounted inside `DBProvider` and outside `Stack`: the DB is certainly open by
 * then, and nothing has to touch the router, which avoids timing problems like
 * "navigate to a route that is not mounted yet".
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

/** "Later" was tapped this launch. Not persisted — the next launch asks
 *  again. */
let skippedThisLaunch = false;

export function DatasetSetupGate({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  // A finished install updates this store through the registry's change event,
  // and the gate opens by itself.
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
  // Only checklist modules are listed; the keys depend on the Taiwan checklist,
  // so they can be downloaded from the data-sources screen afterwards.
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
                        {/* The Taiwan checklist is this app's home ground, so it is the one to install
                            first */}
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
