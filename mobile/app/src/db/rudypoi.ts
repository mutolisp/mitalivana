/**
 * 魯地圖 POI —— 第四個資料庫，隨離線地圖包一起安裝。
 *
 * 這是**上游原檔**（`MOI_OSM_Taiwan_TOPO_Rudy.poi`，766,737 筆），刻意不在
 * desktop 端做篩選或轉檔：schema 本來就有 lat/lon 索引，實測一個 z14 視窗的
 * 查詢在桌面端是 1–17 ms，篩選放在查詢端就好，少一層要維護的產物。
 *
 * **但上游有 36% 不是 POI**：`03 步道/山徑` 164,742 筆裡 118,698 筆是
 * `highway=footway`、`06 溪流/水源/瀑布` 111,602 筆裡 58,342 筆是 `natural=water`
 * —— 那是 way 被索引成點（上游 metadata 寫 `ways = true`），只有 11% 有名字，
 * 畫在地圖上是純雜訊。所以**一定要帶分類條件查**，不要無條件 bbox 查詢。
 *
 * 與 `regionpacks.db` 一樣是可丟棄的參考資料：不進 user.db、不進備份、
 * 存在 documents/poi/ 底下，可在「離線地圖」設定頁單獨刪除。
 */
import { open, type DB } from '@op-engineering/op-sqlite';

import { poiLocation } from '~/lib/poi';

let poiDb: DB | null = null;
let openedFor: string | null = null;

export type RudyPoi = {
  id: number;
  lat: number;
  lon: number;
  /** 原始 OSM tags，`key=value` 以 CR 分隔（上游格式，未轉換）。 */
  data: string;
};

export type PoiBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

/**
 * 顯示群組。分類 id 在每台裝置上都一樣（來自同一份上游檔），但仍以**名稱**
 * 解析，因為上游改版時 id 可能重編而名稱穩定。
 *
 * `tagAny` 是給「整個分類大多是雜訊、只有少數是真 POI」的情況用的：
 * `06 溪流/水源/瀑布` 有 111,602 筆，其中野外真的能取水的只有 3,714 筆。
 */
export type PoiGroup = {
  key: string;
  /** i18n key。 */
  labelKey: string;
  /** 這些分類（含子分類）底下的 POI。 */
  categories: string[];
  /** 有給的話，還要 tags 命中其中一個才收。 */
  tagAny?: string[];
};

export const POI_GROUPS: PoiGroup[] = [
  { key: 'peaks', labelKey: 'poi.groupPeaks', categories: ['01 山頭'] },
  { key: 'marks', labelKey: 'poi.groupMarks', categories: ['02 標石(基點)'] },
  { key: 'signs', labelKey: 'poi.groupSigns', categories: ['04 登山標誌'] },
  { key: 'huts', labelKey: 'poi.groupHuts', categories: ['05 山屋/營地', '涼亭'] },
  {
    key: 'water',
    labelKey: 'poi.groupWater',
    categories: ['06 溪流/水源/瀑布'],
    tagAny: [
      'amenity=drinking_water',
      'waterway=waterfall',
      'natural=hot_spring',
      'man_made=water_tap',
    ],
  },
  { key: 'scenic', labelKey: 'poi.groupScenic', categories: ['07 保護區/景點/觀景台'] },
  { key: 'trees', labelKey: 'poi.groupTrees', categories: ['08 台灣巨木'] },
];

/** 圖磚包沒裝、或這一版 pack 沒有 POI 時回 null，呼叫端不該當成錯誤。 */
export function getPoiDb(): DB | null {
  const loc = poiLocation();
  if (!loc) {
    closePoiDb();
    return null;
  }
  const key = `${loc.location}/${loc.name}`;
  if (poiDb && openedFor === key) return poiDb;
  closePoiDb();
  poiDb = open({ name: loc.name, location: loc.location });
  openedFor = key;
  return poiDb;
}

export function closePoiDb(): void {
  poiDb?.close();
  poiDb = null;
  openedFor = null;
}

let categoryCache: Map<string, number[]> | null = null;

/** 分類名 → 該分類與其所有子分類的 id。 */
function categoryIds(db: DB, names: string[]): number[] {
  if (!categoryCache) {
    const res = db.executeSync('SELECT id, name, parent FROM poi_categories');
    const rows = (res.rows ?? []) as unknown as
      { id: number; name: string; parent: number | null }[];
    const children = new Map<number, number[]>();
    const byName = new Map<string, number>();
    for (const r of rows) {
      byName.set(r.name, r.id);
      if (r.parent != null) {
        const list = children.get(r.parent) ?? [];
        list.push(r.id);
        children.set(r.parent, list);
      }
    }
    categoryCache = new Map();
    for (const [name, id] of byName) {
      const out: number[] = [];
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        out.push(cur);
        for (const c of children.get(cur) ?? []) stack.push(c);
      }
      categoryCache.set(name, out);
    }
  }
  return names.flatMap((n) => categoryCache!.get(n) ?? []);
}

/**
 * 查視窗內的 POI。
 *
 * 由 bbox 驅動（`poi_index_idx_lat` / `_lon` 是上游就有的索引），分類條件走
 * `EXISTS` 子查詢命中 `poi_category_map` 的 (id, category) 主鍵索引。
 * 反過來以分類驅動會全表掃 —— 那個主鍵的前綴是 id 不是 category。
 */
export function queryPoisInBounds(
  bounds: PoiBounds,
  groupKeys: string[],
  limit = 300,
): RudyPoi[] {
  const db = getPoiDb();
  if (!db || groupKeys.length === 0) return [];

  const out: RudyPoi[] = [];
  const seen = new Set<number>();
  for (const group of POI_GROUPS) {
    if (!groupKeys.includes(group.key)) continue;
    const ids = categoryIds(db, group.categories);
    if (ids.length === 0) continue;

    const tagClause = group.tagAny?.length
      ? ` AND (${group.tagAny.map(() => 'd.data LIKE ?').join(' OR ')})`
      : '';
    const sql =
      `SELECT i.id, i.lat, i.lon, d.data FROM poi_index i ` +
      `JOIN poi_data d ON d.id = i.id ` +
      `WHERE i.lat BETWEEN ? AND ? AND i.lon BETWEEN ? AND ? ` +
      `AND EXISTS (SELECT 1 FROM poi_category_map m WHERE m.id = i.id ` +
      `AND m.category IN (${ids.map(() => '?').join(',')}))` +
      tagClause +
      ` LIMIT ?`;
    const params = [
      bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon,
      ...ids,
      ...(group.tagAny ?? []).map((t) => `%${t}%`),
      limit,
    ];
    const res = db.executeSync(sql, params);
    const rows = (res.rows ?? []) as unknown as RudyPoi[];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 上游把 tag 以 CR（0x0D）分隔存成 `key=value`。 */
export function parsePoiTags(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of data.split('\r')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

export function poiDisplayName(tags: Record<string, string>): string | null {
  return tags.name ?? tags['name:zh'] ?? tags['name:en'] ?? null;
}
