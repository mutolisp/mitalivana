/**
 * Map scale bar.
 *
 * Drawn by hand rather than via `<MapView showsScale>`: that prop is **iOS Apple
 * Maps only and entirely unsupported on Android** (react-native-maps
 * MapView.types.ts:627-628), and even on iOS it appears only briefly during a
 * zoom gesture. Judging distance in the field needs a permanent scale bar that
 * is the same on both platforms.
 *
 * It updates with `onRegionChangeComplete` (once per gesture), the same
 * granularity as point clustering. Using `onRegionChange` would recompute every
 * frame of a drag, which is not worth it.
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';

/** Metres per degree of longitude at the equator. */
const METERS_PER_DEGREE = 111_320;
/** Maximum pixel length of the bar; beyond it the next smaller round distance
 *  is used. */
const MAX_BAR_PX = 110;
/** Only these "tidy" distances, so the bar never reads something like 137 m. */
const NICE_METERS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
  100_000, 200_000, 500_000, 1_000_000,
];

export type ScaleRegion = {
  latitude: number;
  longitudeDelta: number;
};

/** Returns (distance in metres, matching pixel width), or null when it cannot
 *  be computed. */
export function pickScale(
  region: ScaleRegion,
  screenWidthPx: number,
): { meters: number; px: number } | null {
  if (!(screenWidthPx > 0) || !(region.longitudeDelta > 0)) return null;
  // Meridians converge with latitude; Taiwan is about 23°N → cos ≈ 0.92, so
  // skipping the correction overestimates by 8%.
  const groundWidth =
    region.longitudeDelta * METERS_PER_DEGREE * Math.cos((region.latitude * Math.PI) / 180);
  if (!(groundWidth > 0)) return null;
  const metersPerPx = groundWidth / screenWidthPx;

  // Take the largest distance that still fits, so the bar is as long as possible
  // and therefore easier to read accurately.
  for (let i = NICE_METERS.length - 1; i >= 0; i -= 1) {
    const meters = NICE_METERS[i]!;
    const px = meters / metersPerPx;
    if (px <= MAX_BAR_PX) return { meters, px };
  }
  return null;
}

export function formatScaleLabel(meters: number): string {
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}

export function MapScaleBar({
  region,
  screenWidth,
  bottom,
}: {
  region: ScaleRegion | null;
  screenWidth: number;
  bottom: number;
}) {
  const scale = useMemo(
    () => (region ? pickScale(region, screenWidth) : null),
    [region, screenWidth],
  );
  if (!scale || scale.px < 24) return null;

  return (
    <View
      pointerEvents="none"
      style={{ bottom }}
      className="absolute left-3 items-start rounded bg-white/75 px-1.5 py-1 dark:bg-black/60"
    >
      <Text className="mb-0.5 text-[10px] leading-3 text-gray-800 dark:text-gray-200">
        {formatScaleLabel(scale.meters)}
      </Text>
      {/* 兩端立柱 + 橫桿，讀起來比單純一條線明確 */}
      <View
        style={{ width: scale.px }}
        className="h-[6px] border-x-2 border-b-2 border-gray-800 dark:border-gray-200"
      />
    </View>
  );
}
