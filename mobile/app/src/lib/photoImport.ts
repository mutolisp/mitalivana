/**
 * Turning a pile of picked photos into checklist records.
 *
 * One record per photo. A checklist normally holds a species once, but a photo
 * import is not a checklist entry — it is a set of occurrences, each with its
 * own coordinate and time, and collapsing them would throw away the positions
 * that were the reason to import photos at all. (The checklist DOCUMENT still
 * shows each species once; see checklistIdentity.ts.)
 *
 * The planning half is pure so the rules below can be checked in Node. Reading
 * files and writing rows is the caller's job.
 */
import type { PhotoMeta } from './photoExif';

/** What the flow knows about one picked photo before anything is written. */
export type PhotoPlanItem = {
  uri: string;
  meta: PhotoMeta;
  /** Taxon the photo names itself, when this app exported it. */
  embeddedTaxonId: string | null;
  hasCoords: boolean;
};

export type PhotoPlan = {
  items: PhotoPlanItem[];
  /** Photos that named their own taxon and need no choice from the user. */
  resolvedCount: number;
  /** Photos that will take whatever species the user picks for the batch. */
  needsTaxonCount: number;
  withCoords: number;
  withoutCoords: number;
};

export function planPhotoImport(
  photos: { uri: string; meta: PhotoMeta }[],
): PhotoPlan {
  const items = photos.map(({ uri, meta }) => ({
    uri,
    meta,
    embeddedTaxonId: meta.embedded?.taxon_id ?? null,
    hasCoords: meta.lat !== null && meta.lng !== null,
  }));
  return {
    items,
    resolvedCount: items.filter((i) => i.embeddedTaxonId !== null).length,
    needsTaxonCount: items.filter((i) => i.embeddedTaxonId === null).length,
    withCoords: items.filter((i) => i.hasCoords).length,
    withoutCoords: items.filter((i) => !i.hasCoords).length,
  };
}

/** What to do with photos that carry no position of their own. */
export type MissingCoordPolicy =
  /** Leave the record without one. The default, because for occurrence data a
   *  wrong coordinate is worse than no coordinate — and you are importing from
   *  the library precisely because you are no longer there. */
  | { kind: 'leave-empty' }
  /** Stamp a position the user supplied, with its measured accuracy when there
   *  is one. Never silently: the UI has to say this is not the photo's own fix. */
  | { kind: 'fixed'; lat: number; lng: number; accuracyM: number | null };

/** One row, ready for `addRecord`. */
export type PlannedRecord = {
  taxon_id: string;
  observed_at: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  photo_paths: string;
};

/**
 * Resolve each photo to a row.
 *
 * `fallbackTaxonId` is the one species the user chose for everything that did
 * not name itself. Photos with neither an embedded taxon nor a fallback are
 * dropped — a record with no taxon is not a record.
 *
 * `takenAt` falls back to import time only when the photo has no
 * DateTimeOriginal at all. That is a real loss and the UI should say so, but
 * refusing the photo would be worse.
 */
export function buildPlannedRecords(
  plan: PhotoPlan,
  fallbackTaxonId: string | null,
  policy: MissingCoordPolicy,
  now: number,
): PlannedRecord[] {
  const out: PlannedRecord[] = [];
  for (const item of plan.items) {
    const taxonId = item.embeddedTaxonId ?? fallbackTaxonId;
    if (!taxonId) continue;
    const coords = item.hasCoords
      ? { lat: item.meta.lat, lng: item.meta.lng, accuracy: item.meta.accuracyM }
      : policy.kind === 'fixed'
        ? { lat: policy.lat, lng: policy.lng, accuracy: policy.accuracyM }
        : { lat: null, lng: null, accuracy: null };
    out.push({
      taxon_id: taxonId,
      observed_at: item.meta.takenAt ?? now,
      lat: coords.lat,
      lng: coords.lng,
      accuracy: coords.accuracy,
      photo_paths: JSON.stringify([item.uri]),
    });
  }
  // Oldest first, so the imported rows read in the order they were taken and
  // the checklist's "first occurrence" is the earliest sighting.
  return out.sort((a, b) => a.observed_at - b.observed_at);
}
