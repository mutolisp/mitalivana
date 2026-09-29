/**
 * − n ＋ for an individual count (02-components.md). Only for records whose
 * quantity type is empty or `individuals`; other abundance types keep their
 * own editor.
 *
 * Empty shows "—" and − is disabled. From "—", ＋ gives 1; from 1, − goes back
 * to EMPTY (null), not 0: in Darwin Core a 0 says "looked, found none", which
 * is a different statement from "not counted".
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function CountStepper({
  value,
  onChange,
  size = 'row',
  unitLabel,
  accessibilityName,
}: {
  /** null = presence only. */
  value: number | null;
  onChange: (next: number | null) => void;
  /** row: 44 buttons in a pill; detail: 52 round buttons, large figure. */
  size?: 'row' | 'detail';
  /** detail only, e.g. 個體數. */
  unitLabel?: string;
  /** The species, for the buttons' screen-reader labels. */
  accessibilityName: string;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const empty = value == null || value <= 0;
  const step = (dir: -1 | 1) => {
    void Haptics.selectionAsync();
    if (dir === 1) onChange(empty ? 1 : value + 1);
    else if (!empty) onChange(value === 1 ? null : value - 1);
  };
  const figure = (
    <Text
      className={`text-center font-bold text-gray-900 dark:text-gray-100 ${size === 'detail' ? 'text-3xl' : 'text-lg'}`}
      style={{ fontVariant: ['tabular-nums'], minWidth: size === 'detail' ? 56 : 28 }}
      accessibilityLabel={empty ? t('count.presenceOnly') : String(value)}
    >
      {empty ? '—' : value}
    </Text>
  );

  if (size === 'detail') {
    return (
      <View className="flex-row items-center justify-center gap-5">
        <Pressable
          onPress={() => step(-1)}
          disabled={empty}
          accessibilityRole="button"
          accessibilityLabel={t('count.decrease', { name: accessibilityName })}
          accessibilityState={{ disabled: empty }}
          className={`h-[52px] w-[52px] items-center justify-center rounded-full border border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800 ${empty ? 'opacity-40' : ''}`}
        >
          <Ionicons name="remove" size={26} color={c.ink} />
        </Pressable>
        <View className="items-center">
          {figure}
          {unitLabel ? <Text className="text-xs text-gray-500 dark:text-gray-400">{unitLabel}</Text> : null}
        </View>
        <Pressable
          onPress={() => step(1)}
          accessibilityRole="button"
          accessibilityLabel={t('count.increase', { name: accessibilityName })}
          className="h-[52px] w-[52px] items-center justify-center rounded-full bg-accent-600 active:bg-accent-700 dark:bg-accent-400 dark:active:bg-accent-300"
        >
          <Ionicons name="add" size={26} color={c.onAccent} />
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-row items-center rounded-full border border-line bg-card dark:border-line-dark dark:bg-card-dark">
      <Pressable
        onPress={() => step(-1)}
        disabled={empty}
        accessibilityRole="button"
        accessibilityLabel={t('count.decrease', { name: accessibilityName })}
        accessibilityState={{ disabled: empty }}
        className={`h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800 ${empty ? 'opacity-40' : ''}`}
      >
        <Ionicons name="remove" size={20} color={c.ink2} />
      </Pressable>
      {figure}
      <Pressable
        onPress={() => step(1)}
        accessibilityRole="button"
        accessibilityLabel={t('count.increase', { name: accessibilityName })}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
      >
        <Ionicons name="add" size={20} color={c.accent} />
      </Pressable>
    </View>
  );
}
