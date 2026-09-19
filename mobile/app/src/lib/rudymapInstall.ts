/**
 * 魯地圖圖磚包的下載／安裝 driver。
 *
 * 架構完全照 `src/lib/gbifDownload.ts`：module-level zustand store + 一支驅動
 * 函式 + id 去重。理由跟那邊寫的一樣 —— 幾 GB 的下載跑十幾分鐘，使用者早就離開
 * 那個畫面了，迴圈不能住在畫面元件裡，否則重新進入畫面會看到假的「未完成」並
 * 啟動第二條同時進行的迴圈。
 *
 * 解壓走 fflate 的**串流** `Unzip`：打包端用 ZIP_STORED（method 0），而 `Unzip`
 * 建構時預設就註冊了 `UnzipPassThrough`，所以完全不做 inflate 運算。搭配
 * `File.open()` → `readBytes(4 MiB)` 迴圈，記憶體峰值與塊大小脫鉤（約 10 MiB）。
 * 刻意**不**沿用 gbifDownload 的 `base64ToBytes(readAsStringAsync(...,'base64'))`：
 * 那是 1.33× 膨脹，在 5 MB 的 GBIF zip 無所謂，在 64 MiB 的圖磚塊上不行。
 */
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { Unzip } from 'fflate';
import { create } from 'zustand';

import i18n from '~/i18n';
import { USER_AGENT, sleep } from '~/lib/apiFetch';
import {
  ensureRudyRoot,
  isPackReady,
  readInstalled,
  rudyTilesDir,
  writeInstalled,
  type RudyChunk,
  type RudyInstalled,
  type RudyManifest,
} from '~/lib/rudymap';
import { useToast } from '~/stores/toast';

/** 圖磚包發佈位置（Cloudflare R2 bucket `mitalivana`，自訂網域 map.mitalivana.org）。
 *  manifest 內的 baseUrl 才是各塊的實際來源，這裡只是進入點 —— 換 hosting 或發新版
 *  時重新發佈 latest/manifest.json 即可，不必改 app。 */
const MANIFEST_URL = 'https://map.mitalivana.org/rudymap/latest/manifest.json';

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_RETRIES = 3;
/** 下載前要求的可用空間餘裕：整包 × 1.15 再加一塊暫存檔的空間。 */
const SPACE_HEADROOM = 1.15;

export type RudyProgress =
  | { phase: 'manifest' }
  | { phase: 'downloading'; chunk: number; chunkCount: number; receivedBytes: number; totalBytes: number | null }
  | { phase: 'verifying'; chunk: number; chunkCount: number }
  | { phase: 'extracting'; chunk: number; chunkCount: number; done: number; total: number }
  | { phase: 'cleanup' };

type RudyInstallState = {
  /** 非 null 就代表正在跑。 */
  progress: RudyProgress | null;
  installed: RudyInstalled | null;
  /** 全部塊到齊才是 true；畫面用這個決定要不要顯示魯地圖底圖選項。 */
  ready: boolean;
};

export const useRudyInstall = create<RudyInstallState>(() => {
  const installed = readInstalled();
  return { progress: null, installed, ready: isPackReady(installed) };
});

/** 讓畫面在外部改動（例如刪除）後重新讀磁碟狀態。 */
export function refreshRudyInstalled(): void {
  const installed = readInstalled();
  useRudyInstall.setState({ installed, ready: isPackReady(installed) });
}

export function isRudyRunning(): boolean {
  return useRudyInstall.getState().progress != null;
}

let cancelled = false;

export function cancelRudyInstall(): void {
  cancelled = true;
}

class Cancelled extends Error {}

function checkCancelled(): void {
  if (cancelled) throw new Cancelled();
}

/** 解壓一塊 zip 到圖磚目錄。回傳寫出的圖磚數。 */
async function extractChunk(
  zip: File,
  onProgress: (done: number) => void,
): Promise<number> {
  ensureRudyRoot();
  const tilesRoot = rudyTilesDir();
  if (!tilesRoot.exists) tilesRoot.create({ intermediates: true, idempotent: true });

  // 已建過的 {z}/{x} 目錄。四萬多張圖磚若每張都呼叫一次 create，光這個就很慢。
  const madeDirs = new Set<string>();
  let done = 0;
  let failure: Error | null = null;

  const unzip = new Unzip((entry) => {
    // entry.name 是 `{z}/{x}/{y}`（打包端刻意不加副檔名，直接對應 tileCachePath）
    const parts = entry.name.split('/');
    if (parts.length !== 3) {
      // 不認得的 entry 照樣要 start()，否則串流會卡在這個檔案上。
      entry.ondata = () => {};
      entry.start();
      return;
    }
    const [z, x, y] = parts;
    // STORED 的檔案仍可能跨越 4 MiB 讀取邊界而分段送達，要湊齊才寫檔。
    const pieces: Uint8Array[] = [];
    entry.ondata = (err, data, final) => {
      if (err) {
        failure ??= err;
        return;
      }
      if (data.length) pieces.push(data);
      if (!final) return;
      try {
        const dirKey = `${z}/${x}`;
        if (!madeDirs.has(dirKey)) {
          new Directory(tilesRoot, z, x).create({ intermediates: true, idempotent: true });
          madeDirs.add(dirKey);
        }
        new File(tilesRoot, z, x, y).write(concat(pieces));
        done += 1;
      } catch (e) {
        failure ??= e as Error;
      }
    };
    entry.start();
  });

  const fh = zip.open();
  try {
    for (;;) {
      checkCancelled();
      const slice = fh.readBytes(READ_CHUNK_BYTES);
      const last = slice.length === 0;
      unzip.push(slice, last);
      if (failure) throw failure;
      onProgress(done);
      if (last) break;
      // 每個讀取切片讓出一次 JS thread（約 30 張圖磚），免得解壓把 UI 凍住。
      await sleep(0);
    }
  } finally {
    fh.close();
  }
  if (failure) throw failure;
  return done;
}

function concat(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pieces) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function downloadChunk(
  manifest: RudyManifest,
  chunk: RudyChunk,
  index: number,
  onProgress: (p: RudyProgress) => void,
): Promise<File> {
  const dest = new File(Paths.cache, `rudymap-${chunk.name}`);
  if (dest.exists) dest.delete();

  const dl = createDownloadResumable(
    `${manifest.baseUrl}${chunk.name}`,
    dest.uri,
    { headers: { 'User-Agent': USER_AGENT } },
    (p) =>
      onProgress({
        phase: 'downloading',
        chunk: index,
        chunkCount: manifest.chunks.length,
        receivedBytes: p.totalBytesWritten,
        totalBytes: p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : chunk.bytes,
      }),
  );
  const res = await dl.downloadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    if (dest.exists) dest.delete();
    throw new Error(`HTTP ${res?.status ?? '?'}`);
  }

  onProgress({ phase: 'verifying', chunk: index, chunkCount: manifest.chunks.length });
  if (dest.md5 !== chunk.md5) {
    dest.delete();
    throw new Error(`md5 mismatch for ${chunk.name}`);
  }
  return dest;
}

async function runInstall(onProgress: (p: RudyProgress) => void): Promise<void> {
  onProgress({ phase: 'manifest' });
  // 明確帶 User-Agent：Cloudflare 會擋掉一些函式庫預設的 UA（實測 Python-urllib
  // 直接 403，換任何其他字串就 200），RN 在 Android 走 okhttp、iOS 走 CFNetwork，
  // 預設值會不會被擋不該賭。
  const res = await fetch(MANIFEST_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = (await res.json()) as RudyManifest;
  if (manifest?.kind !== 'rudymap-tile-pack' || manifest.formatVersion !== 1) {
    throw new Error('unsupported manifest');
  }

  const prev = readInstalled();
  // 版本不同就重來：v1 不做差異更新。呼叫端負責先問過使用者。
  const samePack = prev?.manifest.packVersion === manifest.packVersion;
  const doneChunks = new Set<number>(samePack ? prev!.doneChunks : []);

  const remaining = manifest.chunks.filter((c) => !doneChunks.has(c.id));
  const needBytes = remaining.reduce((n, c) => n + c.bytes, 0) * SPACE_HEADROOM;
  const free = Paths.availableDiskSpace;
  if (free != null && free < needBytes) {
    throw new Error(
      i18n.t('rudymap.notEnoughSpace', {
        need: formatBytes(needBytes),
        free: formatBytes(free),
      }),
    );
  }

  ensureRudyRoot();

  let state: RudyInstalled = {
    manifest,
    doneChunks: [...doneChunks],
    installedAt: prev?.installedAt ?? Date.now(),
  };
  writeInstalled(state);

  for (const chunk of manifest.chunks) {
    checkCancelled();
    if (doneChunks.has(chunk.id)) continue;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt += 1) {
      checkCancelled();
      try {
        const zip = await downloadChunk(manifest, chunk, chunk.id, onProgress);
        try {
          await extractChunk(zip, (done) =>
            onProgress({
              phase: 'extracting',
              chunk: chunk.id,
              chunkCount: manifest.chunks.length,
              done,
              total: chunk.tiles,
            }),
          );
        } finally {
          if (zip.exists) zip.delete();
        }
        lastError = null;
        break;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        lastError = e as Error;
        await sleep(2 ** attempt * 1000);
      }
    }
    if (lastError) throw lastError;

    doneChunks.add(chunk.id);
    state = { ...state, doneChunks: [...doneChunks] };
    writeInstalled(state);
  }

  onProgress({ phase: 'cleanup' });
  refreshRudyInstalled();
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * 啟動（或續傳）安裝。可以從任何地方呼叫；已經在跑的話直接忽略。
 * 完成／失敗走 toast，因為那時使用者多半已經在別的畫面。
 */
export function startRudyInstall(): void {
  if (isRudyRunning()) return;
  cancelled = false;
  useRudyInstall.setState({ progress: { phase: 'manifest' } });
  void (async () => {
    try {
      await runInstall((p) => useRudyInstall.setState({ progress: p }));
      useToast.getState().show(i18n.t('rudymap.installDone'), { durationMs: 8000 });
    } catch (e) {
      if (!(e instanceof Cancelled)) {
        useToast.getState().show(
          i18n.t('rudymap.installError', { msg: String((e as Error)?.message ?? e) }),
        );
      }
    } finally {
      cancelled = false;
      useRudyInstall.setState({ progress: null });
      refreshRudyInstalled();
    }
  })();
}
