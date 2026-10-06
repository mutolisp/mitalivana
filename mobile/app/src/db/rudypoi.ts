/**
 * RudyMap POIs — the fourth database, installed with the offline map package.
 *
 * This is the **upstream source file** (`MOI_OSM_Taiwan_TOPO_Rudy.poi`, 766,737
 * rows), deliberately neither filtered nor converted on the desktop side: the
 * schema already has lat/lon indexes, a z14 viewport query measures 1-17 ms on
 * the desktop, so filtering belongs in the query and there is one fewer artefact
 * to maintain.
 *
 * **But 36% of upstream is not a POI**: of the 164,742 rows under
 * `03 步道/山徑`, 118,698 are `highway=footway`, and of the 111,602 under
 * `06 溪流/水源/瀑布`, 58,342 are `natural=water` — ways indexed as points
 * (upstream metadata says `ways = true`), only 11% of which have a name, and
 * pure noise on a map. So **always query with a category condition**, never an
 * unconditional bbox query.
 *
 * Like `regionpacks.db` this is disposable reference data: it does not go into
 * user.db, does not go into backups, lives under documents/poi/, and can be
 * deleted on its own from the offline map settings screen.
 */
import { open, type DB } from '@op-engineering/op-sqlite';
import { uriToPath } from '~/lib/uriPath';

import { poiLocation } from '~/lib/poi';

let poiDb: DB | null = null;
let openedFor: string | null = null;

export type RudyPoi = {
  id: number;
  lat: number;
  lon: number;
  /** Raw OSM tags, `key=value` separated by CR (the upstream format,
   *  unconverted). */
  data: string;
};

export type PoiBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

/**
 * Display groups. Category ids are the same on every device (they come from the
 * same upstream file), but they are still resolved **by name**, because an
 * upstream revision may renumber ids while names stay stable.
 *
 * `tagAny` is for the case where a whole category is mostly noise and only a few
 * rows are real POIs: `06 溪流/水源/瀑布` has 111,602 rows, of which only 3,714
 * are water you could actually collect in the field.
 */
export type PoiGroup = {
  key: string;
  /** i18n key。 */
  labelKey: string;
  /** POIs under these categories, subcategories included. */
  categories: string[];
  /** When given, tags must also match one of these for the row to count. */
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

/** Returns null when the tile package is not installed, or this pack version has
 *  no POIs; the caller must not treat that as an error. */
export function getPoiDb(): DB | null {
  const loc = poiLocation();
  if (!loc) {
    closePoiDb();
    return null;
  }
  const key = `${loc.location}/${loc.name}`;
  if (poiDb && openedFor === key) return poiDb;
  closePoiDb();
  poiDb = open({ name: loc.name, location: uriToPath(loc.location) });
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
