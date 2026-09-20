/**
 * Parsing and decision rules for the checklist-module manifest (pure logic).
 *
 * Like `mergeScope.ts` this deliberately depends on no native module:
 * `datasetInstall.ts` pulls in expo-file-system / fflate / zustand and cannot
 * run under Node, while the rules here are exactly the part most in need of
 * testing — they decide whether a manifest published early breaks an older app.
 *
 * Two forward-compatibility rules:
 *   1. **An unknown id is skipped**, not an error. The manifest may list a
 *      module that only the next release understands.
 *   2. A module whose `minAppSchema` exceeds this build is skipped too, but
 *      reported as `needsAppUpdate` so the screen can say "update the app first"
 *      instead of quietly showing one row fewer.
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
  /** Some module was skipped for being too new. */
  needsAppUpdate: boolean;
};

/**
 * Pick the modules this build of the app can use out of the manifest JSON.
 *
 * An entry missing `url` / `md5` / `version` counts as bad data and is skipped —
 * without any one of those the download cannot be verified, so it is better to
 * treat it as absent.
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
 * Does it need updating?
 *
 * Version strings are compared for equality only, never ordered: a module
 * version is either a data date (`2026-08-26`) or an upstream number (`1.10`),
 * which share no ordering semantics — and "anything different means re-download
 * the whole package" is precisely the update strategy that was chosen. `null`
 * means not installed yet, which is a download, not an update.
 */
export function datasetNeedsUpdate(
  installedVersion: string | null,
  remoteVersion: string,
): boolean {
  return installedVersion !== null && installedVersion !== remoteVersion;
}

/** Required modules that are not installed yet (`tw-keys` needs `tw-taicol`). */
export function unmetRequirements(
  entry: Pick<DatasetManifestEntryLike, 'requires'>,
  installedIds: readonly string[],
): string[] {
  const installed = new Set(installedIds);
  return entry.requires.filter((need) => !installed.has(need));
}

/**
 * Free space needed to install this module: the archive + the unpacked file +
 * headroom.
 *
 * Both have to be counted: between the end of extraction and `replaceDataset`
 * swapping the file in, the zip and the .db exist at the same time.
 */
export function spaceNeededFor(
  entry: Pick<DatasetManifestEntryLike, 'bytes' | 'uncompressedBytes'>,
  headroom: number,
): number {
  return entry.bytes + entry.uncompressedBytes + headroom;
}
