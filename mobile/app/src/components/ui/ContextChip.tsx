/**
 * One fact about the record in progress — project, place, time, surveyor —
 * as a tappable chip in the checklist's context strip (02-components.md).
 *
 * Unset is drawn dashed and grey, so what is still missing before the survey
 * ends is visible at a glance. `live` is track recording: red, like the
 * recorder's own badge.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function ContextChip({
  icon,
  label,
  set,
  tone = 'default',
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  /** The value when set, the prompt when not (e.g. 調查者未填). */
  label: string;
  set: boolean;
  tone?: 'default' | 'live';
  onPress: () => void;
}) {
  const c = useThemeColors();
  const live = tone === 'live';
  const iconColor = live ? c.alert : set ? c.cupule : c.ink3;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
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
    </Pressable>
  );
}
