/**
 * One GLORIA unit: a 1×1 m quadrat (cover estimation, with entries to
 * frequency and point-framing), a summit area section (abundance), or a
 * 10×10 m square (entry to line-pointing, derived hits, additional species).
 *
 * The species list gets the room; plot environment (researchers, times,
 * aspect, slope, top cover) folds away. Species are added from the docked
 * search box.
 *
 * 完成 (header) stamps the end time and locks the form; pressing it again
 * reopens, and a later 完成 stamps a new time. Every edit is one undo step:
 * a snapshot of the unit row and its species rows taken before the edit.
 * The history is dropped whenever the screen regains focus — frequency,
 * point-framing and the species page write to the same rows, and restoring
 * an older snapshot would silently undo their work.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { SearchBox } from '~/components/SearchBox';
import { showActionSheet } from '~/components/ActionSheet';
import { BackHeaderLeft } from '~/lib/goBack';
import { isoStamp } from '~/lib/datetime';
import { useToast } from '~/stores/toast';
import {
  addUnitSpecies,
  markUnitStarted,
  removeUnitSpecies,
  restoreUnitSnapshot,
  snapshotUnit,
  updateUnit,
  updateUnitSpecies,
  type GloriaUnit,
  type UnitPatch,
  type UnitSnapshot,
} from '~/modules/gloria/db';
import { popcount, surfaceHits, visitedCount, SURFACE_CODES } from '~/modules/gloria/model/grid';
import { coverFromHits, WALK_OPTIONS, type WalkOption } from '~/modules/gloria/model/walk';
import { quadratsOf, unitTypeOf, type Direction } from '~/modules/gloria/model/units';
import { exactSum, speciesCoverSum, vascularCoverOk } from '~/modules/gloria/model/validate';
import { issueText } from '~/modules/gloria/issues';
import { displayName, GLORIA_SEARCH_GROUPS, toUnitSpecies, useSurvey, type SurveySpecies } from '~/modules/gloria/useSurvey';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { SubtypeFields, TopCoverFields, topSum } from '~/modules/gloria/components/CoverFields';
import { ResearcherRow, SurveyTimes, unitResearchers } from '~/modules/gloria/components/SurveyTimes';
import { Banner, BannerText, Btn, Card, FoldBanner, NumAccessory, NumField, PassBanner } from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';

const ABUNDANCE = ['r!', 'r', 's', 'c', 'd'] as const;
const CF_CYCLE: Array<'g' | 's' | 't' | null> = [null, 'g', 's', 't'];
const UNDO_LIMIT = 100;

export default function GloriaUnitScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; code: string }>();
  const id = Number(params.id);
  const code = String(params.code);
  const type = unitTypeOf(code);
  const { state, reload } = useSurvey(id);
  const [panel, setPanel] = useState(false);
  const [envOpen, setEnvOpen] = useState<boolean | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);

  const undo = useRef<UnitSnapshot[]>([]);
  const redo = useRef<UnitSnapshot[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const clearHistory = useCallback(() => {
    undo.current = [];
    redo.current = [];
    setUndoCount(0);
    setRedoCount(0);
  }, []);
  useFocusEffect(clearHistory);

  const unit = state?.unit(code);
  // Say so once on open when the unit is already done, before a tap does nothing.
  const lockedNow = unit ? unit.stop_ts != null : null;
  const lockToastShown = useRef(false);
  useEffect(() => {
    if (lockedNow == null || lockToastShown.current) return;
    lockToastShown.current = true;
    if (lockedNow) toast(t('gloria.unit.lockedToast'));
  }, [lockedNow, toast, t]);

  if (!state || !unit || !type) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: code, headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const active = state.survey.status === 'active';
  const spp = [...state.speciesOf(code)].sort((a, b) => a.serial - b.serial);
  const issues = state.issues.filter((i) => i.unit === code);
  const dir = code[0] as Direction;
  const locked = unit.stop_ts != null;

  /** Run one edit as one undo step; refused while the unit is done. */
  const track = (fn: () => void): boolean => {
    if (locked) {
      toast(t('gloria.unit.lockedToast'));
      return false;
    }
    const before = snapshotUnit(unit.id);
    fn();
    undo.current.push(before);
    if (undo.current.length > UNDO_LIMIT) undo.current.shift();
    redo.current = [];
    setUndoCount(undo.current.length);
    setRedoCount(0);
    reload();
    return true;
  };
  const step = (from: React.MutableRefObject<UnitSnapshot[]>, to: React.MutableRefObject<UnitSnapshot[]>) => {
    const snap = from.current.pop();
    if (!snap) return;
    to.current.push(snapshotUnit(unit.id));
    restoreUnitSnapshot(snap);
    setUndoCount(undo.current.length);
    setRedoCount(redo.current.length);
    reload();
  };

  const patch = (p: UnitPatch) =>
    track(() => {
      markUnitStarted(unit.id);
      updateUnit(unit.id, p);
    });
  const addTaxon = (taxonId: string, name?: string) => {
    const done = track(() => {
      markUnitStarted(unit.id);
      addUnitSpecies(unit.id, taxonId);
    });
    if (done && name) toast(t('gloria.unit.added', { name }));
  };
  const speciesMenu = async (s: SurveySpecies) => {
    const idx = await showActionSheet({
      title: displayName(s),
      options: [{ label: t('gloria.unit.openDetail') }, { label: t('gloria.unit.remove'), destructive: true }],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) router.push(`/gloria/${id}/${code}/species/${s.id}` as Href);
    if (idx === 1) track(() => removeUnitSpecies(s.id));
  };
  /** 完成 stamps the end time now and locks; pressing it again reopens. */
  const toggleDone = () => {
    updateUnit(unit.id, { stop_ts: locked ? null : Date.now() });
    clearHistory();
    reload();
    toast(t(locked ? 'gloria.unit.unlocked' : 'gloria.unit.lockedDone'));
  };
  const title = `${code} · ${type === 'quadrat' ? '1×1 m' : type === 'sas' ? 'SAS' : '10×10 m'}`;

  // ── species row (quadrat / SAS / square share the shell) ───────────────
  const speciesRow = (s: SurveySpecies, i: number, right: React.ReactNode) => (
    <View key={s.id} className={`flex-row items-center px-3 py-2 ${i ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
      <Pressable
        className="flex-1 pr-2"
        onPress={() => router.push(`/gloria/${id}/${code}/species/${s.id}` as Href)}
        onLongPress={() => void speciesMenu(s)}
        accessibilityHint={t('gloria.unit.rowHint')}
      >
        <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={1}>{displayName(s)}</Text>
        <Text className="text-xs italic text-gray-500 dark:text-gray-400" numberOfLines={1}>{s.simple_name}</Text>
      </Pressable>
      {right}
      <Ionicons name="chevron-forward" size={14} color="#9ca3af" />
    </View>
  );

  const cfButton = (s: SurveySpecies) => (
    <Pressable
      onPress={() => {
        const next = CF_CYCLE[(CF_CYCLE.indexOf(s.cf) + 1) % CF_CYCLE.length];
        track(() => updateUnitSpecies(s.id, { cf: next }));
      }}
      accessibilityLabel={t('gloria.unit.cf')}
      className={`ml-1.5 w-8 items-center rounded-md border py-1 ${s.cf ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-gray-300 dark:border-gray-700'}`}
    >
      <Text className={`text-[11px] ${s.cf ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-gray-400'}`}>{s.cf ?? 'cf'}</Text>
    </Pressable>
  );

  const envSummary = (u: GloriaUnit) => {
    const sum = topSum(u);
    return [
      unitResearchers(u, state.survey.recorded_by),
      u.aspect_deg != null ? t('gloria.unit.aspectShort', { v: u.aspect_deg }) : null,
      u.slope_deg != null ? t('gloria.unit.slopeShort', { v: u.slope_deg }) : null,
      type === 'square' ? null : sum != null ? t('gloria.unit.topSumShort', { sum }) : t('gloria.unit.topNotYet'),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // Open until there is something to summarise (a square has no top cover).
  const envIsOpen = envOpen ?? (type === 'square' ? unit.start_ts == null : topSum(unit) == null);

  /** 樣區環境: researchers, a times fold, then the unit type's own fields. */
  const envCard = (fields: React.ReactNode) => (
    <Card>
      <Pressable onPress={() => setEnvOpen(!envIsOpen)} className="flex-row items-center px-3 py-2.5">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.unit.env')}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">{envSummary(unit)}</Text>
        </View>
        <Ionicons name={envIsOpen ? 'chevron-down' : 'chevron-forward'} size={16} color="#9ca3af" />
      </Pressable>
      {envIsOpen ? (
        <View className="gap-2 px-3 pb-3">
          <ResearcherRow unit={unit} surveyBy={state.survey.recorded_by} reload={reload} />
          {/* Survey times fold on their own: set once, rarely looked at again. */}
          <Pressable onPress={() => setTimesOpen(!timesOpen)} className="flex-row items-center">
            <Ionicons name={timesOpen ? 'chevron-down' : 'chevron-forward'} size={14} color="#9ca3af" />
            <Text className="ml-1 flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('gloria.times.titleOnly')}</Text>
            {!timesOpen ? (
              <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
                {unit.start_ts != null ? isoStamp(unit.start_ts).slice(0, 16) : t('gloria.times.notYet')}
              </Text>
            ) : null}
          </Pressable>
          {timesOpen ? <SurveyTimes unit={unit} surveyBy={state.survey.recorded_by} reload={reload} embedded /> : null}
          {fields}
        </View>
      ) : null}
    </Card>
  );

  // ── quadrat ────────────────────────────────────────────────────────────
  const quadratBody = () => {
    const us = spp.map(toUnitSpecies);
    const vOk = vascularCoverOk(
      { vascular: unit.cov_vascular, solidRock: null, scree: null, lichens: null, bryophytes: null, bareGround: null, litter: null },
      us,
    );
    const sum = exactSum(speciesCoverSum(us));
    const freqN = spp.filter((s) => s.freq_cells != null || s.freq_count != null).length;
    const freqKey = unit.freq_mode === 'count' ? 'gloria.step.freqCounted' : 'gloria.step.freqDone';
    const cross = issues.filter((i) => i.kind === 'cover-no-freq' || i.kind === 'freq-no-cover');
    return (
      <>
        {envCard(
          <>
            <View className="flex-row gap-4">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-gray-700 dark:text-gray-300">{t('gloria.unit.aspect')}</Text>
                <NumField value={unit.aspect_deg} onCommit={(v) => patch({ aspect_deg: v })} range={RANGES.aspect} accessibilityLabel={t('gloria.unit.aspect')} width={56} editable={!locked} />
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-gray-700 dark:text-gray-300">{t('gloria.unit.slope')}</Text>
                <NumField value={unit.slope_deg} onCommit={(v) => patch({ slope_deg: v })} range={RANGES.slope} accessibilityLabel={t('gloria.unit.slope')} width={56} editable={!locked} />
              </View>
            </View>
            <TopCoverFields unit={unit} onCommit={patch} editable={!locked} />
            <Pressable onPress={() => setSubOpen(!subOpen)} className="flex-row items-center">
              <Ionicons name={subOpen ? 'chevron-down' : 'chevron-forward'} size={14} color="#9ca3af" />
              <Text className="ml-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{t('gloria.unit.subtypes')}</Text>
            </Pressable>
            {subOpen ? <SubtypeFields unit={unit} onCommit={patch} editable={!locked} /> : null}
          </>,
        )}

        {vOk === false ? (
          <FoldBanner tone="error" title={t('gloria.issue.vascularExceeds', { vascular: unit.cov_vascular, sum })}>
            <BannerText tone="error">{t('gloria.unit.vascularHint')}</BannerText>
          </FoldBanner>
        ) : vOk === true ? (
          <PassBanner text={t('gloria.unit.vascularOk', { vascular: unit.cov_vascular, sum })} />
        ) : null}
        {cross.length ? (
          <FoldBanner tone="error" title={t('gloria.unit.crossTitle')} count={cross.length}>
            {cross.map((i, k) => (
              <BannerText key={k} tone="error">{issueText(t, i)}</BannerText>
            ))}
          </FoldBanner>
        ) : null}

        <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn label={`${t('gloria.step.frequency')} · ${unit.freq_locked ? `${t('gloria.freq.doneShort')} · ` : ''}${freqN ? t(freqKey, { count: freqN }) : t('gloria.step.notStarted')}`} onPress={() => router.push(`/gloria/${id}/${code}/frequency` as Href)} />
          </View>
          <View className="flex-1">
            <Btn label={`${t('gloria.step.pointframe')} · ${unit.pf_locked ? `${t('gloria.freq.doneShort')} · ` : ''}${unit.point_surface ? `${visitedCount(unit.point_surface)}/100` : t('gloria.step.notStarted')}`} onPress={() => router.push(`/gloria/${id}/${code}/points` as Href)} />
          </View>
        </View>

        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">
          {t('gloria.unit.speciesHeader', { count: spp.length, sum })}
        </Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.unit.noSpecies')}</Text>
          ) : (
            spp.map((s, i) =>
              speciesRow(
                s,
                i,
                <>
                  <NumField
                    value={s.cover_pct}
                    onCommit={(v) => track(() => updateUnitSpecies(s.id, { cover_pct: v }))}
                    range={RANGES.percent}
                    width={76}
                    editable={!locked}
                    accessibilityLabel={t('gloria.unit.coverOf', { name: displayName(s) })}
                  />
                  {cfButton(s)}
                </>,
              ),
            )
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.coverRule')}</Text>
      </>
    );
  };

  // ── summit area section ────────────────────────────────────────────────
  const sasBody = () => {
    const missing = issues.find((i) => i.kind === 'sas-missing');
    const missingTaxa = () => {
      const inSas = new Set(spp.map((s) => s.taxon_id));
      const out = new Map<string, string>();
      for (const q of quadratsOf(dir)) for (const s of state.speciesOf(q)) if (!inSas.has(s.taxon_id)) out.set(s.taxon_id, displayName(s));
      return out;
    };
    return (
      <>
        {missing ? (
          <FoldBanner tone="warn" title={t('gloria.unit.sasMissingTitle', { direction: dir })}>
            <BannerText tone="warn">{issueText(t, missing)}</BannerText>
            <View className="mt-1.5 flex-row">
              <Btn
                small
                label={t('gloria.unit.addAll')}
                onPress={() =>
                  track(() => {
                    for (const tid of missingTaxa().keys()) addUnitSpecies(unit.id, tid);
                    markUnitStarted(unit.id);
                  })
                }
              />
            </View>
          </FoldBanner>
        ) : null}
        {envCard(<TopCoverFields unit={unit} onCommit={patch} editable={!locked} />)}
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.unit.sasHeader', { count: spp.length })}</Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.unit.noSpecies')}</Text>
          ) : (
            spp.map((s, i) =>
              speciesRow(
                s,
                i,
                <View className="flex-row">
                  {ABUNDANCE.map((a) => (
                    <Pressable
                      key={a}
                      onPress={() => track(() => updateUnitSpecies(s.id, { abundance: s.abundance === a ? null : a }))}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: s.abundance === a }}
                      className={`ml-1 w-7 items-center rounded-md border py-1 ${s.abundance === a ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
                    >
                      <Text className={`text-[11px] ${s.abundance === a ? 'font-bold text-white' : 'text-gray-600 dark:text-gray-300'}`}>{a}</Text>
                    </Pressable>
                  ))}
                </View>,
              ),
            )
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.abundanceLegend')}</Text>
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.unit.grazing')}</Text>
        <TextInput
          defaultValue={unit.grazing_note ?? ''}
          editable={!locked}
          onEndEditing={(e) => patch({ grazing_note: e.nativeEvent.text.trim() || null })}
          placeholder={t('gloria.unit.grazingPlaceholder')}
          multiline
          className="min-h-[64px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          placeholderTextColor="#9ca3af"
        />
      </>
    );
  };

  // ── 10×10 m square ─────────────────────────────────────────────────────
  const squareBody = () => {
    const visited = visitedCount(unit.point_surface);
    const hits = surfaceHits(unit.point_surface);
    const withHits = spp.map((s) => ({ s, n: s.point_hits != null ? popcount(s.point_hits) : (s.legacy_hits ?? 0) }));
    const hit = withHits.filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const extra = withHits.filter((x) => x.n === 0);
    const fromQuadrats = () => {
      const have = new Set(spp.map((s) => s.taxon_id));
      let n = 0;
      const done = track(() => {
        for (const q of quadratsOf(dir)) {
          for (const s of state.speciesOf(q)) {
            if (have.has(s.taxon_id)) continue;
            have.add(s.taxon_id);
            addUnitSpecies(unit.id, s.taxon_id);
            n++;
          }
        }
        markUnitStarted(unit.id);
      });
      if (done) toast(t('gloria.unit.fromQuadratsDone', { count: n }));
    };
    return (
      <>
        {envCard(null)}
        <Card className="gap-2 p-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.walk')}</Text>
          <View className="flex-row flex-wrap">
            {WALK_OPTIONS.map((o) => (
              <Pressable
                key={o}
                onPress={() => patch({ walk_option: o as WalkOption })}
                className={`mb-1.5 mr-1.5 rounded-lg border px-2.5 py-1.5 ${unit.walk_option === o ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
              >
                <Text className={`text-xs ${unit.walk_option === o ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                  {t(`gloria.square.option${o}`)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Btn
            primary
            label={t('gloria.square.start', { done: visited })}
            disabled={unit.walk_option == null}
            onPress={() => router.push(`/gloria/${id}/${code}/points` as Href)}
          />
          {unit.walk_option == null ? <Text className="text-xs text-gray-400">{t('gloria.square.pickWalk')}</Text> : null}
        </Card>
        {visited > 0 ? (
          <Card className="p-3">
            <Text className="mb-1 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.hitsTitle', { done: visited })}</Text>
            {hit.map(({ s, n }) => (
              <View key={s.id} className="flex-row py-0.5">
                <Text className="flex-1 text-xs text-gray-900 dark:text-gray-100">{displayName(s)}</Text>
                <Text className="w-14 text-right text-xs text-gray-700 dark:text-gray-300" style={{ fontVariant: ['tabular-nums'] }}>{n}</Text>
                <Text className="w-16 text-right text-xs text-gray-500" style={{ fontVariant: ['tabular-nums'] }}>{coverFromHits(n, 400).toFixed(2)}%</Text>
              </View>
            ))}
            <Text className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {SURFACE_CODES.map((c) => `${t(`gloria.surface.${c}`)} ${hits[c]}`).join(' · ')}
            </Text>
          </Card>
        ) : null}
        <View className="flex-row items-center">
          <Text className="flex-1 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.square.extra', { count: extra.length })}</Text>
          <Btn small label={t('gloria.square.fromQuadrats')} onPress={fromQuadrats} />
        </View>
        <Card>
          {extra.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">{t('gloria.square.extraEmpty')}</Text>
          ) : (
            extra.map(({ s }, i) => speciesRow(s, i, null))
          )}
        </Card>
      </>
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title,
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              {!locked ? (
                <HeaderIconButton icon="arrow-undo-outline" label={t('gloria.freq.undo')} disabled={undoCount === 0} onPress={() => step(undo, redo)} />
              ) : null}
              {!locked ? (
                <HeaderIconButton icon="arrow-redo-outline" label={t('gloria.freq.redo')} disabled={redoCount === 0} onPress={() => step(redo, undo)} />
              ) : null}
              <HeaderIconButton icon="grid-outline" label={t('gloria.overview')} onPress={() => setPanel(true)} />
              <HeaderIconButton
                icon={locked ? 'lock-closed' : 'checkmark-done-outline'}
                label={locked ? t('gloria.unit.markUndone') : t('gloria.unit.markDone')}
                onPress={toggleDone}
              />
            </View>
          ),
        }}
      />
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {type === 'quadrat' ? quadratBody() : type === 'sas' ? sasBody() : squareBody()}
      </ScrollView>
      {active && !locked ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox scopeGroups={GLORIA_SEARCH_GROUPS} onSelect={(r) => r.taxon_id && addTaxon(r.taxon_id, r.cname || r.name)} />
        </KeyboardStickyView>
      ) : null}
      <NumAccessory />
      {panel ? (
        <OverviewPanel state={state} code={code} current={type === 'square' ? 'cover' : type === 'sas' ? 'sas' : 'cover'} onClose={() => setPanel(false)} />
      ) : null}
    </SafeAreaView>
  );
}
