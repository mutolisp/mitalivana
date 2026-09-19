/**
 * 舊版合併檔（`Documents/twnamelist.db`，160 MB）的退場。
 *
 * 0.5.0 以前名錄是隨 app 出貨的單一檔案。模組化之後使用者選擇「要求重新下載」
 * 而不是接管舊檔，所以升級時必須把那個檔刪掉——但**順序不能錯**：
 *
 *   1. user.db migration v35（`taxon_name_cache`）——`initDb` 早已跑完
 *   2. `backfillNameCache()`：趁舊檔**還在**，把所有被記錄引用到的名稱抄進 user.db
 *   3. 寫旗標，確認第 2 步真的完成
 *   4. 才刪 `twnamelist.db` + `.version`（此時回收 160 MB）
 *   5. 下載精靈接手
 *
 * 少了第 2 步，升級後到下載完成前，使用者的名錄會整片空白——那是這次改動最容易
 * 造成的傷害。**刪檔也一定要在下載之前**：不然尖峰需要 160（舊）＋34（zip）
 * ＋143（解壓）≈ 337 MB 可用空間，裝置滿的人直接失敗。
 *
 * 可中斷：旗標只有在 backfill 完成後才寫，所以跑到一半被殺掉，下次啟動會從第 2
 * 步重跑（backfill 本身冪等，已有快取的直接跳過）。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { closeAllDatasetDbs, loadDatasetManifest, type DatasetId } from './datasets';
import { getUserDb } from './init';
import { backfillNameCache } from './taxonCache';

const LEGACY_FILE = 'twnamelist.db';
const LEGACY_VERSION_FILE = 'twnamelist.db.version';
/** 舊檔裡可能住著的模組。檢索表不在此列：它沒有自己的 taxon，記錄不會引用它。 */
const LEGACY_NAME_DATASETS: DatasetId[] = ['tw-taicol', 'jp-ylist'];

/** 旗標放 user.db 的 settings：跟著備份走，也跟著「清除所有資料」一起消失——
 *  那時舊檔早就不在了，函式會在第一個 early return 就結束。 */
const FLAG_KEY = 'legacy_bundle_backfilled';

function legacyFile(): File {
  return new File(Paths.document, LEGACY_FILE);
}

function readFlag(): boolean {
  try {
    const res = getUserDb().executeSync(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [
      FLAG_KEY,
    ]);
    return ((res.rows ?? [])[0] as { value?: string } | undefined)?.value === 'true';
  } catch {
    return false;
  }
}

function writeFlag(): void {
  try {
    getUserDb().executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, 'true')`, [
      FLAG_KEY,
    ]);
  } catch {
    // 寫不進去就當沒做完，下次啟動重跑 backfill（冪等）
  }
}

export type LegacyRetirement = {
  /** 這次真的做了退場（第一次升級時才會是 true）。 */
  retired: boolean;
  /** 抄進 user.db 的名稱數。 */
  cached: number;
  /** 記錄引用、但連舊檔裡都查不到的（TaiCOL 版本更迭後消失的 id）。 */
  missing: number;
  /** 回收的空間（bytes）。 */
  freedBytes: number;
};

/**
 * 升級路徑：備份名稱 → 刪舊檔。已經沒有舊檔就什麼都不做。
 *
 * **必須在 `runUserMigrations()` 之後呼叫**（要有 `taxon_name_cache`），而且要在
 * 任何名錄查詢之前——舊檔此時仍被 registry 當成已安裝，backfill 正是靠它才讀得到
 * 名字。
 */
export function retireLegacyBundle(): LegacyRetirement {
  const idle: LegacyRetirement = { retired: false, cached: 0, missing: 0, freedBytes: 0 };
  const legacy = legacyFile();
  if (!legacy.exists) return idle;

  let cached = 0;
  let missing = 0;
  if (!readFlag()) {
    const impact = backfillNameCache(LEGACY_NAME_DATASETS);
    cached = impact.cached;
    missing = impact.missing;
    writeFlag();
  }

  const freedBytes = legacy.size ?? 0;
  // 先關掉所有名錄 handle：舊檔此刻可能正被開著（registry 把三個模組都指向它）。
  closeAllDatasetDbs();
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const f = new File(Paths.document, `${LEGACY_FILE}${suffix}`);
      if (f.exists) f.delete();
    }
    const versionFile = new File(Paths.document, LEGACY_VERSION_FILE);
    if (versionFile.exists) versionFile.delete();
  } catch (e) {
    // 刪不掉不是災難：名稱已經備份好了，下次啟動再試一次。
    console.warn('[legacyBundle] delete failed:', e);
    return { retired: false, cached, missing, freedBytes: 0 };
  }

  // 安裝清單裡那三筆都指向已經不存在的檔案，重讀時會被對帳掉 → 回到「未安裝」，
  // 首次啟動精靈接手。
  loadDatasetManifest();
  return { retired: true, cached, missing, freedBytes };
}

/** 舊的 asset 解壓副本（Android 會把 bundle 內的 DB 解到 cache）。拆掉內建之後
 *  那份也沒用了，順手清掉。找不到就什麼都不做。 */
export function purgeLegacyAssetCache(): void {
  try {
    const dir = new Directory(Paths.cache, 'ExponentAsset');
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.endsWith('.db')) entry.delete();
    }
  } catch {
    // cache 清理失敗完全無所謂
  }
}
