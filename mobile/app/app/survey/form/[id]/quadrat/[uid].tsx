/**
 * One quadrat of a plot-style survey (2G-d4): the fixed plot's quadrat screen
 * (app/plot/[id]/quadrat/[qid].tsx) over a second-level unit — the cover of
 * each species (with the ground cover) and its frequency on the template's
 * grid, then the unit's photos and its other components.
 *
 * A species here is an occurrence in this unit (in the herb layer when the
 * template has layers); its cover is its Abundance as a percentage, its cells
 * the occurrences' Frequency. Marked done (v89 done_at), nothing in it changes
 * until it is opened again from ⋯ — the DB layer refuses it too. Deleting it
 * takes its species and the units below it, as the fixed plot does. Each write is
 * one step of the survey's undo history; a painted stroke, written when the
 * finger lifts, undoes as one.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View, type TextInput } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { LockedBanner } from '~/components/RecordEditButtons';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import { promptText } from '~/components/TextPromptModal';
import type { FrequencyGridHandle } from '~/components/quadrat/FrequencyGrid';
import { FrequencyPanel, type FreqItem } from '~/components/quadrat/FrequencyPanel';
import { topEdgeName } from '~/components/quadrat/names';
import { layerName } from '~/components/quadrat/plotFreqIssueLines';
import { PickChips, QuadratHeaderTitle, QuadratPhotos, QuadratViewSeg, type QuadratView } from '~/components/quadrat/QuadratParts';
import { SurfaceCover } from '~/components/quadrat/SurfaceCover';
import { LabeledNumField } from '~/components/form/LabeledField';
import { Button } from '~/components/ui/Button';
import { StepPager } from '~/components/ui/StepPager';
import { withTransaction } from '~/db/init';
import type { AdoptionInput } from '~/db/taxonLookup';
import { BackHeaderLeft } from '~/lib/goBack';
import { speciesParts } from '~/lib/nameParts';
import { freqCells } from '~/lib/quadratProgress';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useSettledCall } from '~/lib/useSettledCall';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { BannerText, Btn, FoldBanner, NumAccessory, NumField } from '~/modules/gloria/components/ui';
import { autoFillLast, exactSum } from '~/modules/gloria/model/validate';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { ComponentCards } from '~/survey/form/ComponentCards';
import { formComponents } from '~/survey/form/occurrenceForm';
import { quadratLayer, quadratRows, quadratTitle, speciesName, type QuadratRow } from '~/survey/form/PlotSurveyQuadratsTab';
import { coverOf, quadratSetup, SURFACE_OF, type QuadratSetup, type SurfaceKey } from '~/survey/form/quadratModel';
import { layerCountOf } from '~/survey/form/checks';
import { layerHeightUnit } from '~/survey/form/plotStyle';
import { carriedNotes, formErrorText, levelLabel } from '~/survey/form/text';
import { unitSubtree } from '~/survey/form/units';
import { useSurveyForm, type SurveyForm } from '~/survey/form/useSurveyForm';
import { COVER_FIELDS, type ComponentValues } from '~/survey/registry';
import type { ComponentInstance } from '~/survey/template/types';
import {
  addMedia,
  addOccurrence,
  deleteOccurrence,
  deleteUnitWithContents,
  environmentCarried,
  getFrameUnit,
  readComponent,
  removeMedia,
  setUnitDone,
  updateOccurrence,
  updateUnit,
  writeComponent,
} from '~/survey/db/surveys';

type CoverField = (typeof COVER_FIELDS)[number];
type FreqPatch = { freq_cells?: string | null; freq_count?: number | null };
type Run = (fn: () => void, onInvalid?: () => void) => boolean;

/** The unit's own components, as the screen shows them: ground covers, photos, and the rest as cards. */
function unitParts(setup: QuadratSetup, template: SurveyForm['template']) {
  const comps = formComponents(template, { unit: setup.level });
  const others: ComponentInstance[] = [];
  for (const c of comps) {
    if (c === setup.photos) continue;
    if (c === setup.env) {
      // The ground covers are drawn as the quadrat's surface; any other field stays on its card.
      const rest = (Array.isArray(c.params.fields) ? (c.params.fields as string[]) : []).filter((f) => !(COVER_FIELDS as readonly string[]).includes(f));
      if (rest.length) others.push({ ...c, params: { ...c.params, fields: rest } });
      continue;
    }
    others.push(c);
  }
  return { comps, others };
}

export default function SurveyQuadratScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  // `unlocked=1`: the survey screen this was opened from had the ended survey unlocked.
  const params = useLocalSearchParams<{ id: string; uid: string; unlocked?: string }>();
  const surveyId = Number(params.id);
  const uid = Number(params.uid);
  useVersionOnLeave('modular', surveyId);

  const { data, reload: load } = useSurveyForm(surveyId);
  const edit = useRecordEditing('modular', surveyId, data?.survey.status === 'done', params.unlocked === '1');
  const { checkpoint } = edit;
  /** After a write: read again, and the change becomes one undo step. */
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);

  const rows = useMemo(() => (data ? quadratRows(data) : []), [data]);
  const setup = useMemo(() => (data ? quadratSetup(data.template) : null), [data]);
  const row = rows.find((r) => r.unit.id === uid) ?? null;
  // The unit's values, read with the survey (a read while rendering would keep stale ones).
  const unit = useMemo(() => {
    if (!data || !setup || !row) return null;
    const parts = unitParts(setup, data.template);
    const fu = row.unit.frame_unit_id != null ? getFrameUnit(row.unit.frame_unit_id) : null;
    // The size every quadrat takes from the survey's 調查法 (2G-f), unless it has its own.
    const method = formComponents(data.template, 'survey').find((c) => c.type === 'method');
    const mv = method ? (data.surveyValues[method.key] ?? {}) : {};
    const shared = { w: typeof mv.quadrat_w_m === 'number' ? mv.quadrat_w_m : null, l: typeof mv.quadrat_l_m === 'number' ? mv.quadrat_l_m : null };
    return {
      ...parts,
      values: Object.fromEntries(parts.comps.map((c) => [c.key, readComponent({ kind: 'unit', id: uid }, c.key)])) as Record<string, ComponentValues>,
      carried: environmentCarried({ kind: 'unit', id: uid }),
      size: {
        w: row.unit.width_m ?? fu?.width_m ?? shared.w,
        l: row.unit.length_m ?? fu?.length_m ?? shared.l,
        own: { w: row.unit.width_m, l: row.unit.length_m },
        fromMethod: row.unit.width_m == null && row.unit.length_m == null && fu?.width_m == null && shared.w != null,
      },
    };
  }, [data, setup, row, uid]);

  const [view, setView] = useState<QuadratView>('cover');
  const locked = row?.unit.done_at != null;
  // Say so once on arrival; the header lock shows it from then on.
  const toastedLock = useRef(false);
  useEffect(() => {
    if (!row || toastedLock.current) return;
    toastedLock.current = true;
    if (row.unit.done_at != null) toast(t('plot.quadrats.lockedToast'));
  }, [row, t, toast]);

  const grid = useRef<FrequencyGridHandle>(null);
  const flushStroke = () => grid.current?.flush();
  // Frequency's layer filter lives in the ⋯ menu, as on the fixed plot.
  const [layer, setLayer] = useState<string | null>(null);

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
  const run: Run = (fn, onInvalid) => {
    if (refused()) return false;
    settled.flush();
    try {
      fn();
    } catch (e) {
      toast(formErrorText(t, e));
      onInvalid?.();
      return false;
    }
    reload();
    return true;
  };
  // Strokes and counts: written at once and patched in here; reloaded (with
  // the undo snapshot) once the painting pauses — a reload per tap made the brush lag.
  const [patched, setPatched] = useState<ReadonlyMap<number, FreqPatch>>(new Map());
  const settled = useSettledCall(() => {
    setPatched(new Map());
    reload();
  });
  const runQuiet = (fn: () => void, patch: { id: number } & FreqPatch): boolean => {
    if (refused()) return false;
    try {
      fn();
    } catch (e) {
      toast(formErrorText(t, e));
      return false;
    }
    setPatched((m) => new Map(m).set(patch.id, { ...m.get(patch.id), ...patch }));
    settled.schedule();
    return true;
  };

  if (!data || !setup || !row || !unit) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500 dark:text-gray-400">{t('plot.quadrats.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const code = row.unit.code;
  const index = rows.findIndex((r) => r.unit.id === uid);
  const title = quadratTitle(row.unit, data.units);
  const species = row.species.map((o) => ({ ...o, ...patched.get(o.id) }));
  const step = (dir: -1 | 1) => {
    flushStroke();
    const next = rows[index + dir];
    if (next) router.setParams({ uid: String(next.unit.id) });
  };

  const finish = () => {
    flushStroke();
    if (edit.refuse()) return;
    try {
      setUnitDone(uid, true);
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    reload();
    toast(t('plot.quadrats.lockedDone', { label: code }));
  };

  const rename = async () => {
    if (refused()) return;
    const v = await promptText({ title: t('surveyForm.unit.label'), defaultValue: row.unit.label ?? '', allowEmpty: true });
    if (v == null) return;
    run(() => updateUnit(uid, { label: v.trim() || null }));
  };

  const menu = async () => {
    flushStroke();
    const items: { label: string; destructive?: boolean; run: () => void }[] = [];
    const layers = [...new Set(species.map((s) => (s.layer ? layerName(s.layer) : null)).filter((l): l is string => !!l))];
    if (shown === 'freq' && layers.length) {
      const opt = (l: string | null) => ({
        label: `${layer === l ? '✓ ' : ''}${t('plot.quadrats.filterLayer', {
          layer: l ?? t('plot.quadrats.all'),
          n: l ? species.filter((s) => s.layer && layerName(s.layer) === l).length : species.length,
        })}`,
        run: () => setLayer(l),
      });
      items.push(opt(null), ...layers.map(opt));
    }
    if (edit.locked || edit.unlocked) {
      items.push({ label: edit.locked ? t('recordLock.unlock') : t('recordLock.relock'), run: () => edit.setUnlocked(edit.locked) });
    }
    if (!edit.locked) {
      items.push(
        locked
          ? {
              label: t('plot.quadrats.unlock'),
              run: () => {
                setUnitDone(uid, false);
                reload();
                toast(t('plot.quadrats.unlocked'));
              },
            }
          : { label: t('plot.quadrats.finishLock', { label: code }), run: finish },
      );
      if (!locked) items.push({ label: t('surveyForm.unit.label'), run: () => void rename() });
      if (edit.undoCount > 0) items.push({ label: t('recordLock.undo'), run: () => { edit.undo(); load(); } });
      if (edit.redoCount > 0) items.push({ label: t('recordLock.redo'), run: () => { edit.redo(); load(); } });
      items.push({
        label: t('plot.quadrats.delete'),
        destructive: true,
        run: () => {
          if (locked) return void toast(t('plot.quadrats.lockedToast'));
          // Everything in it goes with it, as on the fixed plot; the units below it too.
          const inside = new Set(unitSubtree(data.units.map((u) => u.unit), uid));
          const count = data.occurrences.filter((o) => !o.via_interaction && o.unit_id != null && inside.has(o.unit_id)).length;
          Alert.alert(t('surveyForm.unit.deleteTitle', { path: code }), t('surveyForm.unit.deleteAllMsg', { count }), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: () => {
                try {
                  deleteUnitWithContents(uid);
                } catch (e) {
                  toast(formErrorText(t, e));
                  return;
                }
                checkpoint();
                router.back();
              },
            },
          ]);
        },
      });
    }
    const i = await showActionSheet({ title, options: items.map(({ label, destructive }) => ({ label, destructive })) });
    if (i >= 0) items[i].run();
  };

  const both = setup.recordCover && !!setup.freq;
  const shown: QuadratView = !setup.freq ? 'cover' : !setup.recordCover ? 'freq' : view;
  const cross = row.progress.issues;
  const noFreq = cross.filter((i) => i.kind === 'cover-no-freq').map((i) => i.species);
  const noCover = cross.filter((i) => i.kind === 'freq-no-cover').map((i) => i.species);
  const ro = edit.locked || locked;
  const sizeText = unit.size.w != null && unit.size.l != null ? `${unit.size.w} × ${unit.size.l} m` : null;

  /** Into this quadrat (its herb layer when the template has layers); the one already here when it is. */
  const add = (taxonId: string, adopted?: AdoptionInput | null): number | null => {
    const same = row.species.find((o) => o.taxon_id === taxonId && !o.verbatim_identification);
    if (same) return same.id;
    let id = 0;
    const ok = run(() => {
      id = addOccurrence(surveyId, {
        taxon_id: taxonId,
        unit_id: uid,
        layer: quadratLayer(data),
        ...(adopted ? { used_name_id: adopted.name_id ?? null, used_scientific_name: adopted.scientific_name } : {}),
      });
    });
    return ok ? id : null;
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          headerLeft: BackHeaderLeft,
          headerTitle: () => (
            <QuadratHeaderTitle
              code={code}
              status={row.progress.status}
              title={title.slice(code.length).trim() || code}
              locked={locked}
              subtitle={[data.survey.name, sizeText, setup.freq ? t('plot.quadrats.gridCells', { n: setup.n }) : null].filter(Boolean).join(' · ')}
            />
          ),
          headerRight: () => (
            <View className="flex-row items-center gap-2">
              <StepPager index={index} total={rows.length} onStep={step} />
              <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void menu()} />
            </View>
          ),
        }}
      />

      {edit.locked ? <LockedBanner text={t('plot.quadrats.plotLocked')} /> : null}
      {both ? (
        <View className="px-4 pt-3">
          <QuadratViewSeg
            value={shown}
            onChange={(v) => {
              flushStroke();
              setView(v);
            }}
            freq={{ done: row.progress.withFreq, total: row.progress.species }}
          />
        </View>
      ) : null}

      {/* The frequency view marks the same thing on its badge and dots, and needs the room for its grid. */}
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
          key={uid}
          data={data}
          row={row}
          setup={setup}
          parts={unit}
          ro={ro}
          run={run}
          refused={refused}
          onAdd={add}
          onChanged={reload}
          onFinish={locked ? undefined : finish}
          onBelow={() => router.push(`/survey/form/unit/${uid}${params.unlocked === '1' ? '?unlocked=1' : ''}` as Href)}
          onSize={(p) => run(() => updateUnit(uid, p))}
          belowLabel={data.levelKeys[2] ? `${levelLabel(t, i18n.language, data.template, data.levelKeys[2])} ${data.units.filter((u) => u.unit.parent_id === uid).length}` : null}
        />
      ) : (
        <FrequencyPanel
          key={uid}
          items={species.map(
            (o): FreqItem => ({
              key: `o${o.id}`,
              taxon_id: o.taxon_id,
              name: speciesName(o),
              cname: o.common_name_c || null,
              sci: o.simple_name || null,
              qualifier: o.verbatim_identification,
              layer: o.layer ? layerName(o.layer) : null,
              cover: coverOf(o),
              freq_cells: o.freq_cells,
              freq_count: o.freq_count,
            }),
          )}
          n={setup.n}
          storedMode={setup.mode}
          topEdgeLabel={`▲ ${t('plot.quadrats.topEdgeLabel', { edge: topEdgeName(t, setup.topEdge) })}`}
          ro={ro}
          layer={layer}
          refused={refused}
          onMask={(key, mask) => {
            const id = Number(key.slice(1));
            if (setup.freq) runQuiet(() => writeComponent({ kind: 'occurrence', id }, setup.freq!.key, { freq_cells: mask }), { id, freq_cells: mask });
          }}
          onCount={(key, v) => {
            const id = Number(key.slice(1));
            if (setup.freq) runQuiet(() => writeComponent({ kind: 'occurrence', id }, setup.freq!.key, { freq_count: v }), { id, freq_count: v });
          }}
          onAdd={(r, adopted) => {
            if (!r.taxon_id) return null;
            const id = add(r.taxon_id, adopted);
            if (id == null) return null;
            setLayer(null);
            return `o${id}`;
          }}
          footer={locked ? undefined : <Button size="lg" fullWidth icon="lock-closed-outline" label={t('plot.quadrats.finishLock', { label: code })} onPress={finish} />}
          gridRef={grid}
        />
      )}
      <NumAccessory />
    </SafeAreaView>
  );
}

/** The survey's own Structure values (its layers' height units). */
const surveyStructureValues = (data: SurveyForm) => {
  const c = formComponents(data.template, 'survey').find((x) => x.type === 'structure');
  return c ? data.surveyValues[c.key] : undefined;
};

type CoverProps = {
  data: SurveyForm;
  row: QuadratRow;
  setup: QuadratSetup;
  parts: {
    others: ComponentInstance[];
    values: Record<string, ComponentValues>;
    carried: ReturnType<typeof environmentCarried>;
    size: { w: number | null; l: number | null; own: { w: number | null; l: number | null }; fromMethod: boolean };
  };
  /** This quadrat's own width / length (null: the shared one again). */
  onSize: (p: { widthM?: number | null; lengthM?: number | null }) => void;
  ro: boolean;
  run: Run;
  refused: () => boolean;
  onAdd: (taxonId: string, adopted?: AdoptionInput | null) => number | null;
  onChanged: () => void;
  onFinish?: () => void;
  /** The unit page, for the level below (its units). */
  onBelow: () => void;
  belowLabel: string | null;
};

/** Ground cover, species cover, quick picks from the subplot's list, photos, the other components, and the search dock. */
function CoverBody({ data, row, setup, parts, ro, run, refused, onAdd, onChanged, onFinish, onBelow, belowLabel, onSize }: CoverProps) {
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const owner = { kind: 'unit' as const, id: row.unit.id };
  const coverRefs = useRef(new Map<number, TextInput>());
  // A species just added gets its cover field focused (numeric pad up), once its row exists after the reload.
  const focusId = useRef<number | null>(null);
  // Bumped to reset a cover field whose entry was refused (a 0).
  const [resetN, setResetN] = useState(0);
  const [surfaceOpen, setSurfaceOpen] = useState(true);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [dockH, setDockH] = useState(0);
  const species = row.species;

  useEffect(() => {
    const field = focusId.current != null ? coverRefs.current.get(focusId.current) : undefined;
    if (!field) return;
    focusId.current = null;
    field.focus();
  });

  const add = (taxonId: string, adopted?: AdoptionInput | null) => {
    const id = onAdd(taxonId, adopted);
    if (id != null && setup.recordCover) {
      focusId.current = id;
      coverRefs.current.get(id)?.focus();
    }
  };

  // Quick picks: what the subplot above recorded (its herb layer when there are layers), else the plot list.
  const parent = row.unit.parent_id == null ? null : (data.units.find((u) => u.unit.id === row.unit.parent_id)?.unit ?? null);
  const herb = quadratLayer(data);
  const have = new Set(species.map((s) => s.taxon_id));
  const seen = new Set<string>();
  const fromList = data.occurrences
    .filter((o) => !o.via_interaction && (o.unit_id ?? null) === (parent?.id ?? null) && (!herb || o.layer === herb))
    .filter((o) => !have.has(o.taxon_id) && !seen.has(o.taxon_id) && (seen.add(o.taxon_id), true))
    .map((o) => ({ taxon_id: o.taxon_id, name: speciesName(o) }));

  const surfaceKeys = setup.surface.map((f) => SURFACE_OF[f]);
  const fieldOf = new Map(setup.surface.map((f) => [SURFACE_OF[f], f] as const));
  const env = setup.env ? (parts.values[setup.env.key] ?? row.env) : row.env;
  const surfaceValues = Object.fromEntries(setup.surface.map((f) => [SURFACE_OF[f], typeof env[f] === 'number' ? (env[f] as number) : null])) as Record<SurfaceKey, number | null>;
  const commitSurface = (p: Partial<Record<SurfaceKey, number | null>>) => {
    if (!setup.env) return;
    // Filling the sixth of seven completes the seventh, as in GLORIA.
    const edited = Object.keys(p)[0] as SurfaceKey;
    const fill = autoFillLast({ ...surfaceValues, ...p }, surfaceKeys, edited);
    const all = fill ? { ...p, [fill.key]: fill.value } : p;
    const patch = Object.fromEntries(Object.entries(all).map(([k, v]) => [fieldOf.get(k as SurfaceKey) as CoverField, v ?? null]));
    run(() => writeComponent(owner, setup.env!.key, patch));
  };
  const surfaceSum = surfaceKeys.every((k) => surfaceValues[k] == null) ? null : exactSum(surfaceKeys.reduce((a, k) => a + (surfaceValues[k] ?? 0), 0));
  const speciesSum = exactSum(species.reduce((a, o) => a + (coverOf(o) ?? 0), 0));
  const cells = setup.n * setup.n;
  const photos = setup.photos && Array.isArray(parts.values[setup.photos.key]?.photos) ? (parts.values[setup.photos.key].photos as string[]) : [];

  return (
    <>
      {/* Keeps the focused cover field above the keyboard AND the search dock (bottomOffset). */}
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={dockH + 12}>
        {surfaceKeys.length ? (
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
                keys={surfaceKeys}
                labelKey={(k) => `gloria.cover.${k}`}
                shortKey={(k) => `gloria.cover.short.${k}`}
                onCommit={commitSurface}
                editable={!ro}
              />
            ) : null}
          </View>
        ) : null}

        {setup.recordCover ? (
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
            species.map((o, i) => (
              <Pressable
                key={o.id}
                onLongPress={async () => {
                  if (ro) return;
                  const k = await showActionSheet({ titleParts: speciesParts(o.common_name_c, o.simple_name, o.rank, o.kingdom, o.taxon_id), options: [{ label: t('plot.quadrats.removeSpecies'), destructive: true }] });
                  if (k === 0) run(() => deleteOccurrence(o.id));
                }}
                delayLongPress={350}
                className={`flex-row items-center px-4 py-2.5 ${i < species.length - 1 ? 'border-b border-line dark:border-line-dark' : ''}`}
              >
                <View className="flex-1 pr-2">
                  <Text className="text-base text-ink dark:text-gray-100" numberOfLines={1}>
                    {o.verbatim_identification || speciesName(o)}
                  </Text>
                  {o.simple_name ? (
                    <ScientificName name={o.simple_name} kingdom={o.kingdom} rank={o.rank} className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1} />
                  ) : null}
                </View>
                {setup.freq ? (
                  <Text className="mr-3 text-xs text-ink-2 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>
                    {t('plot.quadrats.freqShort', { pct: Math.round((freqCells(o, setup.mode) / cells) * 100) })}
                  </Text>
                ) : null}
                {setup.recordCover ? (
                  <NumField
                    ref={(r) => {
                      if (r) coverRefs.current.set(o.id, r);
                      else coverRefs.current.delete(o.id);
                    }}
                    value={coverOf(o)}
                    target={`${o.id}:${resetN}`}
                    range={{ min: 0, max: 100, unit: '%' }}
                    width={72}
                    editable={!ro}
                    accessibilityLabel={t('plot.quadrats.coverOf', { name: speciesName(o) })}
                    onSubmitEditing={i < species.length - 1 ? () => coverRefs.current.get(species[i + 1].id)?.focus() : undefined}
                    onPrev={i > 0 ? () => coverRefs.current.get(species[i - 1].id)?.focus() : undefined}
                    onCommit={(v) => {
                      if (v === 0) {
                        toast(t('plot.quadrats.coverZero'));
                        setResetN((n) => n + 1);
                        return;
                      }
                      run(
                        () => updateOccurrence(o.id, { organism_quantity: v == null ? null : String(v), organism_quantity_type: v == null ? null : '% cover' }),
                        () => setResetN((n) => n + 1),
                      );
                    }}
                  />
                ) : null}
              </Pressable>
            ))
          )}
        </View>

        {ro ? null : (
          <PickChips items={fromList} label={parent ? t('surveyForm.quadrat.fromUnitList', { unit: parent.label ?? parent.code }) : t('plot.quadrats.fromPlotList')} onPick={(id) => add(id)} />
        )}

        {setup.photos ? (
          <QuadratPhotos
            photos={photos}
            ro={ro}
            onRefused={() => void refused()}
            onAdd={(uris) => run(() => withTransaction(() => uris.forEach((uri) => addMedia(owner, setup.photos!.key, uri))))}
            onRemove={(uri) => run(() => removeMedia(owner, setup.photos!.key, uri))}
          />
        ) : null}

        {parts.others.length ? (
          <ComponentCards
            owner={owner}
            instances={parts.others}
            values={parts.values}
            readOnly={ro}
            refuse={() => void refused()}
            onChanged={onChanged}
            notes={carriedNotes(t, parts.carried)}
            codelists={data.template.codelists}
            context={{ layerCount: layerCountOf(data.template, data.surveyValues), heightUnitOf: layerHeightUnit(surveyStructureValues(data)) }}
          />
        ) : null}

        <View className="gap-2 rounded-card border border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
          <Pressable onPress={() => (ro ? undefined : setSizeOpen(!sizeOpen))} accessibilityRole="button" accessibilityState={{ expanded: sizeOpen }} className="min-h-11 flex-row items-center gap-2">
            <Text className="flex-1 text-base text-ink dark:text-gray-100">{t('surveyForm.quadrat.size')}</Text>
            <Text className="text-sm text-ink-2 dark:text-gray-300">
              {[parts.size.w != null && parts.size.l != null ? `${parts.size.w} × ${parts.size.l} m` : '—', parts.size.fromMethod ? t('surveyForm.quadrat.sizeShared') : ''].filter(Boolean).join(' · ')}
            </Text>
            {ro ? null : <Ionicons name={sizeOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={c.ink3} />}
          </Pressable>
          {sizeOpen && !ro ? (
            <>
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <LabeledNumField label={t('plot.width')} suffix="m" value={parts.size.own.w} min={0} onSave={(v, done) => done && onSize({ widthM: v })} />
                </View>
                <View className="flex-1">
                  <LabeledNumField label={t('plot.length')} suffix="m" value={parts.size.own.l} min={0} onSave={(v, done) => done && onSize({ lengthM: v })} />
                </View>
              </View>
              <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('surveyForm.quadrat.sizeOwn')}</Text>
            </>
          ) : null}
        </View>

        {belowLabel ? (
          <Pressable
            onPress={onBelow}
            accessibilityRole="button"
            className="flex-row items-center rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
          >
            <Text className="flex-1 text-base text-ink dark:text-gray-100">{belowLabel}</Text>
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </Pressable>
        ) : null}

        {onFinish && !ro ? <Btn label={t('plot.quadrats.finishLock', { label: row.unit.code })} onPress={onFinish} /> : null}
      </KeyboardAwareScrollView>
      {!ro ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View onLayout={(e) => setDockH(e.nativeEvent.layout.height)}>
            <SearchBox onSelect={(r, adopted) => r.taxon_id && add(r.taxon_id, adopted)} />
          </View>
        </KeyboardStickyView>
      ) : null}
    </>
  );
}
