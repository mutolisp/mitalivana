/**
 * 地圖比例尺。
 *
 * 自己畫而不是用 `<MapView showsScale>`：那個 prop 是 **iOS Apple Maps 專用、
 * Android 完全不支援**（react-native-maps MapView.types.ts:627-628），而且 iOS 的
 * 只在縮放手勢期間短暫出現。野外判讀距離需要常駐、兩平台一致的比例尺。
 *
 * 更新時機跟著 `onRegionChangeComplete`（一次手勢一次），與點位聚合同一個
 * granularity。改用 `onRegionChange` 會在拖曳過程中每幀重算，不值得。
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';

/** 赤道上一度經度的公尺數。 */
const METERS_PER_DEGREE = 111_320;
/** 比例尺的最大像素長度，超過就換下一個較小的整數距離。 */
const MAX_BAR_PX = 110;
/** 只用這些「好看的」距離，避免出現 137 m 這種刻度。 */
const NICE_METERS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
  100_000, 200_000, 500_000, 1_000_000,
];

export type ScaleRegion = {
  latitude: number;
  longitudeDelta: number;
};

/** 回傳 (距離公尺, 對應的像素寬度)；無法計算時回 null。 */
export function pickScale(
  region: ScaleRegion,
  screenWidthPx: number,
): { meters: number; px: number } | null {
  if (!(screenWidthPx > 0) || !(region.longitudeDelta > 0)) return null;
  // 經線間距隨緯度收斂，臺灣約 23°N → cos ≈ 0.92，不修正會高估 8%。
  const groundWidth =
    region.longitudeDelta * METERS_PER_DEGREE * Math.cos((region.latitude * Math.PI) / 180);
  if (!(groundWidth > 0)) return null;
  const metersPerPx = groundWidth / screenWidthPx;

  // 由大到小挑第一個畫得下的距離，這樣比例尺會盡量長、讀數比較準。
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
