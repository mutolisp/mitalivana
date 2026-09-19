/**
 * 跨模組合併的純邏輯。
 *
 * 名錄拆成獨立檔之後，「一個答案」往往由兩個以上模組各查一次再併起來。合併的
 * 規則本身沒有任何 SQLite / 原生相依，所以刻意住在這裡：`scripts/check-datasets.mjs`
 * 才能在 Node 下直接 import 來驗證（`src/db/taxonomy.ts` / `regions.ts` 都會連
 * 帶載入 op-sqlite 與 expo-file-system，在 Node 是載不起來的）。
 *
 * 這一層只依賴型別，不依賴任何執行期模組。
 */
import type { TaxonNode } from './taxonomy';
import type { RegionCode } from '~/stores/settings';

/**
 * 合併兩個名錄模組回傳的同一層節點。
 *
 * 同名節點合併、統計相加、中文名以先出現者為準（呼叫端讓 TaiCOL 先進來，所以
 * 臺灣的中文名優先）。合併後重新依 name 排序，維持與 SQL `ORDER BY name` 一致。
 *
 * **統計是相加的**：TW 與 JP 都有的屬會被算兩次。這與 `mergePackNodes` 對 pack
 * 的既有處理一致（那裡也寫明是 approximation）。只有一個模組時（預設只開臺灣）
 * 這個函式根本不會被觸發第二次，數字與拆檔前完全相同。
 */
export function mergeScopeNodes(acc: TaxonNode[], incoming: TaxonNode[]): TaxonNode[] {
  if (acc.length === 0) return incoming;
  if (incoming.length === 0) return acc;
  const byName = new Map(acc.map((n) => [n.name, n]));
  for (const node of incoming) {
    const existing = byName.get(node.name);
    if (!existing) {
      byName.set(node.name, node);
      continue;
    }
    existing.name_c = existing.name_c || node.name_c;
    for (const [k, v] of Object.entries(node.stats)) {
      existing.stats[k] = (existing.stats[k] ?? 0) + v;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 跨區俗名的縫合步驟：把「id → sci_norm」與「各區 sci_norm → 俗名」兩張表接起來。
 *
 * 這是原本那道 `species_xref` 自我 JOIN 在拆檔後留下來的部分——SQL 只負責兩次
 * 索引查詢，怎麼配對是這裡的事。
 */
export function stitchCrossRegion(
  idToNorm: Map<string, string>,
  cnamesByRegion: Map<RegionCode, Map<string, string>>,
): Map<string, { tw?: string; jp?: string }> {
  const out = new Map<string, { tw?: string; jp?: string }>();
  for (const [id, norm] of idToNorm) {
    const entry: { tw?: string; jp?: string } = {};
    const tw = cnamesByRegion.get('TW')?.get(norm);
    const jp = cnamesByRegion.get('JP')?.get(norm);
    if (tw) entry.tw = tw;
    if (jp) entry.jp = jp;
    if (entry.tw || entry.jp) out.set(id, entry);
  }
  return out;
}
