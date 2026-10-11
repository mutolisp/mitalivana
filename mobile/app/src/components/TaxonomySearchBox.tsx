import { Ionicons } from '@expo/vector-icons';
import { memo, useEffect, useRef, useState } from 'react';
import i18next from '~/i18n';
import { useTranslation } from 'react-i18next';
import { FlatList, Keyboard, Pressable, Text, TextInput, View } from 'react-native';
import { INCOMPLETE_PHYLUM, searchTaxonomy, type TaxonSearchHit } from '~/db';
import { rankColor } from '~/lib/rankColors';
import { ScientificName } from './ScientificName';
import { useThemeColors } from '~/theme/colors';

const DEBOUNCE_MS = 250;

type Props = {
  onPick: (hit: TaxonSearchHit) => void;
};

export function TaxonomySearchBox({ onPick }: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaxonSearchHit[]>([]);
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      try {
        setResults(searchTaxonomy(trimmed));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[TaxonomySearchBox] search failed:', e);
        setResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handlePick = (hit: TaxonSearchHit) => {
    // Clear the child state first (including the native input value synchronously)
    // and dismiss the keyboard, then defer the parent's expand + scroll work to the
    // next frame. Otherwise onPick synchronously triggers a storm of parent
    // setState (setExpanded / setNodeMap / setChildrenMap / setSpeciesMap /
    // setSetting writing to SQLite + a scheduled setTimeout), and on a real device
    // the child's setQuery('') / setResults([]) occasionally had no visible effect
    // after that batch.
    setResults([]);
    setQuery('');
    inputRef.current?.clear();
    Keyboard.dismiss();
    requestAnimationFrame(() => onPick(hit));
  };

  return (
    <View className="border-t border-gray-200 dark:border-gray-700 bg-card dark:bg-gray-900">
      {results.length > 0 ? (
        <View className="max-h-60 border-b border-gray-100 dark:border-gray-800">
          <FlatList
            data={results}
            keyExtractor={(r, i) => `${r.rank}:${r.name}:${i}`}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={8}
            maxToRenderPerBatch={6}
            windowSize={5}
            removeClippedSubviews
            renderItem={({ item }) => <HitRow hit={item} onPress={() => handlePick(item)} />}
          />
        </View>
      ) : null}
      <View className="flex-row items-center px-2 py-2">
        <View className="flex-1 flex-row items-center rounded-full bg-gray-100 dark:bg-gray-800 px-3 py-2">
          <Ionicons name="search" size={18} color={c.ink2} />
          <TextInput
            ref={inputRef}
            className="ml-2 flex-1 text-base text-gray-900 dark:text-gray-100"
            placeholder={t('search.taxonomyPlaceholder')}
            placeholderTextColor={c.ink3}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={c.ink3} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const HitRow = memo(function HitRow({ hit, onPress }: { hit: TaxonSearchHit; onPress: () => void }) {
  const { t } = useTranslation();
  // The incomplete bucket's name is a sentinel, never shown (as in the tree).
  const pathPreview = hit.path.map((p) => (p.value === INCOMPLETE_PHYLUM ? t('taxonomy.incompleteBucket') : p.value)).join(' › ');
  const c = rankColor(hit.rank);
  const isSynonym = !!hit.matched_as;
  const isFuzzy = !!hit.fuzzy_match;
  return (
    <Pressable onPress={onPress} className="border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 active:bg-accent-50 dark:active:bg-accent-900/40">
      <View className="flex-row items-center">
        <Text className="flex-1 text-sm text-gray-900 dark:text-gray-100" numberOfLines={1}>
          {isSynonym ? <Text className="text-orange-600">≡ </Text> : null}
          {isFuzzy ? <Text className="text-purple-600">~ </Text> : null}
          {hit.cname ? <Text className="font-medium">{hit.cname} </Text> : null}
          <ScientificName name={hit.name} rank={hit.rank} />
        </Text>
        <View className={`ml-2 rounded px-1.5 py-0.5 ${c.bg}`}>
          <Text className={`text-[10px] font-medium ${c.text}`}>
            {i18next.exists(`rank.${hit.rank.toLowerCase()}`)
              ? t(`rank.${hit.rank.toLowerCase()}`)
              : hit.rank}
          </Text>
        </View>
      </View>
      {hit.matched_as ? (
        <Text className="mt-0.5 text-[11px] text-orange-700 dark:text-orange-300" numberOfLines={1}>
          {t('search.youEntered')}
          {hit.matched_as.vernacular ? hit.matched_as.name : <ScientificName name={hit.matched_as.name} rank={hit.rank} />}
          {t('search.synonymStatus', { status: hit.matched_as.status })}
        </Text>
      ) : null}
      {pathPreview ? (
        <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {pathPreview}
        </Text>
      ) : null}
    </Pressable>
  );
});
