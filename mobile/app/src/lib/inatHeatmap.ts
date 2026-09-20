/**
 * iNaturalist 觀察網格圖的模式決策與瓦片 URL。
 *
 * 純模組——不 import Expo / DB / i18n，所以 `scripts/check-inat-heatmap.mjs` 能在
 * 純 Node 下直接驗（與 `inatPayload.ts` / `inatJwt.ts` 同一種切法）。網路與快取分別
 * 在 `useInatGrid.ts` 與 `src/db/inatTaxonMap.ts`。
 *
 * **為什麼是 `grid` 而不是 `heatmap`**：這層疊在 184px 高的小地圖上，方格聚合在這個
 * 尺寸下比模糊暈染易讀得多，而且實測單張 2,835 B vs 39,026 B——野外的流量與電力都
 * 省一個數量級。四種樣式（grid / heatmap / colored_heatmap / points）端點形狀相同，
 * 要換只改 `STYLE`。
 *
 * **`{z}/{x}/{y}` 必須原樣留在字串裡**：這是給 react-native-maps `UrlTile` 與
 * MapLibre `RasterSource` 的樣板，代入實際數字就是把圖層寫死在一格上。
 */

/**
 * 要畫哪一批觀察。
 *
 * - `wild`：排除圈養／栽培（`captive=false`）。野外調查看的是自然分布，植物園、
 *   行道樹、寵物的紀錄會誤導判讀，所以這是預設。
 * - `all`：不過濾。**只在該物種野外筆數為 0、但總筆數 > 0 時才用**——這種物種
 *   （例如只有栽培紀錄的觀賞植物）若套 `captive=false` 會得到一張全空的圖，
 *   看起來像功能壞掉。此時改畫全部，並由 UI 明講「僅有圈養或栽培紀錄」。
 * - `none`：iNat 上完全沒有資料，不要掛圖層。
 */
export type HeatmapMode = 'wild' | 'all' | 'none';

const TILE_BASE = 'https://api.inaturalist.org/v1/grid/{z}/{x}/{y}.png';

/** 查詢結果的重驗間隔。筆數變舊只是顯示誤差，不值得每次開圖都上網。 */
export const INAT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isInatCacheStale(checkedAt: number, now: number = Date.now()): boolean {
  return !Number.isFinite(checkedAt) || now - checkedAt > INAT_CACHE_TTL_MS;
}

/**
 * 依野外／總筆數決定要畫什麼。
 *
 * `obsTotal` 只有在 `obsWild === 0` 時才被看——野外有資料時我們根本沒去問總數
 * （省一次請求），呼叫端會傳 0 或 null 進來，那不影響結果。
 */
export function pickHeatmapMode(obsWild: number, obsTotal: number): HeatmapMode {
  if (obsWild > 0) return 'wild';
  if (obsTotal > 0) return 'all';
  return 'none';
}

/** 瓦片樣板。`mode === 'none'` 或 id 不合法時回 null，呼叫端就不掛圖層。 */
export function gridTileUrl(inatTaxonId: number, mode: HeatmapMode): string | null {
  if (mode === 'none') return null;
  if (!Number.isInteger(inatTaxonId) || inatTaxonId <= 0) return null;
  const captive = mode === 'wild' ? '&captive=false' : '';
  return `${TILE_BASE}?taxon_id=${inatTaxonId}${captive}`;
}
