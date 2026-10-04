import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { useThemeColors } from '~/theme/colors';

/**
 * Two-line navigation-bar title: the plot id over the live diversity one-liner
 * (the fixed plot, and a plot-style survey drawn with its screen, 2G-d).
 * Tapping it toggles the expanded stats card in the species list — that card's
 * own collapsed row used to live above the list and cost 33pt there.
 *
 * Sizes are pinned in `style`, not via `text-sm` / `text-xs`: those resolve
 * through FontScaleProvider, and at the largest font scale two scaled lines
 * would overflow the native header's fixed height. The collection screen's
 * custom title pins its size for the same reason. The trade is deliberate —
 * every number here is also printed at full size one tap away.
 */
export function PlotHeaderTitle({
  plotid,
  stats,
  expanded,
  onToggle,
}: {
  plotid: string;
  stats: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();

  if (stats === null) {
    return (
      <Text
        className="font-semibold text-gray-900 dark:text-gray-100"
        style={{ fontSize: 17, maxWidth: 200 }}
        numberOfLines={1}
      >
        {plotid}
      </Text>
    );
  }

  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('plotStats.title')}
      accessibilityState={{ expanded }}
      className="items-center active:opacity-60"
    >
      <Text
        className="font-semibold text-gray-900 dark:text-gray-100"
        style={{ fontSize: 15, lineHeight: 18, maxWidth: 200 }}
        numberOfLines={1}
      >
        {plotid}
      </Text>
      <View className="flex-row items-center">
        <Text
          className="text-emerald-700 dark:text-emerald-300"
          style={{ fontSize: 11, lineHeight: 14, maxWidth: 184 }}
          numberOfLines={1}
        >
          {stats}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={11}
          color={c.accent}
          style={{ marginLeft: 3 }}
        />
      </View>
    </Pressable>
  );
}
