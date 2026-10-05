import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SelectionDock, SelectionToolbar } from '~/components/SelectionToolbar';
import { IconDisc } from '~/components/ui/IconDisc';
import { SelectMark } from '~/components/ui/SelectMark';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createProject,
  deleteProject,
  listProjectsWithCounts,
  updateProject,
  type ProjectInput,
  type ProjectWithCounts,
} from '~/db';
import { pickExportLanguage } from '~/lib/pickExportLanguage';
import { confirmExportContent } from '~/components/AnalysisExportOptions';
import { ExportProgressOverlay } from '~/components/ExportProgressOverlay';
import { ProjectEditModal, type ProjectEditTarget } from '~/components/ProjectEditModal';
import { SwipeRowActions } from '~/components/SwipeRowActions';
import { estimateBundleSize } from '~/lib/exportSize';
import { bundleProject } from '~/lib/projectExport';
import { useExportShare } from '~/lib/useExportShare';
import { useSettings } from '~/stores/settings';
import { bundleItemsOf, listRecords } from '~/db';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { BackHeaderLeft } from '~/lib/goBack';
import { useThemeColors } from '~/theme/colors';

/** Below this the list is short enough to scan; a search box would just eat a
 *  row's worth of screen. */
const SEARCH_THRESHOLD = 10;

export default function ProjectsScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [editing, setEditing] = useState<ProjectEditTarget>(null);
  const [filter, setFilter] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const { busy, progress, onProgress, shareBundle, confirmIfLarge } = useExportShare();
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

  // Swipe export: straight to share with the persisted preferences, mirroring
  // the records tab's swipe export. The detail page's sheet is where the
  // analysis options get changed.
  const handleExport = async (project: ProjectWithCounts) => {
    if (busy) return;
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
    const est = await estimateBundleSize(bundleItemsOf(listRecords('all').filter((r) => r.projectId === project.id)), { includePhotos });
    if (!(await confirmIfLarge(est.totalBytes))) return;
    const lang = await pickExportLanguage(t, 'export.language');
    if (!lang) return;
    await shareBundle(() =>
      bundleProject(project.id, {
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

  const reload = useCallback(() => setProjects(listProjectsWithCounts()), []);
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

  const handleLongPress = (p: ProjectWithCounts) => {
    // 未分類 is not a project the user owns — it can never be deleted, so it
    // never enters a selection either.
    if (selectMode || p.id === 0) return;
    void Haptics.selectionAsync();
    setSelectMode(true);
    setPicked(new Set([p.id]));
  };

  const togglePick = (id: number) => {
    if (id === 0) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = (data: ProjectInput) => {
    if (editing === 'new') createProject(data);
    else if (editing) updateProject(editing.id, data);
    reload();
    setEditing(null);
  };

  // Collections, GLORIA and MIREN, checklist / plot-style surveys and tree
  // censuses also belong to projects: counted on the list and named when a
  // delete moves them to 未分類, like the rest.
  const statsLine = (p: ProjectWithCounts) =>
    [
      t('projects.stats', { sessions: p.session_count, plots: p.plot_count }),
      p.collection_count ? t('projects.statsCollections', { n: p.collection_count }) : '',
      p.gloria_count ? t('projects.statsGloria', { n: p.gloria_count }) : '',
      p.miren_count ? t('projects.statsMiren', { n: p.miren_count }) : '',
      p.survey_count ? `${t('record.kindModular')} ${p.survey_count}` : '',
      p.census_count ? `${t('nav.survey')} ${p.census_count}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const othersNote = (ps: ProjectWithCounts[]) => {
    const n = ps.reduce((sum, p) => sum + p.collection_count + p.gloria_count + p.miren_count + p.survey_count + p.census_count, 0);
    return n ? `\n\n${t('projects.deleteOthers', { n })}` : '';
  };

  const handleDelete = (project: ProjectWithCounts) => {
    if (project.id === 0) return;
    Alert.alert(
      t('projects.deleteTitle'),
      t('projects.deleteMsg', {
        name: project.name,
        sessions: t('projects.nChecklists', { count: project.session_count }),
        plots: t('projects.nPlots', { count: project.plot_count }),
      }) + othersNote([project]),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteProject(project.id);
            reload();
          },
        },
      ],
    );
  };

  const q = filter.trim().toLowerCase();
  const display = q
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.location_description ?? '').toLowerCase().includes(q),
      )
    : projects;
  const showSearch = projects.length > SEARCH_THRESHOLD;
  /** 未分類 can never be picked, so it must not count towards "all selected". */
  const selectable = display.filter((p) => p.id !== 0);
  const allVisiblePicked = selectable.length > 0 && selectable.every((p) => picked.has(p.id));

  const toggleSelectAll = () => {
    setPicked(allVisiblePicked ? new Set() : new Set(selectable.map((p) => p.id)));
  };

  const handleBulkDelete = () => {
    const chosen = projects.filter((p) => picked.has(p.id) && p.id !== 0);
    if (chosen.length === 0) return;
    const sessions = chosen.reduce((n, p) => n + p.session_count, 0);
    const plots = chosen.reduce((n, p) => n + p.plot_count, 0);
    Alert.alert(
      t('projects.deleteTitle'),
      t('projects.deleteSelectedMsg', {
        count: chosen.length,
        sessions: t('projects.nChecklists', { count: sessions }),
        plots: t('projects.nPlots', { count: plots }),
      }) + othersNote(chosen),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            for (const p of chosen) deleteProject(p.id);
            exitSelect();
            reload();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('nav.projects'),
          // While selecting, back leaves select mode first (05-controls.md §2.1).
          headerLeft: selectMode
            ? () => <IconDisc icon="back" onPress={exitSelect} accessibilityLabel={t('common.exitSelect')} edge="left" />
            : BackHeaderLeft,
          gestureEnabled: !selectMode,
          headerRight: () =>
            selectMode ? null : (
              <HeaderIconButton
                icon="add"
                onPress={() => setEditing('new')}
                label={t('sheets.newProject')}
              />
            ),
        }}
      />
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
            placeholder={t('projects.searchPlaceholder')}
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
          <Text className="text-sm text-gray-500 dark:text-gray-400">{t('projects.noMatch')}</Text>
        </View>
      ) : (
        <FlatList
          data={display}
          keyExtractor={(p) => String(p.id)}
          renderItem={({ item }) => {
            const checked = picked.has(item.id);
            const row = (
              <Pressable
                onPress={() =>
                  selectMode ? togglePick(item.id) : router.push(`/project/${item.id}` as Href)
                }
                onLongPress={() => (selectMode ? undefined : handleLongPress(item))}
                className="flex-row items-center border-b border-gray-100 bg-card px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:active:bg-gray-800"
              >
                {selectMode ? (
                  // 未分類 can never be picked: shown, but disabled.
                  <View className="mr-2.5">
                    <SelectMark state={checked ? 'on' : 'off'} disabled={item.id === 0} />
                  </View>
                ) : (
                  <Ionicons
                    name={item.id === 0 ? 'help-circle-outline' : 'folder-outline'}
                    size={18}
                    color={c.ink2}
                    style={{ marginRight: 10 }}
                  />
                )}
                <View className="flex-1">
                  <Text
                    className={`text-base ${item.id === 0 ? 'italic text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}
                  >
                    {item.name}
                  </Text>
                  <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {statsLine(item)}
                  </Text>
                  {item.location_description ? (
                    <Text
                      className="mt-0.5 text-xs text-gray-400 dark:text-gray-500"
                      numberOfLines={1}
                    >
                      {item.location_description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
            const actions = [
              {
                label: t('common.export'),
                icon: 'share-outline' as const,
                color: 'export' as const,
                onPress: () => handleExport(item),
              },
              ...(item.id !== 0
                ? [
                    {
                      label: t('common.delete'),
                      icon: 'trash-outline' as const,
                      color: 'red' as const,
                      onPress: () => handleDelete(item),
                    },
                  ]
                : []),
            ];
            return (
              <SwipeRowActions actions={actions} disabled={selectMode}>
                {row}
              </SwipeRowActions>
            );
          }}
        />
      )}
      <ProjectEditModal target={editing} onCancel={() => setEditing(null)} onSave={handleSave} />
      <ExportProgressOverlay progress={progress} />
      {selectMode ? (
        <SelectionDock
          count={picked.size}
          actions={[{ label: t('common.delete'), onPress: handleBulkDelete, destructive: true }]}
        />
      ) : null}
    </SafeAreaView>
  );
}
