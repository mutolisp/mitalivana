/**
 * One fact about the record in progress — project, place, time, surveyor —
 * as a tappable chip (02-components.md): 採集 and a new GLORIA survey. The
 * checklist screens moved theirs into ⋯ (記錄資訊, 2026-10-07).
 *
 * Unset is drawn dashed and grey, so what is still missing before the survey
 * ends is visible at a glance. `live` is track recording: red, like the
 * recorder's own badge.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function ContextChip({
  icon,
  label,
  set,
  tone = 'default',
  onPress,
  missing,
  missingLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  /** The value when set, the prompt when not (e.g. 調查者未填). */
  label: string;
  set: boolean;
  tone?: 'default' | 'live';
  onPress: () => void;
  /** A red dot: something required is not filled in (調查資料, 2G-e). Its words go in `missingLabel`. */
  missing?: boolean;
  missingLabel?: string;
}) {
  const c = useThemeColors();
  const live = tone === 'live';
  const iconColor = live ? c.alert : set ? c.cupule : c.ink3;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={missing && missingLabel ? `${label}, ${missingLabel}` : label}
      className={`flex-row items-center rounded-xl px-3 active:bg-gray-100 dark:active:bg-gray-800 ${
        set || live
          ? 'border border-line bg-card dark:border-line-dark dark:bg-card-dark'
          : 'border-[1.5px] border-dashed border-gray-300 dark:border-gray-600'
      }`}
      style={{ minHeight: 44 }}
    >
      <Ionicons name={live ? 'radio' : icon} size={18} color={iconColor} />
      <Text
        numberOfLines={1}
        className={`ml-1.5 text-xs ${
          live
            ? 'font-medium text-alert dark:text-alert-dark'
            : set
              ? 'font-medium text-ink dark:text-gray-100'
              : 'text-gray-500 dark:text-gray-400'
        }`}
        style={{ maxWidth: 180 }}
      >
        {label}
      </Text>
      {missing ? <View className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-alert dark:bg-alert-dark" /> : null}
    </Pressable>
  );
}
