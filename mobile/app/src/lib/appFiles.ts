/**
 * App-owned media files live under documentDirectory/photos/ (library picks,
 * see photoCapture.persistPickedPhoto), documentDirectory/audio/
 * (recordings) and documentDirectory/files/ (attached documents, fileAttach.ts). Their DB rows store the ABSOLUTE file:// URI — and on iOS the
 * absolute path contains the app container UUID, which changes on every
 * reinstall (a new dev-client build, a TestFlight update…). The files survive
 * (Documents is migrated), the stored path does not, and every thumbnail of a
 * picked photo goes blank while camera shots (`ph://` references) keep
 * working. Measured on 2026-09-15 after the native rebuild for expo-audio.
 *
 * So every READ of such a URI goes through this: re-anchor the trailing
 * `photos/<name>` / `audio/<name>` onto the current container. Android's
 * files dir is stable, so it is a no-op there; writes keep storing the
 * absolute URI, which stays correct for the current container and readable
 * by older builds.
 */
import { cacheDirectory, documentDirectory } from 'expo-file-system/legacy';
import { isAllowedMediaUri, rebaseOnto } from './appMediaUriCore';

export function rebaseAppFileUri(uri: string): string {
  return rebaseOnto(uri, documentDirectory);
}

/** Whether a stored media URI may be read, shared, uploaded or deleted (appMediaUriCore.ts). */
export function isAppMediaAllowed(uri: string): boolean {
  return isAllowedMediaUri(uri, { documentDirectory, cacheDirectory });
}

/**
 * For code that reads, shares, uploads or deletes a record's file: the
 * re-anchored URI, or null when the text points somewhere a record's media
 * never lives (the database, credentials, cache) — security audit S1.
 */
export function safeAppFileUri(uri: string): string | null {
  return isAppMediaAllowed(uri) ? rebaseAppFileUri(uri) : null;
}
