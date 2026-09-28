/**
 * What a tapped map feature is, before deciding what to do with it.
 *
 * Tapping used to open the action sheet directly, which meant every stray
 * touch while reading the map presented "jump to record" / "go to this
 * location" / "edit position" and had to be dismissed. Long-press would be the
 * obvious alternative, but `react-native-maps` has no `onLongPress` on Marker,
 * Polyline or Polygon — only MapView has one, and it reports a coordinate rather
 * than the feature. So the split is tap → this card, the action button → the
 * sheet that already existed.
 *
 * Purely presentational: the caller has already localised every string, which
 * keeps the three feature kinds (plot survey / checklist / geographic site) from
 * leaking in here. Not a Modal — it sits over the map inside the same screen, so
 * the action sheet (a Modal on Android) can open from it without nesting.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { useTabBarInset } from '~/lib/tabBarLayout';
import { useThemeColors } from '~/theme/colors';

export type MapFeatureInfo = {
  title: string;
  subtitle: string;
  /** Extra detail lines; empty ones are dropped by the caller. */
  lines: string[];
  /** e.g. "recording" — shown as a pill when present. */
  badge: string | null;
  /** Colour of the pill and the accent bar, matching the feature on the map. */
  accentColor: string;
  onAction: () => void;
};

export function MapFeatureCard({
  info,
  onClose,
}: {
  info: MapFeatureInfo;
  onClose: () => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  // Sits above the floating tab bar, not just above the safe area — the bar
  // overlays the map rather than ending the scene above itself.
  const tabBarInset = useTabBarInset();

  return (
    <View
      className="absolute left-3 right-3 overflow-hidden rounded-2xl bg-card shadow-lg dark:bg-gray-900"
      style={{ bottom: tabBarInset + 12 }}
    >
      <View className="flex-row">
        {/* Ties the card to the shape that was tapped. */}
        <View style={{ width: 4, backgroundColor: info.accentColor }} />
        <View className="flex-1 px-4 py-3">
          <View className="flex-row items-center">
            <Text
              className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100"
              numberOfLines={1}
            >
              {info.title}
            </Text>
            {info.badge ? (
              <View
                className="ml-2 rounded-full px-2 py-0.5"
                style={{ backgroundColor: info.accentColor }}
              >
                <Text className="text-[11px] font-medium text-white">{info.badge}</Text>
              </View>
            ) : null}
            {/* Beside the close button rather than a full-width button below:
                the card is a glance at what was tapped, and a block of colour
                across the bottom read as the point of it. */}
            <Pressable
              onPress={info.onAction}
              hitSlop={10}
              accessibilityLabel={t('map.featureAction')}
              className="ml-2 h-7 w-7 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 dark:bg-gray-800 dark:active:bg-gray-700"
            >
              <Ionicons name="ellipsis-horizontal" size={16} color="#4b5563" />
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} className="ml-1 p-1">
              <Ionicons name="close" size={18} color={c.ink3} />
            </Pressable>
          </View>

          <Text className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{info.subtitle}</Text>
          {info.lines.map((line, i) => (
            <Text key={i} className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {line}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}
