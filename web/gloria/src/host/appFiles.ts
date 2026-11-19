/**
 * Web replacement for mobile/app/src/lib/appFiles.ts.
 *
 * Web media lives in IndexedDB and is referenced as
 * `webmedia:(photos|files)/<name>` (see mediaStore.ts). Only that shape is
 * accepted for web URIs; anything else falls through to the mobile rule in
 * appMediaUriCore.ts (non-file: URIs pass, file: URIs have no web directory to
 * live in and are refused).
 */
import { isAllowedMediaUri } from '~/lib/appMediaUriCore';

export const WEB_MEDIA_SCHEME = 'webmedia:';
const WEB_MEDIA_RE = /^webmedia:(photos|files)\/[A-Za-z0-9._-]+$/;

export function isWebMediaUri(uri: string): boolean {
  return uri.startsWith(WEB_MEDIA_SCHEME);
}

export function rebaseAppFileUri(uri: string): string {
  return uri;
}

export function isAppMediaAllowed(uri: string): boolean {
  if (isWebMediaUri(uri)) return WEB_MEDIA_RE.test(uri) && !uri.includes('..');
  return isAllowedMediaUri(uri, { documentDirectory: null, cacheDirectory: null });
}

export function safeAppFileUri(uri: string): string | null {
  return isAppMediaAllowed(uri) ? uri : null;
}
