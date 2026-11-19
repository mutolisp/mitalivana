/**
 * Species database lifecycle in the browser:
 *   - `species-manifest.json` is fetched network-first (never from a stale cache);
 *   - the content-hashed `.db.gz` is downloaded with progress, gunzipped, its
 *     sha256 checked against the manifest, and stored in IndexedDB;
 *   - on start-up the stored copy is mounted (datasetsHost.ts) without any
 *     network, so the app works offline once the database was downloaded once.
 */
import { gunzipSync } from 'fflate';
import { idbGet, idbPut } from './persist';
import { mountSpeciesDb } from './datasetsHost';

export type SpeciesManifest = {
  schema: number;
  id: 'tw-taicol';
  subset: string;
  version: string;
  sourceVersion: string;
  file: string;
  sha256: string;
  bytes: number;
  uncompressedBytes: number;
  rows: Record<string, number>;
  attribution: string;
  license: string;
};

type Stored = { version: string; sha256: string; bytes: Uint8Array; installedAt: number; manifest: SpeciesManifest };

const KEY = 'tw-taicol';
const dataUrl = (name: string) => `${import.meta.env.BASE_URL}data/${name}`;

export async function installedSpecies(): Promise<Omit<Stored, 'bytes'> | null> {
  const s = await idbGet<Stored>('species', KEY);
  if (!s) return null;
  const { bytes: _b, ...rest } = s;
  return rest;
}

/** Mount the stored database. Returns its version, or null when none is stored. */
export async function mountStoredSpecies(): Promise<string | null> {
  const s = await idbGet<Stored>('species', KEY);
  if (!s) return null;
  mountSpeciesDb(s.bytes, s.version);
  return s.version;
}

export async function fetchSpeciesManifest(): Promise<SpeciesManifest> {
  const res = await fetch(dataUrl('species-manifest.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return (await res.json()) as SpeciesManifest;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readWithProgress(res: Response, total: number, onProgress?: (done: number, total: number) => void) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    done += r.value.byteLength;
    onProgress?.(done, total);
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Download, verify, store and mount the database named by `m`.
 * Throws on any mismatch; the previously stored copy stays untouched.
 */
export async function downloadSpecies(
  m: SpeciesManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const res = await fetch(dataUrl(m.file), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const body = await readWithProgress(res, m.bytes, onProgress);
  // A server may already have undone the gzip (Content-Encoding); check the magic.
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  const sha = await sha256Hex(raw);
  if (sha !== m.sha256) throw new Error(`sha256 mismatch (${sha.slice(0, 8)} ≠ ${m.sha256.slice(0, 8)})`);
  await idbPut('species', KEY, { version: m.version, sha256: sha, bytes: raw, installedAt: Date.now(), manifest: m } satisfies Stored);
  mountSpeciesDb(raw, m.version);
}

/** Whether the server has a different database than the stored one (null: offline / unknown). */
export async function speciesUpdateAvailable(): Promise<SpeciesManifest | null> {
  try {
    const [m, cur] = await Promise.all([fetchSpeciesManifest(), installedSpecies()]);
    return !cur || cur.sha256 !== m.sha256 ? m : null;
  } catch {
    return null;
  }
}
