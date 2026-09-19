/**
 * 山域地標的下載與解壓。
 *
 * raster 圖磚包退場時從它的安裝流程抽出來獨立 —— POI 與引擎無關，任何底圖
 * 都要顯示，而且只有 66 MB，跟「圖磚包太大」的顧慮無關。
 *
 * 解壓刻意用串流：237 MB 的 `.poi` 不能整個進記憶體。`File.open()` 拿 handle，
 * fflate 的 `ondata` 來一段就 `writeBytes` 一段（兩平台的 writeBytes 都會自動
 * 推進位置：iOS 是 Foundation FileHandle.write、Android 是 FileChannel.write），
 * 記憶體峰值與檔案大小脫鉤。
 */
import { File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { Unzip, UnzipInflate } from 'fflate';
import { create } from 'zustand';

import { USER_AGENT, sleep } from '~/lib/apiFetch';
import {
  ensurePoiRoot,
  isPoiReady,
  poiDbFile,
  readPoiInstalled,
  writePoiInstalled,
  type PoiInstalled,
  type PoiMeta,
} from '~/lib/poi';

/** 每次從 zip 讀多少。4 MiB 讓記憶體峰值大約落在 10 MiB。 */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export type PoiProgress =
  | { phase: 'download'; receivedBytes: number; totalBytes: number }
  | { phase: 'extract'; writtenBytes: number; totalBytes: number }
  | { phase: 'done' };

type State = {
  installed: PoiInstalled | null;
  ready: boolean;
  progress: PoiProgress | null;
  error: string | null;
};

export const usePoiInstall = create<State>(() => {
  const installed = readPoiInstalled();
  return { installed, ready: isPoiReady(installed), progress: null, error: null };
});

export function refreshPoiInstalled(): void {
  const installed = readPoiInstalled();
  usePoiInstall.setState({ installed, ready: isPoiReady(installed) });
}

let cancelled = false;
let running = false;

export function cancelPoiInstall(): void {
  cancelled = true;
}

export async function startPoiInstall(meta: PoiMeta): Promise<void> {
  if (running) return;
  running = true;
  cancelled = false;
  usePoiInstall.setState({ error: null, progress: null });

  const zip = new File(Paths.cache, 'rudypoi.zip');
  try {
    if (zip.exists) zip.delete();

    const dl = createDownloadResumable(
      meta.name,
      zip.uri,
      { headers: { 'User-Agent': USER_AGENT } },
      (p) =>
        usePoiInstall.setState({
          progress: {
            phase: 'download',
            receivedBytes: p.totalBytesWritten,
            totalBytes:
              p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : meta.bytes,
          },
        }),
    );
    const res = await dl.downloadAsync();
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res?.status ?? '?'}`);
    }
    if (zip.md5 !== meta.md5) throw new Error('md5 mismatch');
    if (cancelled) throw new Error('cancelled');

    ensurePoiRoot();
    const out = poiDbFile();
    if (out.exists) out.delete();
    out.create();

    const handle = out.open();
    let written = 0;
    let failure: Error | null = null;
    try {
      const unzip = new Unzip((entry) => {
        entry.ondata = (err, data) => {
          if (err) {
            failure ??= err;
            return;
          }
          if (data.length) {
            handle.writeBytes(data);
            written += data.length;
          }
        };
        entry.start();
      });
      // DEFLATE 一定要註冊 inflate decoder，否則 start() 會丟例外
      // （Unzip 預設只認 method 0 的 stored）。
      unzip.register(UnzipInflate);

      const fh = zip.open();
      try {
        for (;;) {
          if (cancelled) throw new Error('cancelled');
          const slice = fh.readBytes(READ_CHUNK_BYTES);
          const last = slice.length === 0;
          unzip.push(slice, last);
          if (failure) throw failure;
          usePoiInstall.setState({
            progress: {
              phase: 'extract',
              writtenBytes: written,
              totalBytes: meta.uncompressedBytes,
            },
          });
          if (last) break;
          // 讓出一拍，不然解壓會把 JS thread 佔滿、UI 整個凍住。
          await sleep(0);
        }
      } finally {
        fh.close();
      }
    } finally {
      handle.close();
    }
    if (failure) throw failure;

    const state: PoiInstalled = {
      poiCount: meta.poiCount,
      bytes: meta.bytes,
      installedAt: Date.now(),
      sourceComment: meta.sourceComment,
    };
    writePoiInstalled(state);
    usePoiInstall.setState({
      installed: state,
      ready: isPoiReady(state),
      progress: { phase: 'done' },
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 半成品的 .db 會讓 poiLocation() 誤判成裝好了，查詢時才炸。
    const out = poiDbFile();
    if (out.exists) out.delete();
    usePoiInstall.setState({
      installed: null,
      ready: false,
      progress: null,
      error: msg === 'cancelled' ? null : msg,
    });
  } finally {
    if (zip.exists) zip.delete();
    running = false;
  }
}
