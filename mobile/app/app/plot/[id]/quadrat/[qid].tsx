/**
 * One 1×1 m quadrat of a fixed plot (06-plot-quadrats.md §3.3): cover of each
 * species (with the surface cover) and its frequency on the grid_n × grid_n
 * cells, as GLORIA records them.
 *
 * Writes go through src/db/quadrats.ts, which refuses edits to a locked
 * quadrat and a 0 % cover; each write is one step of the plot's undo history
 * (useRecordEditing), so a painted stroke — written once when the finger
 * lifts — undoes as one. An ended plot is read-only here too until unlocked
 * from the ⋯ menu, as on the plot screen.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View, type TextInput } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { LockedBanner } from '~/components/RecordEditButtons';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import type { FrequencyGridHandle } from '~/components/quadrat/FrequencyGrid';
import { StatusBadge } from '~/components/quadrat/PlotQuadratsTab';
import { SurfaceCover } from '~/components/quadrat/SurfaceCover';
import { quadratName, topEdgeName } from '~/components/quadrat/names';
import { StepPager } from '~/components/ui/StepPager';
import { Button } from '~/components/ui/Button';
import { FrequencyPanel, type FreqItem } from '~/components/quadrat/FrequencyPanel';
import { getPlotSurvey, layerLabel, listPlotSpecies, listSubplots, parseEnvPhotos, type PlotSurvey } from '~/db/plots';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { errText } from '~/lib/errText';
import {
  addQuadratSpecies,
  deleteQuadrat,
  deleteQuadratSpecies,
  listQuadrats,
  listQuadratSpeciesWithTaxon,
  parseQuadratConfig,
  previousQuadratTaxa,
  QuadratError,
  setQuadratLocked,
  SURFACE_COLUMNS,
  switchFreqMode,
  updateQuadrat,
  updateQuadratSpecies,
  type Quadrat,
  type QuadratSpeciesWithTaxon,
  type SurfaceColumn,
} from '~/db/quadrats';
import { resolveTaxa } from '~/db/taxonLookup';
import { BackHeaderLeft } from '~/lib/goBack';
import { freqCells, quadratProgress } from '~/lib/quadratProgress';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { Btn, FoldBanner, BannerText, NumAccessory, NumField } from '~/modules/gloria/components/ui';
import { autoFillLast, exactSum } from '~/modules/gloria/model/validate';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { useSettledCall } from '~/lib/useSettledCall';

type View_ = 'cover' | 'freq';

const nameOf = (s: { common_name_c?: string; simple_name?: string; taxon_id: string }) => s.common_name_c || s.simple_name || s.taxon_id;
const keyOf = (s: { id: number }) => `s${s.id}`;

export default function QuadratScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  // `unlocked=1`: the plot screen this was opened from had the ended plot unlocked.
  const params = useLocalSearchParams<{ id: string; qid: string; unlocked?: string }>();
  const plotId = Number(params.id);
  const qid = Number(params.qid);
  useVersionOnLeave('plot', plotId);

  const [plot, setPlot] = useState<PlotSurvey | null>(() => getPlotSurvey(plotId));
  const edit = useRecordEditing('plot', plotId, plot?.status === 'done', params.unlocked === '1');
  const [all, setAll] = useState<Quadrat[]>([]);
  const [species, setSpecies] = useState<QuadratSpeciesWithTaxon[]>([]);
  const quadrat = all.find((q) => q.id === qid) ?? null;

  const load = useCallback(() => {
    setPlot(getPlotSurvey(plotId));
    setAll(listQuadrats(plotId));
    setSpecies(listQuadratSpeciesWithTaxon(qid));
  }, [plotId, qid]);
  const { checkpoint } = edit;
  /** After a write: read again, and the change becomes one undo step. */
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);
  useFocusEffect(load);
  useEffect(() => load(), [load]);

  const cfg = useMemo(() => parseQuadratConfig(plot?.quadrat_config), [plot?.quadrat_config]);
  const [view, setView] = useState<View_>(() => (cfg.recordCover ? 'cover' : 'freq'));
  const locked = quadrat?.locked === 1;
  // Say so once on arrival; the header lock shows it from then on.
  const toastedLock = useRef(false);
  useEffect(() => {
    if (!quadrat || toastedLock.current) return;
    toastedLock.current = true;
    if (quadrat.locked) toast(t('plot.quadrats.lockedToast'));
  }, [quadrat, t, toast]);

  const grid = useRef<FrequencyGridHandle>(null);
  const flushStroke = () => grid.current?.flush();

  /** True when an edit must not happen (and says why). */
  const refused = () => {
    if (edit.refuse()) return true;
    if (locked) {
      toast(t('plot.quadrats.lockedToast'));
      return true;
    }
    return false;
  };
  /** Run a write; the DB layer's refusals become a toast. */
  const run = (fn: () => void, onInvalid?: () => void): boolean => {
    if (refused()) return false;
    settled.flush();
    try {
      fn();
    } catch (e) {
      if (!(e instanceof QuadratError)) throw e;
      if (e.code === 'locked') toast(t('plot.quadrats.lockedToast'));
      else onInvalid?.();
      return false;
    }
    reload();
    return true;
  };
  // Strokes and counts: written at once, reloaded (with the undo snapshot)
  // once the painting pauses — a reload per tap made the brush lag.
  const settled = useSettledCall(reload);
  const runQuiet: QuietRun = (fn, onInvalid, patch) => {
    if (refused()) return false;
    try {
      fn();
    } catch (e) {
      if (!(e instanceof QuadratError)) throw e;
      if (e.code === 'locked') toast(t('plot.quadrats.lockedToast'));
      else onInvalid?.();
      return false;
    }
    // Patched in here so a re-render before the reload shows the stroke.
    if (patch) setSpecies((ss) => ss.map((x) => (x.id === patch.id ? { ...x, ...patch } : x)));
    settled.schedule();
    return true;
  };

  const subplotLabels = useMemo(() => new Map(listSubplots(plotId).map((s) => [s.id, s.label])), [plotId]);
  const layerOf = plotLayers(plotId, plot?.updated_at ?? 0);
  // Frequency's layer filter lives in the ⋯ menu (it was a chip row that
  // took room from the grid).
  const [layer, setLayer] = useState<string | null>(null);
  const progress = quadrat
    ? quadratProgress(quadrat, species.map((s) => ({ ...s, name: nameOf(s) })), { cover: cfg.recordCover, freq: cfg.recordFreq })
    : null;

  if (!plot || !quadrat || !progress) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500 dark:text-gray-400">{t('plot.quadrats.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const index = all.findIndex((q) => q.id === quadrat.id);
  const name = quadratName(t, quadrat, (id) => subplotLabels.get(id));
  const step = (dir: -1 | 1) => {
    flushStroke();
    const next = all[index + dir];
    if (next) router.setParams({ qid: String(next.id) });
  };

  const menu = async () => {
    flushStroke();
    const items: { label: string; destructive?: boolean; run: () => void }[] = [];
    const layers = [...new Set(species.map((s) => layerOf.get(s.taxon_id)).filter((l): l is string => !!l))];
    if (shown === 'freq' && layers.length) {
      const opt = (l: string | null) => ({
        label: `${layer === l ? '✓ ' : ''}${t('plot.quadrats.filterLayer', {
          layer: l ?? t('plot.quadrats.all'),
          n: l ? species.filter((s) => layerOf.get(s.taxon_id) === l).length : species.length,
        })}`,
        run: () => setLayer(l),
      });
      items.push(opt(null), ...layers.map(opt));
    }
    if (edit.locked || edit.unlocked) {
      items.push({
        label: edit.locked ? t('recordLock.unlock') : t('recordLock.relock'),
        run: () => edit.setUnlocked(edit.locked),
      });
    }
    if (!edit.locked) {
      items.push(
        locked
          ? {
              label: t('plot.quadrats.unlock'),
              run: () => {
                setQuadratLocked(quadrat.id, false);
                reload();
                toast(t('plot.quadrats.unlocked'));
              },
            }
          : { label: t('plot.quadrats.finishLock', { label: quadrat.label }), run: finish },
      );
      if (edit.undoCount > 0) items.push({ label: t('recordLock.undo'), run: () => { edit.undo(); load(); } });
      if (edit.redoCount > 0) items.push({ label: t('recordLock.redo'), run: () => { edit.redo(); load(); } });
      items.push({
        label: t('plot.quadrats.delete'),
        destructive: true,
        run: () =>
          Alert.alert(t('plot.quadrats.delete'), t('plot.quadrats.deleteConfirm', { label: quadrat.label, n: species.length }), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: () => {
                deleteQuadrat(quadrat.id);
                checkpoint();
                router.back();
              },
            },
          ]),
      });
    }
    const i = await showActionSheet({ title: name, options: items.map(({ label, destructive }) => ({ label, destructive })) });
    if (i >= 0) items[i].run();
  };

  const finish = () => {
    flushStroke();
    if (edit.refuse()) return;
    setQuadratLocked(quadrat.id, true);
    reload();
    toast(t('plot.quadrats.lockedDone', { label: quadrat.label }));
  };

  const both = cfg.recordCover && cfg.recordFreq;
  const shown: View_ = !cfg.recordFreq ? 'cover' : !cfg.recordCover ? 'freq' : view;
  const cross = progress.issues;
  const noFreq = cross.filter((i) => i.kind === 'cover-no-freq').map((i) => i.species);
  const noCover = cross.filter((i) => i.kind === 'freq-no-cover').map((i) => i.species);
  const ro = edit.locked || locked;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          headerLeft: BackHeaderLeft,
          headerTitle: () => (
            <View>
              <View className="flex-row items-center gap-1.5">
                <StatusBadge label={quadrat.label} status={progress.status} size="sm" />
                <Text className="font-semibold text-ink dark:text-gray-100" style={{ fontSize: 15, maxWidth: 150 }} numberOfLines={1}>
                  {name.slice(quadrat.label.length).trim() || quadrat.label}
                </Text>
                {locked ? <Ionicons name="lock-closed" size={13} color={c.ink2} /> : null}
              </View>
              <Text className="text-ink-2 dark:text-gray-300" style={{ fontSize: 11 }} numberOfLines={1}>
                {[
                  plot.plotid,
                  `${quadrat.size_m} × ${quadrat.size_m} m`,
                  t('plot.quadrats.gridCells', { n: quadrat.grid_n }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ),
          headerRight: () => (
            <View className="flex-row items-center gap-2">
              <StepPager index={index} total={all.length} onStep={step} />
              <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void menu()} />
            </View>
          ),
        }}
      />

      {edit.locked ? <LockedBanner text={t('plot.quadrats.plotLocked')} /> : null}
      {both ? (
        <View className="px-4 pt-3">
          <ViewSeg
            value={shown}
            onChange={(v) => {
              flushStroke();
              setView(v);
            }}
            freq={{ done: progress.withFreq, total: progress.species }}
          />
        </View>
      ) : null}

      {/* The frequency view marks the same thing on its badge and dots, and
          needs the room for its grid. */}
      {shown === 'cover' && (noFreq.length || noCover.length) ? (
        <View className="px-4 pt-3">
          <FoldBanner tone="error" title={t('plot.quadrats.crossTitle')} count={cross.length}>
            {noFreq.length ? <BannerText tone="error">{t('plot.quadrats.coverNoFreq', { names: noFreq.join('、') })}</BannerText> : null}
            {noCover.length ? <BannerText tone="error">{t('plot.quadrats.freqNoCover', { names: noCover.join('、') })}</BannerText> : null}
          </FoldBanner>
        </View>
      ) : null}

      {shown === 'cover' ? (
        <CoverBody
          key={quadrat.id}
          plot={plot}
          quadrat={quadrat}
          species={species}
          cfg={cfg}
          ro={ro}
          run={run}
          onFinish={locked ? undefined : finish}
        />
      ) : (
        <FreqBody
          key={quadrat.id}
          gridRef={grid}
          quadrat={quadrat}
          species={species}
          ro={ro}
          layerOf={layerOf}
          layer={layer}
          onLayer={setLayer}
          run={run}
          runQuiet={runQuiet}
          refused={refused}
          topEdge={topEdgeName(t, quadrat.top_edge)}
          onFinish={locked ? undefined : finish}
        />
      )}
      <NumAccessory />
    </SafeAreaView>
  );
}

type Run = (fn: () => void, onInvalid?: () => void) => boolean;
type QuietRun = (
  fn: () => void,
  onInvalid?: () => void,
  patch?: { id: number; freq_cells?: string | null; freq_count?: number | null },
) => boolean;

/**
 * Taxon → its layer in the plot list, named without the E-number ("灌木層").
 * `stamp` only makes the React Compiler read again after a plot write.
 */
function plotLayers(plotId: number, stamp: number): Map<string, string> {
  void stamp;
  const out = new Map<string, string>();
  for (const r of listPlotSpecies(plotId)) {
    if (!out.has(r.taxon_id) && r.layer !== 'T') out.set(r.taxon_id, layerLabel(r.layer).replace(/^E\d\s*/, ''));
  }
  return out;
}

/** 覆蓋度 ｜ 頻度 n/m (design 10d): the badge is alert-toned until every species has cells. */
function ViewSeg({ value, onChange, freq }: { value: View_; onChange: (v: View_) => void; freq: { done: number; total: number } }) {
  const { t } = useTranslation();
  const complete = freq.total > 0 && freq.done === freq.total;
  const tab = (v: View_, label: string, badge?: React.ReactNode) => {
    const on = value === v;
    return (
      <Pressable
        onPress={() => onChange(v)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-md py-1.5 ${on ? 'bg-card dark:bg-gray-700' : ''}`}
      >
        <Text className={`text-sm ${on ? 'font-semibold text-ink dark:text-gray-100' : 'text-ink-2 dark:text-gray-400'}`}>{label}</Text>
        {badge}
      </Pressable>
    );
  };
  return (
    <View className="flex-row rounded-lg bg-disc p-0.5 dark:bg-disc-dark" accessibilityRole="tablist">
      {tab('cover', t('plot.quadrats.cover'))}
      {tab(
        'freq',
        t('plot.quadrats.frequency'),
        freq.total > 0 ? (
          <View className={`rounded-full px-1.5 ${complete ? 'bg-accent-100 dark:bg-accent-900' : 'bg-alert-tint dark:bg-alert-dark-tint'}`}>
            <Text className={`text-xs font-bold ${complete ? 'text-accent-700 dark:text-accent-300' : 'text-alert dark:text-alert-dark'}`}>
              {`${freq.done}/${freq.total}`}
            </Text>
          </View>
        ) : null,
      )}
    </View>
  );
}

type CoverProps = {
  plot: PlotSurvey;
  quadrat: Quadrat;
  species: QuadratSpeciesWithTaxon[];
  cfg: ReturnType<typeof parseQuadratConfig>;
  ro: boolean;
  run: Run;
  onFinish?: () => void;
};

/** Surface cover, species cover, quick picks from the plot list, and the search dock. */
function CoverBody({ plot, quadrat, species, cfg, ro, run, onFinish }: CoverProps) {
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const coverRefs = useRef(new Map<number, TextInput>());
  // A species just added gets its cover field focused (numeric pad up), once
  // its row exists after the reload — as on GLORIA's unit screen.
  const focusTaxon = useRef<string | null>(null);
  // Bumped to reset a cover field whose entry was refused (a 0).
  const [resetN, setResetN] = useState(0);
  const [surfaceOpen, setSurfaceOpen] = useState(true);
  const [dockH, setDockH] = useState(0);

  useEffect(() => {
    const row = focusTaxon.current ? species.find((s) => s.taxon_id === focusTaxon.current) : undefined;
    const field = row ? coverRefs.current.get(row.id) : undefined;
    if (!field) return;
    focusTaxon.current = null;
    field.focus();
  });

  const have = new Set(species.map((s) => s.taxon_id));
  // Quick picks: the plot's herb layer (moss layer when it has one layer only).
  const herb = plot.layer_count >= 2 ? 'E2' : 'E1';
  const fromPlot = useMemo(() => {
    const seen = new Set<string>();
    return listPlotSpecies(plot.id)
      .filter((r) => r.layer === herb && !seen.has(r.taxon_id) && (seen.add(r.taxon_id), true))
      .map((r) => ({ taxon_id: r.taxon_id, name: nameOf(r) }));
  }, [plot.id, herb]);
  const previous = useMemo(() => {
    if (!cfg.carryPrevious) return [];
    const ids = previousQuadratTaxa(plot.id, quadrat.idx);
    const taxa = resolveTaxa(ids);
    return ids.map((id) => ({ taxon_id: id, name: nameOf({ ...taxa.get(id), taxon_id: id }) }));
  }, [cfg.carryPrevious, plot.id, quadrat.idx]);

  const add = (taxonId: string) => {
    if (cfg.recordCover) focusTaxon.current = taxonId;
    if (!run(() => void addQuadratSpecies(quadrat.id, taxonId))) focusTaxon.current = null;
  };
  const surfaceValues = Object.fromEntries(SURFACE_COLUMNS.map((k) => [k, quadrat[k]])) as Record<SurfaceColumn, number | null>;
  const commitSurface = (p: Partial<Record<SurfaceColumn, number | null>>) => {
    // Filling the sixth of seven completes the seventh, as in GLORIA.
    const edited = Object.keys(p)[0] as SurfaceColumn;
    const fill = autoFillLast({ ...surfaceValues, ...p }, SURFACE_COLUMNS, edited);
    run(() => updateQuadrat(quadrat.id, fill ? { ...p, [fill.key]: fill.value } : p));
  };
  const surfaceSum = SURFACE_COLUMNS.every((k) => quadrat[k] == null)
    ? null
    : exactSum(SURFACE_COLUMNS.reduce((a, k) => a + (quadrat[k] ?? 0), 0));
  const speciesSum = exactSum(species.reduce((a, s) => a + (s.cover_pct ?? 0), 0));
  const cells = quadrat.grid_n * quadrat.grid_n;

  const chips = (list: { taxon_id: string; name: string }[], label: string) => {
    const left = list.filter((x) => !have.has(x.taxon_id));
    if (!left.length || ro) return null;
    return (
      <View className="gap-1.5">
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{label}</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {left.map((x) => (
            <Pressable
              key={x.taxon_id}
              onPress={() => add(x.taxon_id)}
              accessibilityRole="button"
              className="flex-row items-center rounded-full border-[1.5px] border-dashed border-gray-400 px-3 py-1.5 active:bg-gray-100 dark:border-gray-500 dark:active:bg-gray-800"
            >
              <Ionicons name="add" size={14} color={c.accent} />
              <Text className="ml-0.5 text-sm text-ink dark:text-gray-100">{x.name}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  };

  return (
    <>
      {/* Keeps the focused cover field above the keyboard AND the search dock
          (bottomOffset); RN's own inset adjustment is iOS-only. */}
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={dockH + 12}>
        {cfg.recordSurface ? (
          <View className="gap-2 rounded-card border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
            <Pressable onPress={() => setSurfaceOpen(!surfaceOpen)} accessibilityRole="button" accessibilityState={{ expanded: surfaceOpen }} className="flex-row items-center">
              <Ionicons name={surfaceOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={c.ink3} />
              <Text className="ml-1 flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('plot.quadrats.surface')}</Text>
              {surfaceSum != null ? (
                <Text className={`text-xs font-semibold ${surfaceSum === 100 ? 'text-accent-600 dark:text-accent-400' : 'text-alert dark:text-alert-dark'}`}>
                  {surfaceSum === 100 ? t('gloria.cover.sumOk', { sum: surfaceSum }) : t('gloria.cover.sumBad', { sum: surfaceSum })}
                </Text>
              ) : null}
            </Pressable>
            {surfaceOpen ? (
              <SurfaceCover
                values={surfaceValues}
                keys={SURFACE_COLUMNS}
                labelKey={(k) => `gloria.cover.${k}`}
                shortKey={(k) => `gloria.cover.short.${k}`}
                onCommit={commitSurface}
                editable={!ro}
              />
            ) : null}
          </View>
        ) : null}

        {cfg.recordCover ? (
          <View className="flex-row items-center">
            <Text className="flex-1 text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
              {t('plot.quadrats.cover')}
            </Text>
            <Text className="text-xs font-semibold text-ink-2 dark:text-gray-300">{t('plot.quadrats.coverSum', { sum: speciesSum })}</Text>
          </View>
        ) : null}
        <View className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
          {species.length === 0 ? (
            <Text className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('plot.quadrats.noSpecies')}</Text>
          ) : (
            species.map((s, i) => (
              <Pressable
                key={s.id}
                onLongPress={async () => {
                  if (ro) return;
                  const k = await showActionSheet({ title: nameOf(s), options: [{ label: t('plot.quadrats.removeSpecies'), destructive: true }] });
                  if (k === 0) run(() => deleteQuadratSpecies(s.id));
                }}
                delayLongPress={350}
                className={`flex-row items-center px-4 py-2.5 ${i < species.length - 1 ? 'border-b border-line dark:border-line-dark' : ''}`}
              >
                <View className="flex-1 pr-2">
                  <Text className="text-base text-ink dark:text-gray-100" numberOfLines={1}>
                    {nameOf(s)}
                  </Text>
                  {s.simple_name ? (
                    <ScientificName name={s.simple_name} kingdom={s.kingdom} rank={s.rank} className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1} />
                  ) : null}
                </View>
                {cfg.recordFreq ? (
                  <Text className="mr-3 text-xs text-ink-2 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>
                    {t('plot.quadrats.freqShort', { pct: Math.round((freqCells(s, quadrat.freq_mode) / cells) * 100) })}
                  </Text>
                ) : null}
                {cfg.recordCover ? (
                  <NumField
                    ref={(r) => {
                      if (r) coverRefs.current.set(s.id, r);
                      else coverRefs.current.delete(s.id);
                    }}
                    value={s.cover_pct}
                    target={`${s.id}:${resetN}`}
                    range={{ min: 0, max: 100, unit: '%' }}
                    width={72}
                    editable={!ro}
                    accessibilityLabel={t('plot.quadrats.coverOf', { name: nameOf(s) })}
                    onSubmitEditing={i < species.length - 1 ? () => coverRefs.current.get(species[i + 1].id)?.focus() : undefined}
                    onPrev={i > 0 ? () => coverRefs.current.get(species[i - 1].id)?.focus() : undefined}
                    onCommit={(v) => {
                      if (v === 0) {
                        toast(t('plot.quadrats.coverZero'));
                        setResetN((n) => n + 1);
                        return;
                      }
                      run(() => updateQuadratSpecies(s.id, { cover_pct: v }), () => setResetN((n) => n + 1));
                    }}
                  />
                ) : null}
              </Pressable>
            ))
          )}
        </View>

        {chips(fromPlot, t('plot.quadrats.fromPlotList'))}
        {chips(previous, t('plot.quadrats.fromPrevious'))}

        <QuadratPhotos quadrat={quadrat} ro={ro} run={run} />

        {onFinish && !ro ? (
          <Btn label={t('plot.quadrats.finishLock', { label: quadrat.label })} onPress={onFinish} />
        ) : null}
      </KeyboardAwareScrollView>
      {!ro ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View onLayout={(e) => setDockH(e.nativeEvent.layout.height)}>
            <SearchBox onSelect={(r) => r.taxon_id && add(r.taxon_id)} />
          </View>
        </KeyboardStickyView>
      ) : null}
    </>
  );
}

/** The quadrat's photos (v77 photo_paths), taken like the plot's environment photos. */
function QuadratPhotos({ quadrat, ro, run }: { quadrat: Quadrat; ro: boolean; run: Run }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const photos = parseEnvPhotos(quadrat.photo_paths);
  const [viewer, setViewer] = useState<number | null>(null);
  const save = (uris: string[]) => run(() => updateQuadrat(quadrat.id, { photo_paths: uris.length ? JSON.stringify(uris) : null }));
  const add = (uris: string[]) => uris.length && save([...photos, ...uris]);
  return (
    <View>
      <Text className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
        {t('plot.quadrats.photos')}
        {photos.length ? ` (${photos.length})` : ''}
      </Text>
      <PhotoGrid
        photos={photos}
        onAdd={() => {
          if (ro) return void run(() => undefined);
          void captureEnvPhoto()
            .then((uri) => uri && add([uri]))
            .catch((e) => toast(errText(e)));
        }}
        onPickLibrary={
          ro
            ? undefined
            : () =>
                void pickPhotos()
                  .then(add)
                  .catch((e) => toast(errText(e)))
        }
        onView={setViewer}
        onRemove={ro ? undefined : (uri) => save(photos.filter((u) => u !== uri))}
      />
      <PhotoViewerModal photos={photos} index={viewer} onClose={() => setViewer(null)} />
    </View>
  );
}

type FreqProps = {
  quadrat: Quadrat;
  species: QuadratSpeciesWithTaxon[];
  ro: boolean;
  /** Taxon → its layer in the plot list ("灌木層"), for the filter chips. */
  layerOf: ReadonlyMap<string, string>;
  /** Layer filter (chosen in the ⋯ menu); null = all species. */
  layer: string | null;
  onLayer: (layer: string | null) => void;
  run: Run;
  /** Strokes and counts: reloaded once the painting pauses. */
  runQuiet: QuietRun;
  refused: () => boolean;
  topEdge: string;
  onFinish?: () => void;
};

/** A quadrat's frequency: the shared FrequencyPanel over its species. */
function FreqBody({
  quadrat,
  species,
  ro,
  layerOf,
  layer,
  onLayer,
  run,
  runQuiet,
  refused,
  topEdge,
  onFinish,
  gridRef,
}: FreqProps & { gridRef: React.Ref<FrequencyGridHandle> }) {
  const { t } = useTranslation();
  const items: FreqItem[] = species.map((s) => ({
    key: keyOf(s),
    taxon_id: s.taxon_id,
    name: nameOf(s),
    cname: s.common_name_c || null,
    sci: s.simple_name || null,
    layer: layerOf.get(s.taxon_id) ?? null,
    cover: s.cover_pct,
    freq_cells: s.freq_cells,
    freq_count: s.freq_count,
  }));
  const idOf = (key: string) => species.find((s) => keyOf(s) === key)?.id;
  return (
    <FrequencyPanel
      items={items}
      n={quadrat.grid_n}
      storedMode={quadrat.freq_mode}
      topEdgeLabel={`▲ ${t('plot.quadrats.topEdgeLabel', { edge: topEdge })}`}
      ro={ro}
      layer={layer}
      refused={refused}
      onMask={(key, mask) => {
        const id = idOf(key);
        if (id != null) runQuiet(() => updateQuadratSpecies(id, { freq_cells: mask }), undefined, { id, freq_cells: mask });
      }}
      onCount={(key, v) => {
        const id = idOf(key);
        if (id != null) runQuiet(() => updateQuadratSpecies(id, { freq_count: v }), undefined, { id, freq_count: v });
      }}
      onSwitchMode={(toCount) => run(() => switchFreqMode(quadrat.id, toCount ? 'count' : 'cells'))}
      onAdd={(r) => {
        let id = 0;
        if (!run(() => void (id = addQuadratSpecies(quadrat.id, r.taxon_id)))) return null;
        onLayer(null);
        return `s${id}`;
      }}
      footer={
        onFinish ? (
          <Button size="lg" fullWidth icon="lock-closed-outline" label={t('plot.quadrats.finishLock', { label: quadrat.label })} onPress={onFinish} />
        ) : undefined
      }
      gridRef={gridRef}
    />
  );
}
