/**
 * Which stored media URIs the app may read, share, upload or delete
 * (security audit S1, 2026-09-28). Pure, so check:media-uri runs it in Node
 * against made-up Android and iOS directories.
 *
 * Records keep photo / audio / file URIs as text, and some of that text comes
 * from outside: an imported GLORIA file, a restored backup, a teammate. A URI
 * pointing at `user.db` or the credentials file would otherwise be packed
 * into the next export, uploaded or deleted. The rule:
 *   - not `file:` (ph://, content://): resolved through the media library, fine;
 *   - inside the app's own storage (Documents, cache, the app's data root, any
 *     iOS app container): only `Documents/(photos|audio|files)/<name>`;
 *   - elsewhere (Android shared storage, where camera photos saved to the
 *     gallery live as file:///storage/emulated/0/DCIM/…): fine — reachable
 *     only with the user's media permission, never the app's private files;
 *   - anything with `..`, a backslash or an undecodable escape: never.
 */

export type AppDirs = { documentDirectory: string | null; cacheDirectory: string | null };

const APP_FILE_RE = /\/(photos|audio|files)\/([^/]+)$/;
const MEDIA_NAME_RE = /^(photos|audio|files)\/[^/]+$/;
const OLD_IOS_MEDIA_RE = /\/Containers\/Data\/Application\/[^/]+\/Documents\/(photos|audio|files)\/[^/]+$/;
// Private app storage on either platform, whichever app it belongs to.
const PRIVATE_MARKERS = ['/data/data/', '/data/user/', '/data/user_de/', '/Containers/Data/Application/', '/Containers/Shared/AppGroup/'];

/** Re-anchor `…/photos|audio|files/<name>` from an older iOS container onto the current one (appFiles.ts). */
export function rebaseOnto(uri: string, documentDirectory: string | null): string {
  if (!documentDirectory || !uri.startsWith('file:') || uri.startsWith(documentDirectory)) return uri;
  const m = APP_FILE_RE.exec(uri);
  return m ? `${documentDirectory}${m[1]}/${m[2]}` : uri;
}

/** The directory holding Documents (`files/` on Android): the app's data root. */
function appRoot(documentDirectory: string): string {
  return documentDirectory.replace(/[^/]+\/?$/, '');
}

export function isAllowedMediaUri(uri: string, dirs: AppDirs): boolean {
  if (!uri.startsWith('file:')) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return false;
  }
  if (/(^|\/)\.\.?(\/|$)/.test(decoded.replace(/^file:\/\//, '')) || decoded.includes('\\') || decoded.includes('\0')) return false;
  const doc = dirs.documentDirectory;
  if (doc && uri.startsWith(doc)) return MEDIA_NAME_RE.test(uri.slice(doc.length));
  const inside = [doc && appRoot(doc), dirs.cacheDirectory].some((d) => !!d && decoded.startsWith(decodeURIComponent(d)));
  if (inside || PRIVATE_MARKERS.some((m) => decoded.includes(m))) {
    // Private storage: only an earlier iOS container's media folder, which
    // rebaseOnto re-anchors onto this one. Nothing else in an app's own
    // storage (this app's or another's) is ever a record's media.
    return OLD_IOS_MEDIA_RE.test(decoded);
  }
  return true;
}

/**
 * A stored media field with the disallowed URIs taken out: a single URI, or a
 * JSON array of URIs or of `{uri, …}` objects (photo lists, FileRef[],
 * overview photos). Unparseable JSON is dropped rather than kept.
 */
export function sanitizeMediaField(value: string | null | undefined, allow: (uri: string) => boolean): string | null {
  if (value == null || value === '') return value ?? null;
  const t = value.trim();
  if (!t.startsWith('[')) return allow(t) ? value : null;
  let list: unknown;
  try {
    list = JSON.parse(t);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const kept = list.filter((it) => {
    const uri = typeof it === 'string' ? it : (it as { uri?: unknown } | null)?.uri;
    return typeof uri === 'string' && allow(uri);
  });
  return kept.length === list.length ? value : JSON.stringify(kept);
}
