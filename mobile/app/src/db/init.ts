import i18n from '~/i18n';
import { migrateFromRasterPack } from '~/lib/poi';
import { repairLocalStyle } from '~/lib/vectormapInstall';
import { File, Paths } from 'expo-file-system';
import { open, type DB } from '@op-engineering/op-sqlite';
import { adoptLegacyBundle, closeAllDatasetDbs, loadDatasetManifest } from './datasets';
import { purgeLegacyAssetCache, retireLegacyBundle } from './legacyBundle';
import { runUserMigrations } from './migrations';
import { enforceSingleActiveOnStartup, purgeOrphanRows } from './cleanup';

let userDb: DB | null = null;

const USER_DB_NAME = 'user.db';

export type InitProgressFn = (step: string) => void;

export async function initDb(onProgress?: InitProgressFn): Promise<{ user: DB }> {
  // Checklist handles are no longer held here (see `datasets.ts`), so the return
  // value is user.db alone.
  if (userDb) return { user: userDb };

  onProgress?.(i18n.t('splash.opening'));
  // Checklists no longer ship with the app: the install list is authoritative,
  // and absent means absent (the download wizard takes over).
  // `adoptLegacyBundle()` stays so a device mid-upgrade can still resolve names
  // until `retireLegacyBundle()` removes the legacy file — that is what the
  // backfill reads from.
  loadDatasetManifest();
  adoptLegacyBundle();
  userDb = open({ name: USER_DB_NAME, location: Paths.document.uri });

  // Migrations and the repair passes run with FK enforcement OFF, then it is
  // switched on for the rest of the session. Order matters both ways:
  //
  //  - OFF during migrations: restoreBackup() re-runs migrations against a
  //    restored older-schema DB, and with FK on, v3's `ALTER TABLE sites
  //    RENAME` rewrites plot_surveys' REFERENCES clause and its DROP fires
  //    ON DELETE SET NULL across every plot. Destructive.
  //  - OFF during cleanup: purgeOrphanRows/repair fix rows that currently have
  //    dangling references. SQLite validates FK on every row it modifies, so
  //    with FK already on, updating such a row would throw instead of healing.
  //  - ON afterwards: this is what finally makes ON DELETE CASCADE / SET NULL
  //    actually fire. Every cascade in the schema was inert before this line
  //    landed; the delete helpers still remove children explicitly as a
  //    belt-and-braces, not because the cascades are missing.
  userDb.executeSync('PRAGMA foreign_keys = OFF;');

  onProgress?.(i18n.t('splash.migrating'));
  await runUserMigrations(userDb);

  onProgress?.(i18n.t('splash.cleanup'));
  // The upgrade path: the old 160 MB merged file has to go. **Always after the
  // migrations** (it needs v35's `taxon_name_cache`), and it is "back up the
  // names first, then delete" — the other order leaves the user's checklists
  // blank for a while.
  // A no-op on every launch but the first upgrade.
  const retired = retireLegacyBundle();
  if (retired.retired) {
    purgeLegacyAssetCache();
    console.log(
      `[db] legacy bundle retired: cached ${retired.cached} names, ` +
        `${retired.missing} unresolvable, freed ${(retired.freedBytes / 1e6).toFixed(0)} MB`,
    );
  }

  // Idempotent: mops up any leftover multi-active records from older builds.
  enforceSingleActiveOnStartup();
  purgeOrphanRows();
  // Moves the landmark DB out of the old raster tile pack's directory and drops
  // that directory (up to 1.46 GB of tiles for a feature that no longer exists,
  // with no UI left to remove it). Idempotent; no-op once the dir is gone.
  migrateFromRasterPack();
  // Rewrites the offline map style's absolute file:// paths to the current app
  // container and moves glyphs under their fontstack directory. Purely local and
  // idempotent; without it a reinstall leaves a style pointing at a dead UUID and
  // the map renders blank.
  repairLocalStyle();

  userDb.executeSync('PRAGMA foreign_keys = ON;');
  if (__DEV__) {
    // Report, never auto-delete: a surviving violation is a bug to look at,
    // not something to silently destroy user data over.
    const bad = userDb.executeSync('PRAGMA foreign_key_check;');
    const n = bad.rows?.length ?? 0;
    if (n > 0) console.warn(`[db] ${n} foreign-key violation(s) remain`, bad.rows);
  }

  return { user: userDb };
}

export function getUserDb(): DB {
  if (!userDb) throw new Error('User DB not initialized — call initDb() first');
  return userDb;
}

let txDepth = 0;

/**
 * Run `fn` inside a single SQLite transaction on the user DB.
 *
 * op-sqlite's own `db.transaction()` is async (its `execute` returns a
 * Promise), so it can't wrap the synchronous `executeSync` call sites the DB
 * layer is built on — hence explicit BEGIN/COMMIT here.
 *
 * Reentrant by depth counter: SQLite rejects a nested BEGIN, so an inner call
 * just joins the outer transaction. `fn` must stay synchronous — awaiting
 * inside would hold the write lock across the event loop.
 *
 * This is for multi-statement writes that must not half-apply (record import
 * deletes the previous copy before inserting the new one). Migrations
 * deliberately stay outside it: they rely on idempotent replay instead.
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getUserDb();
  if (txDepth > 0) return fn();
  db.executeSync('BEGIN IMMEDIATE;');
  txDepth = 1;
  try {
    const out = fn();
    db.executeSync('COMMIT;');
    return out;
  } catch (e) {
    try {
      db.executeSync('ROLLBACK;');
    } catch {
      // already rolled back by SQLite (e.g. a fatal statement error)
    }
    throw e;
  } finally {
    txDepth = 0;
  }
}

export function closeDbs(): void {
  // 名錄 handle 由 registry 持有（過渡期可能有多個模組共用同一個檔），
  // 所以關閉的責任也在那裡。
  closeAllDatasetDbs();
  userDb?.close();
  userDb = null;
}

/**
 * Wipe every user table and rebuild an empty DB. TaiCOL DB is untouched.
 *
 * Implemented as delete-the-file rather than a list of DROP TABLEs, because
 * the list is exactly what went wrong before: it named 9 tables (one of them,
 * `abundance_records`, never existed) while the schema had 16, so 樣區 / 樣點 /
 * 常用名錄 / 常用調查者 all survived "清除所有資料". Worse, it also dropped
 * `schema_version`, so migrations replayed from v1 against the surviving
 * tables and died at v6 on `duplicate column name: plot_type`, leaving a
 * half-migrated DB that bricked the app on the next launch with no route to
 * the restore screen.
 *
 * Deleting the file cannot miss a table and needs no maintenance when a new
 * one is added. This is the same sequence `restoreBackup` already uses
 * (backup.ts), which is proven in production.
 */
export async function clearAllUserData(): Promise<void> {
  // Release op-sqlite handles before unlinking the file on disk.
  closeDbs();

  const dest = new File(Paths.document, USER_DB_NAME);
  if (dest.exists) dest.delete();
  // Stale journal sidecars would otherwise replay rows back into the new file.
  for (const sidecar of [`${USER_DB_NAME}-wal`, `${USER_DB_NAME}-shm`]) {
    const f = new File(Paths.document, sidecar);
    if (f.exists) f.delete();
  }

  // Re-open and migrate from scratch; initDb() re-seeds the 未分類 project.
  await initDb();
}
