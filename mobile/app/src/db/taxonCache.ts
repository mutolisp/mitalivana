/**
 * 記錄用到的名錄名稱，在 user.db 裡留一份。
 *
 * 名錄模組（臺灣 / 日本）拆成可下載、可刪除的檔之後，「記錄引用的 taxon 查不
 * 到名字」變成一個正常會發生的狀態：模組還沒下載、使用者刪掉它、或跨裝置還原
 * 到沒裝該模組的機器。沒有這一層，使用者會看到一整片只有數量與備註、沒有物種
 * 名的記錄。
 *
 * 這是 `ensureExternalCopy`（regionpacks.ts）那條不變式的雙生子，掛點也一樣
 * ——掛在四個 insert helper 自己身上，所以沒有任何 UI 路徑能忘記。
 *
 * **為什麼不直接沿用 `ensureExternalCopy`**：它會把 pack 的 taxon 轉存成
 * `external_taxa` 並鑄造一個**新的 `g…` id**。對 t…/y… 這樣做等於改寫記錄的
 * taxon_id，會拆散該筆的統計、匯出與彙整。id 絕對不能變，所以要有自己的表。
 *
 * 優先序：**模組在就一定用模組**。快取只在 `resolveTaxa` / `searchByTaxonId`
 * 落空時才讀，所以「快取過時」在模組存在時完全不可見，不需要任何刷新機制。
 */
import { getDatasetDb, datasetForTaxonId, type DatasetId } from './datasets';
import { getUserDb } from './init';
import { ensureExternalCopy } from './regionpacks';

/** 與 `taxon_name_cache` 的欄位順序一致（taxon_id / dataset_id / cached_at 另計）。 */
const CACHE_FIELDS = [
  'simple_name', 'name_author', 'common_name_c', 'alternative_name_c',
  'family', 'family_c', 'rank', 'is_endemic', 'alien_type',
  'redlist', 'iucn', 'cites', 'protected', 'is_hybrid',
  'kingdom', 'kingdom_c', 'phylum', 'phylum_c', 'class', 'class_c',
  'order', 'order_c', 'genus', 'genus_c',
  'is_terrestrial', 'is_freshwater', 'is_brackish', 'is_marine', 'is_fossil',
] as const;

/** `"order"` 是保留字，其餘照抄。 */
const quoted = (col: string) => (col === 'order' ? '"order"' : col);
const SELECT_COLS = CACHE_FIELDS.map(quoted).join(', ');

function readFromDataset(taxonId: string): { row: Record<string, unknown>; dataset: DatasetId } | null {
  const spec = datasetForTaxonId(taxonId);
  if (!spec || spec.tables.kind !== 'names') return null;
  const db = getDatasetDb(spec.id);
  if (!db) return null;
  // 先找接受名；找不到才退而求其次抓任何一列，讓只以同義名存在的 id 也留得下
  // 名字（`getKeyTaxonInfo` 早就是這個行為）。
  for (const extra of [` AND usage_status = 'accepted'`, '']) {
    const res = db.executeSync(
      `SELECT ${SELECT_COLS} FROM ${spec.tables.names} WHERE taxon_id = ?${extra} LIMIT 1`,
      [taxonId],
    );
    const row = (res.rows ?? [])[0] as Record<string, unknown> | undefined;
    if (row) return { row, dataset: spec.id };
  }
  return null;
}

function writeCacheRow(taxonId: string, dataset: DatasetId, row: Record<string, unknown>): void {
  const cols = ['taxon_id', 'dataset_id', ...CACHE_FIELDS.map(quoted), 'cached_at'];
  const values: (string | number)[] = [
    taxonId,
    dataset,
    ...CACHE_FIELDS.map((c) => String(row[c] ?? '')),
    Date.now(),
  ];
  getUserDb().executeSync(
    `INSERT OR REPLACE INTO taxon_name_cache (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
    values,
  );
}

/** 已經有快取了嗎？ */
function isCached(taxonId: string): boolean {
  const res = getUserDb().executeSync(
    'SELECT 1 FROM taxon_name_cache WHERE taxon_id = ? LIMIT 1;',
    [taxonId],
  );
  return (res.rows ?? []).length > 0;
}

/**
 * 把一個 t…/y… taxon 的名稱抄進 user.db。已經有快取、或模組當下不可用時就
 * 什麼都不做。**永不 throw**：複製失敗不該擋住記錄本身的寫入。
 */
export function ensureNameCacheCopy(taxonId: string): void {
  if (!taxonId) return;
  const spec = datasetForTaxonId(taxonId);
  if (!spec) return;
  try {
    if (isCached(taxonId)) return;
    const hit = readFromDataset(taxonId);
    if (!hit) return;
    writeCacheRow(taxonId, hit.dataset, hit.row);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[taxonCache] copy failed:', e);
  }
}

/**
 * 任何一筆記錄寫入時的單一入口：`g…` 走 pack 那條既有的不變式，其餘走名稱快取。
 *
 * 四個 insert helper（records / favorites / plots / collections）呼叫這支，
 * 掛點與強制力與改動前完全相同。
 */
export function ensureTaxonSelfSufficient(taxonId: string): void {
  if (!taxonId) return;
  if (taxonId.charAt(0) === 'g') {
    ensureExternalCopy(taxonId);
    return;
  }
  ensureNameCacheCopy(taxonId);
}

/** 快取列 → `TaxonFields`。`resolveTaxa` 的退路直接用這個映射。 */
export function readNameCache(taxonIds: string[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const ids = taxonIds.filter(Boolean);
  if (ids.length === 0) return out;
  try {
    // 分段：`getSpeciesUnder` 之類的呼叫端可能丟上千個 id 進來，SQLite 的
    // 變數上限預設 999。
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const res = getUserDb().executeSync(
        `SELECT taxon_id, ${SELECT_COLS} FROM taxon_name_cache WHERE taxon_id IN (${ph})`,
        chunk,
      );
      for (const row of (res.rows ?? []) as Array<Record<string, unknown>>) {
        out.set(row.taxon_id as string, row);
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[taxonCache] read failed:', e);
  }
  return out;
}

/** 使用者記錄裡出現過的所有 taxon_id（不含 `g…`，那條走 external_taxa）。 */
function referencedTaxonIds(): string[] {
  const sql = `
    SELECT DISTINCT taxon_id FROM checklist_records WHERE taxon_id IS NOT NULL
    UNION SELECT DISTINCT taxon_id FROM plot_species_records WHERE taxon_id IS NOT NULL
    UNION SELECT DISTINCT taxon_id FROM collection_specimens WHERE taxon_id IS NOT NULL
    UNION SELECT DISTINCT taxon_id FROM favorite_taxa WHERE taxon_id IS NOT NULL`;
  const res = getUserDb().executeSync(sql);
  return ((res.rows ?? []) as Array<{ taxon_id?: string }>)
    .map((r) => String(r.taxon_id ?? ''))
    .filter((id) => id && id.charAt(0) !== 'g');
}

/**
 * 把「記錄有引用、而且屬於 `ids` 這些模組」的名稱全部補進快取。
 *
 * 兩個使用時機，兩者都**必須在檔案還在的時候跑**：
 *   1. 升級舊安裝、準備刪掉合併版 bundle 之前
 *   2. 使用者要刪掉某個模組之前（回傳值給確認對話框用）
 *
 * 冪等、可續跑：已經有快取的直接跳過，所以中途被殺掉再跑一次就好。
 */
export function backfillNameCache(ids: DatasetId[]): { cached: number; missing: number } {
  let cached = 0;
  let missing = 0;
  const wanted = new Set(ids);
  try {
    for (const taxonId of referencedTaxonIds()) {
      const spec = datasetForTaxonId(taxonId);
      if (!spec || !wanted.has(spec.id)) continue;
      if (isCached(taxonId)) {
        cached += 1;
        continue;
      }
      const hit = readFromDataset(taxonId);
      if (!hit) {
        missing += 1;
        continue;
      }
      writeCacheRow(taxonId, hit.dataset, hit.row);
      cached += 1;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[taxonCache] backfill failed:', e);
  }
  return { cached, missing };
}
