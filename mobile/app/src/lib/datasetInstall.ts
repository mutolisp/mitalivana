/**
 * 名錄模組的下載、安裝、更新、刪除。
 *
 * 與離線地圖 / POI 同一套骨架（module-level zustand store + typed phase union +
 * `running`/`cancelled` 旗標），理由也一樣：下載必須撐過使用者離開畫面，而且
 * 重新進入畫面要看到**同一個**進行中的下載，不是又開一個。
 *
 * 解壓走串流（`File.open()` + fflate 的 `Unzip`，4 MiB 一段），因為臺灣名錄解壓後
 * 有 134 MB，整個進記憶體會直接被系統殺掉。
 *
 * 下載完一定驗 **bytes + md5** 才換檔：截斷的 SQLite 檔開得起來，要到查詢時才炸
 * 「no such table」，那是最難追的失敗樣態（pmtiles 的註解也警告過同一件事）。
 */
import { File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { Unzip, UnzipInflate } from 'fflate';
import { create } from 'zustand';

import { USER_AGENT, sleep } from '~/lib/apiFetch';
import {
  datasetNeedsUpdate,
  parseDatasetManifest,
  spaceNeededFor,
  unmetRequirements,
  type DatasetManifestEntryLike,
} from '~/lib/datasetManifest';
import {
  allSpecs,
  backfillNameCache,
  ensureDatasetsDir,
  getInstall,
  isInstalled,
  onDatasetsChanged,
  removeDataset,
  replaceDataset,
  type DatasetId,
  type DatasetInstall,
} from '~/db';

/** 本版 app 讀得懂的模組格式版本。manifest 裡 `minAppSchema` 比這個大的模組會被
 *  跳過並提示更新 app —— 先上架的 manifest 不該讓舊 app 解析失敗。 */
export const APP_DATASET_SCHEMA = 1;

const MANIFEST_URL = 'https://data.mitalivana.org/checklists/latest/manifest.json';

/** 解壓時每次從 zip 讀多少。與 POI 相同，記憶體峰值約 10 MiB。 */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** 下載 + 解壓需要的額外空間緩衝（與離線地圖同一個常數）。 */
const SPACE_HEADROOM = 200 * 1024 * 1024;

export type DatasetManifestEntry = DatasetManifestEntryLike & {
  id: DatasetId;
  requires: DatasetId[];
};

export type DatasetProgress =
  | { phase: 'download'; receivedBytes: number; totalBytes: number }
  | { phase: 'extract'; writtenBytes: number; totalBytes: number }
  | { phase: 'install' };

type InstallState = {
  /** 正在安裝哪一個模組；null = 沒有進行中的安裝。 */
  activeId: DatasetId | null;
  progress: DatasetProgress | null;
  error: string | null;
};

export const useDatasetInstall = create<InstallState>(() => ({
  activeId: null,
  progress: null,
  error: null,
}));

/** 已安裝狀態的快照，給畫面訂閱用。registry 本身刻意不依賴 zustand，所以由這裡
 *  訂閱它的變更事件再同步過來。 */
type InstalledState = { installs: DatasetInstall[] };

export const useInstalledDatasets = create<InstalledState>(() => ({
  installs: allSpecs()
    .map((spec) => getInstall(spec.id))
    .filter((rec): rec is DatasetInstall => rec !== null),
}));

export function refreshInstalledDatasets(): void {
  useInstalledDatasets.setState({
    installs: allSpecs()
      .map((spec) => getInstall(spec.id))
      .filter((rec): rec is DatasetInstall => rec !== null),
  });
}
onDatasetsChanged(refreshInstalledDatasets);

// ── manifest ────────────────────────────────────────────────────────────────

const KNOWN_IDS = new Set<string>(allSpecs().map((s) => s.id));

/**
 * 讀取遠端 manifest。
 *
 * **必須帶自訂 User-Agent**：Cloudflare 會 403 掉 React Native 的預設 UA
 * （離線地圖踩過同一個坑，`vectormapInstall.ts:81`）。
 *
 * 不認識的 id 直接略過而不是報錯——manifest 可能先上了下一版才有的模組。
 * `minAppSchema` 比本版大的也略過，但會標記起來讓畫面能提示「請更新 app」。
 */
export async function fetchDatasetManifest(): Promise<{
  entries: DatasetManifestEntry[];
  needsAppUpdate: boolean;
}> {
  const res = await fetch(MANIFEST_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // 解析規則本身在 `datasetManifest.ts`（純模組，有 check-datasets.mjs 驗）。
  return parseDatasetManifest<DatasetManifestEntry>(await res.json(), {
    knownIds: [...KNOWN_IDS],
    appSchema: APP_DATASET_SCHEMA,
  });
}

/** 這個模組相較於已安裝的版本是新的嗎？ */
export function hasUpdate(entry: DatasetManifestEntry): boolean {
  return datasetNeedsUpdate(getInstall(entry.id)?.version ?? null, entry.version);
}

/** 還沒安裝的相依模組。`tw-keys` 需要 `tw-taicol`。 */
export function missingRequirements(entry: DatasetManifestEntry): DatasetId[] {
  const installed = allSpecs()
    .map((spec) => spec.id)
    .filter((id) => isInstalled(id));
  return unmetRequirements(entry, installed) as DatasetId[];
}

// ── 安裝 ────────────────────────────────────────────────────────────────────

let cancelled = false;
let running = false;

export function cancelDatasetInstall(): void {
  cancelled = true;
}

export function isDatasetInstallRunning(): boolean {
  return running;
}

function stagingFile(id: DatasetId): File {
  // 暫存在 cache：安裝失敗或被殺掉時系統會自己清掉，不會佔住 documents。
  return new File(Paths.cache, `dataset-${id}.db`);
}

function zipFile(id: DatasetId): File {
  return new File(Paths.cache, `dataset-${id}.zip`);
}

/**
 * 下載並安裝（或更新）一個模組。
 *
 * 失敗、取消都會把暫存檔清乾淨；只有在 bytes 與 md5 都對上、解壓完成之後才會
 * 呼叫 `replaceDataset()` 換檔——換檔前 registry 會先關掉指向該檔的 handle 並清
 * journal sidecar。
 */
export async function startDatasetInstall(entry: DatasetManifestEntry): Promise<void> {
  if (running) return;
  running = true;
  cancelled = false;
  useDatasetInstall.setState({ activeId: entry.id, error: null, progress: null });

  const zip = zipFile(entry.id);
  const staged = stagingFile(entry.id);
  try {
    const free = Paths.availableDiskSpace ?? Number.MAX_SAFE_INTEGER;
    if (free < spaceNeededFor(entry, SPACE_HEADROOM)) throw new Error('no-space');

    if (zip.exists) zip.delete();
    if (staged.exists) staged.delete();

    const dl = createDownloadResumable(
      entry.url,
      zip.uri,
      { headers: { 'User-Agent': USER_AGENT } },
      (p) =>
        useDatasetInstall.setState({
          progress: {
            phase: 'download',
            receivedBytes: p.totalBytesWritten,
            totalBytes:
              p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : entry.bytes,
          },
        }),
    );
    const res = await dl.downloadAsync();
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res?.status ?? '?'}`);
    if (cancelled) throw new Error('cancelled');
    // 兩道都驗：size 抓截斷，md5 抓內容不對（快取拿到舊版、傳輸出錯）。
    if (entry.bytes > 0 && zip.size !== entry.bytes) throw new Error('size mismatch');
    if (zip.md5 !== entry.md5) throw new Error('md5 mismatch');

    staged.create();
    const handle = staged.open();
    let written = 0;
    let failure: Error | null = null;
    try {
      const unzip = new Unzip((e) => {
        e.ondata = (err, data) => {
          if (err) {
            failure ??= err;
            return;
          }
          if (data.length) {
            handle.writeBytes(data);
            written += data.length;
          }
        };
        e.start();
      });
      // DEFLATE 一定要註冊 inflate decoder（Unzip 預設只認 stored）。
      unzip.register(UnzipInflate);

      const fh = zip.open();
      try {
        for (;;) {
          if (cancelled) throw new Error('cancelled');
          const slice = fh.readBytes(READ_CHUNK_BYTES);
          const last = slice.length === 0;
          unzip.push(slice, last);
          if (failure) throw failure;
          useDatasetInstall.setState({
            progress: {
              phase: 'extract',
              writtenBytes: written,
              totalBytes: entry.uncompressedBytes,
            },
          });
          if (last) break;
          // 讓出一拍，否則解壓會把 JS thread 佔滿、UI 整個凍住。
          await sleep(0);
        }
      } finally {
        fh.close();
      }
    } finally {
      handle.close();
    }
    if (failure) throw failure;
    if (cancelled) throw new Error('cancelled');

    useDatasetInstall.setState({ progress: { phase: 'install' } });
    ensureDatasetsDir();
    replaceDataset(entry.id, staged.uri, entry.version, written);
    useDatasetInstall.setState({ activeId: null, progress: null, error: null });
  } catch (e) {
    const msg = (e as Error).message;
    // 半成品絕不能留下：一個截斷的 .db 會被當成裝好了，查詢時才炸。
    if (staged.exists) staged.delete();
    useDatasetInstall.setState({
      activeId: null,
      progress: null,
      error: msg === 'cancelled' ? null : msg,
    });
  } finally {
    if (zip.exists) zip.delete();
    running = false;
  }
}

// ── 刪除 ────────────────────────────────────────────────────────────────────

export type RemovalImpact = { cached: number; missing: number };

/**
 * 刪除前先把記錄用到的名稱抄進 user.db，回傳影響筆數給確認對話框。
 *
 * 這一步**必須在檔案還在的時候做**，否則刪完就再也抄不到了。`missing` 是連模組
 * 裡都找不到的（TaiCOL 版本更迭後消失的 id），那些刪完會顯示成「名稱不可用」。
 */
export function previewDatasetRemoval(id: DatasetId): RemovalImpact {
  return backfillNameCache([id]);
}

/** 備份名稱 → 刪檔。呼叫端負責先讓使用者確認。 */
export function removeDatasetSafely(id: DatasetId): RemovalImpact {
  const impact = backfillNameCache([id]);
  removeDataset(id);
  return impact;
}
