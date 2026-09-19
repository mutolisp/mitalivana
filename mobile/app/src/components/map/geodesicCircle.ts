/**
 * 把「圓心 + 公尺半徑」轉成測地線多邊形。
 *
 * 為什麼需要：中性介面的 `circle` 是**公尺**（樣區的 `point_radius_m`、
 * `RecordLocationMap` 的 `reference.radiusM`），react-native-maps 的 `<Circle>`
 * 直接吃公尺，但 MapLibre 的 `circle-radius` 是**螢幕像素**，縮放時圓會跟著
 * 變大變小，語意完全不同。所以 MapLibre 端要自己把圓算成多邊形。
 *
 * 用球面模型（地球平均半徑），不是 WGS84 橢球。樣區半徑通常在幾十到幾百公尺，
 * 這個尺度下兩者差異遠小於 GPS 誤差。
 */

/** IUGG 平均地球半徑（公尺）。 */
const EARTH_RADIUS_M = 6_371_008.8;

/** 預設邊數。72 邊在手機螢幕上看不出稜角，又不會讓幾何肥大。 */
const DEFAULT_STEPS = 72;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * 回傳 GeoJSON Polygon 的外環（`[lng, lat]`，首尾相同）。
 *
 * 用標準的「大圓上給定方位角與距離求終點」公式，所以在高緯度與跨 180 度
 * 經線都成立 —— 單純用 `radiusM / 111320` 換算經緯度在臺灣看起來還行，
 * 但那是把圓畫成橢圓。
 */
export function geodesicCircle(
  lat: number,
  lng: number,
  radiusM: number,
  steps: number = DEFAULT_STEPS,
): [number, number][] {
  const angular = radiusM / EARTH_RADIUS_M;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angular);
  const cosAng = Math.cos(angular);

  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(bearing));
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2),
      );
    // 正規化到 -180..180，避免跨經線時產生 190 之類的值
    ring.push([((toDeg(lng2) + 540) % 360) - 180, toDeg(lat2)]);
  }
  ring.push(ring[0]!);
  return ring;
}
