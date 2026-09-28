/**
 * Country checklist pack management screen.
 *
 * A pack = one country's GBIF SPECIES_LIST download (optionally narrowed to
 * taxon groups), imported into regionpacks.db so that country's species are
 * searchable offline. Creation needs the user's own (free) GBIF account for
 * exactly one call — the download request; polling and the file itself are
 * public, so an interrupted download resumes without the password.
 *
 * Taiwan is blocked here (the bundled TaiCOL checklist IS the Taiwan list),
 * and Japan-with-only-plants is redirected to the bundled YList overlay.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  FlatList,
  Linking,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Switch } from '~/components/ui/Switch';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { promptText } from '~/components/TextPromptModal';
import { SwipeRow } from '~/components/SwipeRow';
import { ApiError } from '~/lib/apiFetch';
import { COUNTRIES, countryName, type Country } from '~/lib/countries';
import {
  clearGbifCredentials,
  loadGbifCredentials,
  saveGbifCredentials,
  type GbifCredentials,
} from '~/lib/gbifCredentials';
import {
  drivePack,
  isPackRunning,
  requestSpeciesListDownload,
  usePackDownloads,
} from '~/lib/gbifDownload';
import { ICONIC_TAXA, type IconicTaxon } from '~/lib/inat';
import { useSettings, type RegionCode } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import {
  createPack,
  deletePack,
  invalidatePackCache,
  listPacks,
  updatePack,
  type RegionPack,
} from '~/db/regionpacks';
import { allSpecs, type DatasetId } from '~/db';
import { clearTaxonomyCache } from '~/db';
import {
  cancelDatasetInstall,
  fetchDatasetManifest,
  hasUpdate,
  isDatasetInstallRunning,
  missingRequirements,
  previewDatasetRemoval,
  removeDatasetSafely,
  startDatasetInstall,
  useDatasetInstall,
  useInstalledDatasets,
  type DatasetManifestEntry,
} from '~/lib/datasetInstall';
import { formatBytes } from '~/lib/exportSize';
import { clearSearchResultCache } from '~/components/SearchBox';
import { ACTION_FILL } from '~/lib/colors';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';

export default function RegionPacksScreen() {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const toast = useToast((s) => s.show);
  const settings = useSettings();
  const [packs, setPacks] = useState<RegionPack[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Live progress comes from the module-level driver (survives navigation);
  // subscribing here is what re-renders the rows while a download runs.
  const progress = usePackDownloads((st) => st.progress);

  // ── Checklist modules (download / update / delete) ─────────────────────
  // Install state subscribes to the registry's snapshot store, so finishing a
  // download or a delete repaints immediately.
  const installs = useInstalledDatasets((st) => st.installs);
  const dsActive = useDatasetInstall((st) => st.activeId);
  const dsProgress = useDatasetInstall((st) => st.progress);
  const dsError = useDatasetInstall((st) => st.error);
  const [remote, setRemote] = useState<DatasetManifestEntry[]>([]);
  const [remoteState, setRemoteState] = useState<'idle' | 'loading' | 'failed' | 'stale-app'>(
    'idle',
  );

  const refreshRemote = useCallback(async () => {
    setRemoteState('loading');
    try {
      const { entries, needsAppUpdate } = await fetchDatasetManifest();
      setRemote(entries);
      setRemoteState(needsAppUpdate ? 'stale-app' : 'idle');
    } catch {
      // Being offline is normal (this is a field app): fall back quietly to the
      // installed list.
      setRemoteState('failed');
    }
  }, []);
  useEffect(() => {
    void refreshRemote();
  }, [refreshRemote]);

  const reload = useCallback(() => {
    try {
      setPacks(listPacks());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[regionpacks] list failed:', e);
    }
  }, []);
  useFocusEffect(useCallback(() => reload(), [reload]));
  // A pack finishing (or failing) removes its progress key — refresh the DB
  // rows so status/species-count update without leaving the screen.
  const runningCount = Object.keys(progress).length;
  useEffect(() => reload(), [runningCount, reload]);

  // ── Unified region rows: built-in TW / JP + downloaded packs ──
  const enabledRegions = useSettings((st) => st.enabled_regions);
  const setSetting = useSettings((st) => st.set);
  /** Everything that toggles dataset scope invalidates the same caches. */
  const afterScopeChange = useCallback(() => {
    clearTaxonomyCache();
    clearSearchResultCache();
  }, []);
  // "Keep at least one source" — a checklist module only counts when it is
  // **installed and enabled** (ticking TW without downloading it is not a
  // queryable source), plus any ready pack. The DB layer still allows any
  // combination; this rule exists in the UI alone.
  const installedRegionCodes = installs
    .map((rec) => allSpecs().find((sp) => sp.id === rec.id)?.region)
    .filter((r): r is RegionCode => r === 'TW' || r === 'JP');
  const enabledSourceCount =
    enabledRegions.filter((r) => installedRegionCodes.includes(r)).length +
    packs.filter((pk) => pk.enabled && pk.status === 'ready').length;
  const toggleBuiltin = useCallback(
    (code: RegionCode, on: boolean) => {
      const next: RegionCode[] = on
        ? code === 'TW'
          ? ['TW', ...enabledRegions.filter((r) => r !== 'TW')]
          : [...enabledRegions.filter((r) => r !== 'JP'), 'JP']
        : enabledRegions.filter((r) => r !== code);
      setSetting('enabled_regions', next);
      afterScopeChange();
    },
    [afterScopeChange, enabledRegions, setSetting],
  );
  type RegionRow = { kind: 'dataset'; id: DatasetId } | { kind: 'pack'; pack: RegionPack };
  const rows: RegionRow[] = [
    ...allSpecs().map((spec) => ({ kind: 'dataset' as const, id: spec.id })),
    ...packs.map((pack) => ({ kind: 'pack' as const, pack })),
  ];

  /**
   * Filter box over the installed list.
   *
   * Only once the list is long enough to be worth scanning — three checklist
   * modules and one country do not need a search box above them, and an empty
   * one on a settings page is just noise. The threshold is the three modules
   * plus a handful of packs.
   */
  const [filter, setFilter] = useState('');
  const searchable = rows.length >= 8;

  /**
   * Saved credentials first (opt-in file, never inside user.db backups), else
   * prompt. The GBIF API authenticates with the USERNAME only — the website
   * accepts email, the API does not (techdocs, api-downloads) — so an '@' in
   * the input gets an explanation and a fresh prompt instead of a confusing
   * 401 later.
   */
  const obtainCredentials = useCallback(
    async (
      forcePrompt: boolean,
    ): Promise<{ creds: GbifCredentials; fromStore: boolean } | null> => {
      if (!forcePrompt) {
        const stored = await loadGbifCredentials();
        if (stored) return { creds: stored, fromStore: true };
      }
      let defaultName = settings.gbif_username;
      for (;;) {
        const username = (
          await promptText({
            title: t('regionPacks.gbifUserTitle'),
            message: t('regionPacks.gbifUserMsg'),
            defaultValue: defaultName,
            autoCapitalize: 'none',
          })
        )?.trim();
        if (!username) return null;
        if (username.includes('@')) {
          defaultName = username;
          await new Promise<void>((resolve) =>
            // Wait out the prompt Modal's dismissal before the Alert presents.
            setTimeout(
              () =>
                Alert.alert(
                  t('regionPacks.emailNotAllowedTitle'),
                  t('regionPacks.emailNotAllowedMsg'),
                  [{ text: t('common.confirm'), onPress: () => resolve() }],
                ),
              450,
            ),
          );
          await new Promise<void>((r) => setTimeout(r, 450));
          continue;
        }
        const password = await promptText({
          title: t('regionPacks.gbifPassTitle'),
          message: t('regionPacks.gbifPassMsg'),
          autoCapitalize: 'none',
          secureTextEntry: true,
        });
        if (!password) return null;
        return { creds: { username, password }, fromStore: false };
      }
    },
    [settings, t],
  );

  /** After a request that proved the credentials work, offer to keep them. */
  const offerSavePassword = useCallback(
    (creds: GbifCredentials) => {
      setTimeout(
        () =>
          Alert.alert(t('regionPacks.savePwTitle'), t('regionPacks.savePwMsg'), [
            { text: t('regionPacks.savePwNo'), style: 'cancel' },
            { text: t('regionPacks.savePwYes'), onPress: () => void saveGbifCredentials(creds) },
          ]),
        450,
      );
    },
    [t],
  );

  /**
   * (Re)submit the download request for a pack. Shared by create and the
   * retry button on failed packs — a failed pack keeps its country/groups, so
   * retrying never re-walks the pickers.
   */
  const submitRequest = useCallback(
    async (pack: RegionPack, forcePrompt = false) => {
      const got = await obtainCredentials(forcePrompt);
      if (!got) return;
      settings.set('gbif_username', got.creds.username);
      // Completion email (optional): GBIF mails when the file is ready — the
      // only channel that works while the app is backgrounded. Skipped when
      // saved credentials + a saved email already cover it; cancel keeps the
      // stored value instead of aborting the whole request.
      let notifyEmail = settings.gbif_notify_email;
      if (!got.fromStore || !notifyEmail) {
        const entered = await promptText({
          title: t('regionPacks.notifyEmailTitle'),
          message: t('regionPacks.notifyEmailMsg'),
          defaultValue: notifyEmail,
          keyboardType: 'email-address',
          autoCapitalize: 'none',
          allowEmpty: true,
        });
        if (entered != null) {
          notifyEmail = entered.trim();
          settings.set('gbif_notify_email', notifyEmail);
        }
      }
      try {
        const key = await requestSpeciesListDownload(
          pack.country_code,
          pack.groups as IconicTaxon[],
          got.creds.username,
          got.creds.password,
          notifyEmail || undefined,
        );
        updatePack(pack.id, { gbif_download_key: key, status: 'requested', error: null });
        reload();
        toast(t('regionPacks.requested'));
        if (!got.fromStore) offerSavePassword(got.creds);
        drivePack(pack.id);
      } catch (e) {
        const is401 = e instanceof ApiError && e.status === 401;
        if (is401) void clearGbifCredentials(); // stale saved password must not loop forever
        const msg = is401
          ? t('regionPacks.badCredentials')
          : e instanceof ApiError && e.detail
            ? `${e.message}: ${e.detail}`
            : String((e as Error)?.message ?? e);
        updatePack(pack.id, { status: 'failed', error: msg });
        reload();
        setTimeout(() => Alert.alert(t('regionPacks.requestFailed'), msg), 450);
      }
    },
    [obtainCredentials, offerSavePassword, reload, settings, t, toast],
  );

  const startCreate = useCallback(
    async (country: Country, groups: IconicTaxon[]) => {
      const pack = createPack(country.code, groups);
      reload();
      await submitRequest(pack);
    },
    [reload, submitRequest],
  );

  const handlePicked = useCallback(
    (country: Country) => {
      setPickerOpen(false);
      // iOS refuses to present a Modal/Alert while the previous Modal is still
      // dismissing — it silently never shows. Same 450 ms wait the export
      // share-sheet path uses.
      setTimeout(() => {
        if (country.code === 'TW') {
          Alert.alert(t('regionPacks.builtinTitle'), t('regionPacks.builtinTaiwan'));
          return;
        }
        openGroupChooser(country);
      }, 450);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // ── Group chooser modal state ──
  const [groupCountry, setGroupCountry] = useState<Country | null>(null);
  const [chosenGroups, setChosenGroups] = useState<Set<IconicTaxon>>(new Set());
  const openGroupChooser = (country: Country) => {
    setChosenGroups(new Set());
    setGroupCountry(country);
  };
  const confirmGroups = () => {
    const country = groupCountry;
    if (!country) return;
    const groups = [...chosenGroups];
    if (country.code === 'JP' && groups.length === 1 && groups[0] === 'Plantae') {
      Alert.alert(t('regionPacks.builtinTitle'), t('regionPacks.builtinJapanPlants'));
      return;
    }
    setGroupCountry(null);
    // Wait out this Modal's dismissal before the TextPromptHost Modal presents.
    setTimeout(() => void startCreate(country, groups), 450);
  };

  const handleDelete = (pack: RegionPack) => {
    Alert.alert(
      t('regionPacks.deleteTitle'),
      t('regionPacks.deleteMsg', { name: countryName(pack.country_code, i18n.language) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deletePack(pack.id);
            invalidatePackCache();
            reload();
          },
        },
      ],
    );
  };

  const statusLine = (pack: RegionPack): string => {
    const p = progress[pack.id];
    if (p) {
      if (p.phase === 'waiting') {
        // GBIF's status API has no percentage during PREPARING/RUNNING;
        // elapsed time is the only real progress signal there is.
        const min = Math.floor(p.elapsedMs / 60000);
        const elapsed =
          min >= 1
            ? t('regionPacks.elapsedMin', { n: min })
            : t('regionPacks.elapsedSec', { n: Math.max(1, Math.round(p.elapsedMs / 1000)) });
        return t('regionPacks.waiting', { status: p.gbifStatus, elapsed });
      }
      if (p.phase === 'downloading') {
        const mb = (p.receivedBytes / 1048576).toFixed(1);
        return p.totalBytes
          ? t('regionPacks.downloadingPct', {
              pct: Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)),
              mb,
            })
          : t('regionPacks.downloadingMb', { mb });
      }
      if (p.phase === 'importing')
        return t('regionPacks.importing', { done: p.done, total: p.total });
    }
    switch (pack.status) {
      case 'ready':
        return t('regionPacks.readyCount', { count: pack.species_count ?? 0 });
      case 'failed':
        return `${t('regionPacks.failed')}${pack.error ? `：${pack.error}` : ''}`;
      case 'importing':
      case 'running':
      case 'requested':
        return t('regionPacks.pending');
    }
  };

  const groupLabels = (pack: RegionPack): string =>
    pack.groups.length === 0
      ? t('regionPacks.allGroups')
      : pack.groups.map((g) => t(`areaSpecies.iconic.${g}`)).join('、');

  /** 模組名稱：優先用 manifest 的在地化標題，離線時退回內建字串。 */
  const datasetName = (id: DatasetId): string => {
    const entry = remote.find((e) => e.id === id);
    const fromManifest = entry?.title?.[i18n.language] ?? entry?.title?.['zh-TW'];
    if (fromManifest) return fromManifest;
    if (id === 'tw-taicol') return t('regionPacks.builtinTwName');
    if (id === 'jp-ylist') return t('regionPacks.builtinJpName');
    return t('datasets.keysName');
  };

  const needle = searchable ? filter.trim().toLowerCase() : '';
  const visibleRows = needle
    ? rows.filter((r) =>
        r.kind === 'dataset'
          ? datasetName(r.id).toLowerCase().includes(needle)
          : // Country name in the current language, plus the ISO code, which is
            // what someone who knows it will type.
            countryName(r.pack.country_code, i18n.language).toLowerCase().includes(needle) ||
            r.pack.country_code.toLowerCase().includes(needle),
      )
    : rows;

  const handleDatasetRemove = (id: DatasetId) => {
    // 先把記錄用到的名稱抄進 user.db（必須在檔案還在時做），再讓使用者確認。
    const impact = previewDatasetRemoval(id);
    const name = datasetName(id);
    Alert.alert(
      t('datasets.removeTitle', { name }),
      impact.missing > 0
        ? t('datasets.removeMsg', { cached: impact.cached, missing: impact.missing })
        : t('datasets.removeMsgClean', { cached: impact.cached }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            removeDatasetSafely(id);
            afterScopeChange();
            toast(t('datasets.removed', { name }));
          },
        },
      ],
    );
  };

  const renderDataset = (id: DatasetId) => {
    const spec = allSpecs().find((sp) => sp.id === id);
    if (!spec) return null;
    const rec = installs.find((r) => r.id === id) ?? null;
    const entry = remote.find((e) => e.id === id) ?? null;
    const busy = dsActive === id;
    const updatable = entry !== null && rec !== null && hasUpdate(entry);
    const blockedBy = entry ? missingRequirements(entry) : [];
    const code = spec.region;
    const on = code ? enabledRegions.includes(code) : false;
    // 只有「已安裝且已啟用」的模組才算來源，所以最後一個來源不能被關掉。
    const isLast = !!code && on && rec !== null && enabledSourceCount <= 1;

    const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
    let statusLine: string;
    if (busy && dsProgress?.phase === 'download') {
      statusLine = t('datasets.downloading', {
        percent: pct(dsProgress.receivedBytes, dsProgress.totalBytes),
      });
    } else if (busy && dsProgress?.phase === 'extract') {
      statusLine = t('datasets.extracting', {
        percent: pct(dsProgress.writtenBytes, dsProgress.totalBytes),
      });
    } else if (busy) {
      statusLine = t('datasets.installing');
    } else if (rec) {
      statusLine = t('datasets.installed', {
        version: rec.version.replace(/^legacy:.*/, t('regionPacks.builtinTag')),
        size: formatBytes(rec.bytes),
      });
    } else if (blockedBy.length > 0) {
      statusLine = t('datasets.needsRequirement', { name: datasetName(blockedBy[0]) });
    } else {
      statusLine = t('datasets.notInstalled');
    }

    const actionLabel = updatable
      ? t('datasets.update', { size: formatBytes(entry?.bytes ?? 0) })
      : t('datasets.download', { size: formatBytes(entry?.bytes ?? 0) });
    const canAct = entry !== null && !busy && !isDatasetInstallRunning() && blockedBy.length === 0;

    const body = (
      <View className="border-b border-gray-100 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <View className="flex-row items-center">
          <View className="flex-1 pr-3">
            <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
              {datasetName(id)}
              {updatable ? (
                <Text className="text-xs text-accent-600 dark:text-accent-400">
                  {' '}
                  {t('datasets.updateAvailable')}
                </Text>
              ) : null}
            </Text>
            <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{statusLine}</Text>
          </View>
          {/* 區域開關只對有 region 的名錄模組有意義；檢索表跟著臺灣名錄走。 */}
          {code ? (
            <Switch
              value={on}
              disabled={isLast || rec === null}
              onValueChange={(v) => {
                if (!v && isLast) return;
                toggleBuiltin(code, v);
              }}
            />
          ) : null}
        </View>

        {busy && dsProgress ? (
          <View className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <View
              className="h-1.5 rounded-full bg-accent-500"
              style={{
                width: `${
                  dsProgress.phase === 'download'
                    ? pct(dsProgress.receivedBytes, dsProgress.totalBytes)
                    : dsProgress.phase === 'extract'
                      ? pct(dsProgress.writtenBytes, dsProgress.totalBytes)
                      : 100
                }%`,
              }}
            />
          </View>
        ) : null}

        {/* Delete moved onto the swipe (below), so this row is only ever the
            download / update / cancel action — and disappears entirely when
            there is none, rather than leaving an empty strip. */}
        {busy || ((rec === null || updatable) && canAct) ? (
          <View className="mt-2 flex-row items-center gap-3">
            {busy ? (
              <Pressable onPress={cancelDatasetInstall} hitSlop={8}>
                <Text className="text-sm text-gray-600 dark:text-gray-400">
                  {t('common.cancel')}
                </Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => void startDatasetInstall(entry!)} hitSlop={8}>
                <Text className="text-sm font-medium text-accent-600 dark:text-accent-400">
                  {actionLabel}
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}
        {busy === false && dsError && dsActive === null && rec === null ? (
          <Text className="mt-1 text-xs text-red-600 dark:text-red-400">
            {dsError === 'no-space'
              ? t('datasets.errorNoSpace')
              : t('datasets.errorFailed', { error: dsError })}
          </Text>
        ) : null}
      </View>
    );

    // Only a module that is actually on the device, and not mid-install, can be
    // swiped away: a swipe that reveals a delete for a file that is not there,
    // or is being written at that moment, is worse than no swipe at all.
    return rec !== null && !busy ? (
      <SwipeRow onDelete={() => handleDatasetRemove(id)} label={t('common.delete')}>
        {body}
      </SwipeRow>
    ) : (
      body
    );
  };

  const renderPack = ({ item }: { item: RegionPack }) => {
    const busy = isPackRunning(item.id);
    // A live key means the queued download can simply be polled again; a
    // failed or key-less pack needs a fresh request (with credentials).
    const resumable =
      !busy &&
      item.status !== 'ready' &&
      item.status !== 'failed' &&
      item.gbif_download_key != null;
    const retryable = !busy && item.status !== 'ready' && !resumable;
    return (
      <SwipeRow onDelete={() => handleDelete(item)} label={t('common.delete')}>
        <Pressable
          // Re-fetch + re-import from the SAME download key (the file stays on
          // GBIF's servers) — the rescue path for a pack whose import went
          // wrong, without re-queueing a new request.
          onLongPress={
            !busy && item.gbif_download_key
              ? () =>
                  Alert.alert(t('regionPacks.reimportTitle'), t('regionPacks.reimportMsg'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('regionPacks.reimportGo'), onPress: () => drivePack(item.id) },
                  ])
              : undefined
          }
          delayLongPress={350}
          className="border-b border-gray-100 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900"
        >
          <View className="flex-row items-center">
            <View className="flex-1">
              <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
                {countryName(item.country_code, i18n.language)}
                <Text className="text-xs text-gray-400"> {item.country_code}</Text>
              </Text>
              <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {groupLabels(item)}
              </Text>
              <Text
                className={`mt-0.5 text-xs ${item.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
                numberOfLines={2}
              >
                {statusLine(item)}
              </Text>
            </View>
            {item.status === 'ready' ? (
              <Switch
                value={item.enabled}
                onValueChange={(on) => {
                  updatePack(item.id, { enabled: on });
                  invalidatePackCache();
                  afterScopeChange();
                  reload();
                }}
                disabled={item.enabled && enabledSourceCount <= 1}
              />
            ) : resumable ? (
              <Pressable
                onPress={() => drivePack(item.id)}
                hitSlop={8}
                className={`rounded-full px-3 py-1.5 ${ACTION_FILL}`}
                accessibilityLabel={t('regionPacks.resume')}
              >
                <Text className="text-xs font-medium text-white">{t('regionPacks.resume')}</Text>
              </Pressable>
            ) : retryable ? (
              <Pressable
                onPress={() => void submitRequest(item)}
                hitSlop={8}
                className="rounded-full bg-orange-500 px-3 py-1.5 active:bg-orange-600"
                accessibilityLabel={t('regionPacks.retry')}
              >
                <Text className="text-xs font-medium text-white">{t('regionPacks.retry')}</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </SwipeRow>
    );
  };

  return (
    <SettingsPage>
      {/* Above the FlatList, not in its header: the point of a filter is that it
          is still there after you have scrolled past what you were looking for. */}
      {searchable ? (
        <View className="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
          <View className="flex-row items-center rounded-full bg-gray-100 px-3 py-2 dark:bg-gray-800">
            <Ionicons name="search" size={16} color={c.ink2} />
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder={t('regionPacks.filterPlaceholder')}
              placeholderTextColor={c.ink3}
              autoCapitalize="none"
              autoCorrect={false}
              className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100"
            />
            {filter ? (
              <Pressable onPress={() => setFilter('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={c.ink3} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      <FlatList
        data={visibleRows}
        // The filter box sits above the list, so without this a tap on a row
        // while the keyboard is up is swallowed by dismissing the keyboard.
        keyboardShouldPersistTaps="handled"
        keyExtractor={(r) => (r.kind === 'dataset' ? `dataset-${r.id}` : `pack-${r.pack.id}`)}
        renderItem={({ item }) =>
          item.kind === 'dataset' ? renderDataset(item.id) : renderPack({ item: item.pack })
        }
        ListEmptyComponent={
          needle ? (
            <Text className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('regionPacks.filterEmpty', { q: filter.trim() })}
            </Text>
          ) : null
        }
        ListHeaderComponent={
          <View className="px-4 py-3">
            {/* 名錄模組的狀態列：檢查中 / 抓不到清單（離線是常態）/ 需要更新 app */}
            <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('datasets.section')}
            </Text>
            <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('datasets.offlineHint')}
            </Text>
            {remoteState === 'loading' ? (
              <Text className="mt-1 text-xs text-gray-400">{t('datasets.checking')}</Text>
            ) : remoteState === 'failed' ? (
              <Text className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('datasets.checkFailed')}
              </Text>
            ) : remoteState === 'stale-app' ? (
              <Text className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('datasets.needsAppUpdate')}
              </Text>
            ) : null}
            <Text className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t('regionPacks.intro')}
              <Text
                // Nested-Text link: opens GBIF's login/register page in the
                // browser for users without an account yet.
                onPress={() => void Linking.openURL('https://www.gbif.org/user/profile')}
                className="text-accent-600 dark:text-accent-400"
              >
                {t('regionPacks.introRegister')}
              </Text>
              {t('regionPacks.introEnd')}
            </Text>
            <Pressable
              onPress={() => void Linking.openURL('https://www.gbif.org/user/download')}
              hitSlop={6}
              className="mt-2 flex-row items-center"
              accessibilityRole="link"
            >
              <Ionicons name="open-outline" size={14} color={c.accent} />
              <Text className="ml-1 text-xs text-accent-600 dark:text-accent-400">
                {t('regionPacks.openGbifWeb')}
              </Text>
            </Pressable>
          </View>
        }
      />
      <View className="px-4 pb-2 pt-2">
        <Button label={t('regionPacks.add')} onPress={() => setPickerOpen(true)} size="lg" fullWidth />
      </View>

      <CountryPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePicked}
      />
      <GroupChooserModal
        country={groupCountry}
        chosen={chosenGroups}
        onToggle={(g) =>
          setChosenGroups((prev) => {
            const next = new Set(prev);
            if (next.has(g)) next.delete(g);
            else next.add(g);
            return next;
          })
        }
        onCancel={() => setGroupCountry(null)}
        onConfirm={confirmGroups}
      />
    </SettingsPage>
  );
}

function CountryPickerModal({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (c: Country) => void;
}) {
  const tc = useThemeColors();
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const zh = i18n.language.startsWith('zh');
  const data = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...COUNTRIES].sort((a, b) =>
      (zh ? a.zh : a.en).localeCompare(zh ? b.zh : b.en, i18n.language),
    );
    if (!needle) return all;
    return all.filter(
      (c) =>
        c.zh.toLowerCase().includes(needle) ||
        c.en.toLowerCase().includes(needle) ||
        c.code.toLowerCase() === needle,
    );
  }, [q, zh, i18n.language]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ paddingTop: insets.top }} className="flex-1 bg-card dark:bg-gray-900">
        <View className="flex-row items-center border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <Text className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('regionPacks.pickCountry')}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel={t('common.cancel')}>
            <Ionicons name="close" size={22} color={tc.ink2} />
          </Pressable>
        </View>
        <View className="px-4 py-2">
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('regionPacks.searchCountry')}
            placeholderTextColor={tc.ink3}
            autoCapitalize="none"
            className="rounded-lg border border-gray-300 bg-card px-3 py-2.5 text-base text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </View>
        <FlatList
          data={data}
          keyExtractor={(c) => c.code}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPick(item)}
              className="flex-row items-center border-b border-gray-100 px-4 py-3 active:bg-accent-50 dark:border-gray-800 dark:active:bg-accent-900/40"
            >
              <Text className="flex-1 text-base text-gray-900 dark:text-gray-100">
                {zh ? item.zh : item.en}
              </Text>
              <Text className="text-xs text-gray-400">{item.code}</Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

function GroupChooserModal({
  country,
  chosen,
  onToggle,
  onCancel,
  onConfirm,
}: {
  country: Country | null;
  chosen: Set<IconicTaxon>;
  onToggle: (g: IconicTaxon) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const coarse = chosen.has('Reptilia') || chosen.has('Actinopterygii');
  return (
    <Modal visible={country != null} animationType="slide" onRequestClose={onCancel}>
      <View style={{ paddingTop: insets.top }} className="flex-1 bg-card dark:bg-gray-900">
        <View className="flex-row items-center border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <Text className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {country ? countryName(country.code, i18n.language) : ''}
          </Text>
          <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel={t('common.cancel')}>
            <Ionicons name="close" size={22} color={c.ink2} />
          </Pressable>
        </View>
        <View className="px-4 py-3">
          <Text className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
            {t('areaSpecies.groups')}
          </Text>
          <Text className="mb-2 text-xs text-gray-500 dark:text-gray-400">
            {t('regionPacks.groupsHint')}
          </Text>
          <View className="mb-2 flex-row flex-wrap gap-2">
            {ICONIC_TAXA.map((k) => {
              const on = chosen.has(k);
              return (
                <Pressable
                  key={k}
                  onPress={() => onToggle(k)}
                  className={`rounded-full border px-3 py-1.5 ${
                    on
                      ? 'border-accent-500 bg-accent-500'
                      : 'border-gray-300 bg-card dark:border-gray-600 dark:bg-gray-800'
                  }`}
                >
                  <Text
                    className={`text-xs ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    {t(`areaSpecies.iconic.${k}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {coarse ? (
            <Text className="mb-2 text-xs text-amber-700 dark:text-amber-400">
              {t('areaSpecies.gbifCoarseGroup')}
            </Text>
          ) : null}
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('regionPacks.qualityNote')}
          </Text>
        </View>
        <View className="mt-auto px-4 pb-4" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          <Button label={t('regionPacks.startDownload')} onPress={onConfirm} size="lg" fullWidth />
        </View>
      </View>
    </Modal>
  );
}
