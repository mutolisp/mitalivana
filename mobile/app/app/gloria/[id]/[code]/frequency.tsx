/**
 * Subplot frequency in a 1×1 m quadrat (manual §5.1.2, Form 5-S): which of
 * the 100 cells of 10 × 10 cm each species — and each of the three grazing
 * features — occupies. Cells are labelled R1–R10 (top → bottom) and C1–C10
 * (left → right looking toward the summit); storage is fixed to the ground
 * (model/grid.ts), and the export writes them as f11…f00.
 *
 * Brush mode paints a whole stroke and writes once when the finger lifts.
 * Cell mode walks the cells in Form order and toggles what is in each.
 * Count mode takes just the number of cells (0–100) per species and grazing
 * feature, for resurveys whose earlier records kept only the totals.
 *
 * The entry itself is the shared FrequencyPanel, the same as the fixed plot's
 * frequency (user decision 2026-09-29); Hi1–Hi3 are items of their own after
 * the species. This screen keeps what is GLORIA's: undo / redo, the lock,
 * morphospecies labels on a new species, the cover cross-check.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { FrequencyPanel, type FreqItem } from '~/components/quadrat/FrequencyPanel';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import {
  addUnitSpecies,
  setFrequencyMode,
  setFrequencyLocked,
  startFrequency,
  touchFrequency,
  updateUnit,
  updateUnitSpecies,
} from '~/modules/gloria/db';
import { pickMorphoLabel } from '~/modules/gloria/morpho';
import { emptyMask, popcount, QUADRAT_N } from '~/modules/gloria/model/grid';
import type { Direction } from '~/modules/gloria/model/units';
import { bySpeciesOrder } from '~/modules/gloria/model/speciesOrder';
import { displayName, GLORIA_SEARCH_GROUPS, useSurvey } from '~/modules/gloria/useSurvey';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { NumAccessory } from '~/modules/gloria/components/ui';
import { saveVersionSoon } from '~/db/recordVersions';
import { coverFreqIssues } from '~/lib/quadratIssues';
import type { FrequencyGridHandle } from '~/components/quadrat/FrequencyGrid';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';

const CELLS = QUADRAT_N * QUADRAT_N;
const GRAZING = [
  { key: 'hi1', col: 'dist_hi1', countCol: 'dist_hi1_n' },
  { key: 'hi2', col: 'dist_hi2', countCol: 'dist_hi2_n' },
  { key: 'hi3', col: 'dist_hi3', countCol: 'dist_hi3_n' },
] as const;
/** Grazing features as extra grid targets: a corner square in their tone. */
const GRAZING_TONES: Record<string, string> = { hi1: '#a16207', hi2: '#be185d', hi3: '#7c3aed' };
// Looking toward the summit from each cluster, which compass side is left / right.
const SIDES: Record<Direction, [Direction, Direction]> = { N: ['E', 'W'], E: ['S', 'N'], S: ['W', 'E'], W: ['N', 'S'] };

export default function FrequencyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
  useVersionOnLeave('gloria', id);
  const code = String(params.code);
  const { state, reload } = useSurvey(id);
  const unit = state?.unit(code);
  // Marked done: nothing on this screen may change the data until reopened.
  const locked = unit?.freq_locked === 1;
  // Say so once on arrival; the header lock shows it from then on.
  const lockedOnOpen = useRef(locked);
  useEffect(() => {
    if (lockedOnOpen.current) toast(t('gloria.freq.lockedToast'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const spp = useMemo(() => (state ? [...state.speciesOf(code)].sort(bySpeciesOrder) : []), [state, code]);

  // The screen's own copy of the masks, for undo: the panel paints on its
  // own and hands over each finished stroke (onMask), before which this
  // copy still holds the mask the stroke started from.
  const [masks, setMasksState] = useState<Record<string, string>>({});
  const masksRef = useRef<Record<string, string>>({});
  const setMasks = (m: Record<string, string>) => {
    masksRef.current = m;
    setMasksState(m);
  };
  useEffect(() => {
    if (!unit) return;
    const m: Record<string, string> = {};
    for (const s of spp) m[`sp${s.id}`] = s.freq_cells ?? emptyMask(CELLS);
    for (const g of GRAZING) m[g.key] = unit[g.col] ?? emptyMask(CELLS);
    setMasks(m);
  }, [unit, spp]);

  // Cell recording is stamped once per visit; `unit` is not reloaded per stroke.
  const cellsStarted = useRef(false);
  const [panel, setPanel] = useState(false);
  const undo = useRef<{ key: string; mask: string }[]>([]);
  // The stack lives in a ref; its length is state so the header's buttons
  // enable when a stroke ends (a finished stroke writes but does not reload).
  const [undoCount, setUndoCount] = useState(0);
  // Redo: what undo took back, until the next new edit (then history forks).
  const redo = useRef<{ key: string; mask: string }[]>([]);
  const [redoCount, setRedoCount] = useState(0);
  const pushUndo = (e: { key: string; mask: string }, fresh = true) => {
    undo.current.push(e);
    if (undo.current.length > 100) undo.current.shift();
    setUndoCount(undo.current.length);
    if (fresh) {
      redo.current = [];
      setRedoCount(0);
    }
  };
  const clearUndo = () => {
    undo.current = [];
    redo.current = [];
    setUndoCount(0);
    setRedoCount(0);
  };
  const grid = useRef<FrequencyGridHandle>(null);
  const flushStroke = () => grid.current?.flush();

  if (!state || !unit) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: code, headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const refused = () => {
    if (locked) toast(t('gloria.freq.lockedToast'));
    return locked;
  };
  const persist = (key: string, mask: string) => {
    if (!cellsStarted.current && unit.freq_mode !== 'cells') startFrequency(unit.id);
    cellsStarted.current = true;
    const g = GRAZING.find((x) => x.key === key);
    if (g) updateUnit(unit.id, { [g.col]: mask });
    else updateUnitSpecies(Number(key.slice(2)), { freq_cells: mask });
    touchFrequency(unit.id);
  };
  const write = (key: string, mask: string, record = true) => {
    if (refused()) return;
    const before = masksRef.current[key] ?? emptyMask(CELLS);
    if (before === mask) return;
    if (record) pushUndo({ key, mask: before });
    setMasks({ ...masksRef.current, [key]: mask });
    persist(key, mask);
  };

  const [leftSide, rightSide] = SIDES[code[0] as Direction];
  const byCount = unit.freq_mode === 'count';
  const items: FreqItem[] = [
    ...spp.map((s) => ({
      key: `sp${s.id}`,
      taxon_id: s.taxon_id,
      name: s.common_name_c || s.simple_name || s.taxon_id,
      cname: s.common_name_c || null,
      sci: s.simple_name || null,
      qualifier: s.verbatim_identification,
      layer: null,
      cover: s.cover_pct,
      freq_cells: masks[`sp${s.id}`] ?? s.freq_cells,
      freq_count: s.freq_count,
    })),
    ...GRAZING.map((g, i) => ({
      key: g.key,
      taxon_id: '',
      name: t(`gloria.freq.hi${i + 1}`),
      cname: t(`gloria.freq.hi${i + 1}`),
      sci: null,
      layer: null,
      color: GRAZING_TONES[g.key],
      tone: true,
      cover: null,
      freq_cells: masks[g.key] ?? unit[g.col],
      freq_count: unit[g.countCol],
    })),
  ];
  const cross = coverFreqIssues(
    spp.map((s) => ({
      name: displayName(s),
      cover: s.cover_pct,
      cells: byCount ? (s.freq_count ?? 0) : popcount(masks[`sp${s.id}`]),
    })),
  ).map((i) =>
    i.kind === 'cover-no-freq'
      ? t('gloria.issue.coverNoFreq', { name: i.species, cover: i.cover })
      : t('gloria.issue.freqNoCover', { name: i.species, count: i.cells }),
  );

  // A quadrat holds cells or counts, never both: the panel asks before a
  // switch that clears data, and this clears it.
  const hasCells = !byCount && Object.values(masks).some((m) => popcount(m) > 0);
  const hasCounts = byCount && (spp.some((s) => s.freq_count != null) || GRAZING.some((g) => unit[g.countCol] != null));
  const switchMode = (toCount: boolean) => {
    const loses = toCount ? hasCells : hasCounts;
    if (loses) {
      setFrequencyMode(unit.id, toCount ? 'count' : 'cells', { discard: true });
      cellsStarted.current = false;
    }
    // Undo steps are cell masks: none of them belong across a switch.
    clearUndo();
    if (loses) reload();
    return true;
  };
  const writeCount = (key: string, v: number | null) => {
    if (refused()) return;
    // Never wipes painted cells: those were cleared (with confirmation) on the way in.
    if (!byCount && !setFrequencyMode(unit.id, 'count')) return;
    const g = GRAZING.find((x) => x.key === key);
    if (g) updateUnit(unit.id, { [g.countCol]: v });
    else updateUnitSpecies(Number(key.slice(2)), { freq_count: v });
    touchFrequency(unit.id);
    reload();
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('gloria.freq.title', { code }),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              {!locked ? (
                <HeaderIconButton
                  icon="arrow-undo-outline"
                  label={t('gloria.freq.undo')}
                  disabled={undoCount === 0}
                  onPress={() => {
                    flushStroke();
                    const u = undo.current.pop();
                    setUndoCount(undo.current.length);
                    if (!u) return;
                    redo.current.push({ key: u.key, mask: masksRef.current[u.key] ?? emptyMask(CELLS) });
                    setRedoCount(redo.current.length);
                    write(u.key, u.mask, false);
                  }}
                />
              ) : null}
              {!locked ? (
                <HeaderIconButton
                  icon="arrow-redo-outline"
                  label={t('gloria.freq.redo')}
                  disabled={redoCount === 0}
                  onPress={() => {
                    flushStroke();
                    const r = redo.current.pop();
                    setRedoCount(redo.current.length);
                    if (!r) return;
                    // Back onto the undo stack without dropping the rest of the redo stack.
                    pushUndo({ key: r.key, mask: masksRef.current[r.key] ?? emptyMask(CELLS) }, false);
                    write(r.key, r.mask, false);
                  }}
                />
              ) : null}
              <HeaderIconButton icon="grid-outline" label={t('gloria.overview')} onPress={() => setPanel(true)} />
              <HeaderIconButton
                icon={locked ? 'lock-closed' : 'checkmark-done-outline'}
                label={locked ? t('gloria.freq.unlock') : t('gloria.freq.done')}
                onPress={async () => {
                  flushStroke();
                  let endTs: number | null = null;
                  if (!locked) {
                    const chosen = await chooseEndTime(unit.freq_stop_ts);
                    if (chosen === undefined) return;
                    endTs = chosen;
                  }
                  setFrequencyLocked(unit.id, !locked, endTs);
                  if (!locked) saveVersionSoon('gloria', id, 'done');
                  clearUndo();
                  reload();
                  toast(locked ? t('gloria.freq.unlocked') : t('gloria.freq.lockedDone'));
                }}
              />
            </View>
          ),
        }}
      />
      <FrequencyPanel
        items={items}
        n={QUADRAT_N}
        storedMode={byCount ? 'count' : 'cells'}
        topEdgeLabel={t('gloria.freq.uphill')}
        leftRightLabels={[leftSide, rightSide]}
        ro={locked}
        layer={null}
        refused={refused}
        onMask={(key, mask) => write(key, mask)}
        onCount={writeCount}
        onSwitchMode={switchMode}
        searchGroups={GLORIA_SEARCH_GROUPS}
        onAdd={async (r) => {
          const label = await pickMorphoLabel(t, unit.survey_id, r.taxon_id, r.rank, r.cname || r.name);
          if (label === undefined) return null;
          const usid = addUnitSpecies(unit.id, r.taxon_id, label);
          if (unit.freq_mode == null) startFrequency(unit.id);
          reload();
          toast(t('gloria.freq.addedNoCover', { name: r.cname || r.name }), {
            action: { label: t('gloria.freq.goCover'), onPress: () => router.replace(`/gloria/${id}/${code}` as Href) },
          });
          return `sp${usid}`;
        }}
        issues={cross.length ? { title: t('gloria.unit.crossTitle'), lines: cross } : null}
        hints={{ brush: t('gloria.freq.brushHint'), inverse: t('gloria.freq.inverseHint'), count: t('gloria.freq.countHint') }}
        gridRef={grid}
      />
      <NumAccessory />
      {panel ? <OverviewPanel state={state} code={code} current="frequency" onClose={() => setPanel(false)} /> : null}
    </SafeAreaView>
  );
}
