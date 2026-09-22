/**
 * Reading a photo's metadata off the device.
 *
 * The parsing lives in `photoExif.ts`, which is pure and checked in Node. This
 * is the half that touches the filesystem and the photo library, kept apart so
 * the rules can be tested without either.
 */
import { readAsStringAsync } from 'expo-file-system/legacy';
import piexif from 'piexifjs';
import * as MediaLibrary from 'expo-media-library';
import { resolveAssetUri } from './bundleExport';
import { recallPhotoFix, rememberPhotoFix } from '~/db/photoFix';
import {
  metaFromExifDict,
  metaFromPickerExif,
  mergeMeta,
  type PhotoMeta,
} from './photoExif';

/**
 * Everything a photo can tell us, from whichever sources are available.
 *
 * `pickerExif` is `asset.exif` when the photo just came from the picker. It is
 * the ONLY source for a HEIC: piexif accepts JPEG, TIFF or a bare Exif blob and
 * throws on anything else, and an iPhone camera writes HEIC. So a failure to
 * parse the bytes is normal, not an error — it just means this photo has
 * whatever the picker gave us and nothing more.
 */
export async function readPhotoMeta(
  uri: string,
  pickerExif?: Record<string, unknown> | null,
): Promise<PhotoMeta> {
  const fromPicker = pickerExif ? metaFromPickerExif(pickerExif) : null;
  let fromBytes: PhotoMeta | null = null;
  try {
    const fileUri = await resolveAssetUri(uri);
    if (fileUri) {
      const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
      fromBytes = metaFromExifDict(piexif.load(`data:image/jpeg;base64,${b64}`));
    }
  } catch {
    // Unreadable, or not a format piexif knows. The picker half may still have
    // the answer; if it does not, the caller gets an empty PhotoMeta and says
    // so rather than inventing a position.
  }
  return mergeMeta(fromBytes, fromPicker);
}

/**
 * Store what a freshly picked batch said about itself, for every photo.
 *
 * Called right after the pick and unconditionally — NOT folded into
 * `firstPhotoFix`, which stops at the first photo carrying a position and is
 * itself only called when a record lacks one. Both of those would leave gaps:
 * a record that already had a coordinate would never cache anything, and the
 * second photo of a pick would be forgotten. Either way the user clears a
 * coordinate later and 「用照片的 GNSS 定位」 finds nothing.
 *
 * Reads only `asset.exif`, which the picker already handed over — no file I/O,
 * no photo-library permission, nothing that can fail slowly.
 */
export function rememberPickedPhotos(
  picked: { uri: string; exif?: Record<string, unknown> | null }[],
): void {
  for (const { uri, exif } of picked) {
    if (!exif) continue;
    const meta = metaFromPickerExif(exif);
    rememberPhotoFix(uri, meta);
  }
}

/** A coordinate read off a photo, and which photo it came from. */
export type PhotoFix = {
  lat: number;
  lng: number;
  /** Metres, when the photo stated it. Null means unknown — NOT zero, and not
   *  the accuracy of some other fix. */
  accuracyM: number | null;
  takenAt: number | null;
  uri: string;
};

export type PhotoFixOutcome =
  | { kind: 'found'; fix: PhotoFix }
  /** Every photo was readable and none carried a position. */
  | { kind: 'no-gnss' }
  /** Some photos live in the photo library and we may not open them. Distinct
   *  from `no-gps` because the answer is different: one is "the photo does not
   *  know", the other is "we were not allowed to ask". */
  | { kind: 'needs-photo-access' };

/** `ph://` (iOS) and `content://` (Android) need MediaLibrary to resolve;
 *  `file://` is our own copy and needs nothing. */
function needsLibrary(uri: string): boolean {
  return !uri.startsWith('file://');
}

/**
 * The first photo in the list that carries a position.
 *
 * First, not best: the photos are in the order the recorder attached them, and
 * the first is the one they took of the thing. Scanning for a "better" fix
 * would need a rule for choosing between two positions, and there is no honest
 * one.
 *
 * Deliberately does NOT call `ensurePhotosReadAccess()`. That requests the
 * permission, which presents a system dialog — and this runs from inside the
 * record detail sheet, which is a Modal. iOS refuses to present on a view
 * controller that is already presenting, and the whole presentation stack is
 * left broken afterwards:
 *
 *     Attempt to present <RCTFabricModalHostViewController> on
 *     <UIViewController> which is already presenting …
 *
 * So it reads what it may and reports the permission case back instead. Asking
 * belongs somewhere with no Modal on screen.
 */
/** A photo to inspect. A bare string is the stored URI; the object form also
 *  carries `asset.exif` from the picker, which is the ONLY source of a
 *  position for a HEIC — piexif cannot parse one at all, and an iPhone camera
 *  writes HEIC by default. Passing it also means no photo-library permission
 *  is needed, because nothing has to be resolved back to the library. */
export type PhotoFixSource = string | { uri: string; exif?: Record<string, unknown> | null };

export async function firstPhotoFix(sources: PhotoFixSource[]): Promise<PhotoFixOutcome> {
  const items = sources.map((s) => (typeof s === 'string' ? { uri: s, exif: null } : s));
  if (items.length === 0) return { kind: 'no-gnss' };
  let libraryGranted: boolean | null = null;
  let skipped = 0;
  for (const { uri, exif } of items) {
    // Only a stored URI has to be resolved through the library. When the
    // picker handed us the EXIF there is nothing to resolve and nothing to
    // ask permission for.
    if (!exif && needsLibrary(uri)) {
      if (libraryGranted === null) {
        // Reads the status; unlike requestPermissionsAsync it presents nothing.
        libraryGranted = (await MediaLibrary.getPermissionsAsync(false)).granted;
      }
      if (!libraryGranted) {
        skipped += 1;
        continue;
      }
    }
    const meta = await readPhotoMeta(uri, exif);
    if (meta.lat !== null && meta.lng !== null) {
      // Remember it now. For a HEIC this is the ONLY moment the position is
      // legible — `piexif` cannot parse one and the stored copy is unchanged —
      // so without this the same photo answers differently later, depending on
      // whether the picker's EXIF happens to still be in memory.
      rememberPhotoFix(uri, meta);
      return {
        kind: 'found',
        fix: {
          lat: meta.lat,
          lng: meta.lng,
          accuracyM: meta.accuracyM,
          takenAt: meta.takenAt,
          uri,
        },
      };
    }
    // Nothing legible right now — but this photo may have told us once.
    const remembered = recallPhotoFix(uri);
    if (remembered) {
      return {
        kind: 'found',
        fix: {
          lat: remembered.lat,
          lng: remembered.lng,
          accuracyM: remembered.accuracy,
          takenAt: remembered.takenAt,
          uri,
        },
      };
    }
  }
  return skipped > 0 ? { kind: 'needs-photo-access' } : { kind: 'no-gnss' };
}
