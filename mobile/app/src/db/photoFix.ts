/**
 * Where a picked photo said it was taken (v41).
 *
 * A cache, not a source of truth. It exists because a HEIC's position is
 * legible exactly once — when `ImagePicker` hands over `asset.exif`. `piexif`
 * cannot parse HEIC at all, and `persistPickedPhoto` copies the file unchanged,
 * so after the pick the position was unreadable from disk. (`heifExifSegment`
 * now reads a HEIC's own Exif item, so the file is a second source; this cache
 * still covers anything that parser rejects and photos resolved through the
 * library without permission.)
 *
 * That asymmetry produced a real defect: attaching a photo filled in a missing
 * coordinate, but clearing the coordinate and pressing 「用照片的 GNSS 定位」
 * found nothing — the same photo, answered differently depending on whether the
 * app still had the picker's EXIF in memory.
 *
 * Losing a row costs a coordinate that has to be entered again; it never costs
 * a record. Nothing reads this to decide what a record IS.
 */
import { getUserDb } from './init';

export type StoredPhotoFix = {
  lat: number;
  lng: number;
  /** Metres, when the photo stated it. Null means unknown — not zero. */
  accuracy: number | null;
  takenAt: number | null;
};

/**
 * Remember what a photo said, if it said anything positional.
 *
 * Photos without a position are deliberately not stored: an empty row and a
 * missing row would mean the same thing, and writing one per photo would grow
 * the table for no answer.
 */
export function rememberPhotoFix(
  uri: string,
  fix: { lat: number | null; lng: number | null; accuracyM: number | null; takenAt: number | null },
): void {
  if (fix.lat === null || fix.lng === null) return;
  getUserDb().executeSync(
    `INSERT INTO photo_fix (uri, lat, lng, accuracy, taken_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       lat = excluded.lat, lng = excluded.lng,
       accuracy = excluded.accuracy, taken_at = excluded.taken_at`,
    [uri, fix.lat, fix.lng, fix.accuracyM, fix.takenAt, Date.now()],
  );
}

/** What this photo said, or null if it never told us. */
export function recallPhotoFix(uri: string): StoredPhotoFix | null {
  const res = getUserDb().executeSync(
    `SELECT lat, lng, accuracy, taken_at FROM photo_fix WHERE uri = ?`,
    [uri],
  );
  const row = (res.rows ?? [])[0] as
    | { lat: number; lng: number; accuracy: number | null; taken_at: number | null }
    | undefined;
  if (!row || row.lat === null || row.lng === null) return null;
  return { lat: row.lat, lng: row.lng, accuracy: row.accuracy, takenAt: row.taken_at };
}

/** Drop what we remembered about photos that no record references any more.
 *  Called from the same startup cleanup that prunes orphaned media files. */
export function pruneOrphanPhotoFixes(referenced: Set<string>): number {
  const db = getUserDb();
  const res = db.executeSync(`SELECT uri FROM photo_fix`);
  const rows = (res.rows ?? []) as unknown as { uri: string }[];
  let removed = 0;
  for (const r of rows) {
    if (referenced.has(r.uri)) continue;
    db.executeSync(`DELETE FROM photo_fix WHERE uri = ?`, [r.uri]);
    removed += 1;
  }
  return removed;
}
