/**
 * 名錄模組 manifest 的解析與判斷規則（純邏輯）。
 *
 * 與 `mergeScope.ts` 同樣刻意不相依任何原生模組：`datasetInstall.ts` 會載入
 * expo-file-system / fflate / zustand，在 Node 下跑不起來，而這裡的規則正是最
 * 需要被測到的部分——它們決定「先上架的 manifest 會不會讓舊版 app 壞掉」。
 *
 * 兩條向前相容規則：
 *   1. **不認識的 id 直接略過**，不是錯誤。manifest 可能先列了下一版才有的模組。
 *   2. `minAppSchema` 比本版大的模組也略過，但要回報 `needsAppUpdate`，讓畫面
 *      能說「請先更新 app」而不是安靜地少一列。
 */

export type DatasetManifestEntryLike = {
  id: string;
  region: 'TW' | 'JP' | null;
  version: string;
  title: Record<string, string>;
  url: string;
  bytes: number;
  uncompressedBytes: number;
  md5: string;
  rows: Record<string, number>;
  requires: string[];
  minAppSchema: number;
  attribution: string;
  license: string;
};

export type ParsedManifest<T extends DatasetManifestEntryLike = DatasetManifestEntryLike> = {
  entries: T[];
  /** 有模組因為格式太新而被略過。 */
  needsAppUpdate: boolean;
};

/**
 * 從 manifest JSON 取出本版 app 用得到的模組。
 *
 * 缺 `url` / `md5` / `version` 的條目視為壞資料而略過——那些欄位少一個，下載就
 * 沒辦法驗證，寧可當它不存在。
 */
export function parseDatasetManifest<T extends DatasetManifestEntryLike>(
  json: unknown,
  opts: { knownIds: readonly string[]; appSchema: number },
): ParsedManifest<T> {
  const known = new Set(opts.knownIds);
  const list =
    json && typeof json === 'object' && Array.isArray((json as { datasets?: unknown }).datasets)
      ? ((json as { datasets: unknown[] }).datasets as unknown[])
      : [];

  const entries: T[] = [];
  let needsAppUpdate = false;
  for (const raw of list) {
    const e = raw as T;
    if (!e || typeof e.id !== 'string' || !known.has(e.id)) continue;
    if (typeof e.minAppSchema === 'number' && e.minAppSchema > opts.appSchema) {
      needsAppUpdate = true;
      continue;
    }
    if (!e.url || !e.md5 || !e.version) continue;
    entries.push({ ...e, requires: Array.isArray(e.requires) ? e.requires : [] });
  }
  return { entries, needsAppUpdate };
}

/**
 * 需要更新嗎？
 *
 * 版本字串只做相等比較，不做大小比較：模組版本是資料日期（`2026-08-26`）或上游
 * 版號（`1.10`），沒有共通的排序語意，而且「發現不一樣就重下整包」正是使用者
 * 選定的更新策略。`null` 代表還沒安裝——那是「下載」不是「更新」。
 */
export function datasetNeedsUpdate(
  installedVersion: string | null,
  remoteVersion: string,
): boolean {
  return installedVersion !== null && installedVersion !== remoteVersion;
}

/** 還沒安裝的相依模組（`tw-keys` 需要 `tw-taicol`）。 */
export function unmetRequirements(
  entry: Pick<DatasetManifestEntryLike, 'requires'>,
  installedIds: readonly string[],
): string[] {
  const installed = new Set(installedIds);
  return entry.requires.filter((need) => !installed.has(need));
}

/**
 * 安裝這個模組需要的可用空間：壓縮檔 + 解壓後的檔 + 緩衝。
 *
 * 兩份都要算：解壓完成、`replaceDataset` 換檔之前，zip 與 .db 會同時存在。
 */
export function spaceNeededFor(
  entry: Pick<DatasetManifestEntryLike, 'bytes' | 'uncompressedBytes'>,
  headroom: number,
): number {
  return entry.bytes + entry.uncompressedBytes + headroom;
}
