import { errText } from '~/lib/errText';
import { CollapsibleSection, Section } from '~/components/form/Section';
import { LabeledField, LabeledNumField } from '~/components/form/LabeledField';
import { captureFix } from '~/lib/gnssFix';
import { Ionicons } from '@expo/vector-icons';
import { FolderAreaMap } from '~/components/FolderAreaMap';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import {
  SwipeBlockedArea,
  SwipeBlockProvider,
  SwipeNavArea,
  useSwipeNav,
} from '~/components/SwipeNavigator';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { BackHeaderLeft } from '~/lib/goBack';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { PlotHeaderTitle } from '~/components/plot/PlotHeaderTitle';
import { TabBtn } from '~/components/plot/TabBtn';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  endPlotSurvey,
  getActiveLayers,
  getPlotLayers,
  getPlotSurvey,
  getProject,
  getSite,
  parseGeometry,
  type GeoJSONGeometry,
  layerKeyForIndex,
  listPlotSpecies,
  parseEnvPhotos,
  plotCanAcceptSpecies,
  reopenPlotSurvey,
  setPlotLayerCount,
  updatePlotEnvPhotos,
  updatePlotLayer,
  updatePlotSurvey,
  listSubplots,
  setSubplotCount,
  updateSubplot,
  type Subplot,
  type PlotLayer,
  type PlotSpeciesRecordWithTaxon,
  type PlotSurvey,
  type Project,
  type Site,
  MAX_LAYER_COUNT,
} from '~/db';
import { PlotSpeciesTab } from '~/components/PlotSpeciesTab';
import { plotStatsSummary } from '~/components/PlotDiversityCard';
import { checkPlotCover } from '~/lib/plotCoverCheck';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { TransectTrackControl } from '~/components/TransectTrackControl';
import { isRecordingTarget, pauseIfNot, pauseRecording } from '~/lib/trackRecorder';
import { useSettings, type PlotTab } from '~/stores/settings';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveSession } from '~/stores/activeSession';

import { useRecordEditing } from '~/lib/useRecordEditing';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { confirmReopenOver } from '~/lib/recordCreate';
import { LockedBanner, RecordEditButtons } from '~/components/RecordEditButtons';
import { onVersionRestored, saveVersionSoon } from '~/db/recordVersions';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { PlotQuadratsTab } from '~/components/quadrat/PlotQuadratsTab';
import { PlotFreqTab } from '~/components/quadrat/PlotFreqTab';
import { QuadratSettings } from '~/components/quadrat/QuadratSettings';
import {
  CentreLocationCard,
  EnvAdvancedSection,
  EnvPhotoSectionView,
  LayerSectionView,
  ProjectRow,
  SubplotSectionView,
  SurveyorRow,
  SurveyTimeBox,
} from '~/components/plot/EnvSections';
import { listQuadrats, parseQuadratConfig } from '~/db/quadrats';
import { plotFreqIssueLines } from '~/components/quadrat/plotFreqIssueLines';
import { AdvancedFold } from '~/components/AdvancedFold';
import { MapToggle, useSplitMapOpen } from '~/components/map/SplitMapView';
import { shows, vis } from '~/lib/usageMode';
import { currentUsageMode, useModeT, useUsageMode } from '~/lib/useUsageMode';

export default function PlotDetailScreen() {
  const { t } = useTranslation();

  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const plotId = Number(id);
  useVersionOnLeave('plot', plotId);
  const [plot, setPlot] = useState<PlotSurvey | null>(null);
  /**
   * Restore the tab this plot was last left on — a survey is filled in on the
   * Environment tab once and then lived in on Species, so landing back on
   * Environment after every trip out to the map or the camera is pure friction.
   *
   * Read once through `getState()`, not a selector: this is a starting point,
   * not something that should yank the tab out from under the user if the
   * setting changes while the screen is open. The store is already loaded —
   * `DBProvider` gates the whole app render on it.
   */
  const [tab, setTab] = useState<PlotTab>(() => {
    const last = useSettings.getState().plot_last_tab;
    if (last.plotId === plotId) return last.tab;
    // Volunteers live on 物種 (18j / 18m): it opens first once the plot can take species.
    if (vis(currentUsageMode(), 'plotEnvExtra') === 'adv') {
      const p = getPlotSurvey(plotId);
      if (p && p.plot_type !== 'fixed' && plotCanAcceptSpecies(p)) return 'species';
    }
    return 'env';
  });

  const selectTab = (next: PlotTab) => {
    setTab(next);
    useSettings.getState().set('plot_last_tab', { plotId, tab: next });
  };
  // The rows themselves, not just their count: the tab label needs the count
  // and the navigation-bar title needs the diversity summary, and one query
  // serves both.
  const [records, setRecords] = useState<PlotSpeciesRecordWithTaxon[]>([]);
  const refreshActivePlot = useActivePlot((s) => s.refresh);
  const refreshActiveSession = useActiveSession((s) => s.refresh);

  // Lock + undo / redo (src/lib/useRecordEditing): a finished plot is
  // read-only until unlocked here; every reload after an edit is one step.
  const edit = useRecordEditing('plot', plotId, plot?.status === 'done');
  const { checkpoint, absorb } = edit;
  // Bumped after an undo / redo: the tabs keep local copies of rows (layers,
  // subplots, species) keyed by plot id, so they remount to read them again.
  const [rev, setRev] = useState(0);

  const refresh = useCallback(() => {
    const p = getPlotSurvey(plotId);
    setPlot(p);
    setRecords(p ? listPlotSpecies(p.id) : []);
    refreshActivePlot();
  }, [plotId, refreshActivePlot]);
  const reload = useCallback(() => {
    refresh();
    checkpoint();
  }, [refresh, checkpoint]);
  const reloadQuiet = useCallback(() => {
    refresh();
    absorb();
  }, [refresh, absorb]);

  useEffect(() => {
    reload();
  }, [reload]);
  // Back from a quadrat screen, which writes behind this one: read it again
  // (the edit history restarts on focus anyway, see useRecordEditing).
  useFocusEffect(refresh);
  // A version restored from the versions screen (opened over this one): read everything again.
  useEffect(
    () =>
      onVersionRestored((kind, rid) => {
        if (kind !== 'plot' || rid !== plotId) return;
        setRev((n) => n + 1);
        reload();
      }),
    [plotId, reload],
  );

  const ready = plot ? plotCanAcceptSpecies(plot) : false;
  const mode = useUsageMode();
  const tm = useModeT();
  // Volunteer mode on a transect or point count: 物種 first, 基本資料 second,
  // the title's second line names the kind, diversity is under ⋯ › 進階.
  const simple = !!plot && plot.plot_type !== 'fixed' && vis(mode, 'plotEnvExtra') === 'adv';
  // Split map (18j / 18m): a 「地圖」 toggle at the right of the tab row.
  const mapAllowed = simple && shows(mode, 'splitMapPlot');
  const [mapPref, setMapOpen] = useSplitMapOpen('plot');
  const showMap = mapAllowed && mapPref;
  // The 小樣方 tab exists only on a fixed plot with the module switched on.
  const qcfg = parseQuadratConfig(plot?.quadrat_config);
  const quadratsOn = plot?.plot_type === 'fixed' && qcfg.enabled;
  // Frequency over the whole plot (v78): a 「頻度」 tab, independent of quadrats.
  const freqOn = plot?.plot_type === 'fixed' && qcfg.freqEnabled;
  const freqTally = {
    done: records.filter((r) => r.layer !== 'T' && (r.freq_cells?.includes('1') || (r.freq_count ?? 0) > 0)).length,
    total: records.filter((r) => r.layer !== 'T').length,
  };
  const quadratTally = useMemo(() => {
    const qs = plot && quadratsOn ? listQuadrats(plot.id) : [];
    return { done: qs.filter((q) => q.locked).length, total: qs.length };
    // `plot` is re-read after every edit and on focus, so it stands for the quadrats too.
  }, [plot, quadratsOn]);
  const shownTab: PlotTab = (tab === 'quadrats' && !quadratsOn) || (tab === 'freq' && !freqOn) ? 'env' : tab;

  // Navigation-bar title state. Declared here, above the not-found early
  // return, so the hook order stays stable.
  const statsExpanded = useSettings((s) => s.plot_stats_expanded);
  const setSetting = useSettings((s) => s.set);
  const statsLine = useMemo(() => plotStatsSummary(records), [records]);
  // Σ species cover ≥ total cover; see plotCoverCheck.ts for when it applies.
  const coverCheck = useMemo(
    () => checkPlotCover(plot?.total_cover_pct ?? null, plot ? getPlotLayers(plot.id) : [], records),
    [plot, records],
  );

  // Dominance ⇄ frequency mismatches (same rule as the 頻度 / 物種 tabs), for
  // the end-of-survey confirmation: a reminder there, ending still allowed.
  const freqIssues = freqOn ? plotFreqIssueLines(t, records, qcfg.freqMode) : [];

  /** The tabs by horizontal swipe, in the bar's order, mirroring its buttons
   *  exactly — Species and 頻度 stay shut until the survey can accept species.
   *  Only Environment and Species were reachable (code review L20). Declared
   *  before the not-found early return so the hook order is stable. */
  const tabOrder = ((simple ? ['species', 'env'] : ['env', 'species']).concat(freqOn ? ['freq'] : [], quadratsOn ? ['quadrats'] : []) as PlotTab[]).filter(
    (x) => x === 'env' || x === 'quadrats' || ready,
  );
  const tabAt = tabOrder.indexOf(shownTab);
  const tabNav = useSwipeNav({
    onStep: (dir) => {
      const next = tabOrder[tabAt + dir];
      if (next) selectTab(next);
    },
    hasPrev: tabAt > 0,
    hasNext: tabAt >= 0 && tabAt < tabOrder.length - 1,
  });

  if (!plot) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('nav.plot'), headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500 dark:text-gray-400">{t('plot.notFound')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          headerTitle: () => (
            simple ? (
              <PlotHeaderTitle
                plotid={plot.plotid || t('nav.plot')}
                stats={`${t(plot.plot_type === 'transect' ? 'map.plotTransect' : 'map.plotPointCount')} · ${t('plotStats.sppCount', {
                  count: new Set(records.map((r) => r.taxon_id)).size,
                })}`}
                expanded={statsExpanded}
              />
            ) : (
              <PlotHeaderTitle
                plotid={plot.plotid || t('nav.plot')}
                // Only on the Species tab: on Environment the numbers would be
                // answering a question nobody asked.
                stats={tab === 'species' ? statsLine : null}
                expanded={statsExpanded}
                onToggle={() => setSetting('plot_stats_expanded', !statsExpanded)}
              />
            )
          ),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton
                kind="plot"
                id={plot.id}
                reportHref={`/report/plot/${plot.id}` as Href}
                extra={
                  simple && vis(mode, 'plotDiversity') === 'adv'
                    ? [
                        {
                          label: statsExpanded ? t('plotStats.hideCard') : t('plotStats.title'),
                          icon: 'stats-chart-outline',
                          cap: 'plotDiversity',
                          onPress: () => {
                            setSetting('plot_stats_expanded', !statsExpanded);
                            if (!statsExpanded) selectTab('species');
                          },
                        },
                      ]
                    : []
                }
                onSynced={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
                edit={edit}
                onEdited={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
              />
              <RecordEditButtons
                edit={edit}
                ended={plot.status === 'done'}
                onChanged={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
                inMenu
              />
              {plot.status === 'done' && !edit.locked ? null : (
              <HeaderIconButton
                icon={plot.status === 'done' ? 'refresh-outline' : 'stop-circle-outline'}
                // 結束 is the destructive half of this toggle; 繼續 is not.
                tone={plot.status === 'done' ? 'default' : 'danger'}
                label={plot.status === 'done' ? t('plot.reopen') : t('session.end')}
                onPress={() => {
                  if (plot.status === 'done') {
                    // Reopen force-ends any other active record DB-side: ask
                    // first (code review N2, as 快速名錄's 繼續編輯, M24).
                    void confirmReopenOver().then((go) => {
                      if (!go) return;
                      // Stop a GNSS watch that belongs to something other than this plot.
                      pauseIfNot({ kind: 'plot', id: plot.id });
                      reopenPlotSurvey(plot.id);
                      // Reopen force-ends any active session DB-side too; refresh
                      // both stores so the UI bars + watchers reflect reality.
                      refreshActivePlot();
                      refreshActiveSession();
                      useActiveGloria.getState().refresh();
                      reload();
                    });
                  } else {
                    // The end-time choice doubles as the confirmation; the
                    // cover warning the old Alert carried rides along as a note.
                    void chooseEndTime(plot.stop_ts, {
                      title: t('plot.endTitle'),
                      note: [
                        t('plot.endMsg'),
                        coverCheck.kind === 'total-exceeds-species'
                          ? t('plot.coverExceedsSpecies', { total: coverCheck.total, sum: coverCheck.speciesSum })
                          : null,
                        freqIssues.length ? `${t('plot.quadrats.domFreqTitle')}\n${freqIssues.join('\n')}` : null,
                      ]
                        .filter(Boolean)
                        .join('\n\n'),
                    }).then((chosen) => {
                      if (chosen === undefined) return;
                      if (isRecordingTarget({ kind: 'plot', id: plot.id })) pauseRecording();
                      endPlotSurvey(plot.id, chosen);
                      saveVersionSoon('plot', plot.id, 'done');
                      reload();
                    });
                  }
                }}
              />
              )}
            </View>
          ),
        }}
      />
      <View className="flex-row border-b border-gray-200 bg-card dark:border-gray-700 dark:bg-gray-900">
        {simple ? null : <TabBtn label={t('plot.tabEnv')} active={shownTab === 'env'} onPress={() => selectTab('env')} />}
        <TabBtn
          label={`${t('plot.tabSpecies')} ${records.length > 0 ? records.length : ''}`}
          active={shownTab === 'species'}
          onPress={() => selectTab('species')}
          disabled={!ready}
        />
        {simple ? <TabBtn label={tm('plot.tabEnv')} active={shownTab === 'env'} onPress={() => selectTab('env')} /> : null}
        {mapAllowed ? (
          <View className="justify-center px-2">
            <MapToggle
              on={showMap}
              onPress={() => {
                setMapOpen(!showMap);
                // The map sits beside the species list.
                if (!showMap && ready) selectTab('species');
              }}
            />
          </View>
        ) : null}
        {freqOn ? (
          <TabBtn
            label={`${t('plot.tabFreq')} ${freqTally.done}/${freqTally.total}`}
            active={shownTab === 'freq'}
            onPress={() => selectTab('freq')}
            disabled={!ready}
          />
        ) : null}
        {quadratsOn ? (
          <TabBtn
            label={`${t('plot.tabQuadrats')} ${quadratTally.done}/${quadratTally.total}`}
            active={shownTab === 'quadrats'}
            onPress={() => selectTab('quadrats')}
          />
        ) : null}
      </View>

      <SwipeBlockProvider nav={tabNav}>
        <SwipeNavArea nav={tabNav}>
          {/* EnvTab wraps its content in a `KeyboardAwareScrollView` (from
            `react-native-keyboard-controller`) which auto-scrolls the focused
            TextInput above the keyboard. PlotSpeciesTab wraps its SearchBox
            in KeyboardStickyView so the search row follows the kbd top. */}
          {shownTab === 'env' ? <EnvTab key={rev} plot={plot} onUpdated={reload} locked={edit.locked} /> : null}
          {shownTab === 'freq' ? (
            ready ? (
              <PlotFreqTab key={rev} plot={plot} locked={edit.locked} refuse={edit.refuse} onChanged={reload} onGoSpecies={() => selectTab('species')} />
            ) : (
              <SpeciesGateScreen />
            )
          ) : null}
          {shownTab === 'quadrats' ? (
            <PlotQuadratsTab
              key={rev}
              plot={plot}
              locked={edit.locked}
              unlocked={edit.unlocked}
              refuse={edit.refuse}
              onChanged={reload}
              onSettings={() => selectTab('env')}
            />
          ) : null}
          {shownTab === 'species' ? (
            ready ? (
              <PlotSpeciesTab
                key={rev}
                plot={plot}
                showMap={showMap}
                onChanged={reload}
                lock={{
                  locked: edit.locked,
                  refuse: edit.refuse,
                  deferAudioDelete: edit.deferAudioDelete,
                  onChangedQuiet: reloadQuiet,
                }}
              />
            ) : (
              <SpeciesGateScreen />
            )
          ) : null}
        </SwipeNavArea>
      </SwipeBlockProvider>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Env Tab
// ─────────────────────────────────────────────────────────────────────

function EnvTab({
  plot,
  onUpdated,
  locked,
}: {
  plot: PlotSurvey;
  onUpdated: () => void;
  /** Finished and not unlocked: shown, not editable (touches still scroll). */
  locked: boolean;
}) {
  const router = useRouter();
  const boundary = usePlotBoundary(plot.site_id);
  const coverCheck = useMemo(
    () => checkPlotCover(plot.total_cover_pct, getPlotLayers(plot.id), listPlotSpecies(plot.id)),
    [plot],
  );
  const { t } = useTranslation();
  const tm = useModeT();
  const mode = useUsageMode();
  // Volunteer mode on a transect or point count (18j / 18m): what a volunteer
  // fills stays in view, method, size and terrain fold into one 進階. A fixed
  // plot keeps its full layout in every mode.
  const simple = plot.plot_type !== 'fixed' && vis(mode, 'plotEnvExtra') === 'adv';

  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [surveyorSheetOpen, setSurveyorSheetOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    setProject(getProject(plot.project_id));
  }, [plot.project_id]);

  const patch = (p: Parameters<typeof updatePlotSurvey>[1]) => {
    updatePlotSurvey(plot.id, p);
    onUpdated();
  };

  const captureGps = async () => {
    const fix = await captureFix();
    if (!fix) return;
    try {
      patch({
        decimal_latitude: fix.lat,
        decimal_longitude: fix.lng,
        coord_uncertainty_m: fix.accuracy,
        // Grab altitude (海拔) from the same GNSS fix; keep existing value if the
        // device couldn't resolve altitude (often null indoors / poor signal).
        ...(fix.altitudeM != null ? { elevation_m: Math.round(fix.altitudeM), elevation_source: 'gnss' } : null),
        start_ts: plot.start_ts ?? Date.now(),
      });
    } catch (e) {
      Alert.alert(t('gnss.posFailTitle'), errText(e));
    }
  };

  // A transect needs no plot size / unit: its track length gives its extent.
  const sizeFields =
    plot.plot_type !== 'transect' ? (
      <>
        <LabeledNumField
          label={tm('plot.sampleSizeValue')}
          value={plot.sample_size_value}
          placeholder={t('plot.egSampleSize')}
          onSave={(n) => patch({ sample_size_value: n })}
        />
        <LabeledField
          label={tm('plot.sampleSizeUnit')}
          value={plot.sample_size_unit ?? ''}
          placeholder={t('plot.egSampleUnit')}
          onSave={(v) => patch({ sample_size_unit: v || null })}
        />
      </>
    ) : null;
  const protocolField = (
    <LabeledField
      label={tm('plot.samplingProtocol')}
      value={plot.sampling_protocol ?? ''}
      placeholder={t('plot.egProtocol')}
      onSave={(v) => patch({ sampling_protocol: v || null })}
    />
  );
  // Total vegetation cover belongs to vegetation plots; volunteers count.
  const totalCoverField = shows(mode, 'plotTotalCover') ? (
    <>
      <LabeledNumField
        label={t('plot.totalCover')}
        value={plot.total_cover_pct}
        suffix="%"
        min={0}
        max={100}
        onSave={(n) => patch({ total_cover_pct: n })}
      />
      {/* Same place and shape as the ground-cover sum hint above. Only ever a
          note: a survey in progress legitimately has fewer species recorded
          than the total cover implies. */}
      {coverCheck.kind === 'total-exceeds-species' ? (
        <Text className="mb-3 -mt-1 text-xs text-amber-700 dark:text-amber-400">
          {t('plot.coverExceedsSpecies', {
            total: coverCheck.total,
            sum: coverCheck.speciesSum,
          })}
        </Text>
      ) : null}
    </>
  ) : null;
  const placeAndNotes = (
    <>
      <LabeledField
        label={tm('plot.locality')}
        value={plot.locality ?? ''}
        placeholder={t('plot.egLocality')}
        onSave={(v) => patch({ locality: v || null })}
        multiline
      />
      <LabeledField
        label={tm('plot.fieldNote')}
        value={plot.field_note ?? ''}
        onSave={(v) => patch({ field_note: v || null })}
        multiline
      />
    </>
  );
  const envAdvanced = (open: boolean) => (
    <EnvAdvancedSection
      values={plot}
      defaultExpanded={open || undefined}
      // A typed elevation is a manual one (GNSS fixes set their own source).
      onPatch={(p) => patch('elevation_m' in p ? { ...p, elevation_source: p.elevation_m != null ? 'manual' : null } : p)}
    />
  );

  return (
    <KeyboardAwareScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      {locked ? <LockedBanner /> : null}
      <View pointerEvents={locked ? 'none' : 'auto'}>
      <Section title={t('plot.required')} required>
        <LabeledField label={tm('plot.plotidLabel')} value={plot.plotid} onSave={(v) => patch({ plotid: v })} required />

        <ProjectRow project={project} onPress={() => setProjectSheetOpen(true)} />

        {plot.plot_type === 'transect' ? (
          <TransectTrackControl plot={plot} onUpdated={onUpdated} />
        ) : (
          <CentreLocationCard
            lat={plot.decimal_latitude}
            lng={plot.decimal_longitude}
            accuracy={plot.coord_uncertainty_m}
            elevation={plot.elevation_m}
            boundary={boundary}
            onCapture={captureGps}
            onPlace={(lat, lng, accuracy) =>
              patch({
                decimal_latitude: lat,
                decimal_longitude: lng,
                // Hand-placed arrives as null; an undo restores the measured
                // value that was there before.
                coord_uncertainty_m: accuracy,
              })
            }
            // A point count's extent is its radius; volunteers are not offered a boundary.
            onDrawBoundary={
              shows(mode, 'plotRange') && !(simple && plot.plot_type === 'point_count')
                ? () => router.push(`/(tabs)/map?draw=Polygon&plot=${plot.id}` as Href)
                : undefined
            }
          />
        )}

        {plot.plot_type === 'point_count' ? (
          <>
            <LabeledNumField
              label={tm('plot.radius')}
              value={plot.point_radius_m}
              placeholder={t('plot.egRadius')}
              suffix="m"
              onSave={(n) => patch({ point_radius_m: n })}
            />
          </>
        ) : null}
        {/* Start / end: typed by hand for old field sheets, or set to now. For a
            point count they are the count's own time. */}
        <SurveyTimeBox
          title={plot.plot_type === 'point_count' ? t('plot.countTime') : t('surveyTime.title')}
          start={plot.start_ts}
          end={plot.stop_ts}
          readOnly={locked}
          onChange={(which, ts) => patch(which === 'start' ? { start_ts: ts } : { stop_ts: ts })}
        />

        <SurveyorRow value={plot.recorded_by} onPress={() => setSurveyorSheetOpen(true)} />
      </Section>

      {/* A transect has no centre-point map to carry the boundary, so it keeps
          the boundary in its own section. */}
      {plot.plot_type === 'transect' && !simple ? <PlotBoundarySection plot={plot} /> : null}

      {simple ? (
        <Section title={t('plot.placeAndNotes')}>{placeAndNotes}</Section>
      ) : (
        <CollapsibleSection title={t('plot.basicInfo')}>
          {sizeFields}
          {protocolField}
          {totalCoverField}
          {placeAndNotes}
        </CollapsibleSection>
      )}

      {plot.plot_type === 'fixed' ? <LayerSection plot={plot} onUpdated={onUpdated} /> : null}

      {plot.plot_type === 'fixed' ? <SubplotSection plot={plot} onUpdated={onUpdated} /> : null}

      {plot.plot_type === 'fixed' ? (
        // The section title is upper-cased, which would turn "1 × 1 m" into "M";
        // the full name is on the switch inside.
        <CollapsibleSection
          title={t('plot.quadrats.section')}
          defaultExpanded={parseQuadratConfig(plot.quadrat_config).enabled || parseQuadratConfig(plot.quadrat_config).freqEnabled}
        >
          <QuadratSettings plot={plot} onUpdated={onUpdated} />
        </CollapsibleSection>
      ) : null}

      {simple ? null : envAdvanced(false)}

      <EnvPhotoSection plot={plot} onUpdated={onUpdated} />

      {simple ? (
        <AdvancedFold className="mx-4 mt-4" summary={t('mode.advPlot')}>
          {/* The sections carry their own px-4. */}
          <View className="-mx-4">
            <Section title={t('plot.basicInfo')}>
              {protocolField}
              {sizeFields}
            </Section>
            {envAdvanced(true)}
            {plot.plot_type === 'transect' && vis(mode, 'plotRange') === 'adv' ? <PlotBoundarySection plot={plot} /> : null}
          </View>
        </AdvancedFold>
      ) : null}

      <View className="h-12" />

      <ProjectAssignSheet
        visible={projectSheetOpen}
        currentProjectId={plot.project_id}
        onCancel={() => setProjectSheetOpen(false)}
        onAssign={(projectId) => {
          patch({ project_id: projectId });
          setProjectSheetOpen(false);
        }}
      />
      <SurveyorAssignSheet
        visible={surveyorSheetOpen}
        current={plot.recorded_by ?? ''}
        onCancel={() => setSurveyorSheetOpen(false)}
        onAssign={(v) => {
          patch({ recorded_by: v || null });
          setSurveyorSheetOpen(false);
        }}
      />
      </View>
    </KeyboardAwareScrollView>
  );
}

/**
 * The plot boundary (its linked `sites` row) as geometry, or null. Re-read when
 * `site_id` changes; drawing on the map screen comes back via `router.replace`,
 * which remounts this screen. A malformed row shows as no boundary rather than
 * taking the environment tab down.
 */
function usePlotBoundary(siteId: number | null): GeoJSONGeometry | null {
  const [geometry, setGeometry] = useState<GeoJSONGeometry | null>(null);
  useEffect(() => {
    const site = siteId !== null ? getSite(siteId) : null;
    let next: GeoJSONGeometry | null = null;
    if (site) {
      try {
        next = parseGeometry(site);
      } catch {
        next = null;
      }
    }
    setGeometry(next);
  }, [siteId]);
  return geometry;
}

/** Section with a tappable header that collapses/expands its body. Matches the
 *  visual style of `Section`; default collapsed to declutter the env tab. */
/**
 * 樣區範圍 — the plot's boundary, stored as a linked `sites` row (that table is
 * the app's one geometry container, and `plot_surveys.site_id` already existed
 * for it). Read-only here: drawing hands over to the map screen, the only place
 * with vertex handles, and comes back via `router.replace`.
 *
 * Transects only: fixed and point-count plots draw the boundary on the
 * centre-point map in the GNSS card instead (two native maps on one screen is
 * what the mini-map components go out of their way to avoid). Collapsed by
 * default when there is no boundary — `CollapsibleSection` renders nothing
 * while closed, so the MapView is not mounted.
 */
function PlotBoundarySection({ plot }: { plot: PlotSurvey }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [site, setSite] = useState<Site | null>(null);

  useEffect(() => {
    setSite(plot.site_id !== null ? (getSite(plot.site_id) ?? null) : null);
  }, [plot.site_id]);

  return (
    <CollapsibleSection title={t('plot.rangeSection')} defaultExpanded={plot.site_id !== null}>
      {/* FolderAreaMap carries its own mx-4; cancel it so the card lines up
          with the sibling sections instead of sitting 32px in. */}
      <View className="-mx-4">
        <SwipeBlockedArea>
          <FolderAreaMap
            areaGeoJson={site?.geometry_geojson ?? ''}
            onEdit={() => router.push(`/(tabs)/map?draw=Polygon&plot=${plot.id}` as Href)}
            title={t('plot.rangeTitle')}
            emptyLabel={t('plot.drawRange')}
            editLabel={t('plot.editRange')}
          />
        </SwipeBlockedArea>
      </View>
      <Text className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
        {t('plot.rangeHint')}
      </Text>
    </CollapsibleSection>
  );
}

/** 小區 on a fixed plot: its `plot_subplots` rows through SubplotSectionView. */
function SubplotSection({ plot, onUpdated }: { plot: PlotSurvey; onUpdated: () => void }) {
  const [subplots, setSubplots] = useState<Subplot[]>([]);
  const reload = useCallback(() => setSubplots(listSubplots(plot.id)), [plot.id]);
  useEffect(() => reload(), [reload]);
  return (
    <SubplotSectionView
      subplots={subplots}
      setCount={(n) => {
        setSubplotCount(plot.id, n);
        return listSubplots(plot.id);
      }}
      update={(id, fields) => updateSubplot(id, fields)}
      onChanged={() => {
        reload();
        onUpdated();
      }}
    />
  );
}

function SpeciesGateScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 items-center justify-center px-8">
      <Ionicons name="lock-closed-outline" size={48} color="#fbbf24" />
      <Text className="mt-3 text-center text-gray-500 dark:text-gray-400">
        {t('plot.speciesGate')}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Layer section (rendered inside EnvTab for fixed plots)
// ─────────────────────────────────────────────────────────────────────

/** 分層 on a fixed plot: its `plot_survey_layers` rows through LayerSectionView. */
function LayerSection({ plot, onUpdated }: { plot: PlotSurvey; onUpdated: () => void }) {
  const [layers, setLayers] = useState<PlotLayer[]>([]);
  useEffect(() => {
    setLayers(getPlotLayers(plot.id));
  }, [plot.id, plot.layer_count]);
  return (
    <LayerSectionView
      layerCount={plot.layer_count}
      maxLayers={MAX_LAYER_COUNT}
      activeLayers={getActiveLayers(plot.layer_count)}
      layers={layers}
      onLayerCount={(n) => {
        setPlotLayerCount(plot.id, n);
        onUpdated();
      }}
      onPatchLayer={(layerIdx, fields) => {
        updatePlotLayer(plot.id, layerIdx, fields);
        setLayers(getPlotLayers(plot.id));
        onUpdated();
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Env photo section
// ─────────────────────────────────────────────────────────────────────

function EnvPhotoSection({ plot, onUpdated }: { plot: PlotSurvey; onUpdated: () => void }) {
  const { t } = useTranslation();
  const photos = parseEnvPhotos(plot.env_photos_json);
  return (
    <EnvPhotoSectionView
      photos={photos}
      hint={t('plot.envPhotoNaming', { plotid: plot.plotid || '<plotid>' })}
      onAppend={(uris) => {
        updatePlotEnvPhotos(plot.id, [...photos, ...uris]);
        onUpdated();
      }}
      onRemove={(uri) => {
        updatePlotEnvPhotos(
          plot.id,
          photos.filter((u) => u !== uri),
        );
        onUpdated();
      }}
    />
  );
}
