/**
 * 山域地標（POI）的路徑與狀態。
 *
 * 766,737 筆，來自魯地圖的上游原檔 `MOI_OSM_Taiwan_TOPO_Rudy.poi`。
 *
 * **與地圖引擎無關**：山頭、基點、登山標誌、山屋、水源這些點位，不管底圖是
 * Apple/Google 還是向量魯地圖都要顯示。原本掛在 raster 圖磚包的安裝流程裡，
 * raster 退場後抽出來獨立 —— 它只有 66 MB，跟「圖磚包太大」的顧慮無關。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { excludeFromBackup } from '../../modules/backup-exclusion';

const ROOT_DIR = 'poi';
const DB_NAME = 'rudypoi.db';
const STATE_FILE = 'installed.json';

/** raster 時代 POI 的舊位置。升級時要搬過來，不然使用者得重抓 66 MB。 */
const LEGACY_DIR = 'rudymap';

export type PoiMeta = {
  name: string;
  installName: string;
  bytes: number;
  uncompressedBytes: number;
  poiCount: number;
  md5: string;
  sourceComment?: string;
};

export type PoiInstalled = {
  poiCount: number;
  bytes: number;
  installedAt: number;
  sourceComment?: string;
};

export function poiRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

export function poiDbFile(): File {
  return new File(poiRoot(), DB_NAME);
}

/**
 * 建立目錄並在 iOS 標記為不進備份。
 *
 * 與圖磚包一樣**每次**都設旗標：原生模組可能在資料裝好之後才隨新的 dev client
 * 進來，只在建立時設會讓先安裝的使用者永遠被漏掉。
 */
export function ensurePoiRoot(): Directory {
  const root = poiRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  excludeFromBackup(root.uri);
  return root;
}

/**
 * 給 op-sqlite 的 `open({ name, location })`。
 *
 * 沒裝就回 null —— 呼叫端據此決定要不要查，而不是開一個不存在的 DB。
 */
export function poiLocation(): { name: string; location: string } | null {
  const f = poiDbFile();
  if (!f.exists) return null;
  return { name: DB_NAME, location: poiRoot().uri.replace(/\/$/, '') };
}

export function readPoiInstalled(): PoiInstalled | null {
  const f = new File(poiRoot(), STATE_FILE);
  if (!f.exists) return null;
  try {
    return JSON.parse(f.textSync()) as PoiInstalled;
  } catch {
    return null;
  }
}

export function writePoiInstalled(state: PoiInstalled): void {
  ensurePoiRoot();
  new File(poiRoot(), STATE_FILE).write(JSON.stringify(state));
}

export function isPoiReady(state: PoiInstalled | null): boolean {
  return state != null && poiDbFile().exists;
}

export function deletePoi(): void {
  const root = poiRoot();
  if (root.exists) root.delete();
}

/**
 * 從 raster 時代的佈局搬過來，並清掉已經沒有功能對應的圖磚。
 *
 * 兩件事一起做，因為都是一次性的升級動作：
 *
 * 1. `rudymap/rudypoi.db` → `poi/rudypoi.db`。不搬的話使用者要重抓 66 MB。
 * 2. 刪掉整個 `rudymap/`（圖磚包最大 1.46 GB）。raster 功能已移除，UI 上再也
 *    沒有入口可以刪它，留著就是永遠佔著空間。那些是唯讀且可重新取得的資料，
 *    不是使用者產生的內容。
 *
 * 冪等：舊目錄不存在就什麼都不做。
 */
export function migrateFromRasterPack(): void {
  const legacy = new Directory(Paths.document, LEGACY_DIR);
  if (!legacy.exists) return;

  const oldDb = new File(legacy, DB_NAME);
  const target = poiDbFile();
  if (oldDb.exists && !target.exists) {
    ensurePoiRoot();
    try {
      oldDb.move(target);
    } catch {
      // 搬不動就算了，下面照樣刪；使用者重抓 66 MB 比卡在半途好。
    }
  }
  try {
    legacy.delete();
  } catch {
    // 刪不掉不影響功能，下次啟動再試。
  }
}
