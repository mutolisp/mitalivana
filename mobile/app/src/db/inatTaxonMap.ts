/**
 * 學名 → iNaturalist taxon id 的持久化快取（user.db `inat_taxon_map`，v36）。
 *
 * 只負責讀寫，**不碰網路**——上網那半在 `src/lib/useInatGrid.ts`，這樣 `src/db/`
 * 這一層維持「只有儲存」的分工，也不會把 `inatApi.ts` 的 `expo-file-system/legacy`
 * 相依拉進 DB 層。
 *
 * **負快取是這張表存在的主因**：實測 30 個 TaiCOL 接受名有 5 個 iNat 完全沒有
 * （約 17%，冷門無脊椎動物尤其明顯）。`inatTaxonId === null` 代表「查過、沒有」，
 * 與「還沒查過」（讀不到列）是兩件不同的事，不能混為一談。
 *
 * 既有的上傳流程（`inatUpload.ts` 的 `taxonCache`）也在做同樣的解析，但那只是批次
 * 內的 `Map`、跑完就丟。等這張表在熱區圖上證明可用之後可以接過去，本次不動它。
 */
import { getUserDb } from './init';

export type InatTaxonInfo = {
  /** null = 查過但 iNat 沒有這個名字。 */
  inatTaxonId: number | null;
  /** `captive=false` 的觀察筆數。 */
  obsWild: number;
  /** 未過濾的總筆數；null = 沒去問（`obsWild > 0` 時不需要）。 */
  obsTotal: number | null;
};

export type CachedInatTaxon = InatTaxonInfo & { checkedAt: number };

type Row = {
  inat_taxon_id?: number | null;
  obs_wild?: number | null;
  obs_total?: number | null;
  checked_at?: number | null;
};

/** 讀不到回 null（＝還沒查過），與「查過、沒有」是不同的答案。 */
export function readInatTaxonCache(name: string, kingdom: string): CachedInatTaxon | null {
  const key = name.trim();
  if (!key) return null;
  try {
    const res = getUserDb().executeSync(
      `SELECT inat_taxon_id, obs_wild, obs_total, checked_at
         FROM inat_taxon_map WHERE name = ? AND kingdom = ? LIMIT 1`,
      [key, kingdom ?? ''],
    );
    const row = ((res.rows ?? [])[0] as Row | undefined) ?? null;
    if (!row) return null;
    return {
      inatTaxonId: row.inat_taxon_id == null ? null : Number(row.inat_taxon_id),
      obsWild: Number(row.obs_wild ?? 0),
      obsTotal: row.obs_total == null ? null : Number(row.obs_total),
      checkedAt: Number(row.checked_at ?? 0),
    };
  } catch {
    // 快取讀不到不該讓地圖壞掉；當成沒查過，最多多打一次 API
    return null;
  }
}

export function writeInatTaxonCache(name: string, kingdom: string, info: InatTaxonInfo): void {
  const key = name.trim();
  if (!key) return;
  try {
    getUserDb().executeSync(
      `INSERT OR REPLACE INTO inat_taxon_map
         (name, kingdom, inat_taxon_id, obs_wild, obs_total, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, kingdom ?? '', info.inatTaxonId, info.obsWild, info.obsTotal, Date.now()],
    );
  } catch {
    // 寫不進去只是下次要重查一次，不值得打斷使用者
  }
}
