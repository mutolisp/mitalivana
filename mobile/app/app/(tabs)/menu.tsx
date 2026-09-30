/**
 * The menu — the app's only settings surface (03-screens-flow.md §4c).
 *
 * Every row, and every subpage row the search can reach, comes from
 * src/lib/settingsIndex.ts; this screen only wires each id to its value and
 * handler. The grouped page and the search results are both built from that
 * list, so the two cannot drift apart.
 *
 * Grouped by what the row is for, not by which screen it used to live on:
 * day-to-day management first, set-once preferences after, destructive last.
 */
import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useNavigation, useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { LinkRow, Section, SelectRow, SwitchRow } from '~/components/settings/rows';
import { LANGUAGE_CATALOGUE } from '~/i18n';
import {
  SECTION_ORDER,
  SECTION_TITLE,
  SETTINGS_INDEX,
  parentOf,
  searchSettings,
  toneOf,
  type SettingsEntry,
} from '~/lib/settingsIndex';
import {
  useSettings,
  type Theme,
  type CardDensity,
  type IntermediateRanksMode,
  type FontScale,
  type RecordTypeDefault,
} from '~/stores/settings';
import { checkIntegrity, clearSearchHistory } from '~/db';
import { clearAllData } from '~/lib/clearAllData';
import { useDriveState } from '~/lib/driveState';
import { usePoiInstall } from '~/lib/poiInstall';
import { useVectorInstall } from '~/lib/vectormapInstall';
import { useHasDatasetUpdate } from '~/lib/datasetUpdateCheck';
import { useToast } from '~/stores/toast';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';
import { useActiveSession } from '~/stores/activeSession';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useThemeColors } from '~/theme/colors';

export default function MenuScreen() {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  const hasDatasetUpdate = useHasDatasetUpdate();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const toast = useToast((s) => s.show);

  // Per-field selectors, not the whole store: this is a tab, so it stays
  // mounted for the session and a whole-store subscription would re-render it
  // on every settings write from anywhere in the app.
  const language = useSettings((s) => s.language);
  const theme = useSettings((s) => s.theme);
  const vernacularLangs = useSettings((s) => s.vernacular_langs);
  const cardDensity = useSettings((s) => s.card_density);
  const intermediateRanks = useSettings((s) => s.taxonomy_intermediate_ranks);
  const fontScale = useSettings((s) => s.font_scale);
  const undoDuration = useSettings((s) => s.undo_duration);
  const recordTypeDefault = useSettings((s) => s.record_type_default);
  const gpsSession = useSettings((s) => s.record_gps_session);
  const gpsPlot = useSettings((s) => s.record_gps_plot);
  const trackAccuracy = useSettings((s) => s.track_accuracy);
  const usageRank = useSettings((s) => s.search_usage_rank);
  const moduleGloria = useSettings((s) => s.module_gloria);
  const moduleMiren = useSettings((s) => s.module_miren);
  const fabSide = useSettings((s) => s.fab_side);
  const inatLogin = useSettings((s) => s.inat_login);
  const vectorReady = useVectorInstall((x) => x.ready);
  const poiReady = usePoiInstall((x) => x.ready);
  const gdriveAccount = useSettings((s) => s.gdrive_account);
  const lastUploadAtMs = useDriveState((s) => s.lastUploadAtMs);
  const loadDriveState = useDriveState((s) => s.load);
  useEffect(() => {
    void loadDriveState();
  }, [loadDriveState]);
  const setSetting = useSettings((s) => s.set);
  const reloadSettings = useSettings((s) => s.load);

  const themeOptions: Array<{ value: Theme; label: string }> = [
    { value: 'auto', label: t('settings.themeAuto') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];
  const undoOptions = [5, 8, 10];
  const densityOptions: Array<{ value: CardDensity; label: string }> = [
    { value: 'compact', label: t('settings.densityCompact') },
    { value: 'comfortable', label: t('settings.densityComfortable') },
  ];
  const intermediateOptions: Array<{ value: IntermediateRanksMode; label: string }> = [
    { value: 'below_order', label: t('settings.intermediateBelowOrder') },
    { value: 'all', label: t('settings.intermediateAll') },
  ];
  const fontScaleOptions: Array<{ value: FontScale; label: string }> = [
    { value: 'small', label: t('settings.fontSmall') },
    { value: 'normal', label: t('settings.fontNormal') },
    { value: 'large', label: t('settings.fontLarge') },
    { value: 'xlarge', label: t('settings.fontXLarge') },
  ];
  const recordTypeOptions: Array<{ value: RecordTypeDefault; label: string }> = [
    { value: 'ask', label: t('settings.createAsk') },
    { value: 'session', label: t('record.kindSession') },
    { value: 'plot', label: t('record.kindPlot') },
    { value: 'collection', label: t('record.kindCollection') },
  ];

  // Endonym, matching how the language screen lists them.
  const languageLabel =
    language === 'system'
      ? t('settings.languageSystem')
      : (LANGUAGE_CATALOGUE.find((l) => l.value === language)?.native ?? language);

  /** Read-only inventory. Duplicate occurrence_ids are deliberately not cleaned
   *  up automatically — those are published DwC identifiers, and re-issuing them
   *  would no longer match the files already delivered, so this only reports the
   *  number and lets the user decide. */
  const handleCheckIntegrity = () => {
    try {
      const r = checkIntegrity();
      const lines: string[] = [];
      for (const d of r.duplicateOccurrenceIds) {
        lines.push(t('settings.integrityDup', {
            table: d.table,
            groups: t('settings.nDupGroups', { count: d.groups }),
            rows: t('settings.nRows', { count: d.rows }),
          }));
      }
      for (const o of r.orphanRows) lines.push(t('settings.integrityOrphan', { table: o.table, count: o.n }));
      for (const d of r.danglingProjectIds) {
        lines.push(t('settings.integrityProject', { table: d.table, count: d.n }));
      }
      for (const a of r.staleAdoptedNames) {
        lines.push(t('settings.integrityAdopted', { table: a.table, count: a.n }));
      }
      if (r.fkViolations > 0) lines.push(t('settings.integrityFk', { count: r.fkViolations }));
      Alert.alert(
        t('settings.integrityTitle'),
        lines.length === 0 ? t('settings.integrityClean') : lines.join('\n'),
        [{ text: t('common.ok') }],
      );
    } catch (e) {
      toast(t('settings.integrityFailed', { error: errText(e) }));
    }
  };

  const handleClearHistory = () => {
    Alert.alert(t('settings.clearHistoryConfirmTitle'), t('settings.clearHistoryConfirmMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.clear'),
        style: 'destructive',
        onPress: () => {
          clearSearchHistory();
          toast(t('settings.historyCleared'));
        },
      },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert(
      t('settings.clearAllConfirmTitle'),
      t('settings.clearAllConfirmMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.confirm'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(t('settings.clearAllConfirm2Title'), t('settings.clearAllConfirm2Msg'), [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('common.clear'),
                style: 'destructive',
                onPress: async () => {
                  try {
                    // user.db, and everything else this phone keeps for the
                    // user: secrets, media folders, local backups (clearAllData.ts).
                    await clearAllData();
                    reloadSettings();
                    // Both active records, not just the session: the whole DB
                    // file is gone, so a live plot survey would otherwise leave
                    // ActiveSessionBar pointing at a plot that no longer exists.
                    useActiveSession.getState().refresh();
                    useActivePlot.getState().refresh();
                    useActiveGloria.getState().refresh();
                    useActiveMiren.getState().refresh();
                    toast(t('settings.allCleared'));
                    router.replace('/');
                  } catch (e) {
                    toast(t('settings.clearFailed', { error: errText(e) }));
                  }
                },
              },
            ]);
          },
        },
      ],
    );
  };

  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const scrollRef = useRef<ScrollView>(null);
  // Switching tabs clears the search, so coming back shows the groups. Opening
  // a result's subpage does not: back should return to the same results. On
  // a tab switch the tab navigator itself stays focused; under a pushed
  // screen it does not.
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener('blur', () => {
        if (navigation.getParent()?.isFocused()) setQuery('');
      }),
    [navigation],
  );
  // Entering or leaving search starts the list from the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [searching]);

  const visible = (e: SettingsEntry) =>
    e.visibleWhen === 'module_gloria' ? moduleGloria : e.visibleWhen === 'module_miren' ? moduleMiren : true;

  // A key missing in this locale must not match: t() would return the key
  // itself, and `settingsSearch.theme` contains "theme".
  const translate = (key: string) => (i18n.exists(key) ? t(key) : '');
  const hits = searching ? searchSettings(query, translate, visible) : [];

  const sectionTitle = (e: SettingsEntry) => {
    const k = SECTION_TITLE[e.section];
    return k ? t(k) : '';
  };
  /** 「調查 › 標本採集」 for a subpage row, the group name for the rest. */
  const crumbOf = (e: SettingsEntry) => {
    const parent = parentOf(e);
    return [sectionTitle(e), parent ? t(parent.labelKey) : ''].filter(Boolean).join(' › ') || undefined;
  };

  /** Values and subtitles that depend on live state rather than a fixed key. */
  const offlineMapValue =
    // The two sets of data are independent, so the state is "both / one missing / neither".
    vectorReady && poiReady
      ? t('offlinemap.statusBoth')
      : vectorReady
        ? t('vectormap.heading')
        : poiReady
          ? t('offlinemap.poiHeading')
          : t('vectormap.notInstalled');
  const navLive: Record<string, { description?: string; value?: string; badge?: boolean }> = {
    backup: lastUploadAtMs
      ? { description: t('gdrive.lastUpload', { date: new Date(lastUploadAtMs).toLocaleDateString() }) }
      : {},
    regionPacks: { badge: hasDatasetUpdate },
    offlineMap: { value: offlineMapValue },
    inaturalist: inatLogin ? { description: t('settings.inaturalistLinked', { login: inatLogin }) } : {},
    gdrive: gdriveAccount ? { description: t('settings.gdriveLinked', { email: gdriveAccount }) } : {},
    // Its own screen, not a dropdown: a popover has no room for the
    // `English · en` sublabel and no search box, and both are what a user
    // stranded in an unreadable script needs.
    language: { value: languageLabel },
    vernacular: {
      value: vernacularLangs.map((l) => t(l === 'ja' ? 'vernacular.jaShort' : 'vernacular.zhTWShort')).join(' / '),
    },
  };
  const actions: Record<string, () => void> = {
    integrity: handleCheckIntegrity,
    clearHistory: handleClearHistory,
    clearAll: handleClearAll,
  };
  const switches: Record<string, { value: boolean; onChange: (v: boolean) => void }> = {
    gpsSession: { value: gpsSession, onChange: (v) => setSetting('record_gps_session', v) },
    gpsPlot: { value: gpsPlot, onChange: (v) => setSetting('record_gps_plot', v) },
    usageRank: { value: usageRank, onChange: (v) => setSetting('search_usage_rank', v) },
    moduleGloria: { value: moduleGloria, onChange: (v) => setSetting('module_gloria', v) },
    moduleMiren: { value: moduleMiren, onChange: (v) => setSetting('module_miren', v) },
  };

  const renderEntry = (e: SettingsEntry, search: boolean) => {
    const decor = {
      icon: e.icon,
      tone: toneOf(e),
      crumb: search ? crumbOf(e) : undefined,
      highlight: search ? query : undefined,
    };
    const label = t(e.labelKey);
    const description = e.descKey ? t(e.descKey) : undefined;

    if (e.kind === 'switch') {
      const sw = switches[e.id];
      return <SwitchRow key={e.id} label={label} description={description} value={sw.value} onChange={sw.onChange} {...decor} />;
    }
    if (e.kind === 'select') {
      const common = { label, description, ...decor };
      switch (e.id) {
        case 'defaultCreate':
          return (
            <SelectRow
              key={e.id} {...common}
              value={recordTypeDefault}
              options={recordTypeOptions}
              onChange={(v) => setSetting('record_type_default', v)}
            />
          );
        case 'trackAccuracy':
          return (
            <SelectRow
              key={e.id} {...common}
              value={trackAccuracy}
              options={[
                { value: 'high' as const, label: t('settings.trackAccuracyHigh') },
                { value: 'medium' as const, label: t('settings.trackAccuracyMedium') },
                { value: 'low' as const, label: t('settings.trackAccuracyLow') },
              ]}
              onChange={(v) => setSetting('track_accuracy', v)}
            />
          );
        case 'intermediateRanks':
          return (
            <SelectRow
              key={e.id} {...common}
              value={intermediateRanks}
              options={intermediateOptions}
              onChange={(v) => setSetting('taxonomy_intermediate_ranks', v)}
            />
          );
        case 'theme':
          return <SelectRow key={e.id} {...common} value={theme} options={themeOptions} onChange={(v) => setSetting('theme', v)} />;
        case 'fontSize':
          return (
            <SelectRow key={e.id} {...common} value={fontScale} options={fontScaleOptions} onChange={(v) => setSetting('font_scale', v)} />
          );
        case 'cardDensity':
          return (
            <SelectRow key={e.id} {...common} value={cardDensity} options={densityOptions} onChange={(v) => setSetting('card_density', v)} />
          );
        case 'fabSide':
          // Under Appearance rather than Surveying: it changes where the +
          // button lives, which is a reach/handedness preference.
          return (
            <SelectRow
              key={e.id} {...common}
              value={fabSide}
              options={[
                { value: 'right' as const, label: t('settings.fabSideRight') },
                { value: 'left' as const, label: t('settings.fabSideLeft') },
              ]}
              onChange={(v) => setSetting('fab_side', v)}
            />
          );
        case 'undoDuration':
          return (
            <SelectRow
              key={e.id} {...common}
              value={undoDuration}
              options={undoOptions.map((s) => ({ value: s, label: t('settings.undoSeconds', { count: s }) }))}
              onChange={(v) => setSetting('undo_duration', v)}
            />
          );
        default:
          return null;
      }
    }
    if (e.kind === 'action') {
      return (
        <LinkRow
          key={e.id}
          label={label}
          description={description}
          destructive={e.id === 'clearAll'}
          chevron={false}
          onPress={actions[e.id]}
          {...decor}
        />
      );
    }
    const live = navLive[e.id] ?? {};
    return (
      <LinkRow
        key={e.id}
        label={label}
        description={live.description ?? description}
        value={live.value}
        badge={live.badge}
        badgeLabel={t('settings.updateTag')}
        onPress={() => router.push((e.focus ? `${e.route}?focus=${e.focus}` : e.route) as Href)}
        {...decor}
      />
    );
  };

  const version = Constants.expoConfig?.version;

  return (
    <View className="flex-1 bg-gray-50 dark:bg-gray-950">
      <View className="border-b border-gray-200 bg-card px-4 py-4 dark:border-gray-700 dark:bg-gray-900">
        <Text numberOfLines={1} className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          {t('tab.menu')}
        </Text>
      </View>

      {/* Same field as the records tab's; the border turns accent while typing. */}
      <View
        className={`mx-4 mt-3 flex-row items-center rounded-full border bg-card px-4 dark:bg-card-dark ${
          query ? 'border-accent dark:border-accent-400' : 'border-line dark:border-line-dark'
        }`}
        style={{ minHeight: 44 }}
      >
        <Ionicons name="search" size={18} color={c.ink3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('settings.searchPlaceholder')}
          placeholderTextColor={c.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('settings.search')}
          className="ml-2 flex-1 py-2 text-base text-gray-900 dark:text-gray-100"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={12} accessibilityLabel={t('common.clear')}>
            <Ionicons name="close-circle" size={18} color={c.ink3} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: tabBarInset + 24 }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {searching ? (
          hits.length > 0 ? (
            // One flat card, label hits first; switches and selects work here
            // directly, subpage rows open their page at the row.
            <Section title={t('settings.searchCount', { count: hits.length })}>
              {hits.map((h) => renderEntry(h.entry, true))}
            </Section>
          ) : (
            <View className="items-center px-8 pt-16">
              <Ionicons name="search" size={32} color={c.ink3} />
              <Text className="mt-3 text-center text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('settings.searchEmpty', { q: query.trim() })}
              </Text>
              <Text className="mt-1 text-center text-sm text-gray-500 dark:text-gray-400">
                {t('settings.searchEmptyHint')}
              </Text>
            </View>
          )
        ) : (
          <>
            {SECTION_ORDER.map((sec) => {
              const rows = SETTINGS_INDEX.filter((e) => e.section === sec && !e.focus && visible(e));
              const title = SECTION_TITLE[sec];
              return (
                <Section key={sec} title={title ? t(title) : undefined}>
                  {rows.map((e) => renderEntry(e, false))}
                </Section>
              );
            })}
            {version ? (
              <Text className="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">v{version}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
