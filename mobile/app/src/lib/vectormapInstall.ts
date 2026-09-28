/**
 * Download and install of the offline vector map.
 *
 * **No chunking, no unpacking**: the whole map is one .pmtiles file that
 * MapLibre Native range-reads directly. The earlier raster tile packs had to
 * stream-unzip 25 archives into 40,000-odd tiles, which was where nearly all
 * the complexity lived.
 *
 * What gets downloaded:
 *   rudy.pmtiles        383 MB   the tiles themselves
 *   hillshade.pmtiles    83 MB   hillshade
 *   sprite / glyphs       2 MB   4 + 22 small files, **not one may be missing**
 *   style.json                   rewritten after download to point at local files
 */
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { create } from 'zustand';

import i18n from '~/i18n';
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

/** Headroom kept free during the download so the device is not filled exactly
 *  to the brim. */
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
   * How many times the local style has been replaced. MapLibre reads the style
   * once at mount, and the styleUri string does not change when the style is
   * updated, so React would not re-render — the map screen uses this as a key to
   * pick up the new style.
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
    // Cloudflare 403s the default UA (the raster pipeline hit this), so it must be
  // sent.
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
    // 380 KB, read once on the startup path.
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
 * Refresh style.json alone and keep the tiles.
 *
 * At install time `localizeStyle` writes a **copy** of the remote style locally,
 * so every later styling change (colours, line widths, the hillshade maxzoom…)
 * never reaches anyone who already installed — and making them re-download
 * 466 MB for a few KB of JSON is obviously unreasonable. An unchanged version
 * means the tiles are unchanged, so the style can be updated on its own.
 *
 * This also fixes a latent problem: the local style stores absolute file://
 * paths, and the iOS app container UUID changes after an update, invalidating
 * all of them. Running this writes the current paths back.
 *
 * Failure is not an error: no signal in the field is normal, and keeping the
 * existing style is fine.
 */
export async function refreshVectorStyle(manifest: VectorManifest): Promise<boolean> {
  const installed = readVectorInstalled();
  if (!installed || !isVectorReady(installed)) return false;
  // A different version means the tiles themselves need replacing, which a new
    // style cannot fix.
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

/**
 * Download to dest, and **verify the byte count** when the expected size is
 * known.
 *
 * HTTP 200 does not mean the file is complete: a dropped connection, a full
 * disk, or the system reclaiming a background download can all leave a
 * truncated file. A truncated .pmtiles is especially hard to diagnose — the
 * header and root directory sit at the start of the file and read fine, so the
 * style loads while not a single tile can be fetched, and the screen shows
 * "hillshade yes, vector map blank". Better to fail here than to keep a broken
 * file that looks installed.
 */
async function downloadTo(
  url: string,
  dest: File,
  onProgress?: (received: number, total: number) => void,
  expectBytes?: number,
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
  if (expectBytes != null && expectBytes > 0) {
    const got = dest.size ?? 0;
    if (got !== expectBytes) {
      if (dest.exists) dest.delete();
      throw new Error(i18n.t('vectormap.err.incomplete', { name: dest.name, got, expect: expectBytes }));
    }
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
      throw new Error(i18n.t('vectormap.err.noSpace'));
    }

    const tilesUrl = manifest.tilesPmtiles[0];
    if (!tilesUrl) throw new Error(i18n.t('vectormap.err.noTiles'));
    if (manifest.tilesPmtiles.length > 1) {
      // 一個 style source 只能指一個 .pmtiles，切檔版沒辦法離線。
      throw new Error(i18n.t('vectormap.err.splitTiles'));
    }

    ensureVectorRoot();

    await downloadTo(
      tilesUrl,
      vectorTilesFile(),
      (received, total) =>
        useVectorInstall.setState({
          progress: {
            phase: 'tiles',
            receivedBytes: received,
            totalBytes: total > 0 ? total : (manifest.tileBytes ?? manifest.bytes),
          },
        }),
      manifest.tileBytes,
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
      tileBytes: vectorTilesFile().size ?? undefined,
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
