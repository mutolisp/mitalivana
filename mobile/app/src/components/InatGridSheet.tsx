/**
 * Picks the taxon whose iNaturalist observation grid the map draws.
 *
 * Two search paths, in this order:
 *   1. the local checklists, through the app's own `SearchBox` — Chinese
 *      vernacular names, fuzzy matching and the ≡ synonym marks all come with
 *      it, and they work with no signal;
 *   2. iNaturalist itself, offered only once the local search comes back empty
 *      (`renderNoMatch`), for a family, an order, or a species outside Taiwan
 *      and Japan — none of which the bundled checklists carry.
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
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SearchResult } from '~/db';
import i18n from '~/i18n';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { searchTaxa, type InatTaxonHit } from '~/lib/inatApi';
import { pickHeatmapMode, type HeatmapMode } from '~/lib/inatHeatmap';
import { inatTilesReachable, resolveInatTaxon, type InatGridTaxon } from '~/lib/useInatGrid';
import { KeyboardStickyView } from './KeyboardAvoidingView';
import { ScientificName } from './ScientificName';
import { SearchBox } from './SearchBox';

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
};

type Notice = { tone: 'warn' | 'error'; text: string };

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

export function InatGridSheet({ visible, current, onApply, onClear, onClose }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** A resolution that changed the name, held back for the user to accept. */
  const [confirm, setConfirm] = useState<InatGridSelection | null>(null);
  const [inatHits, setInatHits] = useState<InatTaxonHit[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

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

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      {/* edges={['bottom']} is what the docked SearchBox below compensates for
          (see scripts/check-bottom-dock.mjs); the top inset is applied by hand,
          because a SafeAreaView top edge inside a Modal measures wrong. */}
      <SafeAreaView
        edges={['bottom']}
        className="flex-1 bg-white dark:bg-gray-900"
        style={{ paddingTop: insets.top }}
      >
        <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Pressable onPress={close} hitSlop={8}>
            <Text className="text-base text-gray-700 dark:text-gray-300">{t('common.close')}</Text>
          </Pressable>
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('inatGrid.sheetTitle')}
          </Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
          {current ? (
            <View className="m-3 rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950/30">
              <Text className="text-[11px] text-orange-700 dark:text-orange-300">
                {t('inatGrid.showingNow')}
              </Text>
              <View className="mt-1 flex-row flex-wrap items-center">
                {current.commonName ? (
                  <Text className="mr-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {current.commonName}
                  </Text>
                ) : null}
                <ScientificName
                  name={current.inatName}
                  rank={current.rank}
                  className="text-sm text-gray-700 dark:text-gray-300"
                />
              </View>
              <Text className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                {current.mode === 'wild'
                  ? t('inatGrid.wild', { count: current.count })
                  : t('inatGrid.captiveOnly', { count: current.count })}
              </Text>
              <Pressable
                onPress={() => {
                  reset();
                  onClear();
                }}
                className="mt-2 flex-row items-center self-start rounded-full bg-white px-3 py-1.5 dark:bg-gray-900"
              >
                <Ionicons name="close-circle-outline" size={14} color="#b45309" />
                <Text className="ml-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {t('inatGrid.stop')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {busy ? (
            <View className="flex-row items-center justify-center gap-2 py-6">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {t('inatGrid.checking')}
              </Text>
            </View>
          ) : null}

          {/* The name check. iNaturalist answered with a different name than the
              one asked for, so nothing is drawn until the user says to. */}
          {confirm ? (
            <View className="mx-3 mb-3 rounded-lg border border-blue-300 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/30">
              <Text className="text-xs text-gray-700 dark:text-gray-300">
                {t('inatGrid.synonymAsk', { asked: confirm.askedName, accepted: confirm.inatName })}
              </Text>
              <Text className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {confirm.mode === 'wild'
                  ? t('inatGrid.wild', { count: confirm.count })
                  : t('inatGrid.captiveOnly', { count: confirm.count })}
              </Text>
              <View className="mt-2 flex-row gap-2">
                <Pressable
                  onPress={() => apply(confirm)}
                  className="rounded-full bg-blue-600 px-3 py-1.5 active:bg-blue-700"
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
              className={`mx-4 mb-3 text-xs ${
                notice.tone === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-700 dark:text-amber-400'
              }`}
            >
              {notice.text}
            </Text>
          ) : null}

          {inatHits && inatHits.length > 0 ? (
            <View className="mb-3">
              <Text className="px-4 pb-1 text-[11px] text-gray-500 dark:text-gray-400">
                {t('inatGrid.inatResults')}
              </Text>
              {inatHits.map((hit) => (
                <Pressable
                  key={hit.id}
                  onPress={() => handleInatPick(hit)}
                  className="border-b border-gray-100 px-4 py-2.5 active:bg-blue-50 dark:border-gray-800 dark:active:bg-blue-900/40"
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

          {!current && !busy && !confirm && !inatHits ? (
            <View className="px-6 py-8">
              <Ionicons name="grid-outline" size={44} color="#9ca3af" style={{ alignSelf: 'center' }} />
              <Text className="mt-3 text-center text-sm text-gray-600 dark:text-gray-400">
                {t('inatGrid.searchHint')}
              </Text>
            </View>
          ) : null}

          {/* Legend. The grid's darkness is the observation count — and saying
              so is the only way the shading reads as data rather than styling. */}
          <View className="mx-4 mb-6 mt-2 flex-row items-center">
            <Text className="mr-2 text-[11px] text-gray-500 dark:text-gray-400">
              {t('inatGrid.legendFew')}
            </Text>
            {LEGEND_STEPS.map((o) => (
              <View
                key={o}
                style={{ backgroundColor: GRID_COLOR, opacity: o, width: 22, height: 12 }}
                className="mr-0.5 rounded-[2px]"
              />
            ))}
            <Text className="ml-2 text-[11px] text-gray-500 dark:text-gray-400">
              {t('inatGrid.legendMany')}
            </Text>
          </View>
          <Text className="mx-4 mb-6 text-[10px] text-gray-400 dark:text-gray-500">
            {t('inatGrid.attribution')}
          </Text>
        </ScrollView>

        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <SearchBox
            onSelect={handleLocalPick}
            afterSelect="dismiss"
            // Minting a taxon into the local checklist is not an answer to
            // "which observations should the map draw" — searching iNaturalist
            // is.
            gbifFallback={false}
            renderNoMatch={(q) => (
              <View className="items-center border-b border-gray-100 px-4 py-4 dark:border-gray-800">
                <Text className="text-center text-xs text-gray-500 dark:text-gray-400">
                  {t('search.noLocalMatch', { q })}
                </Text>
                <Pressable
                  onPress={() => void searchInat(q)}
                  className="mt-2 flex-row items-center rounded-full bg-emerald-50 px-3 py-1.5 active:bg-emerald-100 dark:bg-emerald-950/40 dark:active:bg-emerald-900/60"
                >
                  <Ionicons name="leaf-outline" size={14} color="#047857" />
                  <Text className="ml-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    {t('inatGrid.searchInat')}
                  </Text>
                </Pressable>
              </View>
            )}
          />
        </KeyboardStickyView>
      </SafeAreaView>
    </Modal>
  );
}
