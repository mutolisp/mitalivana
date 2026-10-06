import { Ionicons } from '@expo/vector-icons';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Keyboard, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import {
  onDatasetsChanged,
  prewarmFuzzyIndex,
  searchByTaxonId,
  searchWithFuzzyFallback,
  TAXON_GROUP_FILTERS,
  type SearchResult,
} from '~/db';
import { invalidateUsageCounts, usageCounts } from '~/db/usageCounts';
import { rankByUsage, usedMatching } from '~/lib/usageRank';
import type { AdoptionInput } from '~/db';
import { onPackContentChanged } from '~/db/regionpacks';
import type { TaxonGroup } from '~/db/types';
import { applyChoice, chooseNameUsage } from '~/lib/adoptName';
import { alienBadge } from '~/lib/conservationColors';
import { familyChineseFirst } from '~/lib/familyLabel';
import { lookupGbifName, manualTaxonEntry, type GbifLookupOutcome, type LookupRunner } from './GbifLookupHost';
import { AdvancedFold } from './AdvancedFold';
import { vis } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';
import { TaxonGroupPicker } from './TaxonGroupPicker';
import { ScientificName } from './ScientificName';
import { useSettings } from '~/stores/settings';
import { useTopChrome } from '~/stores/topChrome';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { Button } from './ui/Button';

/**
 * Debounce window between the last keystroke and the actual search firing.
 * Chinese IME composition pauses for ~100-200ms between committed chars, so
 * 250ms gives the user enough room to finish typing a word before we hit
 * the 242k-row SQLite scan + 62k-row fuzzy index.
 *
 * Single-char queries (芒, 櫸, 薹, 莎, 桑…) are valid common names so we
 * don't gate on length — the cache + 250ms debounce + column projection
 * are what we lean on for performance.
 */
const DEBOUNCE_MS = 250;
/** A navigation bar's height (Material top app bar 56 dp, iOS 44 pt + margin). */
const NAV_BAR_NOMINAL = 56;
/** Cap on the in-memory result cache (FIFO eviction). 20 keeps the typical
 *  back-and-forth typing path warm without growing the JS heap. */
const CACHE_LIMIT = 20;

type Props = {
  /** `adopted` is set only when the user chose a name the checklist does not
   *  treat as accepted; pass it straight through to the add path. */
  onSelect: (result: SearchResult, adopted?: AdoptionInput | null) => void;
  onLongPressResult?: (result: SearchResult) => void;
  autoFocus?: boolean;
  /**
   * Behaviour after the user picks a result:
   *   - 'refocus' (default): re-focus the input + keep keyboard up. Right for
   *     quick-add flows (session / plot list) where the next action is typing
   *     another species.
   *   - 'dismiss': blur the input + dismiss the keyboard. Right for inline
   *     detail panels where the keyboard would cover the detail the user
   *     just opened.
   */
  afterSelect?: 'refocus' | 'dismiss';
  /** Offer the GBIF lookup when the local checklists have nothing. Default on;
   *  turn it off where adding a brand-new taxon makes no sense. */
  gbifFallback?: boolean;
  /**
   * Replaces the GBIF / manual-entry row shown when the local checklists come
   * back empty, for callers whose answer to "not in the checklist" is something
   * other than minting a taxon (the iNaturalist grid searches iNaturalist
   * instead). Receives the trimmed query.
   *
   * Set it together with `gbifFallback={false}`: nothing stops both, but two
   * different offers on one empty result is a choice the user should not have
   * to make.
   */
  renderNoMatch?: (query: string) => ReactNode;
  /**
   * Taxon groups a screen always starts with, whatever the user last picked
   * elsewhere — a GLORIA survey records vascular plants only. The user can
   * still change them here, but that change stays on this screen and is not
   * remembered as `last_search_groups`.
   */
  scopeGroups?: TaxonGroup[];
  /** The input got focus — e.g. to make room for the list being added to. */
  onFocus?: () => void;
  /**
   * Window y of the top of the screen's content (just under the navigation
   * header). Docked suggestions never grow above it. Without it the limit is
   * estimated from the header height alone, which misses chrome drawn above
   * the navigator (the active-record bar).
   */
  topLimit?: number;
  /**
   * Which way round the box is built.
   *
   *   - 'dock' (default): suggestions ABOVE the input. Right when the box is
   *     pinned to the bottom of a screen, where the input sits next to the
   *     keyboard and the list grows upwards into free space.
   *   - 'dropdown': suggestions BELOW the input, the way a floating panel
   *     anchored to the top of the screen has to read. The list is also shorter,
   *     because that panel has other things under it.
   *
   * Only the order and the list's height change; everything else — debounce,
   * cache, fuzzy fallback, name adoption — is the same box.
   */
  layout?: 'dock' | 'dropdown';
  /**
   * How to open the GBIF lookup / manual-taxon form (both root-hosted Modals).
   * A box that sits inside a Modal MUST pass
   * `(run) => runOverModal(setHidden, run)`: presenting one Modal over another
   * crashes iOS. Default runs them directly.
   */
  runLookup?: LookupRunner;
  /** Taxa already on the list being added to: their rows carry `markLabel`,
   *  so adding the same species twice is a decision rather than a slip. */
  markedTaxa?: ReadonlySet<string>;
  markLabel?: string;
  /**
   * Dock only: a control beside the input (the checklist's camera key). It
   * gives way to a Cancel while the input has focus — Cancel clears the query
   * and puts the keyboard away.
   */
  trailing?: ReactNode;
};

/**
 * Small FIFO-evicting cache. Keys are `${trimmedQuery}|${groupOrEmpty}`.
 * Module-scope so cache survives navigation between screens that all mount
 * SearchBox (lookup → session → plot, same query) — Chinese keyword search
 * over 242k rows costs ~100-300ms, repeated lookups should be instant.
 */
const resultCache = new Map<string, SearchResult[]>();
function cacheGet(key: string): SearchResult[] | undefined {
  return resultCache.get(key);
}
/** Drop every cached result.
 *
 *  The cache has no other invalidation, so after the user mints an external
 *  taxon the empty result for the very query that offered it would otherwise
 *  survive until 20 other queries evict it — and the search box would keep
 *  insisting the species does not exist. */
export function clearSearchResultCache(): void {
  resultCache.clear();
}
// A different checklist module means the cached results answer the previous
      // dataset.
onDatasetsChanged(clearSearchResultCache);
// Same for region packs: deleting one, or one finishing its download, changes
// what a query should return (a stale hit on a deleted pack's taxon saves a
// record whose name resolves to nothing).
onPackContentChanged(clearSearchResultCache);

function inGroups(r: SearchResult, groups: TaxonGroup[]): boolean {
  if (groups.length === 0) return true;
  return groups.some((g) => {
    const f = TAXON_GROUP_FILTERS[g];
    return (
      (!f.kingdom || r.kingdom === f.kingdom) &&
      (!f.phylum || r.phylum === f.phylum) &&
      (!f.class || r.class_name === f.class)
    );
  });
}

/**
 * Setting `search_usage_rank`: exact matches first, then the taxa the user
 * records most (src/lib/usageRank.ts). Used taxa that match the query but fell
 * outside the search's own cut-off are brought back first, so a species
 * recorded a hundred times is not lost behind twenty rarer ones. Applied
 * after the result cache, so a fresh add counts at once.
 */
function withUsage(results: SearchResult[], q: string, groups: TaxonGroup[]): SearchResult[] {
  try {
    const { used, counts } = usageCounts();
    const have = new Set(results.map((r) => r.taxon_id));
    const extra = usedMatching(
      used.filter((u) => !have.has(u.taxon_id)),
      q,
      5,
    )
      .map((u) => searchByTaxonId(u.taxon_id))
      .filter((r): r is SearchResult => !!r && !have.has(r.taxon_id) && inGroups(r, groups));
    return rankByUsage([...results, ...extra], q, counts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[SearchBox] usage ranking failed:', e);
    return results;
  }
}

function cacheSet(key: string, value: SearchResult[]): void {
  if (resultCache.has(key)) resultCache.delete(key);
  resultCache.set(key, value);
  if (resultCache.size > CACHE_LIMIT) {
    const first = resultCache.keys().next().value;
    if (first !== undefined) resultCache.delete(first);
  }
}

export function SearchBox({
  onSelect,
  onLongPressResult,
  autoFocus = false,
  afterSelect = 'refocus',
  gbifFallback = true,
  renderNoMatch,
  layout = 'dock',
  runLookup = (run) => run(),
  scopeGroups,
  onFocus,
  topLimit,
  markedTaxa,
  markLabel,
  trailing,
}: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const mode = useUsageMode();
  const lastGroups = useSettings((s) => s.last_search_groups);
  const usageRank = useSettings((s) => s.search_usage_rank);
  const setSetting = useSettings((s) => s.set);

  const [query, setQuery] = useState('');
  const [groups, setGroupsLocal] = useState<TaxonGroup[]>(scopeGroups ?? lastGroups);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmedQuery = query.trim();
  // Only offer the network once the local search has actually run and come
  // back empty — not while the debounce is still pending.
  const noLocalHit =
    (gbifFallback || !!renderNoMatch) && trimmedQuery.length > 0 && results.length === 0;

  // A screen can gain or lose its scope while mounted (a GLORIA survey starts
  // or ends under the taxonomy tab); follow it, then the remembered groups.
  useEffect(() => {
    setGroupsLocal(scopeGroups ?? lastGroups);
  }, [lastGroups, scopeGroups]);

  // Pre-warm the 62k fuzzy cname index off the critical path so the first
  // user query doesn't pay the ~200-500ms cold-load cost. setTimeout(0)
  // yields to UI render first; an already-warm index is a no-op.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        prewarmFuzzyIndex();
      } catch {
        // non-fatal: search still works via exact path, just slower on
        // the first fuzzy fallback.
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    // Cache hit fires synchronously — no debounce wait. Lets the user
    // erase a char and instantly see the prior result without re-running
    // the SQL.
    const cacheKey = `${trimmed}|${groups.join(',')}`;
    const cached = cacheGet(cacheKey);
    const finish = (r: SearchResult[]) =>
      setResults((usageRank ? withUsage(r, trimmed, groups) : r).slice(0, 20));
    if (cached) {
      finish(cached);
      return;
    }
    debounceRef.current = setTimeout(() => {
      try {
        const r = searchWithFuzzyFallback({ q: trimmed, groups: groups.length ? groups : undefined });
        cacheSet(cacheKey, r);
        finish(r);
      } catch (e) {
        // Defense in depth: never let a search-time exception escape the
        // debounce timer — an uncaught error here has been observed to
        // destabilize the JS runtime (Hermes GC crash) when typing fires
        // many queries in quick succession.
        // eslint-disable-next-line no-console
        console.warn('[SearchBox] search failed:', e);
        setResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, groups, usageRank]);

  const handleGroupChange = (next: TaxonGroup[]) => {
    setGroupsLocal(next);
    if (!scopeGroups) setSetting('last_search_groups', next);
  };

  /** The user tapped the 「你輸入：X」 line: ask which name to file under. */
  const handleAdopt = async (result: SearchResult) => {
    Keyboard.dismiss();
    const choice = await chooseNameUsage(result, runLookup);
    if (!choice) return;
    const { result: picked, adopted } = applyChoice(result, choice);
    handleSelect(picked, adopted);
  };

  const handleSelect = (result: SearchResult, adopted: AdoptionInput | null = null) => {
    onSelect(result, adopted);
    // Probably just recorded: let the next search count it.
    invalidateUsageCounts();
    setQuery('');
    setResults([]);
    if (afterSelect === 'refocus') {
      inputRef.current?.focus();
    } else {
      inputRef.current?.blur();
      Keyboard.dismiss();
    }
  };

  /** Shared tail of both empty-state CTAs (GBIF lookup / manual create):
   *  a freshly minted taxon must not stay invisible behind the cached
   *  "nothing found" for this very query. */
  const applyPicked = (picked: GbifLookupOutcome | null) => {
    if (!picked) return;
    clearSearchResultCache();
    setResults([]);
    handleSelect(picked.result);
    useToast
      .getState()
      .show(
        picked.viaLocal
          ? t('gbifLookup.resolvedLocal', { name: picked.result.cname || picked.result.name })
          : t('gbifLookup.added', { name: picked.result.cname || picked.result.name }),
      );
  };

  const dropdown = layout === 'dropdown';

  // Docked, the suggestions grow UP from the input. With the keyboard up the
  // room above is only window − keyboard − where the content starts − this
  // box's own chrome (group filter + input), so cap it. The content starts
  // under the app chrome above the navigator (the active-record bar, or the
  // status-bar spacer) and a navigation bar. HeaderHeightContext is no measure
  // of that bar: on the plot screen it read 220 dp for a ~75 dp header, which
  // left a 96 dp list (about one row) during a survey. A nominal bar is used
  // instead; the list is inverted, so if the room is overestimated only the
  // tail runs under the header, never the best match.
  const topChrome = useTopChrome((s) => s.height);
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const [chromeHeight, setChromeHeight] = useState(0);
  const listCap =
    !dropdown && keyboardHeight > 0
      ? Math.max(96, windowHeight - (topLimit ?? topChrome + NAV_BAR_NOMINAL) - keyboardHeight - chromeHeight - 8)
      : undefined;

  const createOwnChip = (
    <Pressable
      onPress={async () => {
        Keyboard.dismiss();
        applyPicked(await runLookup(() => manualTaxonEntry(trimmedQuery)));
      }}
      className="flex-row items-center rounded-full bg-amber-50 px-3 py-1.5 active:bg-amber-100 dark:bg-amber-950/40 dark:active:bg-amber-900/60"
    >
      <Ionicons name="create-outline" size={14} color="#b45309" />
      <Text className="ml-1 text-xs font-medium text-amber-700 dark:text-amber-300">
        {t('manualTaxon.createOwn')}
      </Text>
    </Pressable>
  );
  const suggestions =
    results.length > 0 ? (
      <View
        className={`${dropdown ? 'max-h-56 border-t' : 'max-h-72 border-b'} border-gray-100 dark:border-gray-800`}
        style={listCap != null ? { maxHeight: Math.min(288, listCap) } : undefined}
      >
        {/* Docked, the list is inverted: the best match sits right on top of the
            input and the rest go up from there, so whatever may not fit is the
            tail, never the first suggestion (user decision 2026-09-30). */}
        <FlatList
          data={results}
          inverted={!dropdown}
          keyExtractor={getResultKey}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews
          renderItem={({ item }) => (
            <AutocompleteRow
              result={item}
              markLabel={markedTaxa?.has(item.taxon_id) ? markLabel : undefined}
              onPress={() => handleSelect(item)}
              onLongPress={onLongPressResult ? () => onLongPressResult(item) : undefined}
              onAdopt={() => handleAdopt(item)}
            />
          )}
        />
      </View>
    ) : noLocalHit && renderNoMatch ? (
      renderNoMatch(trimmedQuery)
    ) : noLocalHit ? (
      <View
        className={`items-center ${dropdown ? 'border-t' : 'border-b'} border-gray-100 px-4 py-4 dark:border-gray-800`}
      >
        <Text className="text-center text-xs text-gray-500 dark:text-gray-400">
          {t('search.noLocalMatch', { q: trimmedQuery })}
        </Text>
        <View className="mt-2 flex-row items-center gap-2">
          <Pressable
            onPress={async () => {
              Keyboard.dismiss();
              applyPicked(await runLookup(() => lookupGbifName(trimmedQuery)));
            }}
            className="flex-row items-center rounded-full bg-accent-50 px-3 py-1.5 active:bg-accent-100 dark:bg-accent-950/40 dark:active:bg-accent-900/60"
          >
            <Ionicons name="earth-outline" size={14} color={c.accent} />
            <Text className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-300">
              {t('search.lookupGbif')}
            </Text>
          </Pressable>
          {vis(mode, 'customTaxon') === 'show' ? createOwnChip : null}
        </View>
        {/* Self-made taxa go into exports and iNat; volunteers reach them under 進階. */}
        {vis(mode, 'customTaxon') === 'adv' ? (
          <AdvancedFold className="mt-3 self-stretch">
            <View className="items-center">{createOwnChip}</View>
          </AdvancedFold>
        ) : null}
      </View>
    ) : null;

  const picker = (
    <View
      className={`flex-row items-center justify-start gap-2 ${dropdown ? 'border-t' : 'border-b'} border-gray-100 px-3 py-2 dark:border-gray-800`}
    >
      <TaxonGroupPicker value={groups} onChange={handleGroupChange} />
    </View>
  );

  const input = (
    <View className="flex-row items-center gap-2 px-2 py-2">
      <View
        className={`flex-1 flex-row items-center rounded-full px-3 ${
          dropdown
            ? 'bg-gray-100 py-2 dark:bg-gray-800'
            : 'border-[1.5px] border-gray-300 bg-paper dark:border-gray-600 dark:bg-paper-dark'
        }`}
        style={dropdown ? undefined : { minHeight: 48 }}
      >
        <Ionicons name="search" size={dropdown ? 18 : 20} color={c.ink2} />
        <TextInput
          ref={inputRef}
          className="ml-2 flex-1 py-2 text-base text-gray-900 dark:text-gray-100"
          placeholder={t('search.placeholder')}
          placeholderTextColor={c.ink3}
          value={query}
          onChangeText={setQuery}
          autoFocus={autoFocus}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => setFocused(false)}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={c.ink3} />
          </Pressable>
        ) : null}
      </View>
      {trailing && !dropdown ? (
        // Focus alone is not enough: Android's back key hides the keyboard but
        // leaves the input focused, which would strand the camera behind Cancel.
        focused && keyboardHeight > 0 ? (
          <Button
            label={t('common.cancel')}
            variant="ghost"
            onPress={() => {
              setQuery('');
              Keyboard.dismiss();
            }}
          />
        ) : (
          trailing
        )
      ) : null}
    </View>
  );

  return (
    <View
      className={`${dropdown ? '' : 'border-t border-gray-200 dark:border-gray-700'} bg-card dark:bg-gray-900`}
    >
      {dropdown ? (
        <>
          {input}
          {picker}
          {suggestions}
        </>
      ) : (
        <>
          {suggestions}
          <View onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}>
            {picker}
            {input}
          </View>
        </>
      )}
    </View>
  );
}

function getResultKey(r: SearchResult): string {
  // taxon_id is unique across all three namespaces ('t…' / 'y…' / 'g…');
  // `id` is TaiCOL's name_id and is 0 for external taxa, so keying on it
  // would collide the moment two of them show up together.
  return r.taxon_id || `${r.id}`;
}

const AutocompleteRow = memo(function AutocompleteRow({
  result,
  markLabel,
  onPress,
  onLongPress,
  onAdopt,
}: {
  result: SearchResult;
  /** Set when the taxon is already on the list (e.g. 已在名錄). */
  markLabel?: string;
  onPress: () => void;
  onLongPress?: () => void;
  onAdopt: () => void;
}) {
  const { t } = useTranslation();
  const mode = useUsageMode();
  const isSynonym = !!result.matched_as;
  const isFuzzy = !!result.fuzzy_match;
  const isEndemic = result.endemic === 1;
  const ab = alienBadge(result.alien_type, result.kingdom);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className="border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 active:bg-accent-50 dark:active:bg-accent-900/40"
    >
      <View className="flex-row flex-wrap items-center">
        {isSynonym ? <Text className="mr-1 text-sm text-orange-600">≡</Text> : null}
        {isFuzzy ? <Text className="mr-1 text-sm text-purple-600">~</Text> : null}
        {result.cname ? (
          <>
            <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{result.cname}</Text>
            <Text className="ml-1 text-xs text-gray-500 dark:text-gray-400"> </Text>
          </>
        ) : null}
        <ScientificName
          name={result.name}
          rank={result.rank}
          author={result.fullname.replace(result.name, '').trim()}
          kingdom={result.kingdom}
          nomenclature={result.nomenclature_name}
          className="text-sm text-gray-700 dark:text-gray-300"
        />
        {isEndemic ? (
          <Text className="ml-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">{t('species.endemicShort')}</Text>
        ) : null}
        {ab ? (
          <Text className={`ml-1.5 text-xs font-medium ${ab.textClass}`}>{ab.shortLabel}</Text>
        ) : null}
        {result.pack_country ? (
          // GBIF-derived country-pack row — badge it so it is never mistaken
          // for a checklist-verified name (external rows historically had no
          // marker at all, which was a known gap).
          <Text className="ml-1.5 rounded bg-sky-100 px-1 text-xs font-medium text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
            {result.pack_country}
          </Text>
        ) : null}
        {result.external_source === 'manual' ? (
          <Text className="ml-1.5 rounded bg-amber-100 px-1 text-xs font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            {t('manualTaxon.badge')}
          </Text>
        ) : result.external_source ? (
          // Taken from GBIF / iNat, not from a checklist — the same badge as the taxonomy tree's row.
          <Text className="ml-1.5 rounded bg-sky-100 px-1 text-xs font-medium text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
            {result.external_source === 'gbif' ? 'GBIF' : 'iNat'}
          </Text>
        ) : null}
        {markLabel ? (
          <Text className="ml-1.5 rounded bg-accent-100 px-1 text-xs font-bold text-accent-700 dark:bg-accent-900 dark:text-accent-300">
            {markLabel}
          </Text>
        ) : null}
      </View>
      {result.matched_as ? (
        // Tappable: the checklist calls this name not-accepted, but that is an
        // opinion the recorder may not share. Sits inside the row's Pressable,
        // so it needs its own generous hit area and a visible affordance —
        // this is used one-handed in the field.
        <Pressable
          // Choosing to keep the non-accepted name is folded away for
          // volunteers: the line still says what matched, but does nothing.
          onPress={vis(mode, 'nameUsagePick') === 'show' ? onAdopt : undefined}
          disabled={vis(mode, 'nameUsagePick') !== 'show'}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          className="mt-0.5 flex-row items-center"
        >
          <Text className="flex-1 text-xs text-orange-700 dark:text-orange-300" numberOfLines={1}>
            {t('search.youEntered')}
            <ScientificName
              name={result.matched_as.name}
              rank={result.rank}
              kingdom={result.kingdom}
              nomenclature={result.nomenclature_name}
            />
            （{result.matched_as.status}）
          </Text>
          {vis(mode, 'nameUsagePick') === 'show' ? <Ionicons name="chevron-forward" size={12} color="#c2410c" /> : null}
        </Pressable>
      ) : null}
      {result.family_cname || result.family ? (
        <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {familyChineseFirst(result.family, result.family_cname)}
        </Text>
      ) : null}
    </Pressable>
  );
});
