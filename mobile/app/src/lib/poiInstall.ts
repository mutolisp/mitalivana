/**
 * Download and extraction of the mountain landmarks.
 *
 * Pulled out of the raster tile package's install flow when that was retired —
 * POIs are engine-independent, shown over any basemap, and at 66 MB they have
 * nothing to do with the "tile packs are too big" concern.
 *
 * Extraction is streamed on purpose: a 237 MB `.poi` cannot be held in memory.
 * `File.open()` takes a handle and fflate's `ondata` writes each chunk with
 * `writeBytes` as it arrives (writeBytes advances the position itself on both
 * platforms: Foundation FileHandle.write on iOS, FileChannel.write on Android),
 * which decouples peak memory from file size.
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

/** How much is read from the zip at a time. 4 MiB keeps peak memory around
 *  10 MiB. */
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

/** A download or import is in progress (its zip sits in the cache). */
export function isPoiRunning(): boolean {
  return running;
}

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
