/**
 * Estimate the on-disk size of an export bundle BEFORE doing the actual zip.
 *
 * Used by the multi-select export flow to surface a warning when the user
 * picks N records whose photos add up to hundreds of MB.
 *
 * Strategy:
 *  - Photos: query `MediaLibrary.getAssetInfoAsync` for each asset and read
 *    `fileSize` when available. PHAsset on iOS exposes this; Android usually
 *    does too. Falls back to a 3 MB-per-photo heuristic when unknown.
 *  - Text artefacts (yml / csv / md / geo): cheap approximation — 1 KB per
 *    record. We never block on these because they're dwarfed by photos.
 */
import { censusExportSizeInput } from '~/survey/db/stemmap';
import { getUserDb } from '~/db/init';
import { File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { listPending, listPlotSpecies, listSessionRecords, listSpecimens } from '~/db';
import { mediaAssetTarget, type BundleItem } from './bundleExport';
import { rebaseAppFileUri } from './appFiles';

const PHOTO_FALLBACK_BYTES = 3 * 1024 * 1024; // 3 MB per photo when size unknown
const TEXT_BYTES_PER_RECORD = 1024; // 1 KB per record for yml+csv+md combined

function parsePhotoUris(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    // ignore
  }
  return [];
}

async function photoBytes(uri: string): Promise<number> {
  // App-owned files are on disk — read the size directly instead of going
  // through the media library, which doesn't know about them at all.
  if (uri.startsWith('file://')) {
    try {
      const size = new File(rebaseAppFileUri(uri)).size;
      if (typeof size === 'number' && size > 0) return size;
    } catch {
      // fall through to fallback
    }
    return PHOTO_FALLBACK_BYTES;
  }

  // `getAssetInfoAsync` takes a bare localIdentifier / MediaStore id, not the
  // prefixed URI. This used to pass `uri` straight through, so on iOS every
  // `ph://` photo threw and the estimate silently became 3 MB × n.
  const { assetId } = mediaAssetTarget(uri);
  if (!assetId) return PHOTO_FALLBACK_BYTES;
  try {
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    // MediaLibrary.AssetInfo doesn't strictly type `fileSize` across platforms
    // but the underlying native module returns it when available.
    const size = (info as unknown as { fileSize?: number }).fileSize;
    if (typeof size === 'number' && size > 0) return size;
  } catch (e) {
    if (__DEV__) console.warn('[exportSize] getAssetInfoAsync failed', uri, e);
  }
  return PHOTO_FALLBACK_BYTES;
}

async function recordsPhotoBytes(records: { photo_paths: string | null }[]): Promise<number> {
  let total = 0;
  for (const r of records) {
    for (const uri of parsePhotoUris(r.photo_paths)) {
      total += await photoBytes(uri);
    }
  }
  return total;
}

export type SizeEstimate = {
  totalBytes: number;
  photoBytes: number;
  textBytes: number;
  photoCount: number;
  recordCount: number;
};

export async function estimateBundleSize(
  items: BundleItem[],
  /** withPending: the unassigned project's export carries pending observations (code review L59). */
  opts: { includePhotos: boolean; withPending?: boolean },
): Promise<SizeEstimate> {
  let totalPhotoBytes = 0;
  let photoCount = 0;
  let recordCount = 0;

  for (const it of items) {
    if (it.kind === 'modular') {
      // A checklist / plot-style survey: an occurrence stands for a record; photos and recordings are fw_media rows.
      const db = getUserDb();
      recordCount += Number((db.executeSync(`SELECT COUNT(*) AS n FROM fw_occurrences WHERE survey_id = ?`, [it.id]).rows?.[0] as { n: number } | undefined)?.n ?? 0);
      const media = (db.executeSync(`SELECT uri FROM fw_media WHERE survey_id = ? AND kind = 'photo'`, [it.id]).rows ?? []) as { uri: string }[];
      photoCount += media.length;
      if (opts.includePhotos) totalPhotoBytes += await recordsPhotoBytes(media.map((m) => ({ photo_paths: JSON.stringify([m.uri]) })));
      continue;
    }
    if (it.kind === 'perm_survey') {
      // A census: its photos are rows of their own; a tree stands for a record.
      const c = censusExportSizeInput(it.id);
      recordCount += c.trees;
      photoCount += c.photos.length;
      if (opts.includePhotos) totalPhotoBytes += await recordsPhotoBytes(c.photos);
      continue;
    }
    const records: { photo_paths: string | null }[] =
      it.kind === 'session'
        ? listSessionRecords(it.id)
        : it.kind === 'collection'
          ? listSpecimens(it.id)
          : it.kind === 'plot'
            ? listPlotSpecies(it.id)
            : []; // GLORIA: no photos in the bundle yet; its size is text only
    recordCount += records.length;
    photoCount += records.flatMap((r) => parsePhotoUris(r.photo_paths)).length;
    if (opts.includePhotos) totalPhotoBytes += await recordsPhotoBytes(records);
  }
  if (opts.withPending) {
    const pending = listPending();
    recordCount += pending.length;
    photoCount += pending.flatMap((r) => parsePhotoUris(r.photo_paths)).length;
    if (opts.includePhotos) totalPhotoBytes += await recordsPhotoBytes(pending);
  }

  const textBytes = recordCount * TEXT_BYTES_PER_RECORD;
  return {
    totalBytes: totalPhotoBytes + textBytes,
    photoBytes: totalPhotoBytes,
    textBytes,
    photoCount,
    recordCount,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
