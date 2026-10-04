/**
 * Photos for a species record, the 快速名錄 way (moved out of the checklist
 * screen for 2G, so a survey built from a template adds photos the same way):
 * the camera writes the species and a fresh fix into the file it saves; the
 * library keeps the picker's EXIF, the only place a HEIC's position is
 * legible, for `firstPhotoFix`.
 */
import { captureAndSavePhoto, pickPhotosWithExif, type PhotoSpeciesContext, type PickedPhoto } from '~/lib/photoCapture';
import { rememberPickedPhotos } from '~/lib/photoMeta';

/** The photos taken or picked (none when cancelled). */
export async function takeSpeciesPhotos(ctx: PhotoSpeciesContext, mode: 'camera' | 'library'): Promise<PickedPhoto[]> {
  let picked: PickedPhoto[] = [];
  if (mode === 'camera') {
    const uri = await captureAndSavePhoto(ctx);
    // The camera path already stamps a fresh fix into the file it writes,
    // so its EXIF is on disk and readable; nothing to carry separately.
    if (uri) picked = [{ uri, exif: null }];
  } else {
    // `pickPhotosWithExif`, not `pickPhotos`: adding a photo to an existing
    // record used to throw the EXIF away, so a record created first and
    // photographed second never got the coordinate that the SAME photo
    // would have supplied through the import flow. The picker's exif map is
    // also the only place a HEIC's position is legible.
    picked = await pickPhotosWithExif();
  }
  // Unconditional: see rememberPickedPhotos for why this cannot live inside
  // the 'record has no coordinate' branch of the caller.
  if (picked.length) rememberPickedPhotos(picked);
  return picked;
}
