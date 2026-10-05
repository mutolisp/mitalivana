import { errText } from '~/lib/errText';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { shareThenDelete } from '~/lib/shareFile';
import { File, Paths } from 'expo-file-system';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isoDateTime } from '~/lib/datetime';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { IconDisc } from '~/components/ui/IconDisc';
import { SelectMark } from '~/components/ui/SelectMark';
import { Alert, BackHandler, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  countSiteReferences,
  createSite,
  deleteSite,
  getProject,
  listPlotSurveysWithMeta,
  listSessions,
  listSites,
  referencedSiteIds,
  updateSite,
  withTransaction,
  type Site,
} from '~/db';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import {
  buildGeoRows,
  geoRowToSite,
  groupGeoRows,
  type GeoRow,
  type GeoRowGroup,
} from '~/lib/geoRows';
import { SITE_TYPE_ICON, SITE_TYPE_LABEL } from '~/lib/siteLabels';
import { sitesToGeoJSON, sitesToGPX, sitesToKML, sitesToWKT } from '~/lib/geoExporters';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { promptText } from '~/components/TextPromptModal';
import { SwipeRowActions, type SwipeAction } from '~/components/SwipeRowActions';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { BackHeaderLeft } from '~/lib/goBack';

import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';

type ExportFormat = 'geojson' | 'kml' | 'gpx' | 'wkt';

/** Below this the list is short enough to scan; a search box would just eat a
 *  row's worth of screen. */
const SEARCH_THRESHOLD = 10;

/** A place that belongs to a record — a 樣區's coordinates or boundary, or a
 *  shape a 名錄 holds. Same teal as the map draws them in: must equal
 *  PLOT_COLOR in app/(tabs)/map.tsx. A data colour, so it does not follow the
 *  UI accent. */
const RECORD_TINT = '#00A2A5';
/** A standalone place: drawn or imported by hand, owned by no record. */
const STANDALONE_TINT = '#74AB00';
/** UI chrome (checkboxes, the group share icon). Deliberately neither of the
 *  two above: it says nothing about what a row IS. */
const CHROME_TINT = '#2563eb';

/**
 * Scroll offset to come back to, kept at module level so it survives the
 * screen unmounting.
 *
 * Tapping a row leaves for the map tab; returning through 設定 mounts this
 * screen afresh, which would otherwise dump the user back at the top of a
 * list they had scrolled a long way down.
 */
let lastScrollOffset = 0;

const EXPORT_LABELS: Record<
  ExportFormat,
  { label: string; ext: string; mime: string; uti: string }
> = {
  geojson: { label: 'GeoJSON', ext: 'geojson', mime: 'application/geo+json', uti: 'public.json' },
  kml: {
    label: 'KML',
    ext: 'kml',
    mime: 'application/vnd.google-earth.kml+xml',
    uti: 'com.google.earth.kml',
  },
  gpx: { label: 'GPX', ext: 'gpx', mime: 'application/gpx+xml', uti: 'public.xml' },
  wkt: { label: 'WKT', ext: 'wkt', mime: 'text/plain', uti: 'public.plain-text' },
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]/g, '_').slice(0, 80) || 'sites';
}

function formatTime(ts: number): string {
  return isoDateTime(ts);
}

export default function SitesScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [rows, setRows] = useState<GeoRow[]>([]);
  const listRef = useRef<FlatList<GeoRowGroup>>(null);
  /** One-shot per mount: restore the remembered offset as soon as the list has
   *  content tall enough to scroll to it, and never fight the user after. */
  const restored = useRef(false);
  const [filter, setFilter] = useState('');
  // Collapsed project ids, persisted like the records tab's byProject view.
  const collapsedList = useSettings((s) => s.sites_collapsed);
  const setSetting = useSettings((s) => s.set);
  const collapsedIds = useMemo(() => new Set(collapsedList), [collapsedList]);
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Rows waiting for a project. Kept apart from the sheet's visibility:
   *  ProjectAssignSheet's 「新建專案」 calls onCancel BEFORE onAssign, so
   *  clearing the rows on cancel would make that path move nothing. */
  const [assignRows, setAssignRows] = useState<GeoRow[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const openAssign = (list: GeoRow[]) => {
    setAssignRows(list);
    setAssignOpen(true);
  };

  const reload = useCallback(
    () =>
      setRows(
        buildGeoRows(listSites(), listPlotSurveysWithMeta(), listSessions(), referencedSiteIds()),
      ),
    [],
  );
  useFocusEffect(useCallback(() => reload(), [reload]));

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setPicked(new Set());
  }, []);

  // Android hardware back unwinds select mode before leaving the screen. The
  // listener is registered once with empty deps and reads the flag through a
  // ref, so it can never capture a stale `selectMode`.
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (selectModeRef.current) {
          setSelectMode(false);
          setPicked(new Set());
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, []),
  );

  const handleLongPress = (r: GeoRow) => {
    if (selectMode) return;
    void Haptics.selectionAsync();
    setSelectMode(true);
    setPicked(new Set([r.key]));
  };

  const togglePick = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDelete = (r: GeoRow) => {
    // A site bound to a checklist or plot survey is that record's geometry;
    // deleting it here silently strips the boundary off the record, so say so
    // first.
    const bound = countSiteReferences(r.id) > 0;
    const msg = bound
      ? t('sites.deleteBoundMsg', { name: r.name })
      : t('sites.deleteMsg', { name: r.name });
    Alert.alert(t('sites.deleteTitle'), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteSite(r.id);
          reload();
          toast(t('sites.deleted'));
        },
      },
    ]);
  };

  // Hand the id over and let the map centre itself. Writing `map_view` and
  // navigating used to look right and do nothing: the map is a tab screen, so
  // once it has been visited it stays mounted and only ever reads that setting
  // through `initialRegion` — and its own pan handler overwrites the value
  // 600 ms later anyway.
  const handleJumpTo = (r: GeoRow) => {
    router.push(`/(tabs)/map?${r.kind === 'site' ? 'site' : 'plot'}=${r.id}` as Href);
  };

  /**
   * Copy a row into a brand-new standalone site. This is the one place a
   * derived plot row turns into a stored one — the user asked for a copy, so
   * the copy is theirs to keep, rename and edit without touching the record.
   */
  const handleDuplicate = async (r: GeoRow) => {
    const taken = new Set(rows.map((x) => x.name));
    const suffix = t('sites.copySuffix');
    let suggested = `${r.name}${suffix}`;
    for (let n = 2; taken.has(suggested) && n < 1000; n++) suggested = `${r.name}${suffix}${n}`;
    const entered = await promptText({
      title: t('sites.duplicateTitle'),
      message: t('sites.duplicateMsg', { name: r.name }),
      defaultValue: suggested,
      placeholder: t('sites.namePlaceholder'),
      autoCapitalize: 'none',
    });
    if (entered === null) return;
    const name = entered.trim();
    if (!name) return;
    createSite({
      project_id: r.projectId,
      name,
      geometry: r.geometry,
      notes: r.notes,
    });
    reload();
    toast(t('records.duplicated', { name }));
  };

  const exportSites = async (subset: Site[], format: ExportFormat, baseName: string) => {
    if (subset.length === 0) {
      toast(t('sites.noExport'));
      return;
    }
    try {
      let text = '';
      if (format === 'geojson') text = sitesToGeoJSON(subset);
      else if (format === 'kml') text = sitesToKML(subset);
      else if (format === 'gpx') text = sitesToGPX(subset);
      else text = sitesToWKT(subset);

      const meta = EXPORT_LABELS[format];
      const filename = `${sanitizeFilename(baseName)}.${meta.ext}`;
      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(text);

      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert(t('sites.shareUnavailable'), t('backup.fileGenerated', { uri: file.uri }));
        return;
      }
      await shareThenDelete(file.uri, {
        mimeType: meta.mime,
        dialogTitle: filename,
        UTI: meta.uti,
      });
    } catch (e) {
      Alert.alert(t('export.failed'), errText(e));
    }
  };

  const askExportFormat = async (subset: GeoRow[], baseName: string) => {
    const formats: ExportFormat[] = ['geojson', 'kml', 'gpx', 'wkt'];
    const idx = await showActionSheet({
      title: t('sites.exportTitle', { count: subset.length }),
      options: formats.map((f) => ({ label: EXPORT_LABELS[f].label })),
    });
    if (idx >= 0 && idx < formats.length) {
      exportSites(subset.map(geoRowToSite), formats[idx], baseName);
    }
  };

  const toggleCollapsed = (projectId: number) => {
    setSetting(
      'sites_collapsed',
      collapsedIds.has(projectId)
        ? collapsedList.filter((id) => id !== projectId)
        : [...collapsedList, projectId],
    );
  };

  /** Long-press a header: collapse everything, or expand it all again if it
   *  already is. Only touches the groups currently on screen, so a search
   *  filter narrows what the gesture affects. */
  const toggleCollapseAll = () => {
    const visibleIds = [...new Set(display.map((r) => r.projectId))];
    if (visibleIds.length === 0) return;
    const allCollapsed = visibleIds.every((id) => collapsedIds.has(id));
    setSetting(
      'sites_collapsed',
      allCollapsed
        ? collapsedList.filter((id) => !visibleIds.includes(id))
        : [...new Set([...collapsedList, ...visibleIds])],
    );
  };

  const q = filter.trim().toLowerCase();
  const display = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.projectName.toLowerCase().includes(q) ||
          (r.ownerPlotid ?? '').toLowerCase().includes(q) ||
          (r.notes ?? '').toLowerCase().includes(q),
      )
    : rows;
  const projectGroups = groupGeoRows(display);
  const showSearch = rows.length > SEARCH_THRESHOLD;

  const chosen = rows.filter((r) => picked.has(r.key));
  const allVisiblePicked = display.length > 0 && display.every((r) => picked.has(r.key));

  const toggleSelectAll = () => {
    setPicked(allVisiblePicked ? new Set() : new Set(display.map((r) => r.key)));
  };

  const handleBulkDelete = () => {
    const sites = chosen.filter((r) => r.kind === 'site');
    const plotCount = chosen.length - sites.length;
    if (sites.length === 0) {
      // Every pick is a record's own coordinates: those belong to the record.
      Alert.alert(t('sites.deleteTitle'), t('sites.deletePlotOnlyMsg'));
      return;
    }
    const boundCount = sites.filter((r) => countSiteReferences(r.id) > 0).length;
    const lines = [t('sites.deleteSelectedMsg', { count: sites.length })];
    if (boundCount > 0) lines.push(t('sites.deleteBoundCountMsg', { count: boundCount }));
    if (plotCount > 0) lines.push(t('sites.deleteSkipPlotsMsg', { count: plotCount }));
    Alert.alert(t('sites.deleteTitle'), lines.join('\n'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          for (const r of sites) deleteSite(r.id);
          exitSelect();
          reload();
          toast(t('sites.deletedCount', { count: sites.length }));
        },
      },
    ]);
  };

  /**
   * Move stored sites to another project. Only `kind === 'site'` rows: a
   * derived plot row IS the plot's coordinates and belongs to the plot's
   * project, so it moves with the plot from the records tab, not from here.
   */
  const handleAssignProject = (projectId: number) => {
    const rowsToMove = assignRows;
    setAssignOpen(false);
    const sites = rowsToMove.filter((r) => r.kind === 'site');
    if (sites.length === 0) return;
    withTransaction(() => {
      for (const r of sites) updateSite(r.id, { project_id: projectId });
    });
    const skipped = rowsToMove.length - sites.length;
    if (selectMode) exitSelect();
    reload();
    const moved = t('sites.movedToProject', {
      count: sites.length,
      name: getProject(projectId)?.name ?? '',
    });
    toast(skipped > 0 ? `${moved}\n${t('sites.moveSkipPlotsMsg', { count: skipped })}` : moved);
  };

  const handleBulkAssign = () => {
    if (!chosen.some((r) => r.kind === 'site')) {
      Alert.alert(t('records.moveToProject'), t('sites.movePlotOnlyMsg'));
      return;
    }
    openAssign(chosen);
  };

  const renderRow = (r: GeoRow) => {
    const checked = picked.has(r.key);
    // A row is a record's geometry either because it IS a plot's coordinates
    // (derived) or because a plot bound it as its boundary. Both get the badge
    // so the list never hides whose shape it is showing.
    // A derived row's own name is already the plotid, so the badge stands
    // alone there; a bound site carries a name of its own, so it names the
    // record as well.
    const recordPrefix =
      r.kind === 'plot'
        ? `${t('sites.fromPlot')} · `
        : r.ownerPlotid
          ? `${t('sites.fromPlot')} ${r.ownerPlotid} · `
          : '';
    const tint = r.boundToRecord ? RECORD_TINT : STANDALONE_TINT;
    // A 樣區 wears the records list's own glyph, so it reads as a record at a
    // glance rather than as somewhere the user drew.
    const glyph = r.isPlot ? 'grid-outline' : SITE_TYPE_ICON[r.geometryType];
    const row = (
      <Pressable
        onPress={() => (selectMode ? togglePick(r.key) : handleJumpTo(r))}
        onLongPress={() => (selectMode ? undefined : handleLongPress(r))}
        className="flex-row items-center border-b border-gray-100 bg-card px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:active:bg-gray-800"
      >
        {selectMode ? (
          <View className="mr-3">
            <SelectMark state={checked ? 'on' : 'off'} />
          </View>
        ) : (
          <Ionicons name={glyph} size={20} color={tint} style={{ marginRight: 12 }} />
        )}
        <View className="flex-1">
          <Text className="text-base font-medium text-gray-900 dark:text-gray-100">{r.name}</Text>
          <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {recordPrefix}
            {t(SITE_TYPE_LABEL[r.geometryType])} · {formatTime(r.updatedAt)}
          </Text>
          {r.notes ? (
            <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
              {r.notes}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={c.ink3} />
      </Pressable>
    );
    // A derived row has no row of its own to delete — its coordinates belong
    // to the record, which is where they must be removed.
    const actions: SwipeAction[] = [
      {
        label: t('records.duplicate'),
        icon: 'copy-outline',
        color: 'emerald',
        onPress: () => void handleDuplicate(r),
      },
      ...(r.kind === 'site'
        ? [
            {
              label: t('records.moveToProject'),
              icon: 'folder-open-outline' as const,
              color: 'blue' as const,
              onPress: () => openAssign([r]),
            },
            {
              label: t('common.delete'),
              icon: 'trash-outline' as const,
              color: 'red' as const,
              onPress: () => handleDelete(r),
            },
          ]
        : []),
    ];
    return (
      <SwipeRowActions key={r.key} actions={actions} disabled={selectMode}>
        {row}
      </SwipeRowActions>
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('sites.title'),
          // While selecting, back leaves select mode first (05-controls.md §2.1).
          headerLeft: selectMode
            ? () => <IconDisc icon="back" onPress={exitSelect} accessibilityLabel={t('common.exitSelect')} edge="left" />
            : BackHeaderLeft,
          gestureEnabled: !selectMode,
          headerRight: () =>
            rows.length > 0 && !selectMode ? (
              <HeaderIconButton
                icon="share-outline"
                onPress={() => askExportFormat(display, 'sites')}
                label={t('common.export')}
              />
            ) : null,
        }}
      />

      {rows.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="map-outline" size={64} color={c.ink3} />
          <Text className="mt-4 text-lg font-medium text-gray-700 dark:text-gray-300">
            {t('sites.empty')}
          </Text>
          <Text className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('sites.emptyHint')}
          </Text>
          <Button label={t('sites.goToMap')} onPress={() => router.push('/(tabs)/map')} className="mt-4" />
        </View>
      ) : (
        <>
          {selectMode ? (
            <SelectionToolbar
              count={picked.size}
              allPicked={allVisiblePicked}
              onToggleAll={toggleSelectAll}
              onCancel={exitSelect}
            />
          ) : null}

          {showSearch ? (
            <View className="flex-row items-center border-b border-gray-200 bg-card px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
              <Ionicons name="search" size={16} color={c.ink3} />
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder={t('sites.searchPlaceholder')}
                placeholderTextColor={c.ink3}
                autoCapitalize="none"
                className="ml-2 flex-1 py-1 text-base text-gray-900 dark:text-gray-100"
              />
              {filter ? (
                <Pressable onPress={() => setFilter('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={18} color={c.ink3} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {display.length === 0 ? (
            <View className="flex-1 items-center justify-center px-6">
              <Text className="text-sm text-gray-500 dark:text-gray-400">{t('sites.noMatch')}</Text>
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={projectGroups}
              keyExtractor={(g) => String(g.projectId)}
              keyboardShouldPersistTaps="handled"
              onScroll={(e) => {
                lastScrollOffset = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={64}
              onContentSizeChange={() => {
                if (restored.current || lastScrollOffset <= 0) return;
                restored.current = true;
                listRef.current?.scrollToOffset({ offset: lastScrollOffset, animated: false });
              }}
              renderItem={({ item: g }) => {
                const collapsed = collapsedIds.has(g.projectId);
                const list = g.rows;
                return (
                  <View>
                    <Pressable
                      onPress={() => toggleCollapsed(g.projectId)}
                      onLongPress={toggleCollapseAll}
                      delayLongPress={350}
                      className="flex-row items-center justify-between bg-gray-100 px-4 py-2 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
                    >
                      <Ionicons
                        name={collapsed ? 'chevron-forward' : 'chevron-down'}
                        size={14}
                        color={c.ink2}
                        style={{ marginRight: 4 }}
                      />
                      <Text className="flex-1 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                        {g.projectName} · {t('sites.projectStats', { count: list.length })}
                      </Text>
                      {selectMode ? (
                        <Pressable
                          onPress={() =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              const allIn = list.every((r) => next.has(r.key));
                              for (const r of list) {
                                if (allIn) next.delete(r.key);
                                else next.add(r.key);
                              }
                              return next;
                            })
                          }
                          hitSlop={6}
                        >
                          {/* The group's own select-all: mixed while partly picked. */}
                          <SelectMark
                            state={
                              list.every((r) => picked.has(r.key))
                                ? 'on'
                                : list.some((r) => picked.has(r.key))
                                  ? 'mixed'
                                  : 'off'
                            }
                          />
                        </Pressable>
                      ) : (
                        <Pressable onPress={() => askExportFormat(list, g.projectName)} hitSlop={6}>
                          <Ionicons name="share-outline" size={16} color={CHROME_TINT} />
                        </Pressable>
                      )}
                    </Pressable>
                    {collapsed ? null : list.map(renderRow)}
                  </View>
                );
              }}
            />
          )}
        </>
      )}
      <ProjectAssignSheet
        visible={assignOpen}
        // Several rows have no single current project; -1 ticks nothing.
        currentProjectId={assignRows.length === 1 ? assignRows[0].projectId : -1}
        onCancel={() => setAssignOpen(false)}
        onAssign={handleAssignProject}
        description={t('sites.assignProjectDesc')}
        newProjectDescription={t('sites.newProjectDesc')}
      />
      {selectMode ? (
        <SelectionDock
          count={picked.size}
          actions={[
            { label: t('common.export'), onPress: () => askExportFormat(chosen, 'sites') },
            { label: t('sites.move'), onPress: handleBulkAssign },
            { label: t('common.delete'), onPress: handleBulkDelete, destructive: true },
          ]}
        />
      ) : null}
    </SafeAreaView>
  );
}
