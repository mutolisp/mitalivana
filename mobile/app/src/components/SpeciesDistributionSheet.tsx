/**
 * The map's species-distribution queries, in one panel with two tabs.
 *
 * They are inverse questions over the same iNaturalist data — "where is this
 * species?" (a grid drawn on the map) and "what species are here?" (a list you
 * can keep) — so they share an entry point and this shell. They do NOT share a
 * result: one is a map layer with no list, the other a list with no layer, and
 * forcing them into one output would make both worse.
 *
 * The area tab is only the choice of area. Its filters and the review of what
 * came back stay in `AreaSpeciesModal`, full screen, because that step has a
 * text input and can run to hundreds of rows with per-name disambiguation — the
 * two things a floating panel is worst at.
 *
 * ── Tab A: picks the taxon whose iNaturalist observation grid the map draws.
 *
 * Two search paths, in this order:
 *   1. the local checklists, through the app's own `SearchBox` — Chinese
 *      vernacular names, fuzzy matching and the ≡ synonym marks all come with
 *      it, and they work with no signal;
 *   2. iNaturalist itself, offered only once the local search comes back empty
 *      (`renderNoMatch`), for a family, an order, or a species outside Taiwan
 *      and Japan — none of which the bundled checklists carry.
 *
 * **A floating panel rather than a full-screen modal**, and anchored to the TOP
 * of the screen. The usual rule here is that a modal with a text input goes
 * full screen, because a floating BOTTOM sheet gets shoved off the top edge when
 * the keyboard opens — that has bitten this app repeatedly. A top-anchored panel
 * has the opposite geometry: the keyboard rises into the space below it and the
 * panel never moves, so it needs no keyboard avoidance at all. It also keeps the
 * map visible, which is the point — you are choosing what to draw ON it.
 *
 * **The name check is the point of the middle step.** iNaturalist resolves
 * synonyms silently: asking for `Cyathea lepifera` answers with taxon 460690
 * `Sphaeropteris lepifera` and a `matched_term` naming what was asked for
 * (measured 2026-09-20). The tiles are then a DIFFERENT name's observations, so
 * this sheet stops and says which name it is about to draw, rather than
 * swapping names behind the user's back.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SearchResult } from '~/db';
import i18n from '~/i18n';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { fetchObservationCount, searchTaxa, type InatTaxonHit } from '~/lib/inatApi';
import { pickHeatmapMode, type HeatmapMode } from '~/lib/inatHeatmap';
import { inatTilesReachable, resolveInatTaxon, type InatGridTaxon } from '~/lib/useInatGrid';
import { ScientificName } from './ScientificName';
import { runOverModal } from './GbifLookupHost';
import { SearchBox } from './SearchBox';
import { useThemeColors } from '~/theme/colors';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';
import { AdvancedFold } from './AdvancedFold';
import { vis } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';

/** A taxon resolved all the way to something the map can draw. */
export type InatGridSelection = {
  inatTaxonId: number;
  /** 'wild' excludes captive and cultivated; 'all' is the fallback for a taxon
   *  whose only records are cultivated (see `pickHeatmapMode`). */
  mode: Exclude<HeatmapMode, 'none'>;
  count: number;
  /** The name iNaturalist files the observations under. */
  inatName: string;
  /** The name the user searched, kept only when iNaturalist files it elsewhere.
   *  Empty otherwise, so the caption stays quiet in the ordinary case. */
  askedName: string;
  /** Vernacular name for the map caption; '' when there is none. */
  commonName: string;
  /** Rank in the checklist's capitalised spelling ('Family', 'Species'), which
   *  is what decides whether the name is italicised. */
  rank: string;
};

type Props = {
  visible: boolean;
  /** What the map is drawing right now, so the sheet can offer to stop. */
  current: InatGridSelection | null;
  onApply: (selection: InatGridSelection) => void;
  onClear: () => void;
  onClose: () => void;
  /** Area tab: query the species inside the current map viewport. */
  onPickVisibleArea: () => void;
  /** Area tab: hand over to the map's polygon drawing, then query that. */
  onDrawArea: () => void;
};

/** Which question the panel is asking. */
type Tab = 'taxon' | 'area';

type Notice = { tone: 'warn' | 'error'; text: string };

/**
 * What the drawn observations are made of, for the taxon currently on the map.
 *
 * Only what the grid itself cannot show: how many of the records are captive or
 * cultivated (the grid's default excludes them, so a large number here means a
 * lot of the species' data is invisible), and how many carry a community-
 * confirmed identification. Two requests at most, and `per_page=0` makes each
 * one a bare number — no observation is transferred (see `fetchObservationCount`).
 */
type Breakdown = {
  /** Unfiltered total. */
  total: number;
  /** `captive=false`. */
  wild: number;
  /** Research grade, within whatever the layer is drawing. */
  research: number;
};

/** The grid's own colour, from iNaturalistAPI `lib/inaturalist_map_styles.js`
 *  (`polygon-fill: #FF4500`), at four of its thirteen opacity steps. */
const LEGEND_STEPS = [0.3, 0.5, 0.75, 1];
const GRID_COLOR = '#FF4500';

/**
 * iNaturalist writes ranks in lower case ('family'); the italic rules key on the
 * checklist's capitalised spelling (`NON_ITALIC_RANKS` in
 * scientificNameSegments.ts). Passed through unconverted, 'family' matches
 * nothing AND suppresses the suffix fallback, so Fagaceae comes out italic.
 */
function capRank(rank: string): string {
  return rank ? rank.charAt(0).toUpperCase() + rank.slice(1) : '';
}

export function SpeciesDistributionSheet({
  visible,
  current,
  onApply,
  onClear,
  onClose,
  onPickVisibleArea,
  onDrawArea,
}: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  // 範圍物種 (save an area's species as a favourites list): its own tab in pro
  // mode, under 進階 below the distribution search for volunteers.
  const areaVis = vis(useUsageMode(), 'areaSpecies');
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const [tab, setTab] = useState<Tab>('taxon');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** A resolution that changed the name, held back for the user to accept. */
  const [confirm, setConfirm] = useState<InatGridSelection | null>(null);
  const [inatHits, setInatHits] = useState<InatTaxonHit[] | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  // True while a root-hosted lookup is up — see runOverModal.
  const [steppedAside, setSteppedAside] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Session-lived, so reopening the panel for the same species is free. */
  const breakdownCache = useRef<Map<number, Breakdown>>(new Map());
  const detailAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Reopening while a grid is drawn lands on the taxon tab whatever was open
  // last. The map pill is the usual way back in, and everything it promises —
  // which taxon, the breakdown, 停止顯示 — lives on that tab.
  useEffect(() => {
    if (visible && current) setTab('taxon');
  }, [visible, current]);

  // The breakdown is for the taxon the map is ALREADY drawing, so it is fetched
  // when the panel opens rather than during the pick: at pick time the user is
  // waiting for the map, and two more round trips would be in their way.
  useEffect(() => {
    detailAbortRef.current?.abort();
    if (!visible || !current) {
      setBreakdown(null);
      return;
    }
    const cached = breakdownCache.current.get(current.inatTaxonId);
    if (cached) {
      setBreakdown(cached);
      return;
    }
    setBreakdown(null);
    const ctrl = new AbortController();
    detailAbortRef.current = ctrl;
    const { inatTaxonId, mode, count } = current;
    void (async () => {
      try {
        // 'all' mode only exists when there are no wild records at all, so both
        // halves are already known and only the grade costs a request.
        const total =
          mode === 'wild' ? await fetchObservationCount(inatTaxonId, {}, ctrl.signal) : count;
        const research = await fetchObservationCount(
          inatTaxonId,
          { wildOnly: mode === 'wild', qualityGrade: 'research' },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        const next: Breakdown = { total, wild: mode === 'wild' ? count : 0, research };
        breakdownCache.current.set(inatTaxonId, next);
        setBreakdown(next);
      } catch {
        // A detail line is not worth an error message: the grid itself is
        // already drawn and the counts above it are real.
      }
    })();
    return () => ctrl.abort();
  }, [visible, current]);

  const reset = () => {
    abortRef.current?.abort();
    setBusy(false);
    setNotice(null);
    setConfirm(null);
    setInatHits(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const apply = (selection: InatGridSelection) => {
    reset();
    onApply(selection);
  };

  /**
   * Turn a picked name into something drawable, or into a sentence saying why
   * it is not.
   *
   * `resolveInatTaxon` is the same call the record mini-map makes, cache and
   * all, so picking a species that has already been looked at anywhere in the
   * app costs no requests.
   */
  const resolveAndOffer = async (taxon: InatGridTaxon, commonName: string, rank: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setNotice(null);
    setConfirm(null);
    try {
      const { info, fromCache } = await resolveInatTaxon(taxon, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (info.inatTaxonId === null) {
        setNotice({ tone: 'warn', text: t('inatGrid.unknown') });
        return;
      }
      const mode = pickHeatmapMode(info.obsWild, info.obsTotal ?? 0);
      if (mode === 'none') {
        setNotice({ tone: 'warn', text: t('inatGrid.empty') });
        return;
      }
      const inatName = info.inatName || taxon.name;
      const viaSynonym = info.via === 'synonym' && inatName !== taxon.name;
      const selection: InatGridSelection = {
        inatTaxonId: info.inatTaxonId,
        mode,
        count: mode === 'wild' ? info.obsWild : (info.obsTotal ?? 0),
        inatName,
        askedName: viaSynonym ? taxon.name : '',
        commonName,
        rank,
      };
      // A cache hit never touched the network, so whether tiles can load is
      // still unknown — and mounting a layer that will stay blank while a
      // caption reads "1,130 observations" is the exact illusion
      // src/lib/inat.ts forbids. One HEAD request, memoised app-wide for 60 s.
      if (fromCache && !(await inatTilesReachable(ctrl.signal))) {
        if (ctrl.signal.aborted) return;
        setNotice({ tone: 'warn', text: t('inatGrid.offline') });
        return;
      }
      if (ctrl.signal.aborted) return;
      if (viaSynonym) setConfirm(selection);
      else apply(selection);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setNotice({ tone: 'error', text: await apiErrorMessage(e) });
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };

  const handleLocalPick = (r: SearchResult) => {
    setInatHits(null);
    void resolveAndOffer(
      { localTaxonId: r.taxon_id, name: r.name, kingdom: r.kingdom },
      r._raw_cname || r.cname || '',
      r.rank,
    );
  };

  /** A taxon picked straight from iNaturalist: the id is already iNaturalist's,
   *  so `gi…` short-circuits the autocomplete and only the counts are fetched. */
  const handleInatPick = (hit: InatTaxonHit) => {
    void resolveAndOffer(
      { localTaxonId: `gi${hit.id}`, name: hit.name, kingdom: '' },
      hit.commonName,
      capRank(hit.rank),
    );
  };

  const searchInat = async (q: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setNotice(null);
    setConfirm(null);
    try {
      const hits = await searchTaxa(q, i18n.language, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setInatHits(hits);
      if (hits.length === 0) setNotice({ tone: 'warn', text: t('inatGrid.inatNoMatch', { q }) });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setNotice({ tone: 'error', text: await apiErrorMessage(e) });
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };

  const showEmptyHint = !busy && !confirm && !notice && !inatHits;

  const areaChoices = (
    <>
      <Text className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t('speciesDist.areaHint')}</Text>
      <AreaChoice icon="scan-outline" label={t('areaSpecies.sourceVisible')} onPress={onPickVisibleArea} />
      <AreaChoice icon="create-outline" label={t('areaSpecies.sourceDraw')} onPress={onDrawArea} />
      <Text className="mt-3 text-[10px] text-gray-400 dark:text-gray-500">{t('areaSpecies.attribution')}</Text>
    </>
  );

  return (
    <Modal visible={visible && !steppedAside} transparent animationType="fade" onRequestClose={sheetBack(close)}>
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/30"
        onPress={close}
        accessibilityLabel={t('common.close')}
      />
      {/* Anchored under the status bar, the same corner the map's own search
          sits in. maxHeight keeps it clear of the keyboard; the parts that can
          grow (the suggestion list, the status area) cap themselves. */}
      <View className="absolute left-3 right-3" style={{ top: insets.top + 8 }}>
        {/* maxHeight belongs on the card, not on the positioning wrapper: the
            card is the flex column, so this is what makes the status area's
            flexShrink give way instead of the whole thing overflowing. */}
        <View
          className="overflow-hidden rounded-2xl bg-card shadow-lg dark:bg-gray-900"
          style={{ maxHeight: windowHeight * 0.6 }}
        >
          <View className="flex-row items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800">
            <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('speciesDist.title')}
            </Text>
            <Pressable onPress={close} hitSlop={8}>
              <Ionicons name="close" size={18} color={c.ink3} />
            </Pressable>
          </View>

          <View className="flex-row border-b border-gray-100 px-3 pt-2 dark:border-gray-800">
            {(areaVis === 'show' ? (['taxon', 'area'] as const) : (['taxon'] as const)).map((k) => {
              const active = tab === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setTab(k)}
                  className={`mr-4 border-b-2 pb-1.5 ${
                    active ? 'border-accent-600 dark:border-accent-400' : 'border-transparent'
                  }`}
                >
                  <Text
                    className={`text-xs ${
                      active
                        ? 'font-semibold text-accent-700 dark:text-accent-300'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {t(k === 'taxon' ? 'speciesDist.tabTaxon' : 'speciesDist.tabArea')}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {tab === 'area' && areaVis === 'show' ? <View className="px-3 py-3">{areaChoices}</View> : null}

          {tab === 'taxon' && current ? (
            <View className="flex-row items-center border-b border-gray-100 bg-orange-50 px-3 py-1.5 dark:border-gray-800 dark:bg-orange-950/30">
              <View
                style={{ backgroundColor: GRID_COLOR, opacity: 0.8, width: 10, height: 10 }}
                className="rounded-[2px]"
              />
              <View className="ml-2 flex-1 flex-row flex-wrap items-center">
                {current.commonName ? (
                  <Text className="mr-1 text-xs font-medium text-gray-900 dark:text-gray-100">
                    {current.commonName}
                  </Text>
                ) : null}
                <ScientificName
                  name={current.inatName}
                  rank={current.rank}
                  className="text-xs text-gray-700 dark:text-gray-300"
                />
              </View>
              <Pressable
                onPress={() => {
                  reset();
                  onClear();
                }}
                hitSlop={8}
              >
                <Text className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {t('inatGrid.stop')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* What the grid is made of. Two numbers the map cannot show: how much
              of the species' data the wild-only default is leaving out, and how
              much of what IS drawn carries a confirmed identification. */}
          {tab === 'taxon' && current ? (
            <View className="border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
              {breakdown ? (
                <Text className="text-[11px] text-gray-500 dark:text-gray-400">
                  {t('inatGrid.detailWild', { count: breakdown.wild })}
                  {' · '}
                  {t('inatGrid.detailCaptive', {
                    count: Math.max(0, breakdown.total - breakdown.wild),
                  })}
                  {' · '}
                  {t('inatGrid.detailResearch', {
                    count: breakdown.research,
                    pct:
                      current.count > 0
                        ? Math.round((breakdown.research / current.count) * 100)
                        : 0,
                  })}
                </Text>
              ) : (
                <Text className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('inatGrid.detailLoading')}
                </Text>
              )}
            </View>
          ) : null}

          {tab === 'taxon' ? (
            <>
              {/* Input first, suggestions directly under it — the box's own list and
              the iNaturalist results below are the same column, so a suggestion
              never appears at the far end of the panel from what produced it. */}
              <SearchBox
                layout="dropdown"
                autoFocus
                onSelect={handleLocalPick}
                runLookup={(run) => runOverModal(setSteppedAside, run)}
                afterSelect="dismiss"
                // Minting a taxon into the local checklist is not an answer to
                // "which observations should the map draw" — searching iNaturalist
                // is.
                gbifFallback={false}
                renderNoMatch={(q) => (
                  <View className="flex-row flex-wrap items-center border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                    <Text className="mr-2 flex-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('search.noLocalMatch', { q })}
                    </Text>
                    <Pressable
                      onPress={() => void searchInat(q)}
                      className="flex-row items-center rounded-full bg-emerald-50 px-3 py-1.5 active:bg-emerald-100 dark:bg-emerald-950/40 dark:active:bg-emerald-900/60"
                    >
                      <Ionicons name="leaf-outline" size={14} color="#047857" />
                      <Text className="ml-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        {t('inatGrid.searchInat')}
                      </Text>
                    </Pressable>
                  </View>
                )}
              />

              {/* Sibling of the suggestion list, never its parent: a FlatList inside
              a ScrollView is the nesting React Native warns about. */}
              <ScrollView
                style={{ flexShrink: 1 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 4 }}
              >
                {busy ? (
                  <View className="flex-row items-center justify-center gap-2 py-3">
                    <ActivityIndicator size="small" />
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      {t('inatGrid.checking')}
                    </Text>
                  </View>
                ) : null}

                {/* The name check. iNaturalist answered with a different name than
                the one asked for, so nothing is drawn until the user says so. */}
                {confirm ? (
                  <View className="border-t border-accent-200 bg-accent-50 px-3 py-2 dark:border-accent-900 dark:bg-accent-950/30">
                    <Text className="text-xs text-gray-700 dark:text-gray-300">
                      {t('inatGrid.synonymAsk', {
                        asked: confirm.askedName,
                        accepted: confirm.inatName,
                      })}
                    </Text>
                    <Text className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                      {confirm.mode === 'wild'
                        ? t('inatGrid.wild', { count: confirm.count })
                        : t('inatGrid.captiveOnly', { count: confirm.count })}
                    </Text>
                    <View className="mt-2 flex-row gap-2">
                      <Pressable
                        onPress={() => apply(confirm)}
                        className="rounded-full bg-accent-600 px-3 py-1.5 active:bg-accent-700"
                      >
                        <Text className="text-xs font-medium text-white">
                          {t('inatGrid.synonymUse')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setConfirm(null)}
                        className="rounded-full border border-gray-300 px-3 py-1.5 dark:border-gray-600"
                      >
                        <Text className="text-xs text-gray-700 dark:text-gray-300">
                          {t('common.cancel')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                {notice ? (
                  <Text
                    className={`px-3 py-2 text-xs ${
                      notice.tone === 'error'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {notice.text}
                  </Text>
                ) : null}

                {inatHits && inatHits.length > 0 ? (
                  <View>
                    <Text className="border-t border-gray-100 px-3 pb-1 pt-2 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      {t('inatGrid.inatResults')}
                    </Text>
                    {inatHits.map((hit) => (
                      <Pressable
                        key={hit.id}
                        onPress={() => handleInatPick(hit)}
                        className="border-t border-gray-100 px-3 py-2 active:bg-accent-50 dark:border-gray-800 dark:active:bg-accent-900/40"
                      >
                        <View className="flex-row flex-wrap items-center">
                          {hit.commonName ? (
                            <Text className="mr-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                              {hit.commonName}
                            </Text>
                          ) : null}
                          <ScientificName
                            name={hit.name}
                            rank={capRank(hit.rank)}
                            className="text-sm text-gray-700 dark:text-gray-300"
                          />
                        </View>
                        <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                          {hit.rank ? `${hit.rank} · ` : ''}
                          {t('inatGrid.obsCount', { count: hit.observationCount })}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                {showEmptyHint ? (
                  <Text className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('inatGrid.searchHint')}
                  </Text>
                ) : null}
              </ScrollView>

              {/* Legend. The grid's darkness is the observation count — saying so is
              the only thing that makes the shading read as data, not styling. */}
              <View className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                <View className="flex-row items-center">
                  <Text className="mr-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {t('inatGrid.legendFew')}
                  </Text>
                  {LEGEND_STEPS.map((o) => (
                    <View
                      key={o}
                      style={{ backgroundColor: GRID_COLOR, opacity: o, width: 20, height: 10 }}
                      className="mr-0.5 rounded-[2px]"
                    />
                  ))}
                  <Text className="ml-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {t('inatGrid.legendMany')}
                  </Text>
                </View>
                <Text className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  {t('inatGrid.attribution')}
                </Text>
              </View>
            </>
          ) : null}
          {areaVis === 'adv' ? (
            <AdvancedFold className="mx-3 my-2" summary={t('speciesDist.tabArea')}>
              {areaChoices}
            </AdvancedFold>
          ) : null}
        </View>
      </View>
      <ActionSheetLayer visible={visible && !steppedAside} />
    </Modal>
  );
}

/**
 * One way of choosing the area. A row rather than a chip: the label is a whole
 * phrase in every language, and two of them side by side wrapped badly.
 */
function AreaChoice({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      className="mb-2 flex-row items-center rounded-xl border border-gray-200 px-3 py-2.5 active:bg-gray-50 dark:border-gray-700 dark:active:bg-gray-800"
    >
      <Ionicons name={icon} size={18} color={c.accent} />
      <Text className="ml-2 flex-1 text-sm text-gray-900 dark:text-gray-100">{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={c.ink3} />
    </Pressable>
  );
}
