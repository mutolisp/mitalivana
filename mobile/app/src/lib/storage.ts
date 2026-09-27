/**
 * What the app keeps on the device, and what can safely go.
 *
 * iOS counts the whole container as "Documents & Data": Documents/ AND
 * Library/Caches (Paths.cache). Everything the app writes to the cache is
 * disposable — finished export / backup zips, the image picker's full-size
 * originals, document-picker copies, install staging files — except while an
 * install or download is writing there, so clearing waits for those.
 *
 * Documents/photos and Documents/audio hold files that records point to. A
 * file there is an orphan only when no record names it; matching is by file
 * NAME, because stored absolute paths go stale on reinstall (appFiles.ts).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { referencedMediaNames } from '~/db/media';
import { retireLegacyBundle } from '~/db/legacyBundle';
import { isDatasetInstallRunning } from './datasetInstall';
import { usePackDownloads } from './gbifDownload';
import { isPoiRunning } from './poiInstall';
import { isVectorRunning } from './vectormapInstall';

export type Orphans = { files: File[]; bytes: number };

/** Files in Documents/photos, audio and files that no record names. */
export function findMediaOrphans(): Orphans {
  const keep = referencedMediaNames();
  const files: File[] = [];
  let bytes = 0;
  for (const sub of ['photos', 'audio', 'files']) {
    const dir = new Directory(Paths.document, sub);
    if (!dir.exists) continue;
    for (const f of dir.list()) {
      if (!(f instanceof File) || keep.has(f.name)) continue;
      files.push(f);
      bytes += f.size ?? 0;
    }
  }
  return { files, bytes };
}

export function deleteFiles(files: File[]): number {
  let n = 0;
  for (const f of files) {
    try {
      if (f.exists) {
        f.delete();
        n += 1;
      }
    } catch {
      // Gone already or locked: leave it for next time.
    }
  }
  return n;
}

/** An install or download is writing to the cache right now. */
export function cacheBusy(): boolean {
  return (
    isDatasetInstallRunning() ||
    isVectorRunning() ||
    isPoiRunning() ||
    Object.keys(usePackDownloads.getState().progress).length > 0
  );
}

export function dirSize(dir: Directory): number {
  try {
    return dir.exists ? (dir.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** Empty Library/Caches (and expo-image's disk cache). Returns the bytes freed. */
export async function clearCache(): Promise<number> {
  const root = new Directory(Paths.cache);
  const before = dirSize(root);
  for (const e of root.exists ? root.list() : []) {
    try {
      e.delete();
    } catch {
      // In use by the system (e.g. a share sheet still reading it): skip.
    }
  }
  try {
    await Image.clearDiskCache();
  } catch {
    // Not fatal; its files were under Caches anyway.
  }
  return Math.max(0, before - dirSize(root));
}

/** Recovery copies made before automatic repairs (cleanup.ts createSafetySnapshot). */
export function safetyBackups(): File[] {
  const root = new Directory(Paths.document);
  if (!root.exists) return [];
  return root.list().filter((e): e is File => e instanceof File && /^safety-backup-.*\.db$/.test(e.name));
}

/** Where team merge keeps the record as it was before each merge (teamMergeFlow.ts). */
export const MERGE_BACKUP_DIR = 'merge-backups';

/** Pre-merge backups, newest first (names start with the UTC timestamp). */
export function mergeBackups(): File[] {
  const dir = new Directory(Paths.document, MERGE_BACKUP_DIR);
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((e): e is File => e instanceof File && e.name.endsWith('.zip'))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * `2026-09-26T11-05-00-123Z_GLORIA_TW-DAS-SUN_mocy5.zip` → when and what.
 * The timestamp is `toISOString()` with `:` and `.` made filename-safe.
 */
export function mergeBackupInfo(name: string): { at: number | null; label: string } {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.zip$/);
  if (!m) return { at: null, label: name.replace(/\.zip$/, '') };
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return { at: Number.isFinite(at) ? at : null, label: m[6] };
}

/** Leftovers of retired storage that a failed launch-time delete may have kept. */
export function legacyLeftovers(): Array<File | Directory> {
  const out: Array<File | Directory> = [];
  const raster = new Directory(Paths.document, 'rudymap');
  if (raster.exists) out.push(raster);
  for (const n of ['twnamelist.db', 'twnamelist.db.version']) {
    const f = new File(Paths.document, n);
    if (f.exists) out.push(f);
  }
  return out;
}

/**
 * Remove the leftovers. The legacy checklist goes through retireLegacyBundle,
 * which copies the names records use into user.db before deleting — never a
 * plain delete. The raster map folder has no such dependency.
 */
export function removeLegacyLeftovers(): void {
  retireLegacyBundle();
  const raster = new Directory(Paths.document, 'rudymap');
  if (raster.exists) raster.delete();
}

export function sizeOf(e: File | Directory): number {
  return e instanceof File ? (e.size ?? 0) : dirSize(e);
}
