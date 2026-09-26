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
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  NestableDraggableFlatList,
  NestableScrollContainer,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import { useKeyboardState } from 'react-native-keyboard-controller';
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
  replaceUnitSpeciesTaxon,
  restoreUnitSnapshot,
  setUnitDone,
  takeSpeciesReplace,
  setUnitSpeciesOrder,
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
import { bySpeciesOrder } from '~/modules/gloria/model/speciesOrder';
import { followCoverTimes } from '~/modules/gloria/model/quadratTimes';
import {
  displayName,
  GLORIA_SEARCH_GROUPS,
  toUnitSpecies,
  useSurvey,
  type SurveySpecies,
} from '~/modules/gloria/useSurvey';
import { OverviewPanel } from '~/modules/gloria/components/OverviewPanel';
import { SubtypeFields, TopCoverFields, topSum } from '~/modules/gloria/components/CoverFields';
import {
  ResearcherRow,
  SurveyTimes,
  unitResearchers,
} from '~/modules/gloria/components/SurveyTimes';
import {
  Banner,
  BannerText,
  Btn,
  Card,
  FoldBanner,
  NumAccessory,
  NumField,
  PassBanner,
} from '~/modules/gloria/components/ui';
import { RANGES } from '~/modules/gloria/model/ranges';
import { chooseEndTime } from '~/lib/endTimeChoice';

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
  // Open on arrival when there is nothing to summarise yet, decided once:
  // deriving it on every render folded the card away as soon as the first
  // top-cover value was typed, in the middle of filling in the rest.
  const [envOpen, setEnvOpen] = useState<boolean>(() => {
    const u = state?.unit(code);
    if (!u) return true;
    return unitTypeOf(code) === 'square' ? u.start_ts == null : topSum(u) == null;
  });
  const [subOpen, setSubOpen] = useState(false);
  // Searching to add a species on a 1×1 m quadrat: fold the plot environment
  // away and bring the species list up under the navigation bar, so what is
  // being added to stays in view. `speciesY` is the list header's position in
  // the scroll content; `pinSpecies` waits for the fold to re-layout.
  const scrollRef = useRef<React.ElementRef<typeof NestableScrollContainer>>(null);
  const speciesY = useRef(0);
  const [pinSpecies, setPinSpecies] = useState(false);
  // After adding a species, keep the end of the list against the top of the
  // search dock while the keyboard is up — through the dock shrinking as the
  // suggestions close — until the user scrolls or the keyboard goes.
  const followEnd = useRef(false);
  // Window y of this screen's content (under the header), so the docked
  // suggestions stop there even with the active-record bar above the header.
  const rootRef = useRef<View>(null);
  const [rootTop, setRootTop] = useState<number | undefined>(undefined);
  const scrollToSpecies = () =>
    // After the keyboard has come up: its inset is what makes room to scroll that far.
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, speciesY.current - 8), animated: true }), 300);
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
  // Non-null = the docked search re-identifies that species row instead of
  // adding one (from the row's long-press menu, or its species page).
  const [replaceId, setReplaceId] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      const r = takeSpeciesReplace();
      if (r != null) setReplaceId(r);
    }, []),
  );

  // The docked search (group filter + box) rides up with the keyboard and
  // covers the end of the list unless the list is padded by its height.
  const keyboardUp = useKeyboardState((k) => k.isVisible);
  useEffect(() => {
    if (!keyboardUp) followEnd.current = false;
  }, [keyboardUp]);
  const [dockHeight, setDockHeight] = useState(0);
  // 1×1 m: a species just picked from the search gets its cover field focused
  // (numeric pad up), so the next thing typed is its cover. Consumed once the
  // row exists after the reload.
  const coverRefs = useRef(new Map<number, TextInput>());
  const focusCover = useRef<number | null>(null);
  useEffect(() => {
    const usid = focusCover.current;
    if (usid == null) return;
    const field = coverRefs.current.get(usid);
    if (!field) return;
    focusCover.current = null;
    field.focus();
  });

  const unit = state?.unit(code);
  // Say so once on open when the unit is already done, before a tap does nothing.
  const lockedNow = unit ? unit.done_locked === 1 : null;
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
  const spp = [...state.speciesOf(code)].sort(bySpeciesOrder);
  // Each species' number in this unit — its row number on the field sheet
  // and the export's sp-N; follows the dragged order.
  const numberOf = new Map(spp.map((s, k) => [s.id, k + 1]));
  const issues = state.issues.filter((i) => i.unit === code);
  const dir = code[0] as Direction;
  const locked = unit.done_locked === 1;

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
  const step = (
    from: React.MutableRefObject<UnitSnapshot[]>,
    to: React.MutableRefObject<UnitSnapshot[]>,
  ) => {
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
  /** The docked search picked a taxon while re-identifying `replaceId`. */
  const replaceTaxon = (usid: number, taxonId: string, name: string) => {
    const current = spp.find((x) => x.id === usid);
    if (current?.taxon_id === taxonId) {
      setReplaceId(null);
      return;
    }
    // Checked here too, so a refused pick leaves no empty undo step.
    if (spp.some((x) => x.id !== usid && x.taxon_id === taxonId)) {
      toast(t('gloria.unit.replaceExists', { name }));
      return; // still replacing: they picked a species already on the list
    }
    if (!track(() => replaceUnitSpeciesTaxon(usid, taxonId))) return;
    setReplaceId(null);
    toast(t('gloria.unit.replaced', { name }));
  };
  const addTaxon = (taxonId: string, name?: string) => {
    let usid: number | null = null;
    const done = track(() => {
      markUnitStarted(unit.id);
      usid = addUnitSpecies(unit.id, taxonId);
    });
    if (done) followEnd.current = true;
    if (done && type === 'quadrat') focusCover.current = usid;
    if (done && name) toast(t('gloria.unit.added', { name }));
  };
  const speciesMenu = async (s: SurveySpecies) => {
    const idx = await showActionSheet({
      title: displayName(s),
      options: [
        { label: t('gloria.unit.openDetail') },
        { label: t('gloria.unit.replace') },
        { label: t('gloria.unit.remove'), destructive: true },
      ],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) router.push(`/gloria/${id}/${code}/species/${s.id}` as Href);
    if (idx === 1) {
      if (locked) toast(t('gloria.unit.lockedToast'));
      else setReplaceId(s.id);
    }
    if (idx === 2) track(() => removeUnitSpecies(s.id));
  };
  /** 完成 locks with the end time the user picks (now / keep / blank);
   *  pressing it again reopens and leaves the time as it is. */
  const toggleDone = async () => {
    if (locked) setUnitDone(unit.id, false);
    else {
      const chosen = await chooseEndTime(unit.stop_ts);
      if (chosen === undefined) return;
      setUnitDone(unit.id, true, chosen);
      // A quadrat's frequency starts the minute after the cover estimate ends.
      if (type === 'quadrat' && unit.freq_skipped !== 1) {
        const follow = followCoverTimes(unit, 'stop_ts', chosen);
        if (Object.keys(follow).length) updateUnit(unit.id, follow);
      }
    }
    clearHistory();
    reload();
    toast(t(locked ? 'gloria.unit.unlocked' : 'gloria.unit.lockedDone'));
  };
  const title = `${code} · ${type === 'quadrat' ? '1×1 m' : type === 'sas' ? 'SAS' : '10×10 m'}`;

  // ── species row (quadrat / SAS / square share the shell) ───────────────
  /** `drag`: the row can be long-pressed on its handle and moved (1×1 m list). */
  const speciesRow = (s: SurveySpecies, i: number, right: React.ReactNode, drag?: () => void) => (
    <View
      key={s.id}
      className={`flex-row items-center bg-white px-3 py-2 dark:bg-gray-900 ${i ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
    >
      {drag && !locked ? (
        <Pressable
          onLongPress={drag}
          delayLongPress={120}
          hitSlop={8}
          accessibilityLabel={t('gloria.unit.reorder')}
          className="-ml-1 mr-1.5 py-1"
        >
          <Ionicons name="reorder-three" size={22} color="#9ca3af" />
        </Pressable>
      ) : null}
      <Text
        className="mr-2 w-6 text-right text-sm font-semibold text-gray-500 dark:text-gray-400"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {numberOf.get(s.id)}
      </Text>
      <Pressable
        className="flex-1 pr-2"
        onPress={() => router.push(`/gloria/${id}/${code}/species/${s.id}` as Href)}
        onLongPress={() => void speciesMenu(s)}
        accessibilityHint={t('gloria.unit.rowHint')}
      >
        <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={1}>
          {displayName(s)}
        </Text>
        <Text className="text-xs italic text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {s.simple_name}
        </Text>
      </Pressable>
      {right}
      <Ionicons name="chevron-forward" size={14} color="#9ca3af" />
    </View>
  );

  /**
   * A species list the user can put in the field sheet's order by dragging a
   * row's handle. `items` may be part of the unit's list (a 10×10 m square's
   * species without hits): the dragged rows take the slots they held in the
   * whole list, so the others keep their place. Saved per unit; the export's
   * sp-N numbering follows it (model/speciesOrder.ts).
   */
  const dragList = (items: SurveySpecies[], right: (s: SurveySpecies) => React.ReactNode) => (
    <NestableDraggableFlatList
      data={items}
      keyExtractor={(s) => String(s.id)}
      onDragEnd={({ data }) => {
        if (!data.some((s, k) => s.id !== items[k].id)) return;
        const moved = new Set(items.map((s) => s.id));
        let k = 0;
        const full = spp.map((s) => (moved.has(s.id) ? data[k++] : s));
        track(() => setUnitSpeciesOrder(full.map((s) => s.id)));
      }}
      renderItem={({ item, getIndex, drag }) => (
        <ScaleDecorator>{speciesRow(item, getIndex() ?? 0, right(item), drag)}</ScaleDecorator>
      )}
    />
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
      <Text
        className={`text-[11px] ${s.cf ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-gray-400'}`}
      >
        {s.cf ?? 'cf'}
      </Text>
    </Pressable>
  );

  const envSummary = (u: GloriaUnit) => {
    const sum = topSum(u);
    return [
      unitResearchers(u, state.survey.recorded_by),
      u.aspect_deg != null ? t('gloria.unit.aspectShort', { v: u.aspect_deg }) : null,
      u.slope_deg != null ? t('gloria.unit.slopeShort', { v: u.slope_deg }) : null,
      type === 'square'
        ? null
        : sum != null
          ? t('gloria.unit.topSumShort', { sum })
          : t('gloria.unit.topNotYet'),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // Open until there is something to summarise (a square has no top cover).
  const envIsOpen = envOpen;

  /** 樣區環境: researchers, a times fold, then the unit type's own fields. */
  const envCard = (fields: React.ReactNode) => (
    <Card>
      <Pressable
        onPress={() => setEnvOpen(!envIsOpen)}
        className="flex-row items-center px-3 py-2.5"
      >
        <View className="flex-1">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('gloria.unit.env')}
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">{envSummary(unit)}</Text>
        </View>
        <Ionicons name={envIsOpen ? 'chevron-down' : 'chevron-forward'} size={16} color="#9ca3af" />
      </Pressable>
      {envIsOpen ? (
        <View className="gap-2 px-3 pb-3">
          <ResearcherRow unit={unit} surveyBy={state.survey.recorded_by} reload={reload} />
          {/* Survey times fold on their own: set once, rarely looked at again. */}
          <Pressable onPress={() => setTimesOpen(!timesOpen)} className="flex-row items-center">
            <Ionicons
              name={timesOpen ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color="#9ca3af"
            />
            <Text className="ml-1 flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
              {t('gloria.times.titleOnly')}
            </Text>
            {!timesOpen ? (
              <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
                {unit.start_ts != null
                  ? isoStamp(unit.start_ts).slice(0, 16)
                  : t('gloria.times.notYet')}
              </Text>
            ) : null}
          </Pressable>
          {timesOpen ? (
            <SurveyTimes unit={unit} surveyBy={state.survey.recorded_by} reload={reload} embedded />
          ) : null}
          {fields}
        </View>
      ) : null}
    </Card>
  );

  /** Free-text remarks of the unit (`comments`; sheet 11_ / 21_ / 31_ `comments`). */
  const commentsField = (
    <>
      <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.unit.comments')}</Text>
      <TextInput
        // Keyed by the stored value so an undo shows the restored text.
        key={unit.comments ?? ''}
        defaultValue={unit.comments ?? ''}
        editable={!locked}
        onEndEditing={(e) => {
          const v = e.nativeEvent.text.trim() || null;
          if (v !== unit.comments) patch({ comments: v });
        }}
        placeholder={t('gloria.unit.commentsPlaceholder')}
        multiline
        className="min-h-[64px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        placeholderTextColor="#9ca3af"
      />
    </>
  );

  // ── quadrat ────────────────────────────────────────────────────────────
  const quadratBody = () => {
    const us = spp.map(toUnitSpecies);
    const vOk = vascularCoverOk(
      {
        vascular: unit.cov_vascular,
        solidRock: null,
        scree: null,
        lichens: null,
        bryophytes: null,
        bareGround: null,
        litter: null,
      },
      us,
    );
    const sum = exactSum(speciesCoverSum(us));
    const freqN = spp.filter((s) => s.freq_cells != null || s.freq_count != null).length;
    const freqKey = unit.freq_mode === 'count' ? 'gloria.step.freqCounted' : 'gloria.step.freqDone';
    const cross = issues.filter((i) => i.kind === 'cover-no-freq' || i.kind === 'freq-no-cover');
    const skipped = unit.freq_skipped === 1;
    return (
      <>
        {envCard(
          <>
            <View className="flex-row gap-4">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-gray-700 dark:text-gray-300">
                  {t('gloria.unit.aspect')}
                </Text>
                <NumField
                  value={unit.aspect_deg}
                  onCommit={(v) => patch({ aspect_deg: v })}
                  range={RANGES.aspect}
                  accessibilityLabel={t('gloria.unit.aspect')}
                  width={56}
                  editable={!locked}
                />
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-gray-700 dark:text-gray-300">
                  {t('gloria.unit.slope')}
                </Text>
                <NumField
                  value={unit.slope_deg}
                  onCommit={(v) => patch({ slope_deg: v })}
                  range={RANGES.slope}
                  accessibilityLabel={t('gloria.unit.slope')}
                  width={56}
                  editable={!locked}
                />
              </View>
            </View>
            <TopCoverFields unit={unit} onCommit={patch} editable={!locked} />
            <Pressable onPress={() => setSubOpen(!subOpen)} className="flex-row items-center">
              <Ionicons
                name={subOpen ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color="#9ca3af"
              />
              <Text className="ml-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
                {t('gloria.unit.subtypes')}
              </Text>
            </Pressable>
            {subOpen ? <SubtypeFields unit={unit} onCommit={patch} editable={!locked} /> : null}
          </>,
        )}

        {vOk === false ? (
          <FoldBanner
            tone="error"
            title={t('gloria.issue.vascularExceeds', { vascular: unit.cov_vascular, sum })}
          >
            <BannerText tone="error">{t('gloria.unit.vascularHint')}</BannerText>
          </FoldBanner>
        ) : vOk === true ? (
          <PassBanner text={t('gloria.unit.vascularOk', { vascular: unit.cov_vascular, sum })} />
        ) : null}
        {cross.length ? (
          <FoldBanner tone="error" title={t('gloria.unit.crossTitle')} count={cross.length}>
            {cross.map((i, k) => (
              <BannerText key={k} tone="error">
                {issueText(t, i)}
              </BannerText>
            ))}
          </FoldBanner>
        ) : null}

        {/* Manual §5.1.2 p.51: no frequency where the grid frame cannot be
            mounted (shrubs, small trees, tall vegetation). Point-framing uses
            the same kind of frame, so it is skipped with it. */}
        <Pressable
          onPress={() => patch({ freq_skipped: skipped ? null : 1 })}
          disabled={locked}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: skipped, disabled: locked }}
          className="flex-row items-center gap-2"
        >
          <Ionicons name={skipped ? 'checkbox' : 'square-outline'} size={20} color={skipped ? '#00A2A5' : '#9ca3af'} />
          <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{t('gloria.unit.freqSkip')}</Text>
        </Pressable>
        {skipped ? (
          <Text className="text-xs text-gray-400">{t('gloria.unit.freqSkipHint')}</Text>
        ) : (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn
              label={`${t('gloria.step.frequency')} · ${unit.freq_locked ? `${t('gloria.freq.doneShort')} · ` : ''}${freqN ? t(freqKey, { count: freqN }) : t('gloria.step.notStarted')}`}
              onPress={() => router.push(`/gloria/${id}/${code}/frequency` as Href)}
            />
          </View>
          <View className="flex-1">
            <Btn
              label={`${t('gloria.step.pointframe')} · ${unit.pf_locked ? `${t('gloria.freq.doneShort')} · ` : ''}${unit.point_surface ? `${visitedCount(unit.point_surface)}/100` : t('gloria.step.notStarted')}`}
              onPress={() => router.push(`/gloria/${id}/${code}/points` as Href)}
            />
          </View>
        </View>
        )}

        <Text
          className="text-xs font-semibold text-gray-500 dark:text-gray-400"
          onLayout={(e) => {
            speciesY.current = e.nativeEvent.layout.y;
            if (pinSpecies) {
              setPinSpecies(false);
              scrollToSpecies();
            }
          }}
        >
          {t('gloria.unit.speciesHeader', { count: spp.length, sum })}
        </Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">
              {t('gloria.unit.noSpecies')}
            </Text>
          ) : (
            dragList(spp, (s) => (
              <>
                <NumField
                  ref={(r) => {
                    if (r) coverRefs.current.set(s.id, r);
                    else coverRefs.current.delete(s.id);
                  }}
                  value={s.cover_pct}
                  onCommit={(v) => track(() => updateUnitSpecies(s.id, { cover_pct: v }))}
                  range={RANGES.percent}
                  width={76}
                  editable={!locked}
                  accessibilityLabel={t('gloria.unit.coverOf', { name: displayName(s) })}
                />
                {cfButton(s)}
              </>
            ))
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.coverRule')}</Text>
        {commentsField}
      </>
    );
  };

  // ── summit area section ────────────────────────────────────────────────
  const sasBody = () => {
    const missing = issues.find((i) => i.kind === 'sas-missing');
    const missingTaxa = () => {
      const inSas = new Set(spp.map((s) => s.taxon_id));
      const out = new Map<string, string>();
      for (const q of quadratsOf(dir))
        for (const s of state.speciesOf(q))
          if (!inSas.has(s.taxon_id)) out.set(s.taxon_id, displayName(s));
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
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">
          {t('gloria.unit.sasHeader', { count: spp.length })}
        </Text>
        <Card>
          {spp.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">
              {t('gloria.unit.noSpecies')}
            </Text>
          ) : (
            dragList(spp, (s) => (
              <View className="flex-row">
                {ABUNDANCE.map((a) => (
                  <Pressable
                    key={a}
                    onPress={() =>
                      track(() =>
                        updateUnitSpecies(s.id, { abundance: s.abundance === a ? null : a }),
                      )
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ checked: s.abundance === a }}
                    className={`ml-1 w-7 items-center rounded-md border py-1 ${s.abundance === a ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
                  >
                    <Text
                      className={`text-[11px] ${s.abundance === a ? 'font-bold text-white' : 'text-gray-600 dark:text-gray-300'}`}
                    >
                      {a}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))
          )}
        </Card>
        <Text className="text-xs text-gray-400">{t('gloria.unit.abundanceLegend')}</Text>
        <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">
          {t('gloria.unit.grazing')}
        </Text>
        <TextInput
          defaultValue={unit.grazing_note ?? ''}
          editable={!locked}
          onEndEditing={(e) => patch({ grazing_note: e.nativeEvent.text.trim() || null })}
          placeholder={t('gloria.unit.grazingPlaceholder')}
          multiline
          className="min-h-[64px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          placeholderTextColor="#9ca3af"
        />
        {commentsField}
      </>
    );
  };

  // ── 10×10 m square ─────────────────────────────────────────────────────
  const squareBody = () => {
    const visited = visitedCount(unit.point_surface);
    const hits = surfaceHits(unit.point_surface);
    const withHits = spp.map((s) => ({
      s,
      n: s.point_hits != null ? popcount(s.point_hits) : (s.legacy_hits ?? 0),
    }));
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
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">
            {t('gloria.square.walk')}
          </Text>
          <View className="flex-row flex-wrap">
            {WALK_OPTIONS.map((o) => (
              <Pressable
                key={o}
                onPress={() => patch({ walk_option: o as WalkOption })}
                className={`mb-1.5 mr-1.5 rounded-lg border px-2.5 py-1.5 ${unit.walk_option === o ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'}`}
              >
                <Text
                  className={`text-xs ${unit.walk_option === o ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-300'}`}
                >
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
          {unit.walk_option == null ? (
            <Text className="text-xs text-gray-400">{t('gloria.square.pickWalk')}</Text>
          ) : null}
        </Card>
        {visited > 0 ? (
          <Card className="p-3">
            <Text className="mb-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
              {t('gloria.square.hitsTitle', { done: visited })}
            </Text>
            {hit.map(({ s, n }) => (
              <View key={s.id} className="flex-row py-0.5">
                <Text
                  className="mr-2 w-6 text-right text-xs text-gray-500 dark:text-gray-400"
                  style={{ fontVariant: ['tabular-nums'] }}
                >
                  {numberOf.get(s.id)}
                </Text>
                <Text className="flex-1 text-xs text-gray-900 dark:text-gray-100">
                  {displayName(s)}
                </Text>
                <Text
                  className="w-14 text-right text-xs text-gray-700 dark:text-gray-300"
                  style={{ fontVariant: ['tabular-nums'] }}
                >
                  {n}
                </Text>
                <Text
                  className="w-16 text-right text-xs text-gray-500"
                  style={{ fontVariant: ['tabular-nums'] }}
                >
                  {coverFromHits(n, 400).toFixed(2)}%
                </Text>
              </View>
            ))}
            <Text className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {SURFACE_CODES.map((c) => `${t(`gloria.surface.${c}`)} ${hits[c]}`).join(' · ')}
            </Text>
          </Card>
        ) : null}
        <View className="flex-row items-center">
          <Text className="flex-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
            {t('gloria.square.extra', { count: extra.length })}
          </Text>
          <Btn small label={t('gloria.square.fromQuadrats')} onPress={fromQuadrats} />
        </View>
        <Card>
          {extra.length === 0 ? (
            <Text className="px-3 py-6 text-center text-sm text-gray-400">
              {t('gloria.square.extraEmpty')}
            </Text>
          ) : (
            dragList(
              extra.map(({ s }) => s),
              () => null,
            )
          )}
        </Card>
        {commentsField}
      </>
    );
  };

  return (
    <SafeAreaView
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setRootTop(y))}
      edges={['bottom']}
      className="flex-1 bg-gray-50 dark:bg-gray-950"
    >
      <Stack.Screen
        options={{
          title,
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              {!locked ? (
                <HeaderIconButton
                  icon="arrow-undo-outline"
                  label={t('gloria.freq.undo')}
                  disabled={undoCount === 0}
                  onPress={() => step(undo, redo)}
                />
              ) : null}
              {!locked ? (
                <HeaderIconButton
                  icon="arrow-redo-outline"
                  label={t('gloria.freq.redo')}
                  disabled={redoCount === 0}
                  onPress={() => step(redo, undo)}
                />
              ) : null}
              <HeaderIconButton
                icon="grid-outline"
                label={t('gloria.overview')}
                onPress={() => setPanel(true)}
              />
              <HeaderIconButton
                icon={locked ? 'lock-closed' : 'checkmark-done-outline'}
                label={locked ? t('gloria.unit.markUndone') : t('gloria.unit.markDone')}
                onPress={() => void toggleDone()}
              />
            </View>
          ),
        }}
      />
      {/* Nestable: the 1×1 m species list inside is draggable. */}
      <NestableScrollContainer
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 12,
          padding: 16,
          // Keyboard up: exactly the dock's height, so the last row meets its top edge.
          paddingBottom: keyboardUp ? dockHeight + 4 : 16,
        }}
        onContentSizeChange={() => {
          if (followEnd.current && keyboardUp) scrollRef.current?.scrollToEnd({ animated: true });
        }}
        onScrollBeginDrag={() => {
          followEnd.current = false;
        }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {type === 'quadrat' ? quadratBody() : type === 'sas' ? sasBody() : squareBody()}
      </NestableScrollContainer>
      {active && !locked ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)}>
            {replaceId != null ? (
              <View className="flex-row items-center border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
                <Ionicons name="swap-horizontal" size={14} color="#d97706" />
                <Text className="ml-2 flex-1 text-xs text-amber-800 dark:text-amber-300" numberOfLines={1}>
                  {t('gloria.unit.replaceBanner', {
                    name: (() => {
                      const r = spp.find((x) => x.id === replaceId);
                      return r ? `${numberOf.get(r.id)}. ${displayName(r)}` : '';
                    })(),
                  })}
                </Text>
                <Pressable onPress={() => setReplaceId(null)} hitSlop={8} className="active:opacity-70">
                  <Text className="text-xs font-medium text-amber-800 dark:text-amber-300">{t('common.cancel')}</Text>
                </Pressable>
              </View>
            ) : null}
            <SearchBox
              scopeGroups={GLORIA_SEARCH_GROUPS}
              topLimit={rootTop}
              onSelect={(r) => {
                if (!r.taxon_id) return;
                if (replaceId != null) replaceTaxon(replaceId, r.taxon_id, r.cname || r.name);
                else addTaxon(r.taxon_id, r.cname || r.name);
              }}
              onFocus={
                type === 'quadrat'
                  ? () => {
                      if (envIsOpen) {
                        // Scroll once the folded card has moved the list up.
                        setPinSpecies(true);
                        setEnvOpen(false);
                      } else scrollToSpecies();
                    }
                  : undefined
              }
            />
          </View>
        </KeyboardStickyView>
      ) : null}
      <NumAccessory />
      {panel ? (
        <OverviewPanel
          state={state}
          code={code}
          current={type === 'square' ? 'cover' : type === 'sas' ? 'sas' : 'cover'}
          onClose={() => setPanel(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}
