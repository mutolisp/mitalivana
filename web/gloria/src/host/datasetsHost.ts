/**
 * Hooks the downloaded species databases into the mobile `datasets.ts`
 * registry, so `getDatasetDb('tw-taicol')` / `getDatasetDb('jp-ylist')` — and
 * with them search.ts, fuzzy.ts, taxonLookup.ts and taxonCache.ts — work
 * unchanged.
 *
 * datasets.ts needs two things it normally gets from native modules: a file
 * system (to read `datasets/installed.json` and check the file exists) and an
 * opener. Both point at the in-memory web FS here; the bytes come from
 * IndexedDB (speciesInstall.ts).
 */
import { configureDatasetFs, configureDatasetOpener, invalidateDatasetCaches } from '~/db/datasets';
import * as expoFs from './expoFs';
import { webFs } from './expoFs';
import { openMemoryDbSync, type SyncDb } from './sqlite';

/** The checklist modules the web app offers (a vascular-plant subset of each). */
export type WebDatasetId = 'tw-taicol' | 'jp-ylist';
export const WEB_DATASETS: readonly WebDatasetId[] = ['tw-taicol', 'jp-ylist'];
/** Region each module belongs to (datasets.ts SPECS[id].region). */
export const DATASET_REGION: Record<WebDatasetId, 'TW' | 'JP'> = { 'tw-taicol': 'TW', 'jp-ylist': 'JP' };

// datasets.ts SPECS[id].defaultFile: the name its opener is asked for.
const FILE: Record<WebDatasetId, string> = { 'tw-taicol': 'tw-taicol.db', 'jp-ylist': 'jp-ylist.db' };
const DATASETS_DIR = `${webFs.ROOT}datasets/`;
const uriOf = (id: WebDatasetId) => `${DATASETS_DIR}${id}/${FILE[id]}`;

const mounted = new Map<WebDatasetId, { version: string; bytes: number }>();
// One open database per module, kept here: the registry closes every handle
// whenever the install list changes (configureDatasetFs), but the bytes were
// handed to SQLite and dropped, so a real close could not be reopened. Its
// close is therefore a no-op; the database is closed only when the same
// module is replaced by a new download.
const live = new Map<WebDatasetId, SyncDb>();
let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  configureDatasetFs(expoFs as never);
  configureDatasetOpener(({ name }) => {
    const id = WEB_DATASETS.find((d) => FILE[d] === name);
    if (!id) throw new Error(`dataset ${name} not loaded`);
    let db = live.get(id);
    if (!db) {
      const bytes = webFs.get(uriOf(id));
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error(`dataset ${name} not loaded`);
      db = openMemoryDbSync(bytes);
      live.set(id, db);
      // sqlite3_deserialize copied the bytes into wasm memory; the JS copy is
      // only kept as the "file exists" marker, so drop its contents.
      webFs.put(uriOf(id), new Uint8Array(0));
    }
    return { ...db, close() {} } as never;
  });
}

/** Register a species database (raw SQLite bytes) as an installed module. */
export function mountSpeciesDb(id: WebDatasetId, bytes: Uint8Array, version: string): void {
  configure();
  live.get(id)?.close();
  live.delete(id);
  webFs.put(uriOf(id), bytes);
  mounted.set(id, { version, bytes: bytes.byteLength });
  webFs.put(
    `${DATASETS_DIR}installed.json`,
    JSON.stringify(
      [...mounted].map(([d, m]) => ({
        id: d,
        location: 'datasets',
        file: FILE[d],
        version: m.version,
        bytes: m.bytes,
        installedAt: Date.now(),
        sharedWith: [],
      })),
    ),
  );
  // Re-read the install list and drop any handle opened before (a replaced
  // module must be opened again from its new bytes).
  configureDatasetFs(expoFs as never);
  invalidateDatasetCaches();
}

/** No species database (yet): datasets.ts reports nothing installed. */
export function initDatasetsEmpty(): void {
  configure();
}
