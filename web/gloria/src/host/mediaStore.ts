/**
 * Photos and attached files of the web app: Blobs in IndexedDB (store
 * `media`), referenced from the database as `webmedia:photos/<uuid>.<ext>`
 * or `webmedia:files/<uuid>.<ext>` — the shape host/appFiles.ts allows.
 *
 * Originals are kept byte for byte (no re-encode, EXIF intact). Thumbnails use
 * object URLs, cached and revoked when the cache is trimmed.
 */
import { idbDelete, idbGet, idbPut } from './persist';
import { WEB_MEDIA_SCHEME, isWebMediaUri } from './appFiles';

export type MediaKind = 'photos' | 'files';

const keyOf = (uri: string) => uri.slice(WEB_MEDIA_SCHEME.length);

function extOf(name: string, type: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (m) return m[1].toLowerCase();
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'application/pdf') return 'pdf';
  return 'bin';
}

/** Store a picked / captured file; returns its database URI. */
export async function putMedia(kind: MediaKind, file: Blob & { name?: string }): Promise<string> {
  const name = `${crypto.randomUUID()}.${extOf(file.name ?? '', file.type)}`;
  const uri = `${WEB_MEDIA_SCHEME}${kind}/${name}`;
  await idbPut('media', keyOf(uri), file);
  return uri;
}

export async function getMediaBlob(uri: string): Promise<Blob | null> {
  if (!isWebMediaUri(uri)) return null;
  return (await idbGet<Blob>('media', keyOf(uri))) ?? null;
}

/** Bytes of a stored media URI; null when it is not a web URI or is gone. */
export async function readMediaBytes(uri: string): Promise<Uint8Array | null> {
  const b = await getMediaBlob(uri);
  return b ? new Uint8Array(await b.arrayBuffer()) : null;
}

export async function deleteMedia(uri: string): Promise<void> {
  if (!isWebMediaUri(uri)) return;
  dropObjectUrl(uri);
  await idbDelete('media', keyOf(uri));
}

const urls = new Map<string, string>();
const MAX_URLS = 200;

function dropObjectUrl(uri: string): void {
  const u = urls.get(uri);
  if (u) URL.revokeObjectURL(u);
  urls.delete(uri);
}

/** An object URL for displaying a stored photo (null when missing). */
export async function mediaObjectUrl(uri: string): Promise<string | null> {
  const hit = urls.get(uri);
  if (hit) {
    // Refresh recency.
    urls.delete(uri);
    urls.set(uri, hit);
    return hit;
  }
  const b = await getMediaBlob(uri);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urls.set(uri, u);
  while (urls.size > MAX_URLS) dropObjectUrl(urls.keys().next().value as string);
  return u;
}
