/**
 * Paths and state for mountain landmarks (POIs).
 *
 * 766,737 of them, from RudyMap's upstream source file
 * `MOI_OSM_Taiwan_TOPO_Rudy.poi`.
 *
 * **Independent of the map engine**: peaks, survey markers, trail signs, huts
 * and water sources have to show whether the basemap is Apple/Google or the
 * vector RudyMap. This used to hang off the raster tile package's install flow
 * and was pulled out when raster was retired — at 66 MB it has nothing to do
 * with the "tile packs are too big" concern.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { excludeFromBackup } from '../../modules/backup-exclusion';

const ROOT_DIR = 'poi';
const DB_NAME = 'rudypoi.db';
const STATE_FILE = 'installed.json';

/** Where POIs lived in the raster era. An upgrade has to move them, or the user
 *  re-downloads 66 MB. */
const LEGACY_DIR = 'rudymap';

export type PoiMeta = {
  name: string;
  installName: string;
  bytes: number;
  uncompressedBytes: number;
  poiCount: number;
  md5: string;
  sourceComment?: string;
};

export type PoiInstalled = {
  poiCount: number;
  bytes: number;
  installedAt: number;
  sourceComment?: string;
};

export function poiRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

export function poiDbFile(): File {
  return new File(poiRoot(), DB_NAME);
}

/**
 * Create the directory and mark it as excluded from backup on iOS.
 *
 * As with the tile package the flag is set **every time**: the native module may
 * arrive with a newer dev client after the data is installed, so setting it only
 * at creation would permanently miss everyone who installed earlier.
 */
export function ensurePoiRoot(): Directory {
  const root = poiRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  excludeFromBackup(root.uri);
  return root;
}

/**
 * For op-sqlite's `open({ name, location })`.
 *
 * Returns null when nothing is installed — the caller decides whether to query
 * rather than opening a database that is not there.
 */
export function poiLocation(): { name: string; location: string } | null {
  const f = poiDbFile();
  if (!f.exists) return null;
  return { name: DB_NAME, location: poiRoot().uri.replace(/\/$/, '') };
}

export function readPoiInstalled(): PoiInstalled | null {
  const f = new File(poiRoot(), STATE_FILE);
  if (!f.exists) return null;
  try {
    return JSON.parse(f.textSync()) as PoiInstalled;
  } catch {
    return null;
  }
}

export function writePoiInstalled(state: PoiInstalled): void {
  ensurePoiRoot();
  new File(poiRoot(), STATE_FILE).write(JSON.stringify(state));
}

export function isPoiReady(state: PoiInstalled | null): boolean {
  return state != null && poiDbFile().exists;
}

export function deletePoi(): void {
  const root = poiRoot();
  if (root.exists) root.delete();
}

/**
 * Migrate from the raster-era layout and clear out tiles no feature uses any
 * more.
 *
 * Both at once, because both are one-off upgrade actions:
 *
 * 1. `rudymap/rudypoi.db` → `poi/rudypoi.db`. Without the move the user
 *    re-downloads 66 MB.
 * 2. Delete all of `rudymap/` (tile packages reached 1.46 GB). The raster
 *    feature is gone and no UI entry point can delete it any more, so leaving it
 *    occupies that space forever. It is read-only, re-obtainable data, not
 *    user-generated content.
 *
 * Idempotent: does nothing when the old directory is absent.
 */
export function migrateFromRasterPack(): void {
  const legacy = new Directory(Paths.document, LEGACY_DIR);
  if (!legacy.exists) return;

  const oldDb = new File(legacy, DB_NAME);
  const target = poiDbFile();
  if (oldDb.exists && !target.exists) {
    ensurePoiRoot();
    try {
      oldDb.move(target);
    } catch {
      // If the move fails, carry on and delete anyway; re-downloading 66 MB beats
    // being stuck halfway.
    }
  }
  try {
    legacy.delete();
  } catch {
    // Failing to delete costs no functionality; the next launch tries again.
  }
}
