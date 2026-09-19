/**
 * 向量離線地圖的下載與安裝。
 *
 * **沒有分塊、沒有解壓**：整份地圖是一個 .pmtiles 檔，MapLibre Native 直接
 * 對它做範圍讀取。先前的 raster 圖磚包要把 25 個 zip 串流解壓成四萬多張
 * 圖磚，複雜度幾乎都在那裡。
 *
 * 要下載的東西：
 *   rudy.pmtiles        383 MB   圖磚本體
 *   hillshade.pmtiles    83 MB   山體陰影
 *   sprite / glyph        2 MB   4 + 22 個小檔，**一個都不能少**
 *   style.json                   下載後改寫成指向本機檔案
 */
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { create } from 'zustand';

import { USER_AGENT } from '~/lib/apiFetch';
import {
  ensureVectorRoot,
  isVectorReady,
  VECTOR_FONT_STACK,
  vectorFontsDir,
  localizeStyle,
  readVectorInstalled,
  vectorHillshadeFile,
  vectorRoot,
  vectorStyleFile,
  vectorTilesFile,
  writeVectorInstalled,
  type VectorInstalled,
  type VectorManifest,
} from '~/lib/vectormap';

const MANIFEST_URL = 'https://map.mitalivana.org/vector/latest/manifest.json';

/** 下載期間額外要保留的空間，避免剛好填滿裝置。 */
const SPACE_HEADROOM = 200 * 1024 * 1024;

export type VectorProgress =
  | { phase: 'tiles' | 'hillshade'; receivedBytes: number; totalBytes: number }
  | { phase: 'assets'; done: number; total: number }
  | { phase: 'done' };

export type VectorRemoteState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ready'; manifest: VectorManifest }
  | { kind: 'error'; message: string };

type State = {
  installed: VectorInstalled | null;
  ready: boolean;
  progress: VectorProgress | null;
  error: string | null;
  /**
   * 本機樣式換過幾次。MapLibre 只在掛載時讀一次 style，而樣式更新後 styleUri
   * 這個字串是不變的，React 不會重繪 —— 地圖畫面拿它當 key 才看得到新樣式。
   */
  styleRev: number;
};

export const useVectorInstall = create<State>(() => {
  const installed = readVectorInstalled();
  return {
    installed,
    ready: isVectorReady(installed),
    progress: null,
    error: null,
    styleRev: 0,
  };
});

export function refreshVectorInstalled(): void {
  const installed = readVectorInstalled();
  useVectorInstall.setState({ installed, ready: isVectorReady(installed) });
}

export async function checkVectorRemote(): Promise<VectorRemoteState> {
  try {
    // Cloudflare 會用 403 擋掉預設的 UA（raster 管線踩過），所以一定要帶。
    const res = await fetch(MANIFEST_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
    return { kind: 'ready', manifest: (await res.json()) as VectorManifest };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/**
 * 純本機修復：把樣式裡的路徑改回現在真正的位置，需要時順便搬 glyph。
 *
 * 兩個一起修，因為症狀一樣（地圖全白）而且都只能在本機解：
 *
 * 1. **絕對路徑過期**。樣式裡存的是 `pmtiles://file:///…/Documents/vectormap/…`，
 *    而 iOS 的 app container UUID 會在重裝或更新後改變。檔案都還在（用現在的
 *    `Paths.document` 找得到），但樣式指向的是舊 UUID，於是圖磚一張也載不到。
 * 2. **glyphs 樣板缺 `{fontstack}`**，違反樣式規格。改成合規樣板的同時，檔案
 *    要從 `fonts/<range>.pbf` 搬到 `fonts/<fontstack>/<range>.pbf`。
 *
 * 不連網、不看版本、冪等 —— 版本不同不代表本機這份不該修好。
 */
export function repairLocalStyle(): boolean {
  const installed = readVectorInstalled();
  if (!installed || !isVectorReady(installed)) return false;
  try {
    migrateGlyphLayout();
    // 380 KB，開機路徑上只讀一次。
    const raw = vectorStyleFile().textSync();
    const current = JSON.parse(raw) as Record<string, unknown>;
    const assets = localAssetPaths();
    const fixed = localizeStyle(current, {
      tiles: vectorTilesFile().uri,
      hillshade: vectorHillshadeFile().exists ? vectorHillshadeFile().uri : undefined,
      sprite: assets.sprite,
      glyphs: assets.glyphs,
    });
    const next = JSON.stringify(fixed);
    if (raw === next) return false;
    vectorStyleFile().write(next);
    useVectorInstall.setState((st) => ({ styleRev: st.styleRev + 1 }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 只把 style.json 換新，圖磚留著。
 *
 * 安裝時 `localizeStyle` 是把遠端樣式**複製一份**寫進本機，所以之後每一次樣式
 * 調整（顏色、線寬、山體陰影的 maxzoom…）都到不了已經裝好的使用者手上 —— 為了
 * 幾 KB 的 JSON 叫人重抓 466 MB 顯然不合理。版本號一樣就代表圖磚沒變，樣式可以
 * 單獨更新。
 *
 * 順帶修掉一個潛在問題：本機樣式裡存的是絕對 file:// 路徑，iOS 的 app container
 * UUID 會在更新後改變，那時舊路徑會全部失效。這支跑過就一併寫回新的路徑。
 *
 * 失敗不算錯：野外沒訊號是常態，維持現有樣式即可。
 */
export async function refreshVectorStyle(manifest: VectorManifest): Promise<boolean> {
  const installed = readVectorInstalled();
  if (!installed || !isVectorReady(installed)) return false;
  // 版本不同代表圖磚本身該換，不是換張樣式能解決的事。
  if (installed.version !== manifest.version) return false;

  try {
    const res = await fetch(manifest.styleUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return false;
    const remote = (await res.json()) as Record<string, unknown>;
    const spriteBase = String(remote.sprite ?? '');
    if (spriteBase && spriteBase !== installed.spriteUrl) {
      for (const job of spriteJobs(spriteBase)) await downloadTo(job.url, job.dest);
      writeVectorInstalled({ ...installed, spriteUrl: spriteBase });
      useVectorInstall.setState((st) => ({
        installed: { ...installed, spriteUrl: spriteBase },
        styleRev: st.styleRev + 1,
      }));
    }
    const assets = localAssetPaths();
    const local = localizeStyle(remote, {
      tiles: vectorTilesFile().uri,
      hillshade: manifest.hillshadePmtiles ? vectorHillshadeFile().uri : undefined,
      sprite: assets.sprite,
      glyphs: assets.glyphs,
    });
    const next = JSON.stringify(local);
    if (vectorStyleFile().textSync() === next) return false;
    vectorStyleFile().write(next);
    useVectorInstall.setState((st) => ({ styleRev: st.styleRev + 1 }));
    return true;
  } catch {
    return false;
  }
}

let cancelled = false;
let running = false;

export function isVectorRunning(): boolean {
  return running;
}

export function cancelVectorInstall(): void {
  cancelled = true;
}

async function downloadTo(
  url: string,
  dest: File,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  if (dest.exists) dest.delete();
  const dl = createDownloadResumable(
    url,
    dest.uri,
    { headers: { 'User-Agent': USER_AGENT } },
    (p) => onProgress?.(p.totalBytesWritten, p.totalBytesExpectedToWrite),
  );
  const res = await dl.downloadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    if (dest.exists) dest.delete();
    throw new Error(`HTTP ${res?.status ?? '?'} ${url}`);
  }
}

/**
 * 把 style 引用到的 sprite 與 glyph 全部抓到本機。
 *
 * range 清單由呼叫端給（見 `GLYPH_RANGES`），不是邊用邊抓 —— 缺一段整張圖就
 * 不畫，沒有「用到才補」的餘地。sprite 的四個檔同理。
 */
async function downloadAssets(
  style: Record<string, unknown>,
  ranges: string[],
  onProgress: (done: number, total: number) => void,
): Promise<{ sprite: string; glyphs: string }> {
  ensureVectorRoot();
  const spriteBase = String(style.sprite ?? '');
  const glyphTmpl = String(style.glyphs ?? '');

  const jobs: { url: string; dest: File }[] = spriteJobs(spriteBase);

  const stackDir = new Directory(vectorFontsDir(), VECTOR_FONT_STACK);
  if (!stackDir.exists) stackDir.create({ intermediates: true, idempotent: true });
  for (const r of ranges) {
    jobs.push({
      url: glyphTmpl
        .replace('{fontstack}', encodeURIComponent(VECTOR_FONT_STACK))
        .replace('{range}', r),
      dest: new File(stackDir, `${r}.pbf`),
    });
  }

  let done = 0;
  for (const job of jobs) {
    if (cancelled) throw new Error('cancelled');
    await downloadTo(job.url, job.dest);
    onProgress(++done, jobs.length);
  }
  return localAssetPaths();
}

/** sprite 的四個檔。本機一律叫 sprite.*，遠端叫什麼由樣式決定。 */
function spriteJobs(spriteBase: string): { url: string; dest: File }[] {
  const root = vectorRoot();
  return ['.json', '.png', '@2x.json', '@2x.png'].map((suffix) => ({
    url: `${spriteBase}${suffix}`,
    dest: new File(root, `sprite${suffix}`),
  }));
}

/**
 * 已下載的 sprite / glyph 在本機的位置。
 *
 * 安裝與樣式更新都要算出同一組路徑，所以抽出來共用 —— 兩邊各寫一次就是遲早
 * 會對不上，而對不上的後果是整張圖不畫。
 */
function localAssetPaths(): { sprite: string; glyphs: string } {
  return {
    sprite: new File(vectorRoot(), 'sprite').uri,
    // {fontstack} 不能省：樣式規格要求它一定要出現在 glyphs 樣板裡。
    glyphs: `${vectorFontsDir().uri.replace(/\/$/, '')}/{fontstack}/{range}.pbf`,
  };
}

/**
 * 把早期版本平放在 `fonts/<range>.pbf` 的 glyph 搬進 `fonts/<fontstack>/`。
 *
 * 舊版的 glyphs 樣板沒有 `{fontstack}`，那違反樣式規格。改成合規的樣板之後，
 * 檔案也得跟著搬，否則已經裝好的人會整批 404 —— 而缺一段 glyph 是整張圖不畫，
 * 不是只有標籤消失。冪等：沒有平放的檔案就什麼都不做。
 */
function migrateGlyphLayout(): void {
  const fonts = vectorFontsDir();
  if (!fonts.exists) return;
  const flat = fonts.list().filter((f): f is File => f instanceof File && f.name.endsWith('.pbf'));
  if (flat.length === 0) return;
  const stackDir = new Directory(fonts, VECTOR_FONT_STACK);
  if (!stackDir.exists) stackDir.create({ intermediates: true, idempotent: true });
  for (const f of flat) {
    try {
      f.move(new File(stackDir, f.name));
    } catch {
      // 搬不動就留著，下次再試；樣式仍指向新位置，最壞情況是要重裝。
    }
  }
}

/**
 * glyph 的 range 清單。
 *
 * 由 `glyph_ranges.py` 從實際資料反推、與上傳的那組一致。寫死在這裡而不是從
 * manifest 拿：它只會隨圖資改版而變，而改版本來就要換版本號；多一個欄位反而
 * 多一個對不上的機會，而對不上的後果是整張圖不畫。
 *
 * 後面五段（55296 起）是 **UTF-16 代理區**，不是漏寫。MapLibre Native 按
 * code unit 決定 range，地名裡的罕用字（`石𥕢山` U+25562 之類，全臺 20 個字
 * 出現 169 次）會讓它去要代理半所在的 range。那些 PBF 是空的，但**一定要存在**
 * —— 實機第一次開圖就是栽在這裡（`Failed to load glyph range 56832-57087`）。
 * 瀏覽器端不會請求代理區，所以桌面驗證完全抓不到。
 */
const GLYPH_RANGES = [
  '0-255', '256-511', '512-767', '768-1023',
  '1536-1791', '4096-4351', '7680-7935', '8192-8447',
  '8448-8703', '8704-8959', '9216-9471', '9472-9727',
  '12288-12543', '12544-12799', '12800-13055', '55296-55551',
  '56320-56575', '56576-56831', '56832-57087', '57088-57343',
  '65024-65279', '65280-65535',
];

export async function startVectorInstall(manifest: VectorManifest): Promise<void> {
  if (running) return;
  running = true;
  cancelled = false;
  useVectorInstall.setState({ error: null, progress: null });

  try {
    const need = manifest.bytes + SPACE_HEADROOM;
    if (Paths.availableDiskSpace != null && Paths.availableDiskSpace < need) {
      throw new Error('not_enough_space');
    }

    const tilesUrl = manifest.tilesPmtiles[0];
    if (!tilesUrl) throw new Error('manifest 沒有圖磚檔');
    if (manifest.tilesPmtiles.length > 1) {
      // 一個 style source 只能指一個 .pmtiles，切檔版沒辦法離線。
      throw new Error('manifest 的圖磚被切成多份，離線需要單檔版本');
    }

    ensureVectorRoot();

    await downloadTo(tilesUrl, vectorTilesFile(), (received, total) =>
      useVectorInstall.setState({
        progress: {
          phase: 'tiles',
          receivedBytes: received,
          totalBytes: total > 0 ? total : (manifest.tileBytes ?? manifest.bytes),
        },
      }),
    );
    if (cancelled) throw new Error('cancelled');

    if (manifest.hillshadePmtiles) {
      await downloadTo(manifest.hillshadePmtiles, vectorHillshadeFile(), (received, total) =>
        useVectorInstall.setState({
          progress: { phase: 'hillshade', receivedBytes: received, totalBytes: total },
        }),
      );
      if (cancelled) throw new Error('cancelled');
    }

    const styleRes = await fetch(manifest.styleUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!styleRes.ok) throw new Error(`style HTTP ${styleRes.status}`);
    const remoteStyle = (await styleRes.json()) as Record<string, unknown>;

    const assets = await downloadAssets(remoteStyle, GLYPH_RANGES, (done, total) =>
      useVectorInstall.setState({ progress: { phase: 'assets', done, total } }),
    );

    const local = localizeStyle(remoteStyle, {
      tiles: vectorTilesFile().uri,
      hillshade: manifest.hillshadePmtiles ? vectorHillshadeFile().uri : undefined,
      sprite: assets.sprite,
      glyphs: assets.glyphs,
    });
    vectorStyleFile().write(JSON.stringify(local));

    const state: VectorInstalled = {
      version: manifest.version,
      styleUri: vectorStyleFile().uri,
      bytes: manifest.bytes,
      installedAt: Date.now(),
      spriteUrl: String(remoteStyle.sprite ?? ''),
    };
    writeVectorInstalled(state);
    useVectorInstall.setState({
      installed: state,
      ready: isVectorReady(state),
      progress: { phase: 'done' },
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 取消或失敗都把半成品清掉：留著會讓 isVectorReady 誤判成裝好了。
    const root = vectorRoot();
    if (root.exists) root.delete();
    useVectorInstall.setState({
      installed: null,
      ready: false,
      progress: null,
      error: msg === 'cancelled' ? null : msg,
    });
  } finally {
    running = false;
  }
}
