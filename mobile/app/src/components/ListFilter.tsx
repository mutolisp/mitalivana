/**
 * Finding a species in a record's own list (快速名錄, 穿越線／定點計數／固定樣區,
 * 調查表): a magnifier at the start of the filter row opens a field that takes
 * the chips' place; ✕ clears it and brings them back. Not always on: the box
 * docked at the bottom is the one that adds species, and two standing search
 * boxes on one screen read as the same thing. Matching is
 * `speciesMatches()` in src/lib/recordSearch.ts.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function ListFilterButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t('speciesFilter.open')}
      className="ml-1 h-9 w-9 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
    >
      <Ionicons name="search" size={18} color={c.ink2} />
    </Pressable>
  );
}

export function ListFilterField({
  value,
  onChangeText,
  onClose,
}: {
  value: string;
  onChangeText: (q: string) => void;
  /** Clears the query and closes the field. */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <View
      className="mx-2 my-1.5 flex-1 flex-row items-center rounded-full bg-gray-100 pl-3 pr-1 dark:bg-gray-800"
      style={{ minHeight: 36 }}
    >
      <Ionicons name="search" size={16} color={c.ink3} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoFocus
        placeholder={t('speciesFilter.placeholder')}
        placeholderTextColor={c.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={t('speciesFilter.open')}
        className="ml-2 flex-1 py-1.5 text-sm text-gray-900 dark:text-gray-100"
      />
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        className="h-8 w-8 items-center justify-center rounded-full active:opacity-60"
      >
        <Ionicons name="close-circle" size={18} color={c.ink3} />
      </Pressable>
    </View>
  );
}
