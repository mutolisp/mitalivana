/**
 * Point-intercept recording, point by point.
 *   - 1×1 m quadrat: point-framing at 100 crosshairs (manual p.41, Work Step J)
 *   - 10×10 m square: 20 lines × 20 points (manual §5.3.1)
 *
 * At each point: every vascular species the pin touches, or — only when no
 * vascular plant is hit — one surface type. Each commit is one transaction
 * (db.commitPoint); storage is canonical, the walk only orders the visits
 * (model/walk.ts).
 *
 * Undo / redo work point by point: a step holds one point's values, and
 * applying it returns the values it replaced (the opposite step). 完成 locks
 * recording and stamps its end — point-framing's own on a quadrat, the whole
 * unit's on a square, where the walk is the survey.
 */
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { addUnitSpecies, commitPoint, setPointsLocked, startPoints } from '~/modules/gloria/db';
import { pickMorphoLabel } from '~/modules/gloria/morpho';
import { QUADRAT_N, SQUARE_N, SURFACE_CODES, SURFACE_UNVISITED, SURFACE_VASCULAR, emptyMask, emptySurface, getBit, popcount, setBits, type SurfaceCode } from '~/modules/gloria/model/grid';
import { linePoint, walkOrder } from '~/modules/gloria/model/walk';
import { unitTypeOf } from '~/modules/gloria/model/units';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { bySpeciesOrder } from '~/modules/gloria/model/speciesOrder';
import { displayName, GLORIA_SEARCH_GROUPS, useSurvey } from '~/modules/gloria/useSurvey';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { Btn, Chip } from '~/modules/gloria/components/ui';
import { WalkDiagram } from '~/modules/gloria/components/WalkDiagram';
import { PointMap } from '~/modules/gloria/components/PointMap';
import { saveVersionSoon } from '~/db/recordVersions';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useThemeColors } from '~/theme/colors';

type PointStep = { seq: number; surface: string; hits: Record<number, boolean> };

export default function PointsScreen() {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
  useVersionOnLeave('gloria', id);
  const code = String(params.code);
  const isSquare = unitTypeOf(code) === 'square';
  const n = isSquare ? SQUARE_N : QUADRAT_N;
  const size = n * n;
  const { state, reload } = useSurvey(id);
  const unit = state?.unit(code);
  const spp = useMemo(() => (state ? [...state.speciesOf(code)].sort(bySpeciesOrder) : []), [state, code]);
  const order = useMemo(() => walkOrder(n, isSquare ? (unit?.walk_option ?? 1) : null), [n, isSquare, unit?.walk_option]);

  const [surface, setSurface] = useState<string>(() => unit?.point_surface ?? emptySurface(size));
  const [hits, setHits] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!unit) return;
    setSurface(unit.point_surface ?? emptySurface(size));
    const h: Record<number, string> = {};
    for (const s of spp) h[s.id] = s.point_hits ?? emptyMask(size);
    setHits(h);
  }, [unit, spp, size]);

  const firstOpen = () => {
    const k = order.findIndex((idx) => (unit?.point_surface ?? emptySurface(size))[idx] === SURFACE_UNVISITED);
    return k < 0 ? size : k; // size = every point recorded
  };
  const [seq, setSeq] = useState(firstOpen);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [scrollOn, setScrollOn] = useState(true);
  const scrollRef = useRef<ScrollView>(null);
  // The species shown on the big card (one at a time, like the frequency screen).
  const [cur, setCur] = useState(0);
  const pendingCard = useRef<number | null>(null);
  useEffect(() => {
    if (pendingCard.current == null) return;
    const k = spp.findIndex((x) => x.id === pendingCard.current);
    if (k >= 0) {
      setCur(k);
      pendingCard.current = null;
    }
  }, [spp]);
  const curIdx = spp.length ? Math.min(cur, spp.length - 1) : 0;
  const nav = useSwipeNav({
    onStep: (d) => spp.length && setCur(((curIdx + d) % spp.length + spp.length) % spp.length),
    hasPrev: spp.length > 1,
    hasNext: spp.length > 1,
  });
  const [panel, setPanel] = useState(false);
  const undo = useRef<PointStep[]>([]);
  const redo = useRef<PointStep[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const locked = unit ? (isSquare ? unit.done_locked === 1 : unit.pf_locked === 1) : null;
  const lockToastShown = useRef(false);
  useEffect(() => {
    if (locked == null || lockToastShown.current) return;
    lockToastShown.current = true;
    if (locked) toast(t('gloria.walk.lockedToast'));
  }, [locked, toast, t]);

  if (!state || !unit) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: code, headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const idx = order[Math.min(seq, size - 1)];
  const { line, point } = linePoint(Math.min(seq, size - 1), n);
  const visited = [...surface].filter((c) => c !== SURFACE_UNVISITED).length;
  const done = visited === size && seq >= size;

  const refuseLocked = () => {
    if (locked) toast(t('gloria.walk.lockedToast'));
    return !!locked;
  };
  const pointAt = (k: number): PointStep => {
    const i = order[k];
    const h: Record<number, boolean> = {};
    for (const s of spp) h[s.id] = getBit(hits[s.id] ?? emptyMask(size), i);
    return { seq: k, surface: surface[i], hits: h };
  };

  const commit = (species: number[], surfaceChar: string) => {
    if (seq >= size || refuseLocked()) return;
    if (unit.point_surface == null) startPoints(unit.id, size);
    undo.current.push(pointAt(seq));
    redo.current = [];
    setUndoCount(undo.current.length);
    setRedoCount(0);
    const on = new Set(species);
    commitPoint(unit.id, size, idx, spp.map((s) => ({ unitSpeciesId: s.id, on: on.has(s.id) })), surfaceChar);
    const nextHits = { ...hits };
    for (const s of spp) nextHits[s.id] = setBits(nextHits[s.id] ?? emptyMask(size), [idx], on.has(s.id));
    setHits(nextHits);
    setSurface(surface.slice(0, idx) + surfaceChar + surface.slice(idx + 1));
    setPicked(new Set());
    const lineEnd = (seq + 1) % n === 0;
    if (lineEnd) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const lineIdx = order.slice(seq + 1 - n, seq + 1);
      const lineHitsN = lineIdx.reduce((a, i) => a + spp.filter((s) => getBit(nextHits[s.id], i)).length, 0);
      toast(t('gloria.walk.lineDone', { line, hits: lineHitsN }));
    } else {
      void Haptics.selectionAsync();
    }
    setSeq(seq + 1);
  };

  /** What the previous point holds, for the 同前一點 button (species names, else the surface type). */
  const previousText = (): string | null => {
    if (seq === 0 || seq > size) return null;
    const prevIdx = order[seq - 1];
    const ch = surface[prevIdx];
    if (ch === SURFACE_UNVISITED) return null;
    const names = spp.filter((s) => getBit(hits[s.id] ?? '', prevIdx)).map((s) => displayName(s));
    return names.length ? names.join('、') : t(`gloria.surface.${ch}`);
  };

  const sameAsPrevious = () => {
    if (seq === 0) return;
    const prevIdx = order[seq - 1];
    const ch = surface[prevIdx];
    if (ch === SURFACE_UNVISITED) return;
    const sp = spp.filter((s) => getBit(hits[s.id] ?? '', prevIdx)).map((s) => s.id);
    commit(sp, ch);
  };

  /** Write one point's values back; returns the values they replaced. */
  const applyStep = (u: PointStep): PointStep => {
    const before = pointAt(u.seq);
    const i = order[u.seq];
    commitPoint(unit.id, size, i, spp.map((s) => ({ unitSpeciesId: s.id, on: !!u.hits[s.id] })), u.surface);
    const nextHits = { ...hits };
    for (const s of spp) nextHits[s.id] = setBits(nextHits[s.id] ?? emptyMask(size), [i], !!u.hits[s.id]);
    setHits(nextHits);
    setSurface(surface.slice(0, i) + u.surface + surface.slice(i + 1));
    setPicked(new Set());
    return before;
  };
  const doUndo = () => {
    const u = undo.current.pop();
    if (!u) return;
    redo.current.push(applyStep(u));
    setUndoCount(undo.current.length);
    setRedoCount(redo.current.length);
    setSeq(u.seq);
  };
  const doRedo = () => {
    const r = redo.current.pop();
    if (!r) return;
    undo.current.push(applyStep(r));
    setUndoCount(undo.current.length);
    setRedoCount(redo.current.length);
    setSeq(r.seq + 1);
  };
  const toggleLock = async () => {
    let endTs: number | null = null;
    if (!locked) {
      const chosen = await chooseEndTime(isSquare ? unit.stop_ts : unit.pf_stop_ts);
      if (chosen === undefined) return;
      endTs = chosen;
    }
    setPointsLocked(unit.id, !locked, endTs);
    if (!locked) saveVersionSoon('gloria', id, 'done');
    undo.current = [];
    redo.current = [];
    setUndoCount(0);
    setRedoCount(0);
    reload();
    toast(t(locked ? 'gloria.walk.unlocked' : 'gloria.walk.lockedDone'));
  };

  /** Go back to a recorded point (or the first open one); false when it cannot be reached yet. */
  const jumpTo = (canonical: number): boolean => {
    const k = order.indexOf(canonical);
    if (k < 0 || (surface[canonical] === SURFACE_UNVISITED && k > firstOpenLive())) return false;
    setSeq(k);
    setPicked(new Set(spp.filter((s) => getBit(hits[s.id] ?? '', canonical)).map((s) => s.id)));
    return true;
  };
  const firstOpenLive = () => {
    const k = order.findIndex((i) => surface[i] === SURFACE_UNVISITED);
    return k < 0 ? size : k;
  };

  const toggle = (usid: number) => {
    const p = new Set(picked);
    if (p.has(usid)) p.delete(usid);
    else p.add(usid);
    setPicked(p);
  };

  /**
   * One species at a time, large: swipe or ‹ › to another, tap its name for the
   * full list. Tap the card = hit here (again = not); long press = hit, record
   * the point and go on. The card stays on its species for the next point.
   */
  const spCard = () => {
    const s = spp[curIdx];
    if (!s) return <Text className="py-4 text-center text-sm text-gray-400">{t('gloria.walk.noSpecies')}</Text>;
    const on = picked.has(s.id);
    const arrow = (d: -1 | 1) => (
      <Pressable
        onPress={() => setCur(((curIdx + d) % spp.length + spp.length) % spp.length)}
        disabled={spp.length < 2}
        accessibilityRole="button"
        accessibilityLabel={t(d < 0 ? 'gloria.freq.prevSpecies' : 'gloria.freq.nextSpecies')}
        className="w-11 items-center justify-center self-stretch rounded-lg border border-gray-300 dark:border-gray-700"
      >
        <Ionicons name={d < 0 ? 'chevron-back' : 'chevron-forward'} size={22} color={tc.ink2} />
      </Pressable>
    );
    return (
      <SwipeNavArea nav={nav} style={{ flex: 0 }}>
        <View className="flex-row items-stretch gap-2">
          {arrow(-1)}
          <View className="flex-1 gap-1.5">
            <Select
              value={{ value: String(s.id), label: displayName(s) }}
              onValueChange={(o) => o && setCur(Math.max(0, spp.findIndex((x) => String(x.id) === o.value)))}
            >
              <SelectTrigger className="w-full" accessibilityLabel={t('gloria.walk.pickSpecies')}>
                <SelectValue placeholder={displayName(s)} />
              </SelectTrigger>
              <SelectContent>
                {spp.map((x) => (
                  <SelectItem key={x.id} value={String(x.id)} label={`${displayName(x)} · ${popcount(hits[x.id])}`} />
                ))}
              </SelectContent>
            </Select>
            <Pressable
              onPress={() => !done && toggle(s.id)}
              onLongPress={() => {
                if (done) return;
                commit([...new Set([...picked, s.id])], SURFACE_VASCULAR);
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityHint={t('gloria.walk.cardHint')}
              style={on ? { backgroundColor: tc.accent, borderColor: tc.accent } : undefined}
              className="min-h-[112px] items-center justify-center rounded-xl border-2 border-gray-300 bg-card px-3 py-3 dark:border-gray-700 dark:bg-gray-900"
            >
              <Text className={`text-center text-2xl font-bold ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`} numberOfLines={2}>
                {displayName(s)}
              </Text>
              <Text className={`text-center text-xs italic ${on ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`} numberOfLines={1}>
                {s.simple_name}
              </Text>
              <Text className={`mt-1 text-[10px] ${on ? 'text-white' : 'text-accent-700 dark:text-accent-300'}`} style={{ fontVariant: ['tabular-nums'] }}>
                {on ? t('gloria.walk.cardOn') : t('gloria.walk.cardOff')} · {t('gloria.walk.cardCount', { i: curIdx + 1, n: spp.length, hits: popcount(hits[s.id]) })}
              </Text>
            </Pressable>
          </View>
          {arrow(1)}
        </View>
      </SwipeNavArea>
    );
  };


  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: isSquare ? t('gloria.walk.titleSquare', { code }) : t('gloria.walk.titleQuadrat', { code }),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              {!locked ? <HeaderIconButton icon="arrow-undo-outline" label={t('gloria.freq.undo')} onPress={doUndo} disabled={undoCount === 0} /> : null}
              {!locked ? <HeaderIconButton icon="arrow-redo-outline" label={t('gloria.freq.redo')} onPress={doRedo} disabled={redoCount === 0} /> : null}
              <HeaderIconButton icon="grid-outline" label={t('gloria.overview')} onPress={() => setPanel(true)} />
              <HeaderIconButton
                icon={locked ? 'lock-closed' : 'checkmark-done-outline'}
                label={locked ? t('gloria.freq.unlock') : t('gloria.freq.done')}
                onPress={() => void toggleLock()}
              />
            </View>
          ),
        }}
      />
      <ScrollView ref={scrollRef} className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" scrollEnabled={scrollOn}>
        {/* Title, progress and direction beside the walk sketch: compact, so the species card stays near the top. */}
        <View className="flex-row items-center gap-3">
          {isSquare && unit.walk_option != null && !done ? <WalkDiagram option={unit.walk_option} size={64} line={line} /> : null}
          <View className="flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-lg font-bold text-gray-900 dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
                {done ? t('gloria.walk.allDone', { total: size }) : isSquare ? t('gloria.walk.linePoint', { line, point }) : t('gloria.walk.point', { n: seq + 1 })}
              </Text>
              {isSquare && !done ? (
                <Text className="rounded-md bg-accent-50 px-1.5 py-0.5 text-[11px] font-semibold text-accent-700 dark:bg-accent-950/40 dark:text-accent-300">
                  {line % 2 === 1 ? t('gloria.walk.forward') : t('gloria.walk.back')}
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-gray-500" style={{ fontVariant: ['tabular-nums'] }}>{t('gloria.walk.progress', { done: visited, total: size })}</Text>
            <View className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
              <View className="h-full bg-accent-600" style={{ width: `${(visited / size) * 100}%` }} />
            </View>
          </View>
        </View>

        <View className="flex-row items-center">
          <Text className="flex-1 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.walk.species')}</Text>
          <Chip label={t('gloria.freq.newSpecies')} on={false} onPress={() => !refuseLocked() && setAdding(true)} />
        </View>
        {spCard()}
        {/* What this point holds so far; tap one to take it out. */}
        {picked.size ? (
          <View className="flex-row flex-wrap items-center">
            <Text className="mb-1.5 mr-1.5 text-xs text-gray-500 dark:text-gray-400">{t('gloria.walk.thisPoint')}</Text>
            {spp
              .filter((s) => picked.has(s.id))
              .map((s) => (
                <Chip key={s.id} label={`${displayName(s)}  ✕`} on onPress={() => toggle(s.id)} />
              ))}
          </View>
        ) : null}

        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.walk.surface')}</Text>
        {/* One row, swiped sideways: tapping a surface records the point. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 pr-2" keyboardShouldPersistTaps="handled">
          {SURFACE_CODES.map((c: SurfaceCode) => (
            <View key={c} style={{ minWidth: 88 }}>
              <Btn label={t(`gloria.surface.${c}`)} disabled={picked.size > 0 || done} onPress={() => commit([], c)} />
            </View>
          ))}
        </ScrollView>
        {/* The point map below the recording controls (no scrolling while
            recording), centred and large; pinch or ＋ to zoom, tap a point to go back to it. */}
        <View className="w-full max-w-[380px] self-center">
          <PointMap
            n={n}
            square={isSquare}
            surface={surface}
            current={done ? null : idx}
            onPoint={(i) => {
              // Back to the controls with the chosen point loaded.
              if (jumpTo(i)) scrollRef.current?.scrollTo({ y: 0, animated: true });
            }}
            onInteract={(on) => setScrollOn(!on)}
          />
        </View>
      </ScrollView>
      {adding ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View className="flex-row items-center border-t border-gray-200 bg-card px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
            <Text className="flex-1 text-xs text-gray-500 dark:text-gray-400">{t('gloria.walk.addingHint')}</Text>
            <Pressable onPress={() => setAdding(false)} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('common.cancel')}</Text>
            </Pressable>
          </View>
          <SearchBox
            scopeGroups={GLORIA_SEARCH_GROUPS}
            onSelect={async (r) => {
              if (!r.taxon_id) return;
              const label = await pickMorphoLabel(t, unit.survey_id, r.taxon_id, r.rank, r.cname || r.name);
              if (label === undefined) return;
              if (unit.point_surface == null) startPoints(unit.id, size);
              const usid = addUnitSpecies(unit.id, r.taxon_id, label);
              setAdding(false);
              setPicked(new Set([...picked, usid]));
              // Show the new species on the card (it lands where the unit's order puts it).
              pendingCard.current = usid;
              reload();
            }}
          />
        </KeyboardStickyView>
      ) : (
        <View className="gap-1.5 border-t border-gray-200 bg-card px-4 py-2.5 dark:border-gray-800 dark:bg-gray-900">
          {previousText() && !done ? (
            <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={2}>
              {t('gloria.walk.prevIs', { what: previousText() })}
            </Text>
          ) : null}
          <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn label={t('gloria.walk.same')} onPress={sameAsPrevious} disabled={seq === 0 || done} />
          </View>
          <View className="flex-[2]">
            <Btn primary label={t('gloria.walk.next')} disabled={picked.size === 0 || done} onPress={() => commit([...picked], SURFACE_VASCULAR)} />
          </View>
          </View>
        </View>
      )}
      {panel ? <OverviewPanel state={state} code={code} current={isSquare ? 'points' : 'pointframe'} onClose={() => setPanel(false)} /> : null}
    </SafeAreaView>
  );
}
