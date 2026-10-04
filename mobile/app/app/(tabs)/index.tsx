import { Ionicons } from '@expo/vector-icons';
import { assertNever } from '~/lib/assertNever';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  LayoutAnimation,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { PillButton } from '~/components/PillButton';
import {
  clearRecordDiversityCache,
  RecordGridCard,
  RecordListRow,
  recordDiversity,
} from '~/components/RecordListItem';
import { ActiveRecordCard } from '~/components/ActiveRecordCard';
import { Chip } from '~/components/ui/Chip';
import { useActiveRecordSummary } from '~/lib/useActiveRecordSummary';
import { isoDateTime } from '~/lib/datetime';
import {
  bundleItemsOf,
  deleteCollectionTrip,
  deletePlotSurvey,
  deleteSession,
  getProject,
  listPlotSpecies,
  listProjects,
  listRecordsSummary,
  setRecordStarred,
  mergePlotSurveys,
  mergeSessions,
  takenRecordNames,
  taxonIdsOfRecord,
  updateCollectionTrip,
  updatePlotSurvey,
  updateSession,
  withTransaction,
  type MergeRecordOptions,
  type ProjectGroup,
  type RecordItem,
  type RecordKind,
} from '~/db';
import { offerCompact } from '~/lib/dbCompact';
import { errText } from '~/lib/errText';
import { runTask } from '~/stores/taskProgress';
import { assertDeletableCensuses, deleteCensuses, setCensusProject, SurveyError } from '~/survey/db/stemmap';
import { deleteSurvey } from '~/survey/db/surveys';
import { useActiveSurvey } from '~/survey/form/activeSurvey';
import {
  bundleCollection,
  bundleCensus,
  bundleModular,
  bundleGloria,
  bundleMany,
  bundlePlot,
  bundleSession,
  type BundleItem,
} from '~/lib/bundleExport';
import { confirmExportContent } from '~/components/AnalysisExportOptions';
import { ExportProgressOverlay } from '~/components/ExportProgressOverlay';

import { pickExportLanguage } from '~/lib/pickExportLanguage';
import { DuplicateRecordModal, type DuplicateRequest } from '~/components/DuplicateRecordModal';
import { MergeRecordsModal, type MergeRequest } from '~/components/MergeRecordsModal';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import {
  filterRecordGroups,
  matchingProjectIds,
  normalizeRecordQuery,
  recordMatches,
  type SearchableProject,
} from '~/lib/recordSearch';
import { duplicateRecordAndOpen, importRecordPromptAndOpen } from '~/lib/recordCreate';
import { showCreateSheet } from '~/components/CreateRecordSheet';
import { nextRecordName } from '~/lib/recordName';
import { pickFavoriteFolder } from '~/lib/pickFavoriteFolder';
import { useFavorites } from '~/stores/favorites';
import { estimateBundleSize } from '~/lib/exportSize';
import { bundleProject } from '~/lib/projectExport';
import { betaSimilarity, chao2, type Chao2Result, type DiversityRecord } from '~/lib/diversity';
import { BetaSimilarityBlock, Chao2ResultBlock } from '~/components/CrossPlotChao2Card';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useExportShare } from '~/lib/useExportShare';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveGloria } from '~/modules/gloria/store';
import { deleteGloriaSurvey, updateGloriaSurvey } from '~/modules/gloria/db';
import { useActiveSession } from '~/stores/activeSession';
import { selectionKey, useRecordSelection } from '~/stores/recordSelection';
import { useSettings, type RecordsLayout } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { syncAllTeams } from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { mergeSummary } from '~/lib/mergeSummaryText';

import { useTabBarInset } from '~/lib/tabBarLayout';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';
import { MenuButton, showMenu } from '~/components/OverflowMenu';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { SelectMark, type SelectMarkState } from '~/components/ui/SelectMark';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';

type Filter = 'all' | RecordKind;
type ViewMode = 'flat' | 'byProject';

/** Cross-plot Chao2 with the given plots as incidence units — the shared
 *  computation for the header chip and the multi-select sheet. */
function loadPlotUnitRecords(plotId: number): DiversityRecord[] {
  try {
    return listPlotSpecies(plotId).map((r) => ({
      taxon_id: r.taxon_id,
      used_scientific_name: r.used_scientific_name,
      organism_quantity: r.organism_quantity,
      organism_quantity_type: r.organism_quantity_type,
      subplot_id: plotId,
    }));
  } catch {
    return [];
  }
}

function crossPlotChao2(plotIds: number[]): Chao2Result {
  return chao2(plotIds.flatMap(loadPlotUnitRecords), plotIds);
}

/** Header-chip completeness cache. Computation is deferred off the reload
 *  critical path (records-tab reload is perf-tuned); reload() clears this so
 *  new records show on the next pass. null = computed, not applicable. */
const chao2ChipCache = new Map<string, number | null>();
function ProjectChao2Chip({ projectId, plotIds }: { projectId: number; plotIds: number[] }) {
  const router = useRouter();
  const { t } = useTranslation();
  const key = `${projectId}:${plotIds.join('.')}`;
  const [completeness, setCompleteness] = useState<number | null>(
    () => chao2ChipCache.get(key) ?? null,
  );
  useEffect(() => {
    if (plotIds.length < 2) {
      setCompleteness(null);
      return;
    }
    if (chao2ChipCache.has(key)) {
      setCompleteness(chao2ChipCache.get(key) ?? null);
      return;
    }
    // Deliberately off the mount frame: N plots × listPlotSpecies must not
    // slow the list's first paint.
    const timer = setTimeout(() => {
      const res = crossPlotChao2(plotIds);
      const v = res.applicable ? res.completeness : null;
      chao2ChipCache.set(key, v);
      setCompleteness(v);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (completeness == null) return null;
  return (
    <Pressable
      onPress={() => router.push(`/project/${projectId}` as Href)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t('plotStats.crossTitle')}
      className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 active:opacity-60 dark:bg-sky-900/50"
    >
      <Text className="text-[11px] font-medium text-sky-700 dark:text-sky-300">
        {t('plotStats.chipLabel', { pct: `${Math.round(completeness * 100)}%` })}
      </Text>
    </Pressable>
  );
}

function ProjectHeader({
  group,
  collapsed,
  onToggle,
  onToggleAll,
  onExport,
  selectMode = false,
  groupState = 'off',
  onToggleSelect,
}: {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: () => void;
  /** Long-press: collapse / expand every group. */
  onToggleAll: () => void;
  onExport?: () => void;
  /** Multi-select mode: tap selects / deselects the whole group instead of
   *  collapsing (collapse stays available outside select mode). */
  selectMode?: boolean;
  /** The group's rows: none, some (mixed) or all picked. */
  groupState?: SelectMarkState;
  onToggleSelect?: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const countOf = (k: RecordKind) => group.items.filter((x) => x.kind === k).length;
  const parts = (
    [
      ['session', 'records.sessionCount'],
      ['plot', 'records.plotCount'],
      ['collection', 'records.collectionCount'],
    ] as const
  )
    .map(([kind, key]) => {
      const count = countOf(kind);
      return count > 0 ? t(key, { count }) : null;
    })
    .filter((x): x is string => x !== null);
  // GLORIA: surveys and the distinct summits they cover.
  const gloria = group.items.filter((x) => x.kind === 'gloria');
  if (gloria.length > 0) {
    const summits = new Set(gloria.map((x) => x.gloria?.summit_id)).size;
    parts.push(t('records.gloriaCount', { count: gloria.length, summits }));
  }
  const censuses = countOf('perm_survey');
  if (censuses > 0) parts.push(t('survey.census.projectCount', { count: censuses }));
  const modular = countOf('modular');
  if (modular > 0) parts.push(t('surveyForm.projectCount', { count: modular }));
  return (
    <Pressable
      onPress={selectMode ? onToggleSelect : onToggle}
      onLongPress={selectMode ? undefined : onToggleAll}
      delayLongPress={350}
      // `mb-2` matches the gap between records. Both layouts render records as
      // inset rounded cards that carry only a BOTTOM margin, so without this
      // the first card of a group sits flush against the header bar.
      className="mb-2 border-b border-gray-200 bg-gray-100 px-4 py-2 active:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:active:bg-gray-700"
    >
      <View className="flex-row items-center">
        {selectMode ? (
          <View className="mr-1">
            <SelectMark state={groupState} />
          </View>
        ) : (
          <Ionicons
            name={collapsed ? 'chevron-forward' : 'chevron-down'}
            size={14}
            color={c.ink2}
            style={{ marginRight: 4 }}
          />
        )}
        <Ionicons name="folder-outline" size={14} color="#4b5563" />
        <Text className="ml-1.5 text-sm font-semibold text-gray-800 dark:text-gray-200">
          {group.projectName}
        </Text>
        <Text className="ml-2 flex-1 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {parts.join(' · ')}
        </Text>
        {!selectMode ? (
          <ProjectChao2Chip
            projectId={group.projectId}
            plotIds={group.items.filter((x) => x.kind === 'plot').map((x) => x.id)}
          />
        ) : null}
        {onExport ? (
          <Pressable
            onPress={onExport}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.export')}
            className="ml-2 p-1.5 active:opacity-60"
          >
            <Ionicons name="share-outline" size={16} color={c.accent} />
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

type FlatRow =
  | { kind: 'header'; group: ProjectGroup; key: string }
  /** Group title: pinned, this week, or a month. */
  | { kind: 'dateHeader'; label: string; key: string; pinned?: boolean }
  /** `first` / `last` of its group: a group's rows share one rounded card. */
  | { kind: 'row'; item: RecordItem; key: string; first: boolean; last: boolean; pinned?: boolean }
  /** One grid line of up to `CARD_COLUMNS` records. */
  | { kind: 'cards'; items: RecordItem[]; key: string; pinned?: boolean };

/** Fixed rather than derived from the window width: at phone widths a third
 *  column leaves nothing for a Chinese record name, and the records tab has no
 *  landscape layout of its own. */
const CARD_COLUMNS = 2;

/**
 * Records → FlatList rows, in the chosen layout.
 *
 * The card grid is built by chunking into `cards` rows rather than by putting
 * `numColumns` on the FlatList: the byProject view interleaves full-width
 * `ProjectHeader`s with records in the SAME list, and `numColumns` would tile
 * those headers into the grid alongside the cards. Chunking keeps one column
 * of list rows, so both views and both layouts share one FlatList.
 */
function toItemRows(items: RecordItem[], layout: RecordsLayout, pinned = false): FlatRow[] {
  // A pinned record also appears in its project group (byProject view), so
  // its pinned copy needs a key of its own.
  const pre = pinned ? 'p-' : '';
  if (layout === 'list') {
    return items.map((item, i) => ({
      kind: 'row' as const,
      item,
      key: `${pre}${item.kind}-${item.id}`,
      first: i === 0,
      last: i === items.length - 1,
      pinned,
    }));
  }
  const rows: FlatRow[] = [];
  for (let i = 0; i < items.length; i += CARD_COLUMNS) {
    const chunk = items.slice(i, i + CARD_COLUMNS);
    rows.push({
      kind: 'cards',
      items: chunk,
      key: `${pre}c-${chunk.map((x) => `${x.kind}-${x.id}`).join('+')}`,
      pinned,
    });
  }
  return rows;
}

/** The pinned group's rows, or none when nothing is pinned. */
function pinnedRows(pinned: RecordItem[], layout: RecordsLayout, label: string): FlatRow[] {
  if (!pinned.length) return [];
  return [{ kind: 'dateHeader', label, key: 'd-pinned', pinned: true }, ...toItemRows(pinned, layout, true)];
}

/**
 * The timeline view, grouped: the pinned records first, then this week, then
 * one group per month, newest first.
 *
 * A pinned record appears only in the pinned group, never again under its
 * month. `pinned` is empty while searching (results are one plain list) and
 * leaves out the record in the progress card above the list.
 */
function buildTimelineRows(
  items: RecordItem[],
  layout: RecordsLayout,
  pinned: RecordItem[],
  labels: { pinned: string; thisWeek: string; month: (ts: number) => string },
): FlatRow[] {
  const now = new Date();
  // Monday 00:00 local.
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
  const inPinned = new Set(pinned.map((it) => `${it.kind}-${it.id}`));
  const rest = items.filter((it) => !inPinned.has(`${it.kind}-${it.id}`)).sort((a, b) => b.startedAt - a.startedAt);
  const buckets: { key: string; label: string; items: RecordItem[] }[] = [];
  for (const it of rest) {
    const d = new Date(it.startedAt);
    const key = it.startedAt >= weekStart ? 'week' : `${d.getFullYear()}-${d.getMonth()}`;
    const last = buckets[buckets.length - 1];
    if (last && last.key === key) last.items.push(it);
    else buckets.push({ key, label: key === 'week' ? labels.thisWeek : labels.month(it.startedAt), items: [it] });
  }
  const rows: FlatRow[] = pinnedRows(pinned, layout, labels.pinned);
  for (const b of buckets) {
    rows.push({ kind: 'dateHeader', label: b.label, key: `d-${b.key}` });
    rows.push(...toItemRows(b.items, layout));
  }
  return rows;
}

/** byProject: the pinned group above every project; pinned records also stay
 *  in their own project, which is what that view is for. */
function buildFlatRows(
  groups: ProjectGroup[],
  collapsedIds: Set<number>,
  layout: RecordsLayout,
  pinned: RecordItem[],
  pinnedLabel: string,
): FlatRow[] {
  const rows: FlatRow[] = pinnedRows(pinned, layout, pinnedLabel);
  for (const g of groups) {
    rows.push({ kind: 'header', group: g, key: `h-${g.projectId}` });
    if (collapsedIds.has(g.projectId)) continue;
    rows.push(...toItemRows(g.items, layout));
  }
  return rows;
}

export default function RecordsListScreen() {
  const c = useThemeColors();
  const router = useRouter();
  const tabBarInset = useTabBarInset();
  const { t } = useTranslation();
  const sheetInsets = useSafeAreaInsets();
  const filterLabel: Record<Filter, string> = {
    all: t('records.filterAll'),
    session: t('nav.session'),
    plot: t('nav.plot'),
    collection: t('nav.collection'),
    gloria: t('nav.gloria'),
    perm_survey: t('nav.survey'),
    modular: t('record.kindModular'),
  };
  const refreshActive = useActiveSession((s) => s.refresh);
  const refreshActivePlot = useActivePlot((s) => s.refresh);
  const toast = useToast((s) => s.show);
  const [filter, setFilter] = useState<Filter>('all');
  // Grouped by project by default (asked for 2026-09-07); switching back to the timeline is not persisted.
  const [viewMode, setViewMode] = useState<ViewMode>('byProject');
  // Collapsed project ids (byProject view), persisted in settings (like taxonomy_expanded).
  const collapsedList = useSettings((s) => s.records_collapsed);
  const setSetting = useSettings((s) => s.set);
  const collapsedIds = useMemo(() => new Set(collapsedList), [collapsedList]);
  const [items, setItems] = useState<RecordItem[]>([]);
  // False until the first read: the list starts empty, and showing 「還沒有任何記錄」
  // for that moment made users think their records were gone.
  const [loaded, setLoaded] = useState(false);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  // Search (header magnifier). Projects are loaded with the list so a query
  // can match a project's abstract / location / notes, not only its name.
  const [query, setQuery] = useState('');
  // Records in progress as the list knows them (title, project, counts),
  // taken from ALL records so a kind filter cannot hide one from the card.
  // Several, not one: a collection trip is exempt from single-active and runs
  // alongside a checklist, so "the first active row" can be the wrong record.
  const [activeItems, setActiveItems] = useState<RecordItem[]>([]);
  const [projects, setProjects] = useState<SearchableProject[]>([]);
  const [counts, setCounts] = useState<Record<Filter, number>>({
    all: 0,
    session: 0,
    plot: 0,
    collection: 0,
    gloria: 0,
    perm_survey: 0,
    modular: 0,
  });
  const [duplicating, setDuplicating] = useState<{
    item: RecordItem;
    request: DuplicateRequest;
  } | null>(null);
  const [assigningProject, setAssigningProject] = useState(false);
  const [merging, setMerging] = useState<{
    kind: 'session' | 'plot';
    request: MergeRequest;
  } | null>(null);
  const {
    busy: exportBusy,
    progress: exportProgress,
    onProgress,
    shareBundle,
    confirmIfLarge,
  } = useExportShare();

  const selectMode = useRecordSelection((s) => s.active);
  const selected = useRecordSelection((s) => s.selected);
  const selectEnter = useRecordSelection((s) => s.enter);
  const selectToggle = useRecordSelection((s) => s.toggle);
  const selectSetMany = useRecordSelection((s) => s.setMany);
  const selectClear = useRecordSelection((s) => s.clear);
  // Android hardware back leaves select mode before it leaves the tab — the
  // same rule as every other list (useListSelection). Registered only while
  // selecting, so an ordinary back is never swallowed.
  useFocusEffect(
    useCallback(() => {
      if (!selectMode) return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        selectClear();
        return true;
      });
      return () => sub.remove();
    }, [selectMode, selectClear]),
  );
  const geoFormats = useSettings((s) => s.export_geo_formats);
  const includePhotos = useSettings((s) => s.export_include_photos);
  const mergeDuplicateTaxa = useSettings((s) => s.export_merge_duplicate_taxa);
  const includeDocx = useSettings((s) => s.export_include_docx);
  const docFormat = useSettings((s) => s.export_doc_format);
  const levels = useSettings((s) => s.export_levels);
  const conservationFields = useSettings((s) => s.export_conservation_fields);
  const conservationHideLowConcern = useSettings((s) => s.export_conservation_hide_lc);
  const matrixValue = useSettings((s) => s.export_matrix_value);
  const analysisFormats = useSettings((s) => s.export_analysis_formats);
  const matrixByLayer = useSettings((s) => s.export_matrix_by_layer);
  const includeReport = useSettings((s) => s.export_include_report);
  const reportFormat = useSettings((s) => s.export_report_format);
  const swipeHintShown = useSettings((s) => s.records_swipe_hint_shown);
  const layout = useSettings((s) => s.records_layout);
  const settingsLoaded = useSettings((s) => s.loaded);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    chao2ChipCache.clear();
    clearRecordDiversityCache();
    // One table walk: counts (always over ALL records so the chips stay in
    // sync after any delete / create), the filtered list and the grouping all
    // come from listRecordsSummary — this used to be three identical walks.
    const summary = listRecordsSummary(filter);
    setCounts(summary.counts);
    setItems(summary.items);
    setGroups(summary.groups);
    setActiveItems(
      (filter === 'all' ? summary.items : listRecordsSummary('all').items).filter((it) => it.active),
    );
    setLoaded(true);
    setProjects(listProjects());
    refreshActive();
    refreshActivePlot();
    useActiveGloria.getState().refresh();
    useActiveSurvey.getState().refresh();
  }, [filter, refreshActive, refreshActivePlot]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Re-fetch when an active session / plot changes status (e.g. StaleWatcher
  // alerts fire "結束" while the user is staring at the records tab — without
  // this the row keeps showing「進行中」until the user manually switches
  // screens). Subscribe to the id alone so a no-op refresh (same object
  // shape) doesn't trigger reload. `reload` is read through a ref (not a dep):
  // with it in the deps this effect also re-fired on mount and on every
  // filter change, doubling the reload useFocusEffect already performs.
  const activeSessionId = useActiveSession((s) => s.session?.id ?? null);
  const activePlotId = useActivePlot((s) => s.plot?.id ?? null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const activeIdsSeen = useRef(false);
  useEffect(() => {
    if (!activeIdsSeen.current) {
      activeIdsSeen.current = true;
      return;
    }
    reloadRef.current();
  }, [activeSessionId, activePlotId]);

  const handleOpen = (item: RecordItem) => {
    if (item.kind === 'session') router.push(`/session/${item.id}` as Href);
    else if (item.kind === 'collection') router.push(`/collection/${item.id}` as Href);
    else if (item.kind === 'gloria') router.push(`/gloria/${item.id}` as Href);
    else if (item.kind === 'perm_survey') router.push(`/survey/${item.id}` as Href);
    else if (item.kind === 'modular') router.push(`/survey/form/${item.id}` as Href);
    else router.push(`/plot/${item.id}` as Href);
  };

  const handleRowTap = (item: RecordItem) => {
    if (selectMode) {
      selectToggle(selectionKey(item.kind, item.id));
      return;
    }
    handleOpen(item);
  };

  // Select-mode tap on a group header: whole group in / out.
  const handleToggleSelectGroup = (group: ProjectGroup) => {
    const keys = group.items.map((it) => selectionKey(it.kind, it.id));
    const allSelected = keys.every((k) => selected.has(k));
    selectSetMany(keys, !allSelected);
  };

  const handleRowLongPress = (item: RecordItem) => {
    if (selectMode) return;
    void Haptics.selectionAsync();
    selectEnter(selectionKey(item.kind, item.id));
  };

  const handleExportOne = async (item: RecordItem) => {
    const bundleItem: BundleItem = { kind: item.kind, id: item.id };
    const est = await estimateBundleSize([bundleItem], { includePhotos });
    const proceed = await confirmIfLarge(est.totalBytes);
    if (!proceed) return;

    const lang = await pickExportLanguage(t, 'export.language');
    if (!lang) return;

    const bundleOpts = {
      geoFormats,
      includePhotos,
      mergeDuplicateTaxa,
      includeDocx,
      docFormat,
      levels,
      conservationFields,
      conservationHideLowConcern,
      includeDwca: analysisFormats.includes('dwca'),
      lang,
      onProgress,
    };
    await shareBundle(() => {
      if (item.kind === 'session') return bundleSession(item.id, bundleOpts);
      if (item.kind === 'collection') return bundleCollection(item.id, bundleOpts);
      if (item.kind === 'gloria') return bundleGloria(item.id, bundleOpts);
      if (item.kind === 'perm_survey') return bundleCensus(item.id, bundleOpts);
      if (item.kind === 'modular') return bundleModular(item.id, bundleOpts);
      return bundlePlot(item.id, bundleOpts);
    });
  };

  // Export from a project group header: the whole project (records/ plus the
  // analysis tables), the same as the swipe export on /projects (persisted
  // preferences, no options sheet).
  const handleExportProject = async (group: ProjectGroup) => {
    if (exportBusy) return;
    const okGo = await confirmExportContent(t, {
      analysisFormats,
      matrixValue,
      matrixByLayer,
      includeReport,
      reportFormat,
      includePhotos,
      includeDocx,
      docFormat,
      geoFormats,
    });
    if (!okGo) return;
    const est = await estimateBundleSize(bundleItemsOf(group.items), { includePhotos });
    if (!(await confirmIfLarge(est.totalBytes))) return;
    const lang = await pickExportLanguage(t, 'export.language');
    if (!lang) return;
    await shareBundle(() =>
      bundleProject(group.projectId, {
        geoFormats,
        includePhotos,
        mergeDuplicateTaxa,
        includeDocx,
        docFormat,
        levels,
        conservationFields,
        conservationHideLowConcern,
        includeDwca: analysisFormats.includes('dwca'),
        lang,
        matrixValue,
        analysisFormats,
        matrixByLayer,
        includeReport,
        reportFormat,
        onProgress,
      }),
    );
  };

  const handleExportSelection = async () => {
    if (selected.size === 0) {
      toast(t('records.noneSelected'));
      return;
    }
    const bundleItems: BundleItem[] = [];
    // Resolve back to RecordItem so we can carry kind. We have items + groups —
    // walk the latest `items` array (covers both view modes since `items` is
    // always populated by reload).
    const byKey = new Map(items.map((it) => [selectionKey(it.kind, it.id), it]));
    const picked: RecordItem[] = [];
    for (const k of selected) {
      const it = byKey.get(k);
      if (it) picked.push(it);
    }
    bundleItems.push(...bundleItemsOf(picked));
    if (bundleItems.length === 0) {
      toast(t('records.noExportable'));
      return;
    }
    const est = await estimateBundleSize(bundleItems, { includePhotos });
    const proceed = await confirmIfLarge(est.totalBytes);
    if (!proceed) return;

    const lang = await pickExportLanguage(t, 'export.language');
    if (!lang) return;

    await shareBundle(() =>
      bundleMany(bundleItems, {
        geoFormats,
        includePhotos,
        mergeDuplicateTaxa,
        includeDocx,
        docFormat,
        levels,
        conservationFields,
        conservationHideLowConcern,
        includeDwca: analysisFormats.includes('dwca'),
        lang,
        onProgress,
      }),
    );
    selectClear();
  };

  const nounOf = (kind: RecordKind): string => {
    switch (kind) {
      case 'session':
        return t('nav.session');
      case 'plot':
        return t('nav.plot');
      case 'gloria':
        return t('nav.gloria');
      case 'collection':
        return t('nav.collection');
      case 'perm_survey':
        return t('nav.survey');
      case 'modular':
        return t('record.kindModular');
      default:
        return assertNever(kind, 'record kind');
    }
  };

  const handleDuplicate = (item: RecordItem) => {
    // A GLORIA survey is one summit × one monitoring cycle; a copy would be a
    // second record of the same cycle. The next cycle is started from the summit.
    if (item.kind === 'gloria') {
      toast(t('records.duplicateNoGloria'));
      return;
    }
    // A census belongs to its permanent plot; the next one is started there.
    if (item.kind === 'perm_survey') {
      toast(t('survey.census.noDuplicate'));
      return;
    }
    // Checklist / plot-style surveys: not yet (a permanent plot's next survey is started there).
    if (item.kind === 'modular') {
      toast(t('surveyForm.noDuplicate'));
      return;
    }
    // Names of the SAME kind only: a 名錄 and a 樣區 may legitimately share one.
    const taken = takenRecordNames(item.kind);
    setDuplicating({
      item,
      request: {
        suggested: nextRecordName(item.title, taken),
        taken,
        noun: nounOf(item.kind),
        // plotid is an identifier, not prose.
        autoCapitalize: item.kind === 'plot' ? 'none' : 'sentences',
        // 採集號屬於實體標本，不能預先配發 —— 見 duplicateCollectionTrip。
        speciesDisabled: item.kind === 'collection',
      },
    });
  };

  const handleDuplicateConfirm = async (opts: Parameters<typeof duplicateRecordAndOpen>[1]) => {
    const pending = duplicating;
    setDuplicating(null);
    if (!pending) return;
    // duplicateRecordAndOpen may present the "end the active record?" sheet.
    // Presenting a system sheet in the same tick as dismissing our own Modal
    // is the documented iOS crash/no-op case — let the dismissal land first.
    await new Promise((r) => setTimeout(r, 450));
    const id = await duplicateRecordAndOpen(pending.item, opts);
    if (id === null) return;
    reload();
    toast(t('records.duplicated', { name: opts.name }));
  };

  const handleSaveSelectionToFavorites = async () => {
    if (selected.size === 0) {
      toast(t('records.noneSelected'));
      return;
    }
    const byKey = new Map(items.map((it) => [selectionKey(it.kind, it.id), it]));
    const picked = [...selected].map((k) => byKey.get(k)).filter((it): it is RecordItem => !!it);
    if (picked.length === 0) return;

    const folderId = await pickFavoriteFolder(picked[0].title);
    if (folderId === null) return;

    // Counts are reported over the DISTINCT species of the whole selection —
    // summing per-record results would count a species shared by three records
    // as "1 added, 2 skipped", which reads like a partial failure.
    const distinct = new Set(picked.flatMap((it) => taxonIdsOfRecord(it.kind, it.id)));
    let added = 0;
    let unresolved = 0;
    for (const it of picked) {
      const r = useFavorites.getState().importFromRecord(it.kind, it.id, folderId);
      added += r.added;
      unresolved += r.unresolved;
    }
    selectClear();
    toast(
      t('favorites.importDone', {
        added: t('favorites.nImported', { count: added }),
        skipped: t('favorites.nDuplicate', {
          count: Math.max(0, distinct.size - added - unresolved),
        }),
        unresolved: t('favorites.nUnresolvedNames', { count: unresolved }),
      }),
    );
  };

  /** The selected keys resolved back to rows, in the list's own order. */
  const selectedItems = useMemo(() => {
    const byKey = new Map(items.map((it) => [selectionKey(it.kind, it.id), it]));
    return [...selected].map((k) => byKey.get(k)).filter((it): it is RecordItem => !!it);
  }, [items, selected]);

  /** Move to another project / a new project — one entry point, because
   *  ProjectAssignSheet's 「新建專案」 row already covers the second half. */
  const handleAssignSelectionProject = (projectId: number) => {
    setAssigningProject(false);
    const picked = selectedItems;
    if (picked.length === 0) return;
    withTransaction(() => {
      for (const it of picked) {
        if (it.kind === 'session') updateSession(it.id, { project_id: projectId });
        else if (it.kind === 'plot') updatePlotSurvey(it.id, { project_id: projectId });
        else if (it.kind === 'gloria') updateGloriaSurvey(it.id, { project_id: projectId });
        else if (it.kind === 'perm_survey' || it.kind === 'modular') setCensusProject(it.id, projectId);
        else updateCollectionTrip(it.id, { project_id: projectId });
      }
    });
    reload();
    selectClear();
    toast(
      t('records.movedToProject', {
        count: picked.length,
        name: getProject(projectId)?.name ?? '',
      }),
    );
  };

  /**
   * 合併 — only within one kind, and for plots only within one plot_type.
   *
   * 採集 is excluded: a specimen's collection number comes from the collector's
   * own career series, and merging two trips would have to re-issue numbers
   * already written on the physical sheets.
   */
  /**
   * Ended checklists, plots and collection trips are locked (src/lib/useRecordEditing).
   * Deleting or merging one here first asks to unlock it; GLORIA surveys have
   * their own per-unit locks and are not covered, and censuses have no lock.
   */
  const unlockThen = (items: RecordItem[], run: () => void) => {
    const locked = items.filter((it) => it.kind !== 'gloria' && it.kind !== 'perm_survey' && !it.active).length;
    if (locked === 0) {
      run();
      return;
    }
    Alert.alert(t('recordLock.listLockedTitle', { count: locked }), t('recordLock.listLockedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('recordLock.unlockAndContinue'), style: 'destructive', onPress: run },
    ]);
  };

  const handleMergeSelection = () => unlockThen(selectedItems, mergeSelection);
  const mergeSelection = () => {
    const picked = selectedItems;
    if (picked.length < 2) {
      toast(t('records.mergeNeedTwo'));
      return;
    }
    const kind = picked[0].kind;
    if (picked.some((it) => it.kind !== kind)) {
      toast(t('records.mergeSameKind'));
      return;
    }
    if (kind === 'collection') {
      toast(t('records.mergeNoCollection'));
      return;
    }
    // GLORIA surveys are one summit × one monitoring cycle; there is nothing to merge.
    if (kind === 'gloria') {
      toast(t('records.mergeNoGloria'));
      return;
    }
    // Censuses of one plot are successive, not parallel; team merge joins a census's blocks.
    if (kind === 'perm_survey') {
      toast(t('survey.census.noMerge'));
      return;
    }
    if (kind === 'modular') {
      toast(t('surveyForm.noMerge'));
      return;
    }
    if (kind === 'plot') {
      const type = picked[0].plot?.plot_type;
      if (picked.some((it) => it.plot?.plot_type !== type)) {
        toast(t('records.mergeSamePlotType'));
        return;
      }
    }
    const taken = takenRecordNames(kind);
    setMerging({
      kind,
      request: {
        kind,
        sources: picked.map((it) => ({
          id: it.id,
          title: it.title,
          subtitle: it.subtitlePlain || it.subtitle,
        })),
        suggested: nextRecordName(picked[0].title, taken),
        taken,
        noun: nounOf(kind),
      },
    });
  };

  /**
   * The header ⋯ (03-screens-flow.md §4b): view and layout switch in place —
   * the menu stays open to show the result — and the rest are actions. The
   * kind filter lives in the chips above the list.
   */
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const handleHeaderMore = async (anchor: RefObject<View | null>) => {
    const choice = await showMenu(anchor, () => [
      {
        title: t('records.viewTitle'),
        items: [
          {
            kind: 'radio',
            id: 'byProject',
            group: 'view',
            label: t('records.byProject'),
            icon: 'folder-outline',
            checked: viewModeRef.current === 'byProject',
            onSelect: () => setViewMode('byProject'),
          },
          {
            kind: 'radio',
            id: 'flat',
            group: 'view',
            label: t('records.timeline'),
            icon: 'time-outline',
            checked: viewModeRef.current === 'flat',
            onSelect: () => setViewMode('flat'),
          },
          {
            kind: 'segmented',
            id: 'layout',
            label: t('menu.layout'),
            value: useSettings.getState().records_layout,
            options: [
              { value: 'list', icon: 'list', label: t('records.layoutToList') },
              { value: 'card', icon: 'grid-outline', label: t('records.layoutToCard') },
            ],
            onChange: (v) => setSetting('records_layout', v as RecordsLayout),
          },
        ],
      },
      {
        items: [
          // A way into multi-select besides long-pressing a row.
          { kind: 'action', id: 'select', label: t('menu.selectMany'), icon: 'checkmark-circle-outline' },
          { kind: 'action', id: 'import', label: t('record.kindImport'), icon: 'download-outline' },
          // Recently deleted records (record versions keep them 30 days).
          {
            kind: 'action',
            id: 'deleted',
            label: t('versions.deletedTitle'),
            icon: 'trash-outline',
            detail: t('menu.days30'),
          },
        ],
      },
    ]);
    if (choice === 'select') useRecordSelection.setState({ active: true, selected: new Set<string>() });
    else if (choice === 'import') {
      await importRecordPromptAndOpen();
      reload();
    } else if (choice === 'deleted') router.push('/deleted-records' as Href);
  };

  const handleSelectionMore = async (anchor: RefObject<View | null>) => {
    if (selectedItems.length === 0) {
      toast(t('records.noneSelected'));
      return;
    }
    const choice = await showMenu(anchor, [
      {
        items: [
          { kind: 'action', id: 'pin', label: t('records.star'), icon: 'star-outline' },
          { kind: 'action', id: 'unpin', label: t('records.unstar'), icon: 'close-circle-outline' },
        ],
      },
      {
        items: [
          { kind: 'action', id: 'stats', label: t('plotStats.crossTitle'), icon: 'stats-chart-outline' },
          { kind: 'action', id: 'move', label: t('records.moveToProject'), icon: 'folder-open-outline' },
          { kind: 'action', id: 'merge', label: t('records.merge'), icon: 'git-merge-outline' },
        ],
      },
      // Destructive last and on its own, in red.
      { items: [{ kind: 'action', id: 'delete', label: t('common.delete'), icon: 'trash-outline', destructive: true }] },
    ]);
    if (!choice) return;
    if (choice === 'pin' || choice === 'unpin') {
      for (const it of selectedItems) setRecordStarred(it.kind, it.id, choice === 'pin');
      selectClear();
      reload();
      return;
    }
    // 統計 is listed even when it cannot run, and says why.
    //
    // It used to be a bar icon that simply went grey below two selected plots,
    // which reads as "broken" rather than "not applicable" — cross-plot Chao2
    // needs ≥2 PLOTS as sampling units, so a selection of 名錄 can never
    // produce one. Telling the user beats hiding the option.
    if (choice === 'stats' && selectedPlotIds.length < 2) {
      toast(t('plotStats.crossNeedTwo'));
      return;
    }
    if (choice === 'stats') {
      setChao2Sheet(
        selectedPlotIds.map((id) => ({
          id,
          title: items.find((it) => it.kind === 'plot' && it.id === id)?.title ?? String(id),
        })),
      );
    } else if (choice === 'move') setAssigningProject(true);
    else if (choice === 'merge') handleMergeSelection();
    else if (choice === 'delete') handleDeleteSelection();
  };

  /**
   * Batch delete, always asked first.
   *
   * The confirm names both numbers — records AND the species rows inside them —
   * because "刪除 3 筆" badly understates throwing away 400 observations, and
   * this is the one action in the selection bar that nothing can undo.
   */
  const handleDeleteSelection = () => {
    const picked = selectedItems;
    if (picked.length === 0) {
      toast(t('records.noneSelected'));
      return;
    }
    unlockThen(picked, () => deleteSelection(picked));
  };
  // Checklists, plots, GLORIA surveys and censuses keep their versions 30 days after deletion
  // (record versions); collections have none.
  const recoverableNote = (items: RecordItem[]) =>
    (items.some((it) => it.kind !== 'collection') ? `\n\n${t('records.deleteRecoverable')}` : '') +
    (items.some((it) => it.kind === 'collection') ? `\n\n${t('records.deletePermanent')}` : '');
  const deleteSelection = (picked: RecordItem[]) => {
    const rows = picked.reduce((sum, it) => sum + it.recordCount, 0);
    Alert.alert(
      t('records.deleteSelectedTitle', { count: picked.length }),
      t('records.deleteSelectedMsg', { count: picked.length, rows }) + recoverableNote(picked),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => void deletePicked(picked),
        },
      ],
    );
  };

  const deletePicked = async (picked: RecordItem[]) => {
    const censuses = picked.filter((it) => it.kind === 'perm_survey').map((it) => it.id);
    try {
      // Refused before anything goes: only the last censuses of a series.
      assertDeletableCensuses(censuses);
      withTransaction(() => {
        for (const it of picked) {
          if (it.kind === 'session') deleteSession(it.id);
          else if (it.kind === 'collection') deleteCollectionTrip(it.id);
          else if (it.kind === 'gloria') deleteGloriaSurvey(it.id);
          else if (it.kind === 'modular') deleteSurvey(it.id);
          else if (it.kind !== 'perm_survey') deletePlotSurvey(it.id);
        }
      });
      // A census keeps a version of every quadrat first: seconds for a large
      // one, so on the progress panel, after the other records (1E).
      if (censuses.length) await runTask((report) => deleteCensuses(censuses, report));
    } catch (e) {
      if (e instanceof SurveyError && e.code === 'not_latest_census') toast(t('survey.census.deleteNotLatest'));
      else Alert.alert(t('records.deleteFailed'), errText(e));
      reload();
      return;
    }
    // reload() also refreshes both active stores, which matters here:
    // the selection may well have contained the active record.
    reload();
    selectClear();
    toast(t('records.deletedCount', { count: picked.length }));
    if (censuses.length) await offerCompact({ afterDelete: true });
  };

  const deleteOneCensus = async (id: number) => {
    try {
      await runTask((report) => deleteCensuses([id], report));
    } catch (e) {
      if (e instanceof SurveyError && e.code === 'not_latest_census') toast(t('survey.census.deleteNotLatest'));
      else Alert.alert(t('records.deleteFailed'), errText(e));
      return;
    }
    reload();
    await offerCompact({ afterDelete: true });
  };

  const handleMergeConfirm = (opts: MergeRecordOptions) => {
    const pending = merging;
    setMerging(null);
    if (!pending) return;
    const ids = pending.request.sources.map((s) => s.id);
    const newId =
      pending.kind === 'session' ? mergeSessions(ids, opts) : mergePlotSurveys(ids, opts);
    if (newId === null) {
      toast(t('records.mergeFailed'));
      return;
    }
    // Deleting the sources can remove whichever record was active, and both
    // stores cache that row.
    useActiveSession.getState().refresh();
    useActivePlot.getState().refresh();
    useActiveGloria.getState().refresh();
    reload();
    selectClear();
    useToast.getState().show(t('records.merged', { name: opts.name }), {
      action: {
        label: t('records.open'),
        onPress: () =>
          router.push(`${pending.kind === 'session' ? '/session' : '/plot'}/${newId}` as Href),
      },
    });
  };

  const handleDelete = (item: RecordItem) => unlockThen([item], () => deleteOne(item));
  const deleteOne = (item: RecordItem) => {
    const noun = nounOf(item.kind);
    Alert.alert(
      t('records.deleteTitle', { noun }),
      (item.kind === 'perm_survey'
        ? t('survey.census.deleteMsg', { title: item.title, n: item.survey?.census_no ?? 0 })
        : t('records.deleteMsg', { title: item.title, count: item.recordCount })) + recoverableNote([item]),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (item.kind === 'session') deleteSession(item.id);
            else if (item.kind === 'collection') deleteCollectionTrip(item.id);
            else if (item.kind === 'gloria') deleteGloriaSurvey(item.id);
            else if (item.kind === 'perm_survey') {
              void deleteOneCensus(item.id);
              return;
            } else if (item.kind === 'modular') deleteSurvey(item.id);
            else deletePlotSurvey(item.id);
            reload();
          },
        },
      ],
    );
  };

  const toggleCollapsed = (projectId: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSetting(
      'records_collapsed',
      collapsedIds.has(projectId)
        ? collapsedList.filter((id) => id !== projectId)
        : [...collapsedList, projectId],
    );
  };

  // Long-press a group header: collapse / expand all (like the taxonomy tree's
  // collapseAll). Only the groups visible in this view change; the collapsed
  // state under other filters is left as it is.
  const toggleCollapseAll = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const visibleIds = groups.map((g) => g.projectId);
    const allCollapsed = visibleIds.every((id) => collapsedIds.has(id));
    setSetting(
      'records_collapsed',
      allCollapsed
        ? collapsedList.filter((id) => !visibleIds.includes(id))
        : [...new Set([...collapsedList, ...visibleIds])],
    );
  };

  /** Changes whenever the selection does, so the memoised `listRows` still
   *  lets FlatList know its cells need redrawing. */
  const selectionEpoch = `${selectMode}:${selected.size}:${[...selected].join(',')}`;

  const nq = normalizeRecordQuery(query);
  const projectHits = useMemo(() => matchingProjectIds(projects, nq), [projects, nq]);
  const shownGroups = useMemo(
    () => filterRecordGroups(groups, nq, projectHits),
    [groups, nq, projectHits],
  );
  const shownItems = useMemo(
    () => (nq ? items.filter((it) => recordMatches(it, nq, projectHits)) : items),
    [items, nq, projectHits],
  );
  // While searching, a collapsed group would hide the very matches asked for.
  const noCollapse = useMemo(() => new Set<number>(), []);
  // The pinned group: the kind chip already filtered `items`; none while
  // searching (results are one list); never the record in the progress card.
  const activeSummary = useActiveRecordSummary();
  const activeKey = activeSummary ? `${activeSummary.kind}-${activeSummary.id}` : null;
  const pinned = useMemo(
    () =>
      nq
        ? []
        : items
            .filter((it) => it.starred && `${it.kind}-${it.id}` !== activeKey)
            .sort((a, b) => b.startedAt - a.startedAt),
    [items, nq, activeKey],
  );
  const listRows = useMemo(
    () =>
      viewMode === 'byProject'
        ? buildFlatRows(shownGroups, nq ? noCollapse : collapsedIds, layout, pinned, t('records.starredGroup'))
        : buildTimelineRows(shownItems, layout, pinned, {
            pinned: t('records.starredGroup'),
            thisWeek: t('records.thisWeek'),
            // An i18n template, not Intl: Hermes on Android ships no CJK
            // locale data, so toLocaleDateString('zh-TW') came out English.
            month: (ts) => {
              const d = new Date(ts);
              return t('records.monthGroup', {
                year: d.getFullYear(),
                month: d.getMonth() + 1,
                month2: String(d.getMonth() + 1).padStart(2, '0'),
              });
            },
          }),
    [viewMode, shownGroups, nq, noCollapse, collapsedIds, layout, shownItems, pinned, t],
  );
  const isEmpty = viewMode === 'flat' ? items.length === 0 : groups.length === 0;
  const noSearchMatch =
    !isEmpty && nq !== '' && (viewMode === 'flat' ? shownItems.length === 0 : shownGroups.length === 0);

  // C7: pull-to-refresh. reload() is synchronous (op-sqlite executeSync), so
  // hold the spinner a beat — an instantly vanishing spinner reads as broken.
  // ── Cross-plot Chao2 (multi-select → ad-hoc scope, may span projects) ──
  const selectedPlotIds = useMemo(
    () =>
      [...selected]
        .filter((k) => k.startsWith('plot-'))
        .map((k) => Number(k.slice('plot-'.length)))
        .filter((n) => Number.isFinite(n)),
    [selected],
  );
  const [chao2Sheet, setChao2Sheet] = useState<Array<{ id: number; title: string }> | null>(null);
  const chao2SheetData = useMemo(() => {
    if (!chao2Sheet) return null;
    const perPlot = chao2Sheet.map((p) => ({ ...p, records: loadPlotUnitRecords(p.id) }));
    return {
      result: chao2(
        perPlot.flatMap((p) => p.records),
        perPlot.map((p) => p.id),
      ),
      beta:
        perPlot.length === 2
          ? {
              value: betaSimilarity(perPlot[0].records, perPlot[1].records),
              nameA: perPlot[0].title,
              nameB: perPlot[1].title,
            }
          : null,
      count: perPlot.length,
    };
  }, [chao2Sheet]);

  const handleRefresh = () => {
    setRefreshing(true);
    requestAnimationFrame(() => {
      reload();
      setTimeout(() => setRefreshing(false), 300);
      // Records already synced with a team are synced again too; progress
      // shows in the strip on every screen, so the list stays usable.
      void syncLinkedRecords();
    });
  };

  const syncLinkedRecords = async () => {
    try {
      const r = await syncAllTeams();
      if (!r || r.teams === 0) return;
      reload();
      if (r.queued) toast(t('teamSync.queuedToast'));
      else if (!r.review) {
        const parts = [
          r.sent ? t('teamSync.teamSynced', { count: r.sent }) : null,
          r.mergedFrom.length
            ? (() => {
                const who = t('teamSync.mergedFromToast', { names: [...new Set(r.mergedFrom)].join('、') });
                const what = mergeSummary(t, r.changes);
                return what ? t('teamSync.mergedWithSummary', { who, what }) : who;
              })()
            : null,
        ].filter(Boolean);
        toast(parts.length ? parts.join('；') : t('teamSync.teamNothing'));
      }
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    }
  };

  // C4: one-shot swipe-actions teaser on the first visible record row. The
  // flag flips AFTER the animation window so the prop doesn't change (and
  // cancel the timers) mid-teaser.
  // Card layout produces no 'row' entries at all, so the teaser sits out —
  // which is right: there is nothing to swipe on a card.
  const firstRecordKey = (() => {
    const row = listRows.find((r) => r.kind === 'row');
    return row && row.kind === 'row' ? selectionKey(row.item.kind, row.item.id) : null;
  })();
  const teaserKey = settingsLoaded && !swipeHintShown && !selectMode ? firstRecordKey : null;
  useEffect(() => {
    if (teaserKey == null) return;
    const done = setTimeout(() => setSetting('records_swipe_hint_shown', true), 2200);
    return () => clearTimeout(done);
  }, [teaserKey, setSetting]);

  // ── Top of the list: the record in progress, then the kind chips ──
  const moduleGloria = useSettings((s) => s.module_gloria);
  const moduleSurvey = useSettings((s) => s.module_survey);
  const activeMatch = activeSummary
    ? (activeItems.find((it) => it.kind === activeSummary.kind && it.id === activeSummary.id) ?? null)
    : null;
  const activeSpecies = useMemo(() => {
    if (!activeSummary) return null;
    if (activeSummary.kind === 'session' || activeSummary.kind === 'plot' || activeSummary.kind === 'modular')
      return recordDiversity(activeSummary.kind, activeSummary.id)?.s ?? 0;
    // A GLORIA row's count IS its species count; MIREN has no single one.
    if (activeSummary.kind === 'gloria') return activeMatch?.recordCount ?? null;
    return null;
    // `items` changes on every reload, which is also when the cache is cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSummary?.kind, activeSummary?.id, activeMatch, items]);
  // GLORIA is a module; its chip shows when the module is on or its records exist.
  const chipFilters: Filter[] = [
    'all',
    'session',
    'plot',
    'collection',
    ...(moduleGloria || counts.gloria > 0 ? (['gloria'] as Filter[]) : []),
    ...(moduleSurvey || counts.perm_survey > 0 ? (['perm_survey'] as Filter[]) : []),
    ...(counts.modular > 0 ? (['modular'] as Filter[]) : []),
  ];
  const chipLabel: Record<Filter, string> = { ...filterLabel, gloria: 'GLORIA' };
  const topBlock = selectMode ? null : (
    <View>
      {activeSummary ? (
        <ActiveRecordCard
          kind={activeSummary.kind}
          title={activeMatch?.title ?? activeSummary.barLabel}
          subtitle={[activeMatch?.projectName, isoDateTime(activeSummary.startedAt)].filter(Boolean).join(' · ')}
          speciesCount={activeSpecies}
          startedAt={activeSummary.startedAt}
          onResume={() => router.navigate(activeSummary.targetPath as Href)}
        />
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        className="mb-3"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {chipFilters.map((f) => (
          <Chip
            key={f}
            label={chipLabel[f]}
            count={counts[f]}
            selected={filter === f}
            onPress={() => setFilter(f)}
          />
        ))}
      </ScrollView>
    </View>
  );

  const handleToggleStar = (item: RecordItem) => {
    setRecordStarred(item.kind, item.id, !item.starred);
    // Starring re-sorts the list, so a plain reload is the whole update.
    reload();
  };

  /** A record as a card, for the 2-up grid. No swipe actions: a half-width
   *  cell has nowhere to reveal them, and long-press → multi-select still
   *  reaches 匯出 / 刪除 / 合併. */
  const renderCard = (item: RecordItem, showProject: boolean, pinnedRow = false) => {
    const key = selectionKey(item.kind, item.id);
    return (
      <RecordGridCard
        key={key}
        pinned={pinnedRow}
        item={item}
        showProject={showProject}
        onPress={() => handleRowTap(item)}
        onLongPress={() => handleRowLongPress(item)}
        selectMode={selectMode}
        selected={selected.has(key)}
        onToggleStar={() => handleToggleStar(item)}
      />
    );
  };

  const renderRow = (item: RecordItem, showProject: boolean, first: boolean, last: boolean, pinnedRow = false) => {
    const key = selectionKey(item.kind, item.id);
    return (
      // A group's rows share one card: the first rounds the top, the last the
      // bottom, the rest are split by a hairline. The frame lives OUTSIDE
      // SwipeRowActions and clips it: the revealed 刪除 panel is a
      // square-cornered full-height strip, so without this it would poke out
      // past the card's corners and run to the screen edge.
      <View
        className={`mx-3 overflow-hidden border-x ${
          pinnedRow ? 'border-acorn-edge dark:border-acorn-deep' : 'border-line dark:border-line-dark'
        } ${
          first
            ? 'rounded-t-card border-t'
            : pinnedRow
              ? 'border-t border-t-acorn-edge dark:border-t-gray-700'
              : 'border-t border-t-gray-100 dark:border-t-gray-800'
        } ${last ? 'mb-3 rounded-b-card border-b' : ''}`}
      >
        <SwipeRowActions
          disabled={selectMode}
          teaser={key === teaserKey}
          actions={[
            {
              label: t(item.starred ? 'records.unstar' : 'records.star'),
              icon: item.starred ? 'close-circle-outline' : 'star-outline',
              color: 'acorn',
              onPress: () => handleToggleStar(item),
            },
            // A census and a checklist / plot-style survey are exported, not
            // duplicated or sent to iNaturalist.
            ...(item.kind === 'perm_survey' || item.kind === 'modular'
              ? ([
                  {
                    label: t('common.export'),
                    icon: 'share-outline',
                    color: 'export',
                    onPress: () => handleExportOne(item),
                  },
                ] as const)
              : ([
                  {
                    label: t('records.duplicate'),
                    icon: 'copy-outline',
                    color: 'emerald',
                    onPress: () => handleDuplicate(item),
                  },
                  {
                    label: t('common.export'),
                    icon: 'share-outline',
                    color: 'export',
                    onPress: () => handleExportOne(item),
                  },
                  {
                    label: t('records.uploadInat'),
                    icon: 'cloud-upload-outline',
                    color: 'inat',
                    onPress: () => router.push(`/inat-upload?kind=${item.kind}&id=${item.id}` as Href),
                  },
                ] as const)),
            {
              label: t('common.delete'),
              icon: 'trash',
              color: 'red',
              onPress: () => handleDelete(item),
            },
          ]}
        >
          <RecordListRow
            item={item}
            showProject={showProject}
            onPress={() => handleRowTap(item)}
            onLongPress={() => handleRowLongPress(item)}
            selectMode={selectMode}
            selected={selected.has(key)}
            onToggleStar={() => handleToggleStar(item)}
            pinned={pinnedRow}
          />
        </SwipeRowActions>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-gray-50 dark:bg-gray-950">
      <ExportProgressOverlay progress={exportProgress} />
      {selectMode ? (
        // Select mode (05-controls.md §2.1): ✕ · count · select-all on top,
        // the actions in the dock above the tab bar.
        <SelectionToolbar
          count={selected.size}
          allPicked={shownItems.length > 0 && shownItems.every((it) => selected.has(selectionKey(it.kind, it.id)))}
          onToggleAll={() => {
            const keys = shownItems.map((it) => selectionKey(it.kind, it.id));
            const all = keys.length > 0 && keys.every((k) => selected.has(k));
            selectSetMany(keys, !all);
          }}
          onCancel={selectClear}
        />
      ) : null}
      <View
        className={`border-b border-gray-200 bg-card px-4 py-4 dark:border-gray-700 dark:bg-gray-900 ${selectMode ? 'hidden' : ''}`}
      >
        {selectMode ? null : (
          <View className="flex-row items-center">
            <Text
              numberOfLines={1}
              className="flex-1 text-3xl font-bold text-gray-900 dark:text-gray-100"
            >
              {t('tab.records')}
            </Text>
            {/* Two icon pills, fixed width in every language. Search became the
                always-on field below; the list / card toggle moved into ⋯. */}
            <View className="flex-row items-center gap-2">
              {/* 常用名錄. A heart, not a star: records carry their own star
                  (釘選), and two features sharing one glyph is how you end up
                  tapping the wrong thing in the field. */}
              <PillButton
                icon="heart"
                tone="favorite"
                a11yLabel={t('records.favorites')}
                onPress={() => router.push('/favorites')}
              />
              <MenuButton variant="pill" onOpen={handleHeaderMore} />
            </View>
          </View>
        )}
      </View>

      {/* Always on (was behind a header pill). Stays up in select mode too:
          search a project, then select the group. */}
      <View
        className="mx-4 mt-3 flex-row items-center rounded-full border border-line bg-card px-4 dark:border-line-dark dark:bg-card-dark"
        style={{ minHeight: 44 }}
      >
        <Ionicons name="search" size={18} color={c.ink3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('records.searchPlaceholder')}
          placeholderTextColor={c.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('records.search')}
          className="ml-2 flex-1 py-2 text-base text-gray-900 dark:text-gray-100"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={12} accessibilityLabel={t('common.clear')}>
            <Ionicons name="close-circle" size={18} color={c.ink3} />
          </Pressable>
        ) : null}
      </View>

      {!loaded ? (
        <View className="flex-1 items-center justify-center px-6">
          <ActivityIndicator color={c.accent} />
          <Text className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</Text>
        </View>
      ) : isEmpty ? (
        <View className="flex-1">
          {/* The chips stay reachable when a kind filter leaves nothing to show. */}
          <View className="pt-2">{topBlock}</View>
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="add-circle-outline" size={56} color="#cbd5e1" />
            <Text className="mt-3 text-base font-medium text-gray-700 dark:text-gray-300">
              {filter === 'all'
                ? t('records.empty')
                : t('records.emptyFiltered', { kind: filterLabel[filter] })}
            </Text>
            <Text className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('records.emptyHint')}
            </Text>
            <Button
              label={t('records.emptyCreate')}
              icon="add"
              onPress={() => void showCreateSheet()}
              className="mt-5"
            />
          </View>
        </View>
      ) : noSearchMatch ? (
        <View className="flex-1">
          <View className="pt-2">{topBlock}</View>
          <View className="flex-1 items-center justify-center px-6">
            <Ionicons name="search-outline" size={48} color="#cbd5e1" />
            <Text className="mt-3 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('records.searchNoMatch', { q: query.trim() })}
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          data={listRows}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          keyExtractor={(row) => row.key}
          // `renderItem` closes over selectMode / selected, which are NOT in
          // `data`. Before `listRows` was memoised the array was rebuilt every
          // render and that churn happened to force cells to update; now that
          // it is stable, RN's documented requirement applies (FlatList.js:296
          // — "pass a prop that is not === after updates, otherwise your UI
          // may not update on changes").
          extraData={selectionEpoch}
          ListHeaderComponent={topBlock}
          // Bottom padding clears the floating tab bar, which overlays the
          // scene instead of reserving space below it.
          contentContainerStyle={{ paddingTop: 8, paddingBottom: tabBarInset + 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          renderItem={({ item: row }) => {
            // The pinned group mixes projects, so its rows name theirs.
            const showProject = viewMode === 'byProject' && !('pinned' in row && row.pinned);
            if (row.kind === 'header')
              return (
                <ProjectHeader
                  group={row.group}
                  collapsed={!nq && collapsedIds.has(row.group.projectId)}
                  onToggle={() => toggleCollapsed(row.group.projectId)}
                  onToggleAll={toggleCollapseAll}
                  onExport={selectMode ? undefined : () => handleExportProject(row.group)}
                  selectMode={selectMode}
                  groupState={
                    row.group.items.every((it) => selected.has(selectionKey(it.kind, it.id)))
                      ? 'on'
                      : row.group.items.some((it) => selected.has(selectionKey(it.kind, it.id)))
                        ? 'mixed'
                        : 'off'
                  }
                  onToggleSelect={() => handleToggleSelectGroup(row.group)}
                />
              );
            if (row.kind === 'cards')
              return (
                <View className="mx-3 mb-2 flex-row gap-2">
                  {row.items.map((it) => renderCard(it, showProject, row.pinned))}
                  {/* Keeps a lone last card at one column's width instead of
                      letting flex stretch it across the row. */}
                  {row.items.length < CARD_COLUMNS ? <View className="flex-1" /> : null}
                </View>
              );
            if (row.kind === 'dateHeader')
              return row.pinned ? (
                <View className="flex-row items-center px-5 pb-1.5 pt-1">
                  <Ionicons name="star" size={13} color={c.acornDeep} />
                  <Text className="ml-1 text-xs font-bold tracking-widest text-acorn-deep dark:text-acorn">{row.label}</Text>
                </View>
              ) : (
                <Text className="px-5 pb-1.5 pt-1 text-xs font-bold tracking-widest text-gray-500 dark:text-gray-400">
                  {row.label}
                </Text>
              );
            return renderRow(row.item, showProject, row.first, row.last, row.pinned);
          }}
        />
      )}

      {selectMode ? (
        <SelectionDock
          count={selected.size}
          bottomInset={tabBarInset}
          actions={[
            { label: t('records.favorites'), onPress: () => void handleSaveSelectionToFavorites() },
            { label: t('common.export'), onPress: () => void handleExportSelection() },
            // 釘選 / 統計 / 專案 / 合併 / 刪除: the drop-down, opened from this button.
            { label: t('common.more'), onMenu: (anchor) => void handleSelectionMore(anchor) },
          ]}
        />
      ) : null}

      {/* 跨樣區 Chao2 sheet — ad-hoc scope from the multi-select. No text
          input, so a floating bottom sheet is fine (the full-screen rule is
          for keyboard-bearing modals). */}
      <Modal
        visible={chao2Sheet != null}
        transparent
        animationType="slide"
        onRequestClose={sheetBack(() => setChao2Sheet(null))}
      >
        <Pressable className="flex-1 bg-black/40" onPress={() => setChao2Sheet(null)} />
        <View
          className="rounded-t-2xl bg-card px-4 pt-4 dark:bg-gray-900"
          style={{ paddingBottom: Math.max(sheetInsets.bottom, 16) }}
        >
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('plotStats.crossTitle')}
          </Text>
          <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('plotStats.selectedPlots', { count: chao2SheetData?.count ?? 0 })}
          </Text>
          <Text className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            {t('plotStats.crossHint')}
          </Text>
          {chao2SheetData?.beta ? (
            <BetaSimilarityBlock
              beta={chao2SheetData.beta.value}
              nameA={chao2SheetData.beta.nameA}
              nameB={chao2SheetData.beta.nameB}
            />
          ) : (
            <Text className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
              {t('plotStats.betaNeedTwo')}
            </Text>
          )}
          {chao2SheetData?.result.applicable ? (
            <Chao2ResultBlock result={chao2SheetData.result} />
          ) : (
            <Text className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              {t('plotStats.crossEmpty')}
            </Text>
          )}
          <Text className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
            {t('plotStats.lowerBoundNote')}
          </Text>
        </View>
        <ActionSheetLayer visible={chao2Sheet != null} />
      </Modal>
      <DuplicateRecordModal
        request={duplicating?.request ?? null}
        onCancel={() => setDuplicating(null)}
        onConfirm={handleDuplicateConfirm}
      />
      <MergeRecordsModal
        request={merging?.request ?? null}
        onCancel={() => setMerging(null)}
        onConfirm={handleMergeConfirm}
      />
      <ProjectAssignSheet
        visible={assigningProject}
        // A multi-record selection has no single current project; -1 matches
        // nothing, so no row comes up pre-ticked.
        currentProjectId={-1}
        onCancel={() => setAssigningProject(false)}
        onAssign={handleAssignSelectionProject}
      />
    </View>
  );
}

/**
 * Icon-only dropdown: an icon + a chevron, opening an ActionSheet.
 *
 * The label used to ride along inside the chip, which made the header row's
 * width depend on the UI language — in longer languages it collided with the
 * favourites pill. An icon is fixed-width in every language; the current value
 * lives in `a11yLabel` for screen readers and is spelled out in the sheet the
 * chevron promises.
 */
