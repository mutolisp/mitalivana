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
 */
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AppState, Pressable, ScrollView, Text, useWindowDimensions, View, type TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SelectRow } from '~/components/settings/rows';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { BackHeaderLeft } from '~/lib/goBack';
import { FONT_SCALE_VALUE, useSettings } from '~/stores/settings';
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
import { emptyMask, fillMask, getBit, popcount, rcLabel, setBits, QUADRAT_N } from '~/modules/gloria/model/grid';
import type { Direction } from '~/modules/gloria/model/units';
import { bySpeciesOrder } from '~/modules/gloria/model/speciesOrder';
import { displayName, GLORIA_SEARCH_GROUPS, useSurvey } from '~/modules/gloria/useSurvey';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { BannerText, Btn, Chip, FoldBanner, NumAccessory, NumField, Seg } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';

const CELLS = QUADRAT_N * QUADRAT_N;
const GRAZING = [
  { key: 'hi1', col: 'dist_hi1', countCol: 'dist_hi1_n', tone: '#a16207' },
  { key: 'hi2', col: 'dist_hi2', countCol: 'dist_hi2_n', tone: '#be185d' },
  { key: 'hi3', col: 'dist_hi3', countCol: 'dist_hi3_n', tone: '#7c3aed' },
] as const;
// Looking toward the summit from each cluster, which compass side is left / right.
const SIDES: Record<Direction, [Direction, Direction]> = { N: ['E', 'W'], E: ['S', 'N'], S: ['W', 'E'], W: ['N', 'S'] };

type Target = { key: string; label: string; tone?: string; usid?: number; col?: 'dist_hi1' | 'dist_hi2' | 'dist_hi3' };

export default function FrequencyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  // App font setting × system text size: the picker's arrows grow with the text.
  const fs = FONT_SCALE_VALUE[useSettings((s) => s.font_scale)] * useWindowDimensions().fontScale;
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
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

  const targets: Target[] = useMemo(
    () => [
      ...spp.map((s) => ({ key: `sp${s.id}`, label: displayName(s), usid: s.id })),
      ...GRAZING.map((g, i) => ({ key: g.key, label: t(`gloria.freq.hi${i + 1}`), tone: g.tone, col: g.col })),
    ],
    [spp, t],
  );

  // Masks live here while painting; the DB gets one write per stroke / action.
  // `masksRef` is the truth during a gesture (callbacks must not read a stale
  // render's state); `masks` mirrors it for rendering.
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

  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<'brush' | 'cell' | 'count'>(() => (unit?.freq_mode === 'count' ? 'count' : 'brush'));
  // The mode as of right now, for commits that land after a switch (a count
  // field blurs while it unmounts).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const countRefs = useRef<Array<TextInput | null>>([]);
  // Cell recording is stamped once per visit; `unit` is not reloaded per stroke.
  const cellsStarted = useRef(false);
  const [sel, setSel] = useState(0);
  // Last cell the finger landed on, shown as e.g. "R3C7" until the next touch.
  const [touched, setTouched] = useState<number | null>(null);
  const [inverse, setInverse] = useState(false);
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState(false);
  const undo = useRef<Array<{ key: string; mask: string }>>([]);
  // The stack lives in a ref (gesture callbacks must see it at once); its
  // length is state so the header's undo button enables when a stroke ends —
  // a finished stroke writes but does not re-render, which left it disabled.
  const [undoCount, setUndoCount] = useState(0);
  // Redo: what undo took back, until the next new edit (then history forks).
  const redo = useRef<Array<{ key: string; mask: string }>>([]);
  const [redoCount, setRedoCount] = useState(0);
  const pushUndo = useRef((e: { key: string; mask: string }, fresh = true) => {
    undo.current.push(e);
    if (undo.current.length > 100) undo.current.shift();
    setUndoCount(undo.current.length);
    if (fresh) {
      redo.current = [];
      setRedoCount(0);
    }
  }).current;
  const clearUndo = () => {
    undo.current = [];
    redo.current = [];
    setUndoCount(0);
    setRedoCount(0);
  };
  const [size, setSize] = useState(300);
  const stroke = useRef<{ key: string; on: boolean; seen: Set<number>; before: string } | null>(null);
  const cur = active ?? targets[0]?.key ?? null;

  const persistRef = useRef<(key: string, mask: string) => void>(() => undefined);
  const persist = (key: string, mask: string) => {
    if (!unit) return;
    if (!cellsStarted.current && unit.freq_mode !== 'cells') startFrequency(unit.id);
    cellsStarted.current = true;
    const tg = targets.find((x) => x.key === key);
    if (tg?.usid != null) updateUnitSpecies(tg.usid, { freq_cells: mask });
    else if (tg?.col) updateUnit(unit.id, { [tg.col]: mask });
    touchFrequency(unit.id);
  };
  persistRef.current = persist;
  const write = (key: string, mask: string, record = true) => {
    if (locked) {
      toast(t('gloria.freq.lockedToast'));
      return;
    }
    const before = masksRef.current[key] ?? emptyMask(CELLS);
    if (before === mask) return;
    if (record) {
      pushUndo({ key, mask: before });
    }
    setMasks({ ...masksRef.current, [key]: mask });
    persist(key, mask);
  };

  // A stroke that is still open when the app leaves the foreground is written anyway.
  // Writes the open stroke. The undo step was already taken when the stroke
  // began, so this only persists. It is called from the gesture's finalize,
  // but also before the next stroke, before undo / redo / lock, on leaving
  // and on backgrounding: a device that does not deliver finalize must lose
  // neither the stroke nor its undo step.
  const flushStroke = useRef(() => {
    const s = stroke.current;
    stroke.current = null;
    if (!s) return;
    const now = masksRef.current[s.key];
    if (now && now !== s.before) persistRef.current(s.key, now);
  }).current;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') flushStroke();
    });
    return () => {
      sub.remove();
      flushStroke();
    };
  }, [flushStroke]);

  // Memoised on what cannot change mid-stroke, so a re-render while painting
  // never swaps the gesture out from under the finger.
  const gesture = useMemo(() => {
    const cellAt = (x: number, y: number) => {
      const c = Math.floor((x / size) * QUADRAT_N);
      const r = Math.floor((y / size) * QUADRAT_N);
      return c < 0 || r < 0 || c >= QUADRAT_N || r >= QUADRAT_N ? -1 : r * QUADRAT_N + c;
    };
    return Gesture.Pan()
      .minDistance(0)
      .runOnJS(true)
      .onBegin((e) => {
        const i = cellAt(e.x, e.y);
        if (i < 0) return;
        setTouched(i);
        if (mode === 'cell') {
          setSel(i);
          return;
        }
        if (locked) {
          toast(t('gloria.freq.lockedToast'));
          return;
        }
        if (!cur) return;
        flushStroke(); // a previous stroke whose finalize never came
        const before = masksRef.current[cur] ?? emptyMask(CELLS);
        // The first cell decides: paint where it was empty, erase where it was set.
        const on = !getBit(before, i);
        stroke.current = { key: cur, on, seen: new Set([i]), before };
        pushUndo({ key: cur, mask: before });
        setMasks({ ...masksRef.current, [cur]: setBits(before, [i], on) });
      })
      .onUpdate((e) => {
        const st = stroke.current;
        if (!st) return;
        const i = cellAt(e.x, e.y);
        if (i < 0 || st.seen.has(i)) return;
        st.seen.add(i);
        setMasks({ ...masksRef.current, [st.key]: setBits(masksRef.current[st.key] ?? emptyMask(CELLS), [i], st.on) });
      })
      .onFinalize(() => flushStroke());
    // setMasks only touches refs and a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cur, size, flushStroke, locked]);

  if (!state || !unit) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: code, headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const cellPx = size / QUADRAT_N;
  const curTarget = targets.find((x) => x.key === cur);
  const [leftSide, rightSide] = SIDES[code[0] as Direction];
  const byCount = unit.freq_mode === 'count';
  const cross = spp.flatMap((s) => {
    const n = byCount ? (s.freq_count ?? 0) : popcount(masks[`sp${s.id}`]);
    const cov = s.cover_pct ?? 0;
    if (cov > 0 && n === 0) return [t('gloria.issue.coverNoFreq', { name: displayName(s), cover: cov })];
    if (n > 0 && !(cov > 0)) return [t('gloria.issue.freqNoCover', { name: displayName(s), count: n })];
    return [];
  });

  // A quadrat holds cells or counts, never both: switching away from a method
  // that has data asks before clearing it.
  const hasCells = !byCount && Object.values(masks).some((m) => popcount(m) > 0);
  const hasCounts = byCount && (spp.some((s) => s.freq_count != null) || GRAZING.some((g) => unit[g.countCol] != null));
  const switchMode = (next: typeof mode) => {
    if (next === mode) return;
    // Viewing another method is harmless, but switching to / from counts clears data.
    if (locked && (next === 'count' || mode === 'count')) {
      toast(t('gloria.freq.lockedToast'));
      return;
    }
    const toCount = next === 'count';
    const loses = toCount ? hasCells : mode === 'count' && hasCounts;
    const go = () => {
      if (loses) {
        setFrequencyMode(unit.id, toCount ? 'count' : 'cells', { discard: true });
        cellsStarted.current = false;
        clearUndo();
        reload();
      }
      setInverse(false);
      setMode(next);
    };
    if (!loses) return go();
    Alert.alert(t('gloria.freq.switchTitle'), toCount ? t('gloria.freq.switchToCount') : t('gloria.freq.switchToCells'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('gloria.freq.switchConfirm'), style: 'destructive', onPress: go },
    ]);
  };
  const commitCount = (write: () => void) => {
    if (locked) {
      toast(t('gloria.freq.lockedToast'));
      return;
    }
    // Late commit from a field of a count screen already left: drop it.
    if (modeRef.current !== 'count') return;
    // Never wipes painted cells: those were cleared (with confirmation) on the way in.
    if (!byCount && !setFrequencyMode(unit.id, 'count')) return;
    write();
    touchFrequency(unit.id);
    reload();
  };
  const countRows = [
    ...spp.map((s) => ({
      key: `sp${s.id}`,
      label: displayName(s),
      value: s.freq_count,
      tone: undefined as string | undefined,
      save: (v: number | null) => updateUnitSpecies(s.id, { freq_count: v }),
    })),
    ...GRAZING.map((g, i) => ({
      key: g.key,
      label: t(`gloria.freq.hi${i + 1}`),
      value: unit[g.countCol],
      tone: g.tone as string | undefined,
      save: (v: number | null) => updateUnit(unit.id, { [g.countCol]: v }),
    })),
  ];

  /**
   * Species and disturbance pickers, the same in both modes: a dropdown each
   * (options carry their cell count) instead of a chip per species, and ‹ ›
   * to step through the species in roster order. `onChosen` (cell mode) also
   * puts what was chosen from a dropdown into the current cell; the arrows
   * only move the focus.
   */
  const targetPicker = (onChosen?: (k: string) => void) => {
    const sp = targets.filter((x) => x.usid != null);
    const hi = targets.filter((x) => x.col != null);
    const spOn = sp.some((x) => x.key === cur);
    const hiOn = hi.some((x) => x.key === cur);
    const idx = sp.findIndex((x) => x.key === cur);
    const focus = (k: string) => {
      setActive(k);
      setInverse(false);
    };
    const choose = (k: string) => {
      if (!k) return;
      focus(k);
      onChosen?.(k);
    };
    const opts = (xs: Target[]) => xs.map((x) => ({ value: x.key, label: `${x.label} · ${popcount(masks[x.key])}` }));
    const box = (on: boolean) => `flex-1 rounded-lg border-2 px-1.5 pb-1.5 pt-1 ${on ? 'border-[#00A2A5]' : 'border-transparent'}`;
    const arrow = (dir: 'back' | 'forward') => (
      <Pressable
        onPress={() => {
          if (!sp.length) return;
          focus(sp[dir === 'back' ? (idx <= 0 ? sp.length : idx) - 1 : (idx + 1) % sp.length].key);
        }}
        accessibilityRole="button"
        accessibilityLabel={t(dir === 'back' ? 'gloria.freq.prevSpecies' : 'gloria.freq.nextSpecies')}
        // As tall as the menu beside it (py-2 + border + one text-base line),
        // which grows with the font size.
        style={{ width: Math.round(36 * fs), height: 18 + Math.round(24 * fs) }}
        className="mb-1.5 items-center justify-center rounded-lg border border-gray-300 dark:border-gray-700"
      >
        <Ionicons name={dir === 'back' ? 'chevron-back' : 'chevron-forward'} size={Math.round(18 * fs)} color="#6b7280" />
      </Pressable>
    );
    return (
      <View className="gap-1.5">
        <View className="flex-row items-end gap-1.5">
          {arrow('back')}
          <View className={box(spOn)}>
            <SelectRow
              variant="inline"
              label={t('gloria.freq.speciesPick', { n: sp.length })}
              value={spOn ? cur! : ''}
              options={[{ value: '', label: t('gloria.freq.speciesNone') }, ...opts(sp)]}
              onChange={choose}
            />
          </View>
          {arrow('forward')}
        </View>
        <View className="flex-row items-end gap-1.5">
          <View className={box(hiOn)}>
            <SelectRow
              variant="inline"
              label={t('gloria.freq.disturbPick')}
              value={hiOn ? cur! : ''}
              options={[{ value: '', label: t('gloria.freq.speciesNone') }, ...opts(hi)]}
              onChange={choose}
            />
          </View>
          <View className="mb-1.5">
            <Btn small label={t('gloria.freq.newSpecies')} onPress={() => (locked ? toast(t('gloria.freq.lockedToast')) : setAdding(true))} />
          </View>
        </View>
      </View>
    );
  };
  /** Put `key` into the current cell (cell mode), or take it out. */
  const setInCell = (key: string, on: boolean) => write(key, setBits(masks[key] ?? emptyMask(CELLS), [sel], on));

  const nextCell = (clear: boolean) => {
    if (clear) for (const tg of targets) if (getBit(masks[tg.key] ?? '', sel)) write(tg.key, setBits(masks[tg.key], [sel], false));
    void Haptics.selectionAsync();
    setSel((sel + 1) % CELLS);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('gloria.freq.title', { code }),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              {mode !== 'count' && !locked ? (
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
              {mode !== 'count' && !locked ? (
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
                  clearUndo();
                  setAdding(false);
                  reload();
                  toast(locked ? t('gloria.freq.unlocked') : t('gloria.freq.lockedDone'));
                }}
              />
            </View>
          ),
        }}
      />
      {/* The grid stays put (a drag on it must never scroll the page); the
          species and tools below scroll on their own. */}
      <View className="gap-2.5 px-4 pt-4">
        <Seg
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'brush', label: t('gloria.freq.brush') },
            { value: 'cell', label: t('gloria.freq.cellMode') },
            { value: 'count', label: t('gloria.freq.countMode') },
          ]}
        />
        {mode !== 'count' ? (
        <>
        <View className="flex-row items-center justify-center">
          {touched != null ? (
            <Text
              accessibilityLiveRegion="polite"
              className="absolute left-0 rounded bg-gray-800 px-1.5 py-0.5 text-xs font-bold text-white dark:bg-gray-200 dark:text-gray-900"
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {`R${Math.floor(touched / QUADRAT_N) + 1}C${(touched % QUADRAT_N) + 1}`}
            </Text>
          ) : null}
          <Text className="text-center text-xs font-semibold text-[#00797b] dark:text-cyan-300">{t('gloria.freq.uphill')}</Text>
        </View>
        <View className="flex-row items-center">
          <Text className="w-5 text-center text-[11px] font-bold text-gray-700 dark:text-gray-200" style={{ transform: [{ rotate: '-90deg' }] }}>{leftSide}</Text>
          <View className="flex-1">
            <View className="flex-row" style={{ marginLeft: 22 }}>
              {Array.from({ length: QUADRAT_N }, (_, c) => (
                <Text key={c} style={{ width: cellPx }} className="text-center text-[10px] font-semibold text-gray-700 dark:text-gray-200">{`C${c + 1}`}</Text>
              ))}
            </View>
            <View className="flex-row">
              <View style={{ width: 22 }}>
                {Array.from({ length: QUADRAT_N }, (_, r) => (
                  <Text key={r} style={{ height: cellPx, lineHeight: cellPx }} className="text-[10px] font-semibold text-gray-700 dark:text-gray-200">{`R${r + 1}`}</Text>
                ))}
              </View>
              <GestureDetector gesture={gesture}>
                <View
                  onLayout={(e) => setSize(Math.min(e.nativeEvent.layout.width, 360))}
                  className="flex-1 flex-row flex-wrap border-2 border-gray-600 dark:border-gray-400"
                  style={{ aspectRatio: 1, maxWidth: 360 }}
                  accessibilityLabel={t('gloria.freq.gridLabel')}
                >
                  {Array.from({ length: CELLS }, (_, i) => {
                    const on = mode === 'brush' && cur != null && getBit(masks[cur] ?? '', i);
                    const others = targets.filter((tg) => tg.key !== (mode === 'brush' ? cur : '') && !tg.tone && getBit(masks[tg.key] ?? '', i)).length;
                    const graze = mode === 'cell' || !curTarget?.tone ? targets.find((tg) => tg.tone && getBit(masks[tg.key] ?? '', i)) : undefined;
                    return (
                      <View
                        key={i}
                        style={{
                          width: `${100 / QUADRAT_N}%`,
                          height: `${100 / QUADRAT_N}%`,
                          backgroundColor: on ? (curTarget?.tone ?? '#00A2A5') : undefined,
                          borderWidth: mode === 'cell' && i === sel ? 2 : 0.5,
                          borderColor: mode === 'cell' && i === sel ? '#d97706' : '#d1d5db',
                        }}
                        className={on ? '' : 'bg-white dark:bg-gray-900'}
                      >
                        {inverse && !on ? <Text className="text-center text-[11px] font-bold text-red-500">×</Text> : null}
                        {others > 0 && !inverse ? (
                          <View className="absolute bottom-0.5 left-0.5 flex-row">
                            {Array.from({ length: Math.min(others, 4) }, (_, k) => (
                              <View key={k} className={`mr-px h-[3px] w-[3px] rounded-full ${on ? 'bg-gray-800' : 'bg-gray-400'}`} />
                            ))}
                          </View>
                        ) : null}
                        {graze ? <View className="absolute right-0.5 top-0.5 h-[5px] w-[5px] rounded-sm" style={{ backgroundColor: graze.tone }} /> : null}
                      </View>
                    );
                  })}
                  {/* Centre lines (between C5|C6 and R5|R6) split the quadrat
                      into quarters, the way the field frame is read. */}
                  <View pointerEvents="none" className="absolute bottom-0 top-0 bg-gray-800 dark:bg-gray-200" style={{ left: '50%', width: 2, marginLeft: -1 }} />
                  <View pointerEvents="none" className="absolute left-0 right-0 bg-gray-800 dark:bg-gray-200" style={{ top: '50%', height: 2, marginTop: -1 }} />
                </View>
              </GestureDetector>
            </View>
          </View>
          <Text className="w-5 text-center text-[11px] font-bold text-gray-700 dark:text-gray-200" style={{ transform: [{ rotate: '90deg' }] }}>{rightSide}</Text>
        </View>
        </>
        ) : null}

      </View>
      <ScrollView className="flex-1" contentContainerClassName="gap-2.5 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {cross.length ? (
          <FoldBanner tone="error" title={t('gloria.unit.crossTitle')} count={cross.length}>
            {cross.map((c, k) => (
              <BannerText key={k} tone="error">{c}</BannerText>
            ))}
          </FoldBanner>
        ) : null}

        {mode === 'count' ? (
          <>
            <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.freq.countHint')}</Text>
            {countRows.map((r, i) => (
              <View key={r.key} className="flex-row items-center border-b border-gray-100 py-1 dark:border-gray-800">
                {r.tone ? <View className="mr-2 h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: r.tone }} /> : null}
                <Text className="flex-1 text-sm text-gray-900 dark:text-gray-100" numberOfLines={1}>{r.label}</Text>
                <NumField
                  ref={(x) => { countRefs.current[i] = x; }}
                  value={r.value}
                  onCommit={(v) => commitCount(() => r.save(v))}
                  onSubmitEditing={i < countRows.length - 1 ? () => countRefs.current[i + 1]?.focus() : undefined}
                  accessibilityLabel={r.label}
                  range={RANGES.cells}
                  editable={!locked}
                />
              </View>
            ))}
            <View className="flex-row">
              <Chip label={t('gloria.freq.newSpecies')} on={false} onPress={() => (locked ? toast(t('gloria.freq.lockedToast')) : setAdding(true))} />
            </View>
          </>
        ) : mode === 'brush' ? (
          <>
            {targetPicker()}
            <View className="flex-row gap-2">
              <Btn small label={t('gloria.freq.fillAll')} disabled={!cur || locked} onPress={() => cur && write(cur, fillMask(CELLS, true))} />
              <Btn
                small
                label={inverse ? t('gloria.freq.inverseDone') : t('gloria.freq.inverse')}
                disabled={!cur || locked}
                onPress={() => {
                  if (!cur) return;
                  if (!inverse) write(cur, fillMask(CELLS, true));
                  setInverse(!inverse);
                }}
              />
              <Btn small label={t('gloria.freq.clear')} disabled={!cur || locked} onPress={() => cur && write(cur, fillMask(CELLS, false))} />
            </View>
            <Text className="text-xs text-gray-500 dark:text-gray-400">{inverse ? t('gloria.freq.inverseHint') : t('gloria.freq.brushHint')}</Text>
          </>
        ) : (
          <>
            <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.freq.cellTitle', { cell: rcLabel(sel), n: sel + 1 })}</Text>
            {/* What this cell already holds; ✕ takes one out. */}
            <View className="flex-row flex-wrap items-center">
              <Text className="mb-1.5 mr-1.5 text-xs text-gray-500 dark:text-gray-400">{t('gloria.freq.inCell')}</Text>
              {targets.filter((tg) => getBit(masks[tg.key] ?? '', sel)).length === 0 ? (
                <Text className="mb-1.5 text-xs text-gray-400">{t('gloria.freq.cellEmpty')}</Text>
              ) : (
                targets
                  .filter((tg) => getBit(masks[tg.key] ?? '', sel))
                  .map((tg) => (
                    <Chip key={tg.key} label={`${tg.label}  ✕`} tone={tg.tone} on onPress={() => setInCell(tg.key, false)} />
                  ))
              )}
            </View>
            {targetPicker((k) => setInCell(k, true))}
            {curTarget ? (
              <Btn
                label={
                  getBit(masks[curTarget.key] ?? '', sel)
                    ? t('gloria.freq.cellHas', { name: curTarget.label })
                    : t('gloria.freq.cellAdd', { name: curTarget.label })
                }
                disabled={locked}
                onPress={() => setInCell(curTarget.key, !getBit(masks[curTarget.key] ?? '', sel))}
              />
            ) : null}
            <View className="flex-row gap-2">
              <View className="flex-1"><Btn label={t('gloria.freq.emptyNext')} onPress={() => nextCell(true)} /></View>
              <View className="flex-[2]"><Btn primary label={t('gloria.freq.next')} onPress={() => nextCell(false)} /></View>
            </View>
          </>
        )}
      </ScrollView>
      {adding ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox
            scopeGroups={GLORIA_SEARCH_GROUPS}
            onSelect={async (r) => {
              if (!r.taxon_id) return;
              const label = await pickMorphoLabel(t, unit.survey_id, r.taxon_id, r.rank, r.cname || r.name);
              if (label === undefined) return;
              const usid = addUnitSpecies(unit.id, r.taxon_id, label);
              if (mode !== 'count' && unit.freq_mode !== 'cells') startFrequency(unit.id);
              setAdding(false);
              setActive(`sp${usid}`);
              reload();
              toast(t('gloria.freq.addedNoCover', { name: r.cname || r.name }), {
                action: { label: t('gloria.freq.goCover'), onPress: () => router.replace(`/gloria/${id}/${code}` as Href) },
              });
            }}
          />
        </KeyboardStickyView>
      ) : null}
      <NumAccessory />
      {panel ? <OverviewPanel state={state} code={code} current="frequency" onClose={() => setPanel(false)} /> : null}
    </SafeAreaView>
  );
}
