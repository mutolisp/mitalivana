/**
 * Species database lifecycle in the browser, one per checklist module
 * (TaiCOL for Taiwan, YList for Japan; vascular plants only):
 *   - the module's manifest is fetched network-first (never from a stale cache);
 *   - the content-hashed `.db.gz` is downloaded with progress, gunzipped, its
 *     sha256 checked against the manifest, and stored in IndexedDB;
 *   - on start-up every stored copy is mounted (datasetsHost.ts) without any
 *     network, so the app works offline once a database was downloaded once.
 *
 * Search only uses the regions the user asked for (settings.enabled_regions,
 * read by db/regions.ts), so installing a module also turns its region on.
 */
import { gunzipSync } from 'fflate';
import { useSettings, type RegionCode } from '~/stores/settings';
import { idbGet, idbPut } from './persist';
import { DATASET_REGION, mountSpeciesDb, WEB_DATASETS, type WebDatasetId } from './datasetsHost';

export type { WebDatasetId } from './datasetsHost';
export { WEB_DATASETS as WEB_DATASETS_LIST } from './datasetsHost';

export type SpeciesManifest = {
  schema: number;
  id: WebDatasetId;
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

// Written by backend/scripts/datasets/build_web_species.py (DATASETS[id].manifest).
const MANIFEST: Record<WebDatasetId, string> = {
  'tw-taicol': 'species-manifest.json',
  'jp-ylist': 'species-manifest.jp-ylist.json',
};
const dataUrl = (name: string) => `${import.meta.env.BASE_URL}data/${name}`;

/** Versions of the installed modules (id → version). */
export type InstalledSpecies = Partial<Record<WebDatasetId, string>>;

export async function installedSpecies(id: WebDatasetId = 'tw-taicol'): Promise<Omit<Stored, 'bytes'> | null> {
  const s = await idbGet<Stored>('species', id);
  if (!s) return null;
  const { bytes: _b, ...rest } = s;
  return rest;
}

/** Mount every stored database. */
export async function mountStoredSpecies(): Promise<InstalledSpecies> {
  const out: InstalledSpecies = {};
  for (const id of WEB_DATASETS) {
    const s = await idbGet<Stored>('species', id);
    if (!s) continue;
    mountSpeciesDb(id, s.bytes, s.version);
    out[id] = s.version;
  }
  return out;
}

export async function fetchSpeciesManifest(id: WebDatasetId = 'tw-taicol'): Promise<SpeciesManifest> {
  const res = await fetch(dataUrl(MANIFEST[id]), { cache: 'no-cache' });
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

/** Turn a region on in the search (the setting mobile's region page writes). */
export function enableRegion(region: RegionCode): void {
  const s = useSettings.getState();
  if (!s.enabled_regions.includes(region)) s.set('enabled_regions', [...s.enabled_regions, region]);
}

/**
 * Download, verify, store and mount the database named by `m`, and turn its
 * region on. Throws on any mismatch; the previously stored copy stays untouched.
 */
export async function downloadSpecies(
  m: SpeciesManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const id = m.id ?? 'tw-taicol';
  const res = await fetch(dataUrl(m.file), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const body = await readWithProgress(res, m.bytes, onProgress);
  // A server may already have undone the gzip (Content-Encoding); check the magic.
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  const sha = await sha256Hex(raw);
  if (sha !== m.sha256) throw new Error(`sha256 mismatch (${sha.slice(0, 8)} ≠ ${m.sha256.slice(0, 8)})`);
  await idbPut('species', id, { version: m.version, sha256: sha, bytes: raw, installedAt: Date.now(), manifest: m } satisfies Stored);
  mountSpeciesDb(id, raw, m.version);
  enableRegion(DATASET_REGION[id]);
}

/** Whether the server has a different database than the stored one (null: offline / unknown). */
export async function speciesUpdateAvailable(id: WebDatasetId = 'tw-taicol'): Promise<SpeciesManifest | null> {
  try {
    const [m, cur] = await Promise.all([fetchSpeciesManifest(id), installedSpecies(id)]);
    return !cur || cur.sha256 !== m.sha256 ? m : null;
  } catch {
    return null;
  }
}
