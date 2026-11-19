/**
 * Hooks the downloaded species database into the mobile `datasets.ts`
 * registry, so `getDatasetDb('tw-taicol')` — and with it search.ts, fuzzy.ts,
 * taxonLookup.ts and taxonCache.ts — works unchanged.
 *
 * datasets.ts needs two things it normally gets from native modules: a file
 * system (to read `datasets/installed.json` and check the file exists) and an
 * opener. Both point at the in-memory web FS here; the bytes come from
 * IndexedDB (speciesInstall.ts).
 */
import { configureDatasetFs, configureDatasetOpener, invalidateDatasetCaches } from '~/db/datasets';
import * as expoFs from './expoFs';
import { webFs } from './expoFs';
import { openMemoryDbSync } from './sqlite';

const DATASETS_DIR = `${webFs.ROOT}datasets/`;
const TW_FILE = 'tw-taicol.db';
const twUri = `${DATASETS_DIR}tw-taicol/${TW_FILE}`;

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  configureDatasetFs(expoFs as never);
  configureDatasetOpener(({ name }) => {
    const bytes = name === TW_FILE ? webFs.get(twUri) : undefined;
    if (!(bytes instanceof Uint8Array)) throw new Error(`dataset ${name} not loaded`);
    const db = openMemoryDbSync(bytes);
    // sqlite3_deserialize copied the bytes into wasm memory; the JS copy is
    // only kept as the "file exists" marker, so drop its contents.
    webFs.put(twUri, new Uint8Array(0));
    return db as never;
  });
}

/** Register the species database (raw SQLite bytes) as the installed tw-taicol module. */
export function mountSpeciesDb(bytes: Uint8Array, version: string): void {
  configure();
  webFs.put(twUri, bytes);
  webFs.put(
    `${DATASETS_DIR}installed.json`,
    JSON.stringify([
      {
        id: 'tw-taicol',
        location: 'datasets',
        file: TW_FILE,
        version,
        bytes: bytes.byteLength,
        installedAt: Date.now(),
        sharedWith: [],
      },
    ]),
  );
  // Re-read the install list and drop any handle opened before.
  configureDatasetFs(expoFs as never);
  invalidateDatasetCaches();
}

/** No species database (yet): datasets.ts reports nothing installed. */
export function initDatasetsEmpty(): void {
  configure();
}
