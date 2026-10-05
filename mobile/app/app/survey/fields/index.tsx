/**
 * 自訂欄位庫 (six-item plan C, 2026-10-04): the app's own fields, after
 * iNaturalist's observation fields, to add to any template. Searchable by
 * name, English name and key, filtered by data type; each row says what it
 * takes and how many templates use it. Deprecated fields are listed apart.
 */
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import { ListRow } from '~/components/ui/ListRow';
import { BackHeaderLeft } from '~/lib/goBack';
import { useThemeColors } from '~/theme/colors';
import { fieldHref } from '~/survey/builder/fieldReturn';
import { datatypeName, fieldSummary } from '~/survey/builder/words';
import { fieldUseCounts, listFields, type ObsFieldRow } from '~/survey/db/surveys';
import { FIELD_DATATYPES, type FieldDatatype } from '~/survey/template/obsField';

const load = () => ({ rows: listFields({ deprecated: true }), uses: fieldUseCounts() });

export default function FieldLibraryScreen() {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  const lang = i18n.language;
  const [data, setData] = useState(load);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<FieldDatatype | null>(null);
  const [showDeprecated, setShowDeprecated] = useState(false);
  useFocusEffect(useCallback(() => setData(load()), []));

  const q = query.trim().toLowerCase();
  const matches = (r: ObsFieldRow) =>
    (!type || r.def.datatype === type) && (!q || [r.def.name, r.def.name_en ?? '', r.def.key, r.def.description ?? ''].some((x) => x.toLowerCase().includes(q)));
  const live = data.rows.filter((r) => !r.deprecated && matches(r));
  const old = data.rows.filter((r) => r.deprecated && matches(r));
  const row = (r: ObsFieldRow, i: number, all: ObsFieldRow[]) => {
    const n = data.uses.get(r.def.key) ?? 0;
    return (
      <ListRow
        key={r.def.key}
        title={r.def.name_en ? t('common.withParen', { main: r.def.name, extra: r.def.name_en }) : r.def.name}
        meta={[fieldSummary(t, lang, r.def), r.def.key, n ? t('fieldLib.usedBy', { count: n }) : t('fieldLib.unused')].join(' · ')}
        onPress={() => router.push(fieldHref(r.def.key))}
        divider={i < all.length - 1}
      />
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('fieldLib.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="pb-6" keyboardShouldPersistTaps="handled">
        <Text className="px-4 pt-3 text-xs leading-5 text-ink-2 dark:text-gray-400">{t('fieldLib.intro')}</Text>
        <View className="mx-4 mt-3 flex-row items-center rounded-full border border-line bg-card px-3 dark:border-line-dark dark:bg-card-dark" style={{ minHeight: 44 }}>
          <Ionicons name="search" size={18} color={c.ink2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('fieldLib.search')}
            placeholderTextColor={c.ink3}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={t('fieldLib.search')}
            className="ml-2 flex-1 py-2 text-base text-ink dark:text-gray-100"
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4 pt-3">
          <Chip label={t('fieldLib.allTypes')} selected={type == null} onPress={() => setType(null)} />
          {FIELD_DATATYPES.map((dt) => (
            <Chip key={dt} label={datatypeName(t, dt)} selected={type === dt} onPress={() => setType(type === dt ? null : dt)} />
          ))}
        </ScrollView>
        {live.length ? (
          <View className="mt-3 border-y border-line dark:border-line-dark">{live.map((r, i) => row(r, i, live))}</View>
        ) : (
          <Text className="px-4 pt-4 text-sm leading-5 text-ink-3 dark:text-gray-400">{data.rows.length ? t('fieldLib.noMatch') : t('fieldLib.empty')}</Text>
        )}
        {old.length ? (
          <>
            <Pressable onPress={() => setShowDeprecated(!showDeprecated)} accessibilityRole="button" className="px-4 pb-1.5 pt-5" style={{ minHeight: 44 }}>
              <Text className="text-xs font-bold text-accent-700 dark:text-accent-300">
                {showDeprecated ? t('fieldLib.hideDeprecated') : t('fieldLib.showDeprecated', { count: old.length })}
              </Text>
            </Pressable>
            {showDeprecated ? <View className="border-y border-line dark:border-line-dark">{old.map((r, i) => row(r, i, old))}</View> : null}
          </>
        ) : null}
      </ScrollView>
      <View className="border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
        <Button label={t('fieldLib.newField')} icon="add" onPress={() => router.push(fieldHref())} />
      </View>
    </SafeAreaView>
  );
}
