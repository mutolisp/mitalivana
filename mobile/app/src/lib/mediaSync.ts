/**
 * Files over the team relay (docs/planned/Media_sync.md).
 *
 * Transfer (phase 0): a file goes up and back in sealed 4 MiB chunks.
 *   - The relay's name for a file is keyed on its content (mediaId): the same
 *     photo is sent once, whatever record or phone it is on.
 *   - Chunks are read with a FileHandle, never the whole file at once; sealed
 *     chunks go through a cache file and createUploadTask as binary.
 *   - Chunks already on the relay are skipped, so a broken upload resumes;
 *     `done` asks the relay to check every chunk is in (phase 1).
 *
 * Records (phase 2): syncing a record sends the files it refers to and lists
 * them in its sealed yml (`sync.media`, mediaRefsCore.ts); a teammate's copy
 * is received by fetching what is missing and adding it to the rows
 * (mediaRefs.ts), adding only. Files that cannot be fetched now wait in
 * media_pending and are tried again on the next sync.
 *
 * FileHandle opens files for update, which the photo library does not allow:
 * anything outside the app's own folders is copied to the cache first.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { File, Paths } from 'expo-file-system';
import { FileSystemUploadType, copyAsync, createUploadTask, documentDirectory, downloadAsync, makeDirectoryAsync } from 'expo-file-system/legacy';
import { getUserDb } from '~/db/init';
import { generateUuid } from '~/db/uuid';
import { fetchText } from './apiFetch';
import { isAppMediaAllowed, rebaseAppFileUri } from './appFiles';
import { resolveAssetUri } from './bundleExport';
import type { MergeKind } from './mergeDocs';
import { addRecordMedia, listRecordMedia } from './mediaRefs';
import { extOf, folderFor, readMediaManifest, type MediaEntry } from './mediaRefsCore';
import { MEDIA_CHUNK_BYTES, NONCE_BYTES, chunkAad, chunkCount, mediaId, openChunk, sealChunk, type TeamKeys } from './teamCrypto';
import { TeamSyncError, asSyncError, checkServer, keysOf, randomBytes, serverOf } from './teamSync';
import { useSyncProgress } from '~/stores/syncProgress';

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
const rows = <T>(sql: string, args: Array<string | number | null> = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];

// Hermes reports its heap; other engines give null.
type HermesStats = { js_heapSize?: number };
function heapNow(): number | null {
  const h = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => HermesStats } }).HermesInternal;
  return h?.getInstrumentedStats?.().js_heapSize ?? null;
}
const peak = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

// ── server ────────────────────────────────────────────────────────────────────

/** Worker version that first has have / done / refs (phases 1–2). */
export const MEDIA_WORKER_VERSION = '1.2.0';

export function atLeast(version: string | undefined, min: string): boolean {
  const a = (version ?? '0').split('.').map((x) => Number(x) || 0);
  const b = min.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * Whether a server takes files: self-hosted (mediaEnabled) AND new enough. An
 * older self-hosted Worker (1.1.0) syncs records only until it is deployed
 * again from the app. Asked once per ten minutes.
 */
const takesFiles = new Map<string, { on: boolean; at: number }>();
export async function serverTakesFiles(server: string): Promise<boolean> {
  const c = takesFiles.get(server);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.on;
  const info = await checkServer(server);
  const on = info.limits?.mediaEnabled === 1 && atLeast(info.version, MEDIA_WORKER_VERSION);
  takesFiles.set(server, { on, at: Date.now() });
  return on;
}

export async function mediaEnabled(teamId: string): Promise<boolean> {
  const { team } = await keysOf(teamId);
  return serverTakesFiles(serverOf(team));
}

async function relayJson(server: string, keys: TeamKeys, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
  try {
    const r = await fetchText('sync', method, `${base(server)}/v1/t/${keys.teamId}${path}`, {
      headers: { Authorization: `Bearer ${keys.authToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: 'application/json',
      timeoutMs: 30000,
    });
    return JSON.parse(r.text || '{}');
  } catch (e) {
    throw asSyncError(e);
  }
}

/** Which of these files the relay holds complete. */
async function haveOnServer(server: string, keys: TeamKeys, mids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < mids.length; i += 1000) {
    const r = (await relayJson(server, keys, 'POST', '/m/have', { mids: mids.slice(i, i + 1000) })) as { have?: string[] };
    for (const m of r.have ?? []) out.add(m);
  }
  return out;
}

// ── files ─────────────────────────────────────────────────────────────────────

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

const isAppFile = (uri: string) => !!documentDirectory && uri.startsWith('file:') && rebaseAppFileUri(uri).startsWith(documentDirectory);

/**
 * A readable local copy of a stored reference: app files as they are (re-anchored),
 * photo-library and other files copied to the cache (dispose() removes the copy).
 */
async function readable(uri: string): Promise<{ fileUri: string; name: string; dispose: () => void } | null> {
  // Never a file outside the media folders, whatever the record says (security audit S1).
  if (!isAppMediaAllowed(uri)) return null;
  if (isAppFile(uri)) {
    const f = rebaseAppFileUri(uri);
    return new File(f).exists ? { fileUri: f, name: f.split('/').pop() ?? 'file', dispose: () => {} } : null;
  }
  const src = await resolveAssetUri(uri);
  if (!src) return null;
  const name = decodeURIComponent(src.split('/').pop()?.split('?')[0] ?? 'file');
  const tmp = new File(Paths.cache, `media-src-${generateUuid()}.${extOf(name)}`);
  try {
    await copyAsync({ from: src, to: tmp.uri });
  } catch {
    return null;
  }
  return { fileUri: tmp.uri, name, dispose: () => tmp.exists && tmp.delete() };
}

/** Content hash of a stored reference, from the cache when the file cannot have changed. */
async function shaOfRef(uri: string): Promise<{ sha: string; size: number; name: string } | null> {
  if (!isAppMediaAllowed(uri)) return null;
  const cached = rows<{ sha: string; size: number | null }>(`SELECT sha, size FROM media_hash WHERE uri = ?`, [uri])[0];
  // App files are checked by size; photo-library assets do not change under the same id.
  if (cached && (!isAppFile(uri) || new File(rebaseAppFileUri(uri)).size === cached.size)) {
    return { sha: cached.sha, size: cached.size ?? 0, name: rebaseAppFileUri(uri).split('/').pop() ?? 'file' };
  }
  const r = await readable(uri);
  if (!r) return null;
  try {
    const { sha, size } = hashFile(r.fileUri);
    const hex = bytesToHex(sha);
    getUserDb().executeSync(`INSERT OR REPLACE INTO media_hash (uri, size, sha, at) VALUES (?, ?, ?, ?)`, [uri, size, hex, Date.now()]);
    return { sha: hex, size, name: r.name };
  } finally {
    r.dispose();
  }
}

async function storedChunks(server: string, keys: TeamKeys, mid: string): Promise<Set<number>> {
  const r = (await relayJson(server, keys, 'GET', `/m/${mid}`)) as { chunks?: Array<{ i: number }> };
  return new Set((r.chunks ?? []).map((c) => c.i));
}

/** Seal and send every chunk the relay lacks, then mark the file complete. */
async function sendFile(
  server: string,
  keys: TeamKeys,
  fileUri: string,
  mid: string,
  size: number,
  onChunk?: (done: number, total: number) => void,
): Promise<{ skipped: number; msSeal: number; msUpload: number; heap: number | null }> {
  const count = chunkCount(size);
  const have = await storedChunks(server, keys, mid);
  const tmp = new File(Paths.cache, `media-up-${mid}.bin`);
  const handle = new File(fileUri).open();
  let msSeal = 0;
  let msUpload = 0;
  let heap = heapNow();
  try {
    for (let i = 0; i < count; i++) {
      if (have.has(i)) {
        onChunk?.(i + 1, count);
        continue;
      }
      let t = Date.now();
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
        headers: { Authorization: `Bearer ${keys.authToken}`, 'Content-Type': 'application/octet-stream', 'x-media-size': String(size) },
      });
      let res;
      try {
        res = await task.uploadAsync();
      } catch {
        throw new TeamSyncError('offline');
      }
      if (!res || res.status < 200 || res.status >= 300) throw relayError(res?.status, res?.body);
      msUpload += Date.now() - t;
      onChunk?.(i + 1, count);
    }
  } finally {
    handle.close();
    if (tmp.exists) tmp.delete();
  }
  await relayJson(server, keys, 'POST', `/m/${mid}/done`, { n: count, size });
  return { skipped: have.size, msSeal, msUpload, heap };
}

/** One file up (the phase 0 test screen): hash, send what is missing, mark complete. */
export async function uploadMedia(teamId: string, uri: string, onProgress?: Progress): Promise<UploadResult> {
  const { team, keys } = await keysOf(teamId);
  const server = serverOf(team);
  const t = Date.now();
  const { sha, size } = hashFile(uri, (d, n) => onProgress?.('hash', d, n));
  const msHash = Date.now() - t;
  const mid = mediaId(keys.encKey, sha);
  const r = await sendFile(server, keys, uri, mid, size, (d, n) => onProgress?.('upload', d, n));
  return {
    mid,
    count: chunkCount(size),
    size,
    sha256: bytesToHex(sha),
    skipped: r.skipped,
    ms: { hash: msHash, seal: r.msSeal, upload: r.msUpload },
    heapPeak: r.heap,
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
  return fetchFile(serverOf(team), keys, mid, count, dest, onProgress);
}

async function fetchFile(server: string, keys: TeamKeys, mid: string, count: number, dest: File, onProgress?: Progress): Promise<DownloadResult> {
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
  if (mediaId(keys.encKey, digest) !== mid) {
    if (dest.exists) dest.delete();
    throw new TeamSyncError('mediaMismatch');
  }
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

// ── records (phase 2) ─────────────────────────────────────────────────────────

/** A record's files as its manifest lists them, plus where each one is read from here. */
export type PreparedMedia = { entries: MediaEntry[]; sources: Map<string, string> };

/** Hash the record's files (cached) and build its manifest; nothing is sent yet. Unreadable files are left out. */
export async function prepareRecordMedia(keys: TeamKeys, kind: MergeKind, id: number): Promise<PreparedMedia> {
  const entries: MediaEntry[] = [];
  const sources = new Map<string, string>();
  const seen = new Map<string, { sha: string; size: number; name: string } | null>();
  for (const it of listRecordMedia(kind, id)) {
    if (!seen.has(it.uri)) seen.set(it.uri, await shaOfRef(it.uri));
    const h = seen.get(it.uri);
    if (!h) continue;
    const mid = mediaId(keys.encKey, hexToBytes(h.sha));
    sources.set(mid, it.uri);
    const name = it.meta?.name || `${h.sha.slice(0, 16)}.${extOf(h.name)}`;
    entries.push({ ref: it.ref, sha: h.sha, mid, size: h.size, name, ...(it.meta ? { meta: it.meta } : {}) });
  }
  return { entries, sources };
}

/** Send the files the relay does not hold yet, then tell it which files this record copy refers to. */
export async function sendRecordMedia(server: string, keys: TeamKeys, prepared: PreparedMedia, rec: string, dev: string): Promise<number> {
  const mids = [...new Set(prepared.entries.map((e) => e.mid))];
  const have = mids.length ? await haveOnServer(server, keys, mids) : new Set<string>();
  const todo = mids.filter((m) => !have.has(m)).map((mid) => ({ mid, entry: prepared.entries.find((e) => e.mid === mid)! }));
  const progress = useSyncProgress.getState();
  const total = todo.reduce((a, x) => a + x.entry.size, 0);
  let before = 0;
  let sent = 0;
  try {
    for (let k = 0; k < todo.length; k++) {
      const { mid, entry } = todo[k];
      progress.update({ stage: 'upload', fileIndex: k + 1, fileCount: todo.length, bytesDone: before, bytesTotal: total });
      const src = prepared.sources.get(mid);
      const r = src ? await readable(src) : null;
      if (r) {
        try {
          await sendFile(server, keys, r.fileUri, mid, entry.size, (i) =>
            progress.update({ bytesDone: before + Math.min(entry.size, i * MEDIA_CHUNK_BYTES) }),
          );
          sent += 1;
        } finally {
          r.dispose();
        }
      }
      before += entry.size;
    }
  } finally {
    progress.update({ stage: 'record', fileIndex: null, fileCount: null, bytesDone: 0, bytesTotal: 0 });
  }
  await relayJson(server, keys, 'PUT', `/refs/${rec}/${dev}`, { mids });
  return sent;
}

const entryKey = (e: MediaEntry) => `${e.ref.t}|${e.ref.k}|${e.ref.c}|${e.sha}`;

/** A file with this content already on the device, if any. */
function localWithSha(sha: string): string | null {
  for (const r of rows<{ uri: string }>(`SELECT uri FROM media_hash WHERE sha = ?`, [sha])) {
    if (!isAppFile(r.uri)) continue;
    if (new File(rebaseAppFileUri(r.uri)).exists) return r.uri;
  }
  return null;
}

const shaOfStored = (uri: string) => rows<{ sha: string }>(`SELECT sha FROM media_hash WHERE uri = ?`, [uri])[0]?.sha ?? null;

/**
 * Receive a teammate's record copy's files into local record `id`: fetch what
 * is not here, add it where it belongs. What cannot be fetched now (no signal)
 * or placed yet (its row is not merged) waits in media_pending.
 */
export async function receiveRecordMedia(
  teamId: string,
  kind: MergeKind,
  uuid: string,
  id: number,
  manifest: unknown,
): Promise<{ added: number; pending: number }> {
  const entries = readMediaManifest(manifest);
  if (!entries.length) return { added: 0, pending: 0 };
  const { team, keys } = await keysOf(teamId);
  const server = serverOf(team);
  let added = 0;
  let pending = 0;
  const db = getUserDb();
  // Progress over the files that have to be fetched (the rest are here already).
  const toFetch = entries.filter((e) => !localWithSha(e.sha));
  const total = toFetch.reduce((a, e) => a + e.size, 0);
  const progress = useSyncProgress.getState();
  let fetched = 0;
  let before = 0;
  try {
    for (const e of entries) {
      let uri = localWithSha(e.sha);
      if (!uri) {
        fetched += 1;
        progress.update({ stage: 'download', fileIndex: fetched, fileCount: toFetch.length, bytesDone: before, bytesTotal: total });
        const folder = folderFor(e.name);
        const dir = `${documentDirectory}${folder}/`;
        try {
          await makeDirectoryAsync(dir, { intermediates: true });
        } catch {
          // already there
        }
        const dest = new File(`${dir}${e.sha.slice(0, 32)}.${extOf(e.name)}`);
        try {
          await fetchFile(server, keys, e.mid, chunkCount(e.size), dest, (_s, i) =>
            progress.update({ bytesDone: before + Math.min(e.size, i * MEDIA_CHUNK_BYTES) }),
          );
          before += e.size;
          uri = dest.uri;
          db.executeSync(`INSERT OR REPLACE INTO media_hash (uri, size, sha, at) VALUES (?, ?, ?, ?)`, [uri, e.size, e.sha, Date.now()]);
        } catch (err) {
          if (!(err instanceof TeamSyncError)) throw err;
          db.executeSync(
            `INSERT OR REPLACE INTO media_pending (team_id, record_kind, record_uuid, entry_key, entry, at) VALUES (?, ?, ?, ?, ?, ?)`,
            [teamId, kind, uuid, entryKey(e), JSON.stringify(e), Date.now()],
          );
          pending += 1;
          continue;
        }
      }
      const placed = addRecordMedia(kind, id, e.ref, uri, e.meta, (u) => shaOfStored(u) === e.sha);
      db.executeSync(`DELETE FROM media_pending WHERE team_id = ? AND record_kind = ? AND record_uuid = ? AND entry_key = ?`, [teamId, kind, uuid, entryKey(e)]);
      if (placed) added += 1;
    }
  } finally {
    progress.update({ stage: 'record', fileIndex: null, fileCount: null, bytesDone: 0, bytesTotal: 0 });
  }
  return { added, pending };
}

/** Try again the files that could not be fetched before (this record, or the whole team). */
export async function retryPendingMedia(
  teamId: string,
  localIdOf: (kind: MergeKind, uuid: string) => number | null,
  only?: { kind: MergeKind; uuid: string },
): Promise<{ added: number; pending: number }> {
  const list = only
    ? rows<{ record_kind: MergeKind; record_uuid: string; entry: string }>(
        `SELECT record_kind, record_uuid, entry FROM media_pending WHERE team_id = ? AND record_kind = ? AND record_uuid = ?`,
        [teamId, only.kind, only.uuid],
      )
    : rows<{ record_kind: MergeKind; record_uuid: string; entry: string }>(`SELECT record_kind, record_uuid, entry FROM media_pending WHERE team_id = ?`, [teamId]);
  const byRecord = new Map<string, { kind: MergeKind; uuid: string; entries: unknown[] }>();
  for (const r of list) {
    const k = `${r.record_kind}|${r.record_uuid}`;
    if (!byRecord.has(k)) byRecord.set(k, { kind: r.record_kind, uuid: r.record_uuid, entries: [] });
    try {
      byRecord.get(k)!.entries.push(JSON.parse(r.entry));
    } catch {
      // unreadable: dropped below with its record's clean-up
    }
  }
  let added = 0;
  let pending = 0;
  for (const r of byRecord.values()) {
    const id = localIdOf(r.kind, r.uuid);
    if (id == null) {
      getUserDb().executeSync(`DELETE FROM media_pending WHERE team_id = ? AND record_kind = ? AND record_uuid = ?`, [teamId, r.kind, r.uuid]);
      continue;
    }
    const x = await receiveRecordMedia(teamId, r.kind, r.uuid, id, r.entries);
    added += x.added;
    pending += x.pending;
  }
  return { added, pending };
}

export function pendingMediaCount(teamId: string): number {
  return rows<{ n: number }>(`SELECT COUNT(*) AS n FROM media_pending WHERE team_id = ?`, [teamId])[0]?.n ?? 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
