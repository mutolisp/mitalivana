/**
 * Point-intercept recording, point by point.
 *   - 1×1 m quadrat: point-framing at 100 crosshairs (manual p.41, Work Step J)
 *   - 10×10 m square: 20 lines × 20 points (manual §5.3.1)
 *
 * At each point: every vascular species the pin touches, or — only when no
 * vascular plant is hit — one surface type. Each commit is one transaction
 * (db.commitPoint); storage is canonical, the walk only orders the visits
 * (model/walk.ts).
 */
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { addUnitSpecies, commitPoint, startPoints } from '~/modules/gloria/db';
import { QUADRAT_N, SQUARE_N, SURFACE_CODES, SURFACE_UNVISITED, SURFACE_VASCULAR, emptyMask, emptySurface, getBit, popcount, setBits, type SurfaceCode } from '~/modules/gloria/model/grid';
import { linePoint, walkOrder } from '~/modules/gloria/model/walk';
import { unitTypeOf } from '~/modules/gloria/model/units';
import { displayName, useSurvey } from '~/modules/gloria/useSurvey';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { Btn, Chip } from '~/modules/gloria/components/ui';

type UndoStep = { seq: number; surface: string; hits: Record<number, boolean> };

export default function PointsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
  const code = String(params.code);
  const isSquare = unitTypeOf(code) === 'square';
  const n = isSquare ? SQUARE_N : QUADRAT_N;
  const size = n * n;
  const { state, reload } = useSurvey(id);
  const unit = state?.unit(code);
  const spp = useMemo(() => (state ? [...state.speciesOf(code)].sort((a, b) => a.serial - b.serial) : []), [state, code]);
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
  const [recent, setRecent] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState(false);
  const undo = useRef<UndoStep[]>([]);

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

  const commit = (species: number[], surfaceChar: string) => {
    if (seq >= size) return;
    if (unit.point_surface == null) startPoints(unit.id, size);
    const prevHits: Record<number, boolean> = {};
    for (const s of spp) prevHits[s.id] = getBit(hits[s.id] ?? emptyMask(size), idx);
    undo.current.push({ seq, surface: surface[idx], hits: prevHits });
    const on = new Set(species);
    commitPoint(unit.id, size, idx, spp.map((s) => ({ unitSpeciesId: s.id, on: on.has(s.id) })), surfaceChar);
    const nextHits = { ...hits };
    for (const s of spp) nextHits[s.id] = setBits(nextHits[s.id] ?? emptyMask(size), [idx], on.has(s.id));
    setHits(nextHits);
    setSurface(surface.slice(0, idx) + surfaceChar + surface.slice(idx + 1));
    if (species.length) setRecent((r) => [...species, ...r.filter((x) => !on.has(x))].slice(0, 12));
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

  const sameAsPrevious = () => {
    if (seq === 0) return;
    const prevIdx = order[seq - 1];
    const ch = surface[prevIdx];
    if (ch === SURFACE_UNVISITED) return;
    const sp = spp.filter((s) => getBit(hits[s.id] ?? '', prevIdx)).map((s) => s.id);
    commit(sp, ch);
  };

  const doUndo = () => {
    const u = undo.current.pop();
    if (!u) return;
    const i = order[u.seq];
    commitPoint(unit.id, size, i, spp.map((s) => ({ unitSpeciesId: s.id, on: !!u.hits[s.id] })), u.surface);
    const nextHits = { ...hits };
    for (const s of spp) nextHits[s.id] = setBits(nextHits[s.id] ?? emptyMask(size), [i], !!u.hits[s.id]);
    setHits(nextHits);
    setSurface(surface.slice(0, i) + u.surface + surface.slice(i + 1));
    setSeq(u.seq);
    setPicked(new Set());
  };

  const jumpTo = (canonical: number) => {
    const k = order.indexOf(canonical);
    if (k < 0 || (surface[canonical] === SURFACE_UNVISITED && k > firstOpenLive())) return;
    setSeq(k);
    setPicked(new Set(spp.filter((s) => getBit(hits[s.id] ?? '', canonical)).map((s) => s.id)));
  };
  const firstOpenLive = () => {
    const k = order.findIndex((i) => surface[i] === SURFACE_UNVISITED);
    return k < 0 ? size : k;
  };

  const chipOrder = [...recent.map((r) => spp.find((s) => s.id === r)).filter(Boolean), ...spp.filter((s) => !recent.includes(s.id))] as typeof spp;
  // Mini map: a square is drawn as the diamond it is on the slope (rotated 45°);
  // display row r, column c ↔ canonical a = c, b = n-1-r (model/walk.ts).
  const miniIdx = (r: number, c: number) => (isSquare ? c * n + (n - 1 - r) : r * n + c);
  const cellPx = isSquare ? 6 : 12;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: isSquare ? t('gloria.walk.titleSquare', { code }) : t('gloria.walk.titleQuadrat', { code }),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <HeaderIconButton icon="arrow-undo-outline" label={t('gloria.freq.undo')} onPress={doUndo} disabled={undo.current.length === 0} />
              <HeaderIconButton icon="grid-outline" label={t('gloria.overview')} onPress={() => setPanel(true)} />
            </View>
          ),
        }}
      />
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
        <View className="flex-row items-start gap-3">
          <View className="flex-1 gap-1">
            <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
              {done ? t('gloria.walk.allDone', { total: size }) : isSquare ? t('gloria.walk.linePoint', { line, point }) : t('gloria.walk.point', { n: seq + 1 })}
            </Text>
            <Text className="text-xs text-gray-500" style={{ fontVariant: ['tabular-nums'] }}>{t('gloria.walk.progress', { done: visited, total: size })}</Text>
            <View className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
              <View className="h-full bg-[#00A2A5]" style={{ width: `${(visited / size) * 100}%` }} />
            </View>
            {isSquare && !done ? (
              <Text className="self-start rounded-md bg-cyan-50 px-2 py-1 text-xs font-semibold text-[#00797b] dark:bg-cyan-950/40 dark:text-cyan-300">
                {line % 2 === 1 ? t('gloria.walk.forward') : t('gloria.walk.back')}
              </Text>
            ) : null}
          </View>
          <View style={{ width: n * cellPx + 8, height: n * cellPx + 8, transform: isSquare ? [{ rotate: '45deg' }, { scale: 0.72 }] : undefined }} className="p-1">
            {Array.from({ length: n }, (_, r) => (
              <View key={r} className="flex-row">
                {Array.from({ length: n }, (_, c) => {
                  const ci = miniIdx(r, c);
                  const ch = surface[ci];
                  const isCur = ci === idx && !done;
                  const bg = isCur ? '#d97706' : ch === SURFACE_VASCULAR ? '#059669' : ch && ch !== SURFACE_UNVISITED ? '#9ca3af' : undefined;
                  return (
                    <Pressable key={c} onPress={() => jumpTo(ci)} hitSlop={2}>
                      <View style={{ width: cellPx - 1, height: cellPx - 1, margin: 0.5, backgroundColor: bg }} className={bg ? '' : 'bg-gray-200 dark:bg-gray-800'} />
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </View>

        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.walk.species')}</Text>
        <View className="flex-row flex-wrap">
          {chipOrder.map((s) => (
            <Chip
              key={s.id}
              label={displayName(s)}
              badge={String(popcount(hits[s.id]))}
              on={picked.has(s.id)}
              onPress={() => {
                const p = new Set(picked);
                if (p.has(s.id)) p.delete(s.id);
                else p.add(s.id);
                setPicked(p);
              }}
            />
          ))}
          <Chip label={t('gloria.freq.newSpecies')} on={false} onPress={() => setAdding(true)} />
        </View>

        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.walk.surface')}</Text>
        <View className="flex-row flex-wrap">
          {SURFACE_CODES.map((c: SurfaceCode) => (
            <View key={c} className="w-1/3 p-1">
              <Btn label={t(`gloria.surface.${c}`)} disabled={picked.size > 0 || done} onPress={() => commit([], c)} />
            </View>
          ))}
        </View>
      </ScrollView>
      {adding ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox
            onSelect={(r) => {
              if (!r.taxon_id) return;
              if (unit.point_surface == null) startPoints(unit.id, size);
              const usid = addUnitSpecies(unit.id, r.taxon_id);
              setAdding(false);
              setPicked(new Set([...picked, usid]));
              reload();
            }}
          />
        </KeyboardStickyView>
      ) : (
        <View className="flex-row gap-2 border-t border-gray-200 bg-white px-4 py-2.5 dark:border-gray-800 dark:bg-gray-900">
          <View className="flex-1">
            <Btn label={t('gloria.walk.same')} onPress={sameAsPrevious} disabled={seq === 0 || done} />
          </View>
          <View className="flex-[2]">
            <Btn primary label={t('gloria.walk.next')} disabled={picked.size === 0 || done} onPress={() => commit([...picked], SURFACE_VASCULAR)} />
          </View>
        </View>
      )}
      {panel ? <OverviewPanel state={state} code={code} current={isSquare ? 'points' : 'pointframe'} onClose={() => setPanel(false)} /> : null}
    </SafeAreaView>
  );
}
