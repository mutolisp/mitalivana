import { Ionicons } from '@expo/vector-icons';
import { memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Keyboard, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { HeaderHeightContext } from '@react-navigation/elements';
import { useKeyboardState } from 'react-native-keyboard-controller';
import {
  onDatasetsChanged,
  prewarmFuzzyIndex,
  searchWithFuzzyFallback,
  type SearchResult,
} from '~/db';
import type { AdoptionInput } from '~/db';
import { onPackContentChanged } from '~/db/regionpacks';
import type { TaxonGroup } from '~/db/types';
import { applyChoice, chooseNameUsage } from '~/lib/adoptName';
import { alienBadge } from '~/lib/conservationColors';
import { lookupGbifName, manualTaxonEntry, type GbifLookupOutcome, type LookupRunner } from './GbifLookupHost';
import { TaxonGroupPicker } from './TaxonGroupPicker';
import { ScientificName } from './ScientificName';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';

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
}: Props) {
  const { t } = useTranslation();
  const lastGroups = useSettings((s) => s.last_search_groups);
  const setSetting = useSettings((s) => s.set);

  const [query, setQuery] = useState('');
  const [groups, setGroupsLocal] = useState<TaxonGroup[]>(scopeGroups ?? lastGroups);
  const [results, setResults] = useState<SearchResult[]>([]);
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
    if (cached) {
      setResults(cached.slice(0, 20));
      return;
    }
    debounceRef.current = setTimeout(() => {
      try {
        const r = searchWithFuzzyFallback({ q: trimmed, groups: groups.length ? groups : undefined });
        cacheSet(cacheKey, r);
        setResults(r.slice(0, 20));
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
  }, [query, groups]);

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
  // room above is only window − keyboard − navigation header − this box's own
  // chrome (group filter + input); a fixed max height could run the first
  // rows in under the header (GLORIA unit screens, small phones), so cap it.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const [chromeHeight, setChromeHeight] = useState(0);
  const listCap =
    !dropdown && keyboardHeight > 0
      ? Math.max(96, windowHeight - (topLimit ?? headerHeight) - keyboardHeight - chromeHeight - 8)
      : undefined;

  const suggestions =
    results.length > 0 ? (
      <View
        className={`${dropdown ? 'max-h-56 border-t' : 'max-h-72 border-b'} border-gray-100 dark:border-gray-800`}
        style={listCap != null ? { maxHeight: Math.min(288, listCap) } : undefined}
      >
        <FlatList
          data={results}
          keyExtractor={getResultKey}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews
          renderItem={({ item }) => (
            <AutocompleteRow
              result={item}
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
            className="flex-row items-center rounded-full bg-blue-50 px-3 py-1.5 active:bg-blue-100 dark:bg-blue-950/40 dark:active:bg-blue-900/60"
          >
            <Ionicons name="earth-outline" size={14} color="#2563eb" />
            <Text className="ml-1 text-xs font-medium text-blue-700 dark:text-blue-300">
              {t('search.lookupGbif')}
            </Text>
          </Pressable>
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
        </View>
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
    <View className="flex-row items-center px-2 py-2">
      <View className="flex-1 flex-row items-center rounded-full bg-gray-100 px-3 py-2 dark:bg-gray-800">
        <Ionicons name="search" size={18} color="#6b7280" />
        <TextInput
          ref={inputRef}
          className="ml-2 flex-1 text-base text-gray-900 dark:text-gray-100"
          placeholder={t('search.placeholder')}
          placeholderTextColor="#9ca3af"
          value={query}
          onChangeText={setQuery}
          autoFocus={autoFocus}
          onFocus={onFocus}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color="#9ca3af" />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View
      className={`${dropdown ? '' : 'border-t border-gray-200 dark:border-gray-700'} bg-white dark:bg-gray-900`}
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
  onPress,
  onLongPress,
  onAdopt,
}: {
  result: SearchResult;
  onPress: () => void;
  onLongPress?: () => void;
  onAdopt: () => void;
}) {
  const { t } = useTranslation();
  const isSynonym = !!result.matched_as;
  const isFuzzy = !!result.fuzzy_match;
  const isEndemic = result.endemic === 1;
  const ab = alienBadge(result.alien_type, result.kingdom);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className="border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 active:bg-blue-50 dark:active:bg-blue-900/40"
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
        ) : null}
      </View>
      {result.matched_as ? (
        // Tappable: the checklist calls this name not-accepted, but that is an
        // opinion the recorder may not share. Sits inside the row's Pressable,
        // so it needs its own generous hit area and a visible affordance —
        // this is used one-handed in the field.
        <Pressable
          onPress={onAdopt}
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
          <Ionicons name="chevron-forward" size={12} color="#c2410c" />
        </Pressable>
      ) : null}
      {result.family_cname || result.family ? (
        <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {result.family_cname} {result.family}
        </Text>
      ) : null}
    </Pressable>
  );
});
