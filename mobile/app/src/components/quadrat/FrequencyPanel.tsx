/**
 * Frequency entry (06-plot-quadrats design 10d), the one UI for every grid:
 * the fixed plot's 「頻度」 tab (the whole plot as one grid, v78), a quadrat's
 * frequency view and GLORIA's 1×1 m frequency (user decision 2026-09-29:
 * same UI and UX everywhere). Input method, the grid, the species picker,
 * tools, and a bar fixed at the bottom.
 *
 *   - 筆刷: the species pager (SpeciesPager) — swipe or ‹ ›, tap for the list.
 *   - 逐格: what the current cell holds as chips (✕ takes one out), and the
 *     species card of the point screen (SpeciesToggleCard): tap = in this
 *     cell, long press = in this cell and on to the next.
 *   - 只記格數: a count per species.
 *
 * The caller owns the data: `items` in, one write per stroke / count / mode
 * switch out. Masks live here while painting so the grid follows the finger;
 * `onMask` gets the finished stroke.
 */
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { Alert, Pressable, ScrollView, Text, View, type TextInput } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import type { AdoptionInput } from '~/db/taxonLookup';
import type { SearchResult, TaxonGroup } from '~/db/types';
import { emptyMask, fillMask, getBit, popcount, rcLabel, setBits } from '~/lib/grid';
import { KEYPAD_EMPTY, keypadLongPress, keypadPress, type KeypadAxis, type KeypadState } from '~/lib/gridKeypad';
import { compactSpeciesLabel } from '~/lib/speciesLabel';
import { useSettings } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';
import { BannerText, Btn, Chip, FoldBanner, NumField, Seg } from '~/modules/gloria/components/ui';
import { FrequencyGrid, type FrequencyGridHandle } from './FrequencyGrid';
import { GridKeypad } from './GridKeypad';
import { SpeciesPager, SpeciesToggleCard, type PagerSpecies } from './SpeciesPager';

export type FreqItem = {
  /** Stable key within the panel (a row id). */
  key: string;
  /** '' for something that is not a species (GLORIA's grazing features). */
  taxon_id: string;
  /** Full display name. */
  name: string;
  cname: string | null;
  sci: string | null;
  /** A morphospecies label, after the name. */
  qualifier?: string | null;
  /** The species' layer ("草本層"), for the pager tag and the filter. */
  layer: string | null;
  /** Only for what is not a species (GLORIA's Hi1–Hi3): species share one colour. */
  color?: string;
  /** Marked in a cell's corner instead of counted with the species (GLORIA's Hi1–Hi3). */
  tone?: boolean;
  cover: number | null;
  freq_cells: string | null;
  freq_count: number | null;
};

type Input = 'brush' | 'cell' | 'count';

export function FrequencyPanel({
  items,
  n,
  storedMode,
  topEdgeLabel,
  leftRightLabels,
  ro,
  layer,
  onFilter,
  refused,
  onMask,
  onCount,
  onSwitchMode,
  onAdd,
  searchGroups,
  issues,
  hints,
  emptyHint,
  footer,
  gridRef,
}: {
  items: readonly FreqItem[];
  /** Cells per side. */
  n: number;
  /** How the data is kept: painted cells or plain counts. */
  storedMode: 'cells' | 'count';
  /** Over the grid ("▲ 上邊 · N"). */
  topEdgeLabel: string;
  /** Beside the grid, left and right. */
  leftRightLabels?: readonly [string, string];
  ro: boolean;
  /** Layer filter; null = every species. */
  layer: string | null;
  /** Given: a 「篩選」 tool opens the layer choice (where there is no ⋯ menu of its own). */
  onFilter?: () => void;
  /** True when an edit must not happen (and says why). */
  refused: () => boolean;
  onMask: (key: string, mask: string) => void;
  onCount: (key: string, count: number | null) => void;
  /** Store the other method (clearing the one left); false when refused. Omit
   *  where the method is fixed (a survey template's Frequency, 2G-d3): only
   *  the inputs of the stored method are offered. */
  onSwitchMode?: (toCount: boolean) => boolean;
  /** Given: 「＋ 新物種」 adds the searched species and returns its key (null = not added). */
  onAdd?: (r: SearchResult, adopted?: AdoptionInput | null) => string | null | Promise<string | null>;
  /** Groups the search is kept to. */
  searchGroups?: TaxonGroup[];
  /** Cover ⇄ frequency mismatches, one line each. */
  issues?: { title: string; lines: readonly string[] } | null;
  /** Wording of the caller's own (GLORIA mentions its grazing features). */
  hints?: { brush?: string; inverse?: string; count?: string };
  /** Said while there is no species yet. */
  emptyHint?: string;
  /** Fixed under the page (e.g. 「完成並鎖定」); hidden while searching. */
  footer?: React.ReactNode;
  gridRef: React.Ref<FrequencyGridHandle>;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const cells = n * n;
  const [mode, setMode] = useState<Input>(() => (storedMode === 'count' ? 'count' : 'brush'));
  // The mode as of right now: a count field blurring while it unmounts
  // commits after the switch, and must not write any more.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [active, setActive] = useState<string | null>(null);
  const [inverse, setInverse] = useState(false);
  const [sel, setSel] = useState(0);
  const [adding, setAdding] = useState(false);
  // Height the panel has between the tabs and the bottom bar: the grid gives
  // up size so the species card and its tools stay on screen with it.
  const [areaH, setAreaH] = useState(0);
  const tc = useThemeColors();
  // The R / C keypad (brush only): shown or not is remembered; its state
  // lives in a ref as well, so quick presses never read a stale render.
  const showPad = useSettings((st) => st.freq_keypad);
  const [pad, setPadState] = useState<KeypadState>(KEYPAD_EMPTY);
  const padRef = useRef(pad);
  const setPad = (p: KeypadState) => {
    padRef.current = p;
    setPadState(p);
  };
  // The lower part scrolls: a ⌄ says there is more under the fold.
  const [fold, setFold] = useState({ h: 0, content: 0, y: 0 });
  const moreBelow = fold.content - fold.y - fold.h > 8;
  const countRefs = useRef<(TextInput | null)[]>([]);

  // The masks live here, and this copy is the truth while the screen is in
  // use — as GLORIA's own screen kept it before the panel existed. The parent
  // gets one write per stroke; what comes back from it is taken only when it
  // was changed elsewhere (undo, a mode switch, a new species). Re-taking the
  // parent's copy on every re-render reset strokes the parent did not have yet
  // (a write that lands late on iOS, a delayed reload), which lost taps.
  const fromDb = useMemo(() => Object.fromEntries(items.map((s) => [s.key, s.freq_cells ?? emptyMask(cells)])), [items, cells]);
  const [masks, setMasksState] = useState<Record<string, string>>(fromDb);
  const masksRef = useRef(fromDb);
  const setMasks = (m: Record<string, string>) => {
    masksRef.current = m;
    setMasksState(m);
  };
  /** The parent's copy as last seen, and masks sent to it not yet echoed back. */
  const parentRef = useRef(fromDb);
  const sentRef = useRef<Record<string, Set<string>>>({});
  const send = (key: string, mask: string) => {
    (sentRef.current[key] ??= new Set()).add(mask);
    onMask(key, mask);
  };
  useEffect(() => {
    const next: Record<string, string> = {};
    let changed = false;
    for (const [k, v] of Object.entries(fromDb)) {
      const mine = masksRef.current[k];
      const pending = sentRef.current[k];
      if (mine === undefined) {
        next[k] = v; // a new species
        changed = true;
      } else if (pending?.has(v)) {
        next[k] = mine; // our own write coming back
        if (v === mine) delete sentRef.current[k];
      } else if (v !== parentRef.current[k] && v !== mine) {
        next[k] = v; // changed elsewhere: it wins
        delete sentRef.current[k];
        changed = true;
      } else {
        next[k] = mine;
      }
    }
    if (Object.keys(masksRef.current).some((k) => !(k in fromDb))) changed = true; // a species gone
    parentRef.current = fromDb;
    if (changed) setMasks(next);
  }, [fromDb]);
  const tones = useMemo(() => Object.fromEntries(items.filter((s) => s.tone && s.color).map((s) => [s.key, s.color!])), [items]);

  // The layer filter applies to species; grazing features always stay.
  const shown = layer ? items.filter((s) => s.tone || s.layer === layer) : items;
  const cur = active && shown.some((s) => s.key === active) ? active : (shown[0]?.key ?? null);
  const curIndex = Math.max(0, shown.findIndex((s) => s.key === cur));
  const curItem = items.find((s) => s.key === cur);
  // Another species or grid: a half-entered R / C is dropped, a lock kept
  // (the same row for the next species); a new grid size starts clean.
  useEffect(() => {
    if (padRef.current.pending) setPad({ ...padRef.current, pending: null });
  }, [cur]);
  useEffect(() => {
    setPad(KEYPAD_EMPTY);
  }, [n]);
  const cellsOf = (s: FreqItem) => (storedMode === 'count' ? (s.freq_count ?? 0) : popcount(masks[s.key] ?? s.freq_cells));
  const short = (s: FreqItem) => compactSpeciesLabel({ cname: s.cname, sci: s.sci, qualifier: s.qualifier, fallback: s.name });
  const write = (key: string, mask: string) => {
    if ((masksRef.current[key] ?? emptyMask(cells)) === mask) return;
    if (refused()) return;
    setMasks({ ...masksRef.current, [key]: mask });
    send(key, mask);
  };

  const hasCells = storedMode !== 'count' && items.some((s) => popcount(s.freq_cells) > 0);
  const hasCounts = storedMode === 'count' && items.some((s) => s.freq_count != null);
  const switchMode = (next: Input) => {
    if (next === mode) return;
    const toCount = next === 'count';
    const fromCount = mode === 'count';
    const go = () => {
      setInverse(false);
      setMode(next);
    };
    // Brush ⇄ cell only changes how the same cells are entered.
    if (!toCount && !fromCount) return go();
    if (refused()) return;
    const loses = toCount ? hasCells : hasCounts;
    const apply = () => {
      if (onSwitchMode?.(toCount)) go();
    };
    if (!loses) return apply();
    Alert.alert(t('plot.quadrats.switchTitle'), toCount ? t('plot.quadrats.switchToCount') : t('plot.quadrats.switchToCells'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('plot.quadrats.switchConfirm'), style: 'destructive', onPress: apply },
    ]);
  };

  const inCell = (key: string) => getBit(masks[key] ?? '', sel);
  const setInCell = (key: string, on: boolean) => write(key, setBits(masksRef.current[key] ?? emptyMask(cells), [sel], on));
  const nextCell = (clear: boolean) => {
    if (clear) for (const s of items) if (inCell(s.key)) setInCell(s.key, false);
    void Haptics.selectionAsync();
    setSel((sel + 1) % cells);
  };
  const pick = (i: number) => {
    setActive(shown[i].key);
    setInverse(false);
  };

  const padPress = (axis: KeypadAxis, k: number) => {
    const res = keypadPress(padRef.current, { axis, k }, n);
    setPad(res.state);
    if (res.cell == null || !cur) return;
    // The same path as the brush's fill / clear: toggles the cell in this copy, one write.
    const m = masksRef.current[cur] ?? emptyMask(cells);
    write(cur, setBits(m, [res.cell], !getBit(m, res.cell)));
  };
  const padSwitch = (
    <Pressable
      onPress={() => {
        setPad(KEYPAD_EMPTY);
        useSettings.getState().set('freq_keypad', !showPad);
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t(showPad ? 'plot.quadrats.keypadHide' : 'plot.quadrats.keypadShow')}
      className={`h-8 w-10 items-center justify-center rounded-full ${showPad ? 'bg-accent-100 dark:bg-accent-900/60' : 'bg-mark/30'}`}
    >
      <Ionicons name="keypad-outline" size={18} color={showPad ? tc.accent : tc.ink2} />
    </Pressable>
  );

  const pagerItems: PagerSpecies[] = shown.map((s) => ({
    key: s.key,
    name: s.qualifier ? `${s.name} ${s.qualifier}` : s.name,
    cname: s.cname,
    sci: s.sci,
    qualifier: s.qualifier,
    layer: s.layer,
    color: s.color,
    cover: s.cover,
    cells: cellsOf(s),
    missing: (s.cover ?? 0) > 0 && cellsOf(s) === 0,
  }));
  const noSpecies = <Text className="text-sm text-gray-500 dark:text-gray-400">{emptyHint ?? t('plot.quadrats.noSpecies')}</Text>;
  const newSpecies = !ro && onAdd ? <Pill label={`＋ ${t('plot.quadrats.newSpecies')}`} strong onPress={() => setAdding(!adding)} /> : null;
  const filter = onFilter ? <Pill label={layer ? `${t('plot.quadrats.filter')} · ${layer}` : t('plot.quadrats.filter')} onPress={onFilter} /> : null;
  const banner = issues?.lines.length ? (
    <FoldBanner tone="error" title={issues.title} count={issues.lines.length}>
      {issues.lines.map((l, k) => (
        <BannerText key={k} tone="error">
          {l}
        </BannerText>
      ))}
    </FoldBanner>
  ) : null;

  const inputs: { value: Input; label: string }[] = [
    ...(onSwitchMode || storedMode === 'cells'
      ? [
          { value: 'brush' as const, label: t('quadrat.freq.brush') },
          { value: 'cell' as const, label: t('quadrat.freq.cellMode') },
        ]
      : []),
    ...(onSwitchMode || storedMode === 'count' ? [{ value: 'count' as const, label: t('quadrat.freq.countMode') }] : []),
  ];
  // One way left (a fixed count): nothing to switch.
  const top = inputs.length > 1 ? <Seg value={mode} onChange={switchMode} options={inputs} /> : null;

  const brushTools = (
    <>
      {shown.length ? (
        <SpeciesPager items={pagerItems} index={curIndex} total={cells} onIndex={pick} compact={showPad} trailing={padSwitch} />
      ) : (
        noSpecies
      )}
      {showPad && shown.length ? (
        <GridKeypad
          n={n}
          state={pad}
          disabled={ro}
          onPress={padPress}
          onLongPress={(axis, k) => setPad(keypadLongPress(padRef.current, { axis, k }))}
        />
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        <Pill label={t('quadrat.freq.fillAll')} disabled={!cur || ro} onPress={() => cur && write(cur, fillMask(cells, true))} />
        <Pill
          label={inverse ? t('quadrat.freq.inverseDone') : t('quadrat.freq.inverse')}
          disabled={!cur || ro}
          onPress={() => {
            if (!cur) return;
            if (!inverse) write(cur, fillMask(cells, true));
            setInverse(!inverse);
          }}
        />
        <Pill label={t('quadrat.freq.clear')} danger disabled={!cur || ro} onPress={() => cur && write(cur, fillMask(cells, false))} />
        <View className="flex-1" />
        {filter}
        {newSpecies}
      </View>
      <Text className="text-xs text-gray-500 dark:text-gray-400">
        {inverse ? (hints?.inverse ?? t('plot.quadrats.inverseHint')) : `${t('plot.quadrats.pagerHint')}${hints?.brush ?? t('plot.quadrats.brushHint')}`}
      </Text>
    </>
  );

  const held = items.filter((s) => inCell(s.key));
  const cellTools = (
    <>
      {/* The cell and what it holds so far (✕ takes one out), the tools on the
          right: one row, so the species card stays on screen under the grid. */}
      <View className="flex-row items-start gap-2">
        <View className="flex-1 flex-row flex-wrap items-center">
          <Text className="mb-1.5 mr-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('plot.quadrats.cellTitle', { cell: rcLabel(sel, n), n: sel + 1, total: cells })}
          </Text>
          <Text className="mb-1.5 mr-1.5 text-xs text-gray-500 dark:text-gray-400">{t('plot.quadrats.inCell')}</Text>
          {held.length === 0 ? (
            <Text className="mb-1.5 text-xs text-gray-400">{t('plot.quadrats.cellEmpty')}</Text>
          ) : (
            held.map((s) => (
              <Chip key={s.key} label={`${short(s)}  ✕`} tone={s.tone ? s.color : undefined} on onPress={() => setInCell(s.key, false)} />
            ))
          )}
        </View>
        {filter}
        {newSpecies}
      </View>
      {curItem && shown.length ? (
        <SpeciesToggleCard
          items={pagerItems}
          index={curIndex}
          onIndex={pick}
          on={inCell(curItem.key)}
          disabled={ro}
          onToggle={() => setInCell(curItem.key, !inCell(curItem.key))}
          onLongPress={() => {
            setInCell(curItem.key, true);
            nextCell(false);
          }}
          count={cellsOf(curItem)}
          hint={t('plot.quadrats.cardHint')}
          pickLabel={t('plot.quadrats.pickSpecies')}
        />
      ) : (
        noSpecies
      )}
      <Text className="text-xs text-gray-500 dark:text-gray-400">{t('plot.quadrats.cardHint')}</Text>
    </>
  );

  return (
    <>
      {mode !== 'count' ? (
        <View className="flex-1" onLayout={(e) => setAreaH(Math.floor(e.nativeEvent.layout.height))}>
          {/* The grid stays put, as GLORIA's frequency screen always had it:
              inside a scrolling page, the page's scroll and the brush fought
              over every touch (a tap sometimes did nothing, or needed a
              second one). Only the species card and tools below scroll. */}
          <View className="gap-2.5 px-4 pt-3">
            {top}
            <FrequencyGrid
              ref={gridRef}
              n={n}
              masks={masks}
              active={cur}
              activeColor={curItem?.tone ? curItem.color : undefined}
              mode={mode}
              sel={sel}
              onSelectCell={setSel}
              inverse={inverse}
              tones={tones}
              topEdgeLabel={topEdgeLabel}
              leftRightLabels={leftRightLabels}
              locked={ro}
              onLocked={() => refused()}
              readMask={(key) => masksRef.current[key]}
              onPaint={(key, mask) => setMasks({ ...masksRef.current, [key]: mask })}
              onCommit={(key, mask) => send(key, mask)}
              maxSize={gridMax(areaH, mode, mode === 'brush' && showPad, n)}
              accessibilityLabel={t('plot.quadrats.gridLabel', { n })}
            />
          </View>
          <View className="flex-1">
            <ScrollView
              className="flex-1"
              contentContainerClassName="gap-3 px-4 pb-4 pt-3"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={32}
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                setFold((f) => (f.h === h ? f : { ...f, h }));
              }}
              onContentSizeChange={(_w, content) => setFold((f) => (f.content === content ? f : { ...f, content }))}
              onScroll={(e) => {
                const y = e.nativeEvent.contentOffset.y;
                setFold((f) => (Math.abs(f.y - y) < 4 ? f : { ...f, y }));
              }}
            >
              {mode === 'brush' ? brushTools : cellTools}
              {/* Under the tools: the species card comes first on a short screen. */}
              {banner}
            </ScrollView>
            {moreBelow ? (
              <View
                pointerEvents="none"
                accessibilityLabel={t('plot.quadrats.moreBelow')}
                className="absolute bottom-1 h-7 w-7 items-center justify-center self-center rounded-full bg-card/90 dark:bg-card-dark/90"
              >
                <Ionicons name="chevron-down" size={18} color={tc.ink2} />
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pb-4 pt-3" keyboardShouldPersistTaps="handled" bottomOffset={24}>
          {top}
          {banner}
          <Text className="text-xs text-gray-500 dark:text-gray-400">{hints?.count ?? t('plot.quadrats.countHint', { max: cells })}</Text>
          {shown.map((s, i) => (
            <View key={s.key} className="flex-row items-center border-b border-gray-100 py-1 dark:border-gray-800">
              {s.tone && s.color ? <View className="mr-2 h-3 w-3 rounded" style={{ backgroundColor: s.color }} /> : null}
              <Text className="flex-1 text-sm text-gray-900 dark:text-gray-100" numberOfLines={1}>
                {s.layer ? `${short(s)} · ${s.layer}` : short(s)}
              </Text>
              <NumField
                ref={(x) => {
                  countRefs.current[i] = x;
                }}
                value={s.freq_count}
                range={{ min: 0, max: cells, integer: true, unit: '' }}
                editable={!ro}
                accessibilityLabel={t('plot.quadrats.countOf', { name: s.name })}
                onSubmitEditing={i < shown.length - 1 ? () => countRefs.current[i + 1]?.focus() : undefined}
                onCommit={(v) => {
                  if (modeRef.current === 'count') onCount(s.key, v);
                }}
              />
            </View>
          ))}
          {items.length === 0 ? noSpecies : null}
          <View className="flex-row justify-end gap-2">
            {filter}
            {newSpecies}
          </View>
        </KeyboardAwareScrollView>
      )}
      {/* Dock pairing: every parent (plot/[id], plot/[id]/quadrat/[qid],
          gloria/[id]/[code]/frequency) is a <SafeAreaView edges={['bottom']}>
          root, so insets.bottom is the chrome under the dock. */}
      {adding && !ro && onAdd ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View className="flex-row items-center border-t border-line bg-card px-4 py-2 dark:border-line-dark dark:bg-card-dark">
            <Text className="flex-1 text-xs text-gray-500 dark:text-gray-400">{t('plot.quadrats.addingHint')}</Text>
            <Pressable onPress={() => setAdding(false)} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('common.cancel')}</Text>
            </Pressable>
          </View>
          <SearchBox
            scopeGroups={searchGroups}
            onSelect={async (r, adopted) => {
              if (!r.taxon_id) return;
              const key = await onAdd(r, adopted);
              if (key) {
                setAdding(false);
                setActive(key);
              }
            }}
          />
        </KeyboardStickyView>
      ) : mode === 'cell' || (!ro && footer) ? (
        <View className="gap-2 border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
          {mode === 'cell' ? (
            <View className="flex-row gap-2">
              {/* 3 : 4, not 1 : 2 — 「空格 → 下一格」 needs the room for one line. */}
              <View className="flex-[3]">
                <Btn label={t('plot.quadrats.emptyNext')} disabled={ro} onPress={() => nextCell(true)} />
              </View>
              <View className="flex-[4]">
                <Btn primary label={t('plot.quadrats.nextCell')} onPress={() => nextCell(false)} />
              </View>
            </View>
          ) : null}
          {!ro && footer ? footer : null}
        </View>
      ) : null}
    </>
  );
}

/** Room under the grid for what must stay on screen with it: the species
 *  pager and the tool row (筆刷), or the cell line, the species dropdown and
 *  card (逐格); plus the input switch and labels above it. Never below a
 *  floor where cells get too small to hit. */
const ABOVE_GRID = 100;
const BELOW_GRID = { brush: 180, cell: 190 } as const;
const GRID_FLOOR = { brush: 260, cell: 200 } as const;
/** The keypad's two rows, less what the compact species card gives back. */
const KEYPAD_H = 76;
/** Largest cell on a big screen (iPad, Mac). Never caps below the phone's
 *  360, so a small n keeps the grid it always had. */
const MAX_CELL = 64;
function gridMax(areaH: number, mode: 'brush' | 'cell', keypad: boolean, n: number): number {
  if (!areaH) return 360;
  return Math.min(Math.max(360, n * MAX_CELL), Math.max(GRID_FLOOR[mode], areaH - ABOVE_GRID - BELOW_GRID[mode] - (keypad ? KEYPAD_H : 0)));
}

/** Outlined pill for the frequency tools (design 10d). */
function Pill({ label, onPress, disabled, danger, strong }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean; strong?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      className={`items-center justify-center rounded-full bg-card px-4 active:bg-gray-100 dark:bg-card-dark dark:active:bg-gray-800 ${
        strong ? 'border-2 border-mark dark:border-mark-dark' : 'border border-line dark:border-line-dark'
      } ${disabled ? 'opacity-35' : ''}`}
      style={{ minHeight: 40 }}
    >
      <Text className={`text-sm ${strong ? 'font-bold' : 'font-medium'} ${danger ? 'text-alert dark:text-alert-dark' : 'text-ink dark:text-gray-100'}`}>{label}</Text>
    </Pressable>
  );
}
