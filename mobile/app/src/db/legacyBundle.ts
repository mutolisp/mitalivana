/**
 * Retiring the legacy merged file (`Documents/twnamelist.db`, 160 MB).
 *
 * Before 0.5.0 the checklist shipped with the app as a single file. After
 * modularisation the user chose "require a fresh download" over adopting the old
 * file, so upgrading has to delete it — but **the order cannot change**:
 *
 *   1. user.db migration v35 (`taxon_name_cache`) — `initDb` has long since run
 *   2. `backfillNameCache()`: while the legacy file is **still there**, copy
 *      every name referenced by a record into user.db
 *   3. write the flag, confirming step 2 really finished
 *   4. only then delete `twnamelist.db` + `.version` (reclaiming 160 MB)
 *   5. the download wizard takes over
 *
 * Without step 2 the user's checklists are blank from the upgrade until the
 * download finishes — the easiest damage this change could do. **Deleting must
 * also come before downloading**: otherwise the peak requirement is 160 (old) +
 * 34 (zip) + 143 (unpacked) ≈ 337 MB free, and anyone with a full device fails
 * outright.
 *
 * Interruptible: the flag is only written after the backfill completes, so being
 * killed halfway means the next launch resumes from step 2 (the backfill is
 * idempotent and skips anything already cached).
 */
import { Directory, File, Paths } from 'expo-file-system';

import { closeAllDatasetDbs, loadDatasetManifest, type DatasetId } from './datasets';
import { getUserDb } from './init';
import { backfillNameCache } from './taxonCache';

const LEGACY_FILE = 'twnamelist.db';
const LEGACY_VERSION_FILE = 'twnamelist.db.version';
/** Modules that may live inside the legacy file. Keys are not among them: they
 *  have no taxa of their own, so no record references them. */
const LEGACY_NAME_DATASETS: DatasetId[] = ['tw-taicol', 'jp-ylist'];

/** The flag lives in user.db settings: it travels with a backup and disappears
 *  with "clear all data" — by which point the legacy file is long gone and the
 *  function returns at its first early exit. */
const FLAG_KEY = 'legacy_bundle_backfilled';

function legacyFile(): File {
  return new File(Paths.document, LEGACY_FILE);
}

function readFlag(): boolean {
  try {
    const res = getUserDb().executeSync(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [
      FLAG_KEY,
    ]);
    return ((res.rows ?? [])[0] as { value?: string } | undefined)?.value === 'true';
  } catch {
    return false;
  }
}

function writeFlag(): void {
  try {
    getUserDb().executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, 'true')`, [
      FLAG_KEY,
    ]);
  } catch {
    // If it cannot be written, treat the work as unfinished: the next launch runs
    // the backfill again (it is idempotent).
  }
}

export type LegacyRetirement = {
  /** This run actually retired it (true only on the first upgrade). */
  retired: boolean;
  /** Number of names copied into user.db. */
  cached: number;
  /** Referenced by a record but not found even in the legacy file (ids that
   *  disappeared across TaiCOL versions). */
  missing: number;
  /** Space reclaimed, in bytes. */
  freedBytes: number;
};

/**
 * The upgrade path: back up the names, then delete the legacy file. Does nothing
 * once the legacy file is gone.
 *
 * **Must be called after `runUserMigrations()`** (it needs `taxon_name_cache`)
 * and before any checklist query — at this point the registry still counts the
 * legacy file as installed, which is exactly how the backfill can read the names
 * at all.
 */
export function retireLegacyBundle(): LegacyRetirement {
  const idle: LegacyRetirement = { retired: false, cached: 0, missing: 0, freedBytes: 0 };
  const legacy = legacyFile();
  if (!legacy.exists) return idle;

  let cached = 0;
  let missing = 0;
  if (!readFlag()) {
    const impact = backfillNameCache(LEGACY_NAME_DATASETS);
    cached = impact.cached;
    missing = impact.missing;
    writeFlag();
  }

  const freedBytes = legacy.size ?? 0;
  // Close every checklist handle first: the legacy file may be open right now
  // (the registry points all three modules at it).
  closeAllDatasetDbs();
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const f = new File(Paths.document, `${LEGACY_FILE}${suffix}`);
      if (f.exists) f.delete();
    }
    const versionFile = new File(Paths.document, LEGACY_VERSION_FILE);
    if (versionFile.exists) versionFile.delete();
  } catch (e) {
    // 刪不掉不是災難：名稱已經備份好了，下次啟動再試一次。
    console.warn('[legacyBundle] delete failed:', e);
    return { retired: false, cached, missing, freedBytes: 0 };
  }

  // 安裝清單裡那三筆都指向已經不存在的檔案，重讀時會被對帳掉 → 回到「未安裝」，
  // 首次啟動精靈接手。
  loadDatasetManifest();
  return { retired: true, cached, missing, freedBytes };
}

/** 舊的 asset 解壓副本（Android 會把 bundle 內的 DB 解到 cache）。拆掉內建之後
 *  那份也沒用了，順手清掉。找不到就什麼都不做。 */
export function purgeLegacyAssetCache(): void {
  try {
    const dir = new Directory(Paths.cache, 'ExponentAsset');
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.endsWith('.db')) entry.delete();
    }
  } catch {
    // cache 清理失敗完全無所謂
  }
}
