/**
 * Pill button — the app's in-content / toolbar button.
 *
 * Distinct from `HeaderIconButton` (the circular disc) on purpose: that one
 * belongs to the navigation header, this one sits in a screen's own toolbar,
 * where a pill can carry a word and does not have to compete with the title.
 *
 * Neutral by default. The colour used to vary per screen — new checklist and
 * import were blue, sort grey, the favourites entry amber — which made every
 * toolbar look like it had one important button and some leftovers. Tinting now
 * means something: it is reserved for `favorite`, the favourites colour.
 *
 * 44 tall for real (an icon-only pill is 44 × 44), not a 30 pt pill padded out
 * with hitSlop: this is a field app, used with gloves.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';

import { useThemeColors, type ThemeColors } from '~/theme/colors';

const TONE = {
  neutral: {
    box: 'border-line bg-card active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800',
    icon: 'ink2',
    text: 'text-ink-2 dark:text-gray-300',
  },
  favorite: {
    box: 'border-acorn-tint bg-acorn-tint active:bg-acorn/30 dark:border-gray-700 dark:bg-gray-800 dark:active:bg-gray-700',
    icon: 'acornDeep',
    text: 'text-acorn-deep dark:text-acorn',
  },
} as const satisfies Record<string, { box: string; icon: keyof ThemeColors; text: string }>;

export function PillButton({
  icon,
  label,
  a11yLabel,
  onPress,
  tone = 'neutral',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  /** Visible text. Omit for an icon-only pill — then `a11yLabel` is required. */
  label?: string;
  /** Screen-reader name; defaults to `label`. */
  a11yLabel?: string;
  onPress: () => void;
  tone?: keyof typeof TONE;
}) {
  const c = useThemeColors();
  const t = TONE[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      className={`flex-row items-center justify-center rounded-full border ${label ? 'px-3.5' : ''} ${t.box}`}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      <Ionicons name={icon} size={18} color={c[t.icon]} />
      {label ? <Text className={`ml-1 text-sm font-medium ${t.text}`}>{label}</Text> : null}
    </Pressable>
  );
}
