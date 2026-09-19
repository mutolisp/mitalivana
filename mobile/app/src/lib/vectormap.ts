/**
 * 向量離線地圖（Mitalivana Topo）的路徑與狀態。
 *
 * 關鍵特性：**整份地圖是一個檔案**（先前的 raster 圖磚包是 25 個 zip、
 * 四萬多張圖磚，已於 2026-09-19 移除）。
 *
 * MapLibre Native 原生支援 `pmtiles://` 協定（`PMTILES_PROTOCOL`，iOS 6.26.0
 * 與 Android 13.2.0 都有），`PMTilesFileSource` 把圖磚請求帶著 `dataRange`
 * 委派給 ResourceLoader —— 後面接 `https://` 就走網路範圍請求，接 `file://`
 * 就走 `util::readFile(path, dataRange)`。所以離線不必像 raster 版那樣切成
 * 25 個 zip 再解壓出四萬多張檔案，下載一個 .pmtiles 放著就能用。
 *
 * 也因此不使用 MapLibre 的 `OfflineManager`：那是逐張圖磚下載，全臺 z0-15
 * 有 370,899 張，等於 37 萬次 HTTP 請求。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { excludeFromBackup } from '../../modules/backup-exclusion';
import type { PoiMeta } from '~/lib/poi';

const ROOT_DIR = 'vectormap';
const STATE_FILE = 'installed.json';
/** 本機改寫過的樣式檔名。遠端那份的 source 指向 https，這份指向 file://。 */
const LOCAL_STYLE = 'style.json';

export type VectorManifest = {
  version: string;
  styleUrl: string;
  /** 圖磚檔。可能不只一個（若上游為了大小限制切檔），但離線只支援單檔。 */
  tilesPmtiles: string[];
  hillshadePmtiles?: string;
  /** 全部資產的位元組數，含 style/sprite/glyph。 */
  bytes: number;
  /** 只有圖磚檔的位元組數，進度條用這個才準。 */
  tileBytes?: number;
  /** 山域地標。與地圖引擎無關，但放同一份 manifest 讓 app 只讀一個地方。 */
  poi?: PoiMeta;
  attribution: string;
};

export type VectorInstalled = {
  version: string;
  /** 本機 style.json 的 uri，直接餵給 MapLibre 的 mapStyle。 */
  styleUri: string;
  bytes: number;
  installedAt: number;
  /**
   * 本機 sprite 是從哪個遠端網址抓來的。
   *
   * 用來判斷要不要重抓：sprite 是用 immutable 快取上傳的，所以修正時會換一個
   * 檔名（sprite → sprite2），遠端樣式指過去之後這裡就對不上了。只有 1 MB，
   * 不值得為它叫使用者重抓整份地圖。
   */
  spriteUrl?: string;
  /** 圖磚檔應有的位元組數，用來認出下載被截短的安裝。 */
  tileBytes?: number;
};

export function vectorRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

/**
 * 建立根目錄並在 iOS 標記為不進備份。
 *
 * **每次**都設旗標，不是只在建立時：原生模組可能在
 * 地圖裝好之後才隨新的 dev client 進來，只在建立時設會讓先安裝的使用者永遠
 * 被漏掉，383 MB 會一直留在 iCloud 備份裡。
 */
export function ensureVectorRoot(): Directory {
  const root = vectorRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  excludeFromBackup(root.uri);
  return root;
}

export function vectorTilesFile(): File {
  return new File(vectorRoot(), 'rudy.pmtiles');
}

export function vectorHillshadeFile(): File {
  return new File(vectorRoot(), 'hillshade.pmtiles');
}

export function vectorStyleFile(): File {
  return new File(vectorRoot(), LOCAL_STYLE);
}

/**
 * 字型堆疊名稱，與 style 裡每個 symbol layer 的 `text-font` 必須一致。
 *
 * glyph 要放在 `fonts/<fontstack>/<range>.pbf`，因為樣式規格要求 `glyphs`
 * 樣板一定要含 `{fontstack}`（`validateStyleMin` 會擋）。名字裡的空白不是問題：
 * MapLibre 送出請求前會 percent-encode（`Resource::glyphs`），LocalFileSource
 * 讀檔前又會 percent-decode 回來，兩邊對得上。
 */
export const VECTOR_FONT_STACK = 'Noto Sans Regular';

export function vectorFontsDir(): Directory {
  return new Directory(vectorRoot(), 'fonts');
}

/**
 * 現在該餵給 MapLibre 的本機樣式位置。
 *
 * **不要用 `installed.styleUri`**：那是安裝當下寫死的絕對路徑，而 iOS 的
 * app container UUID 會在重裝或更新後改變，舊路徑就指向不存在的檔案。檔案本身
 * 還在（`isVectorReady` 用目前的 `Paths.document` 檢查得到），於是會變成
 * 「檔案都在、地圖卻是空白」這種很難查的狀態。每次現算就沒有這個問題。
 */
export function vectorStyleUri(): string {
  return vectorStyleFile().uri;
}

/** 地圖載不起來時用的現況快照。只讀不寫，資訊都可安全印到 log。 */
export function describeVectorInstall(): Record<string, unknown> {
  const style = vectorStyleFile();
  const fonts = vectorFontsDir();
  const stackDir = new Directory(fonts, VECTOR_FONT_STACK);
  const tiles = vectorTilesFile();
  const hs = vectorHillshadeFile();
  const out: Record<string, unknown> = {
    root: vectorRoot().uri,
    styleExists: style.exists,
    // 位元組數是關鍵：截短的 .pmtiles 標頭讀得到、圖磚拿不到，症狀是整片空白。
    tileBytes: tiles.exists ? tiles.size : 0,
    hillshadeBytes: hs.exists ? hs.size : 0,
    spriteBytes: new File(vectorRoot(), 'sprite.json').exists
      ? new File(vectorRoot(), 'sprite.json').size
      : 0,
    fontsFlat: fonts.exists ? fonts.list().filter((f) => f instanceof File).length : 0,
    fontsInStack: stackDir.exists ? stackDir.list().length : 0,
    stackDirUri: stackDir.uri,
  };
  if (style.exists) {
    out.styleBytes = style.size;
    try {
      const parsed = JSON.parse(style.textSync()) as Record<string, unknown>;
      const sources = parsed.sources as Record<string, Record<string, unknown>> | undefined;
      out.glyphs = parsed.glyphs;
      out.sprite = parsed.sprite;
      out.rudyUrl = sources?.rudy?.url;
      out.hillshadeUrl = sources?.hillshade?.url;
      out.layerCount = Array.isArray(parsed.layers) ? parsed.layers.length : null;
    } catch (e) {
      out.styleParseError = (e as Error).message;
    }
  }
  return out;
}

/**
 * 把遠端樣式改寫成指向本機檔案。
 *
 * source 的 `url` 由 `pmtiles://https://…` 換成 `pmtiles://file:///…`。
 *
 * **glyph 與 sprite 也一定要存本機**（合計約 2 MB）。不能只換圖磚來源就算了 ——
 * 桌面驗證時實測過：少一個 glyph range，MapLibre 會整張圖算不出來，不是只有
 * 標籤消失，而且 console 只報 404、沒有任何算繪錯誤，非常難查。離線時每個
 * range 都取不到，等於整張地圖是白的。
 */
export function localizeStyle(
  style: Record<string, unknown>,
  paths: { tiles: string; hillshade?: string; sprite?: string; glyphs?: string },
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
  const sources = out.sources as Record<string, Record<string, unknown>> | undefined;
  if (sources?.rudy) {
    sources.rudy.url = `pmtiles://${paths.tiles}`;
    delete sources.rudy.tiles;
  }
  if (sources?.hillshade && paths.hillshade) {
    sources.hillshade.url = `pmtiles://${paths.hillshade}`;
    delete sources.hillshade.tiles;
  }
  if (paths.sprite) out.sprite = paths.sprite;
  if (paths.glyphs) out.glyphs = paths.glyphs;
  return out;
}

export function readVectorInstalled(): VectorInstalled | null {
  const f = new File(vectorRoot(), STATE_FILE);
  if (!f.exists) return null;
  try {
    // textSync：這支會在 render 路徑上被呼叫，不能是 Promise。
    return JSON.parse(f.textSync()) as VectorInstalled;
  } catch {
    return null;
  }
}

export function writeVectorInstalled(state: VectorInstalled): void {
  ensureVectorRoot();
  new File(vectorRoot(), STATE_FILE).write(JSON.stringify(state));
}

/**
 * 檔案真的都在、而且**大小對得上**才算裝好。
 *
 * 只看存不存在是不夠的：截短的 .pmtiles 標頭與根目錄都在檔案開頭，樣式載得起來、
 * 圖磚卻一張也拿不到，畫面上是「山體陰影有、向量地圖整片空白」。大小不符就當成
 * 沒裝，app 會退回線上模式（那是能用的），設定頁也會重新出現下載按鈕 —— 比留著
 * 一份看起來正常的壞檔好。
 */
export function isVectorReady(state: VectorInstalled | null): boolean {
  if (state == null || !vectorTilesFile().exists || !vectorStyleFile().exists) return false;
  if (state.tileBytes != null && state.tileBytes > 0) {
    return (vectorTilesFile().size ?? 0) === state.tileBytes;
  }
  return true;
}

export function deleteVectorMap(): void {
  const root = vectorRoot();
  if (root.exists) root.delete();
}
