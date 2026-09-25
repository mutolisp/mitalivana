/**
 * "Take a photo or pick one" for GLORIA points and units. Camera shots go to
 * the photo library like plot environment photos; picked ones are copied into
 * the app (pickPhotos), so the stored URI outlives the picker's cache.
 * File names follow manual Annex III only in the export (export/photoNames).
 */
import i18n from '~/i18n';
import { showActionSheet } from '~/components/ActionSheet';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';

export async function pickGloriaPhoto(title: string, hasPhoto: boolean): Promise<string | null | 'remove'> {
  const options: Array<{ label: string; destructive?: boolean }> = [
    { label: i18n.t('gloria.photo.camera') },
    { label: i18n.t('gloria.photo.library') },
  ];
  if (hasPhoto) options.push({ label: i18n.t('gloria.photo.remove'), destructive: true });
  const idx = await showActionSheet({ title, options, cancelLabel: i18n.t('common.cancel') });
  if (idx === 0) return captureEnvPhoto();
  if (idx === 1) return (await pickPhotos())[0] ?? null;
  if (idx === 2 && hasPhoto) return 'remove';
  return null;
}
