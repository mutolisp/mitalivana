/**
 * The round buttons floating over the map tab (search, tools, locate) and the
 * labelled rows a round button opens into. Shared with casual mode's map,
 * whose basemap button opens the same way.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';

import { useThemeColors } from '~/theme/colors';

export function FabButton({
  icon,
  onPress,
  accent = false,
  a11yLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accent?: boolean;
  /** Required in practice for the icon-only buttons: a glyph alone tells a
   *  screen reader nothing. */
  a11yLabel?: string;
}) {
  const { overlayIcon, accent: overlayAccent } = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      className="h-11 w-11 items-center justify-center rounded-full bg-card shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Ionicons name={icon} size={20} color={accent ? overlayAccent : overlayIcon} />
    </Pressable>
  );
}

export function FabRow({
  icon,
  label,
  onPress,
  accent = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  accent?: boolean;
}) {
  const { overlayIcon, accent: overlayAccent } = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      className="mt-2 flex-row items-center rounded-full bg-card px-3 py-2 shadow-md active:bg-gray-100 dark:bg-gray-900/95 dark:active:bg-gray-700"
    >
      <Text
        className={`mr-2 text-xs font-medium ${accent ? 'text-accent-700 dark:text-accent-300' : 'text-gray-700 dark:text-gray-300'}`}
      >
        {label}
      </Text>
      <Ionicons name={icon} size={18} color={accent ? overlayAccent : overlayIcon} />
    </Pressable>
  );
}
