/**
 * Files over the team relay — phase 0 of docs/planned/Media_sync.md: one file
 * up and back in sealed 4 MiB chunks, timed, so the design can be checked on
 * real phones before anything is built on it.
 *
 *   - The file's server name is keyed on its content (mediaId), so a file is
 *     read twice: once to hash it, once to seal and send it.
 *   - Chunks are read with a FileHandle, never the whole file at once.
 *   - Sealed chunks go through a cache file and createUploadTask as binary
 *     (the record path sends base64url text, a third larger).
 *   - Chunks already on the server are skipped, so a broken upload resumes.
 *
 * Only `file://` URIs: photo-library references are resolved by the caller.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { File, Paths } from 'expo-file-system';
import { FileSystemUploadType, createUploadTask, downloadAsync } from 'expo-file-system/legacy';
import { fetchText } from './apiFetch';
import { MEDIA_CHUNK_BYTES, NONCE_BYTES, chunkAad, chunkCount, mediaId, openChunk, sealChunk } from './teamCrypto';
import { TeamSyncError, asSyncError, checkServer, keysOf, randomBytes, serverOf } from './teamSync';

export type Progress = (stage: 'hash' | 'upload' | 'download', done: number, total: number) => void;

export type UploadResult = {
  mid: string;
  count: number;
  size: number;
  sha256: string;
  /** Chunks the server already had (a resumed upload). */
  skipped: number;
  ms: { hash: number; seal: number; upload: number };
  heapPeak: number | null;
};

export type DownloadResult = {
  uri: string;
  size: number;
  sha256: string;
  ms: { download: number; open: number };
  heapPeak: number | null;
};

const base = (server: string) => server.replace(/\/+$/, '');

// Hermes reports its heap; other engines give null.
type HermesStats = { js_heapSize?: number };
function heapNow(): number | null {
  const h = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => HermesStats } }).HermesInternal;
  return h?.getInstrumentedStats?.().js_heapSize ?? null;
}
const peak = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

/** Whether the team's server accepts files (only self-hosted servers do). */
export async function mediaEnabled(teamId: string): Promise<boolean> {
  const { team } = await keysOf(teamId);
  return (await checkServer(serverOf(team))).limits?.mediaEnabled === 1;
}

/** SHA-256 and size of a file, read chunk by chunk. */
export function hashFile(uri: string, onChunk?: (done: number, total: number) => void): { sha: Uint8Array; size: number } {
  const file = new File(uri);
  const total = chunkCount(file.size ?? 0);
  const h = sha256.create();
  const handle = file.open();
  let size = 0;
  try {
    for (let i = 0; ; i++) {
      const part = handle.readBytes(MEDIA_CHUNK_BYTES);
      if (part.length === 0) break;
      h.update(part);
      size += part.length;
      onChunk?.(i + 1, total);
    }
  } finally {
    handle.close();
  }
  return { sha: h.digest(), size };
}

async function storedChunks(server: string, teamId: string, token: string, mid: string): Promise<Set<number>> {
  try {
    const r = await fetchText('sync', 'GET', `${base(server)}/v1/t/${teamId}/m/${mid}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 30000,
    });
    return new Set(((JSON.parse(r.text) as { chunks?: Array<{ i: number }> }).chunks ?? []).map((c) => c.i));
  } catch (e) {
    throw asSyncError(e);
  }
}

export async function uploadMedia(teamId: string, uri: string, onProgress?: Progress): Promise<UploadResult> {
  const { team, keys } = await keysOf(teamId);
  const server = serverOf(team);
  let heap = heapNow();

  let t = Date.now();
  const { sha, size } = hashFile(uri, (d, n) => onProgress?.('hash', d, n));
  const msHash = Date.now() - t;
  const mid = mediaId(keys.encKey, sha);
  const count = chunkCount(size);
  const have = await storedChunks(server, keys.teamId, keys.authToken, mid);

  const tmp = new File(Paths.cache, `media-up-${mid}.bin`);
  const handle = new File(uri).open();
  let msSeal = 0;
  let msUpload = 0;
  try {
    for (let i = 0; i < count; i++) {
      if (have.has(i)) {
        onProgress?.('upload', i + 1, count);
        continue;
      }
      t = Date.now();
      handle.offset = i * MEDIA_CHUNK_BYTES;
      const plain = handle.readBytes(MEDIA_CHUNK_BYTES);
      const sealed = sealChunk(keys.encKey, randomBytes(NONCE_BYTES), plain, chunkAad(keys.teamId, mid, i, count));
      if (tmp.exists) tmp.delete();
      tmp.create();
      tmp.write(sealed);
      msSeal += Date.now() - t;
      heap = peak(heap, heapNow());

      t = Date.now();
      const task = createUploadTask(`${base(server)}/v1/t/${keys.teamId}/m/${mid}/${i}`, tmp.uri, {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${keys.authToken}`, 'Content-Type': 'application/octet-stream' },
      });
      let res;
      try {
        res = await task.uploadAsync();
      } catch {
        throw new TeamSyncError('offline');
      }
      if (!res || res.status < 200 || res.status >= 300) throw relayError(res?.status, res?.body);
      msUpload += Date.now() - t;
      onProgress?.('upload', i + 1, count);
    }
  } finally {
    handle.close();
    if (tmp.exists) tmp.delete();
  }
  return {
    mid,
    count,
    size,
    sha256: bytesToHex(sha),
    skipped: have.size,
    ms: { hash: msHash, seal: msSeal, upload: msUpload },
    heapPeak: heap,
  };
}

/** Fetch and open every chunk into `dest` (replaced if present); the content hash is checked on the way. */
export async function downloadMedia(
  teamId: string,
  mid: string,
  count: number,
  dest: File,
  onProgress?: Progress,
): Promise<DownloadResult> {
  const { team, keys } = await keysOf(teamId);
  const server = serverOf(team);
  let heap = heapNow();
  const tmp = new File(Paths.cache, `media-down-${mid}.bin`);
  if (dest.exists) dest.delete();
  dest.create();
  const out = dest.open();
  const h = sha256.create();
  let size = 0;
  let msDownload = 0;
  let msOpen = 0;
  try {
    for (let i = 0; i < count; i++) {
      let t = Date.now();
      let res;
      try {
        res = await downloadAsync(`${base(server)}/v1/t/${keys.teamId}/m/${mid}/${i}`, tmp.uri, {
          headers: { Authorization: `Bearer ${keys.authToken}` },
        });
      } catch {
        throw new TeamSyncError('offline');
      }
      if (res.status !== 200) throw relayError(res.status, tmp.exists ? tmp.textSync() : undefined);
      msDownload += Date.now() - t;

      t = Date.now();
      const plain = openChunk(keys.encKey, await tmp.bytes(), chunkAad(keys.teamId, mid, i, count));
      out.writeBytes(plain);
      h.update(plain);
      size += plain.length;
      msOpen += Date.now() - t;
      heap = peak(heap, heapNow());
      onProgress?.('download', i + 1, count);
    }
  } finally {
    out.close();
    if (tmp.exists) tmp.delete();
  }
  const digest = h.digest();
  // The name is keyed on the content: a mismatch means the wrong file came back.
  if (mediaId(keys.encKey, digest) !== mid) throw new TeamSyncError('mediaMismatch');
  return { uri: dest.uri, size, sha256: bytesToHex(digest), ms: { download: msDownload, open: msOpen }, heapPeak: heap };
}

function relayError(status: number | undefined, body: string | undefined): TeamSyncError {
  try {
    const j = JSON.parse(body ?? '{}') as { error?: string; limit?: number };
    if (j.error) return new TeamSyncError(j.error, j.limit);
  } catch {
    // not the relay's JSON
  }
  return new TeamSyncError('server', undefined, `HTTP ${status ?? '?'}`);
}
