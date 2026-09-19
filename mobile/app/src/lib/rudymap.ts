/**
 * 魯地圖離線底圖圖磚包 —— 路徑、manifest、安裝狀態。
 *
 * 圖磚放在 `Paths.document` 底下而不是 `Paths.cache`：Caches 雖然不進 iCloud
 * 備份，但 iOS 在磁碟吃緊時會清掉它，而且 app 沒在跑也會被清。幾 GB 的底圖
 * 在上山前一晚消失是不能接受的失敗模式。備份排除改由 config plugin 設
 * `NSURLIsExcludedFromBackupKey` 處理（見 mobile/app/plugins/）。
 *
 * **安裝狀態的單一真實來源是磁碟上的 installed.json**，不是 settings、也不是
 * user.db。理由：底圖不是使用者資料（不該被備份或「清除所有資料」波及），而且
 * 一份寫在別處的「已安裝」標記一旦與實際檔案不同步，地圖就會整片空白。
 *
 * 圖磚佈局是 react-native-maps `tileCachePath` 的格式：`{root}/{z}/{x}/{y}`，
 * y **沒有副檔名**（見 AIRMapUrlTileCachedOverlay.m / MapTileProvider.java）。
 * 打包端已經照這個格式寫 zip entry，所以解壓後不需要改名。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { excludeFromBackup } from '../../modules/backup-exclusion';

const ROOT_DIR = 'rudymap';
const TILES_DIR = 'tiles';
const INSTALLED_FILE = 'installed.json';

export type RudyChunk = {
  id: number;
  name: string;
  bytes: number;
  tiles: number;
  zoomRange: [number, number];
  /** 裝置端用 md5：File.md5 是 expo-file-system 的原生屬性，不必多裝 crypto 套件。 */
  md5: string;
  /** CI／發佈端用。 */
  sha256: string;
};

export type RudyManifest = {
  kind: 'rudymap-tile-pack';
  formatVersion: 1;
  packVersion: string;
  tileFormat: 'png';
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  totalBytes: number;
  baseUrl: string;
  chunks: RudyChunk[];
  /** 語系 → 版權標示。放 manifest 而非 app 程式碼，換包不必發 app 版本。 */
  attribution: Record<string, string>;
};

export type RudyInstalled = {
  manifest: RudyManifest;
  /** 已完成的 chunk id。續傳只做塊層級。 */
  doneChunks: number[];
  installedAt: number;
};

export function rudyRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

export function rudyTilesDir(): Directory {
  return new Directory(rudyRoot(), TILES_DIR);
}

/**
 * 建立圖磚包根目錄，並在 iOS 把它標記為不進備份。
 *
 * 在**根目錄**上設旗標而不是逐張圖磚：四萬多張檔案逐一設是不可行的。
 * Android 不走這裡，是建置期的 backup_rules.xml（plugins/withBackupExclusions.js）。
 * 設定失敗不中斷流程 —— 沒有排除只是備份會變大，不是功能壞掉。
 */
export function ensureRudyRoot(): Directory {
  const root = rudyRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  // **每次**都設，不是只在建立時設。原生模組可能在圖磚包裝好之後才隨新的
  // dev client／app 版本進來（requireOptionalNativeModule 在那之前是靜默 no-op）；
  // 只在建立時設的話，那些先安裝的使用者就永遠不會被排除，幾 GB 會一直留在
  // iCloud 備份裡。設這個旗標是冪等的檔案屬性寫入，重複呼叫沒有代價。
  excludeFromBackup(root.uri);
  return root;
}

/**
 * `<UrlTile tileCachePath>` 要的值。
 *
 * iOS 的 AIRMapUrlTile 會判斷字串是不是 `file://` 開頭並自行轉 NSURL，所以這裡
 * 回傳 expo 的 uri 即可 —— 但**不要**把它拿去餵 `<LocalTile pathTemplate>`，
 * 那條路徑走 NSFileManager/FileInputStream，只吃純檔案路徑。
 */
export function rudyTileCachePath(): string {
  return rudyTilesDir().uri.replace(/\/$/, '');
}

function installedFile(): File {
  return new File(rudyRoot(), INSTALLED_FILE);
}

export function readInstalled(): RudyInstalled | null {
  try {
    const f = installedFile();
    if (!f.exists) return null;
    const parsed = JSON.parse(f.textSync()) as RudyInstalled;
    if (parsed?.manifest?.kind !== 'rudymap-tile-pack') return null;
    return parsed;
  } catch {
    // 寫到一半被中斷的 JSON：當成沒安裝，讓使用者重跑安裝流程。
    return null;
  }
}

export function writeInstalled(state: RudyInstalled): void {
  ensureRudyRoot();
  installedFile().write(JSON.stringify(state));
}

/** 全部塊都到齊了才算可用；缺塊的地圖會開天窗。 */
export function isPackReady(state: RudyInstalled | null): boolean {
  if (!state) return false;
  return state.doneChunks.length === state.manifest.chunks.length;
}

/** 已下載的塊佔總位元組的比例，給進度文案用。 */
export function installedBytes(state: RudyInstalled | null): number {
  if (!state) return 0;
  const done = new Set(state.doneChunks);
  return state.manifest.chunks.reduce((sum, c) => (done.has(c.id) ? sum + c.bytes : sum), 0);
}

export function rudyAttribution(state: RudyInstalled | null, lang: string): string {
  const a = state?.manifest.attribution;
  if (!a) return '';
  return a[lang] ?? a['zh-TW'] ?? a['en'] ?? '';
}

/**
 * 對**已經存在**的圖磚包補設備份排除旗標，不存在就什麼都不做。
 *
 * 補救「先裝好圖磚包、之後才升級到帶原生模組的版本」這條路徑：那些使用者
 * 不會再經過 ensureRudyRoot()，沒有這一支就永遠不會被排除。App 啟動時呼叫一次。
 */
export function reapplyBackupExclusion(): void {
  const root = rudyRoot();
  if (root.exists) excludeFromBackup(root.uri);
}

/** 砍掉整包。呼叫端負責在此之後把底圖切回 standard。 */
export function deleteRudyPack(): void {
  const root = rudyRoot();
  if (root.exists) root.delete();
}
