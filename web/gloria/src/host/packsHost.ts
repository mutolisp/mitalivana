/**
 * regionpacks.db (country checklist packs) on the web: the mobile module
 * (db/regionpacks.ts) opens it with op-sqlite's `open`, which here returns an
 * in-memory database filled from the snapshot registered below; writes are
 * flushed to IndexedDB like user.db.
 *
 * A pack is re-downloadable, so a snapshot that fails `quick_check` is
 * dropped instead of blocking start-up (the records that used its species
 * already have their own copy in user.db's external_taxa).
 */
import { getPacksDb, PACKS_DB_NAME } from '~/db/regionpacks';
import { registerDbSource } from './opSqlite';
import { openMemoryDb } from './sqlite';
import { createFlusher, readSnapshot, type Flusher } from './persist';

async function healthy(bytes: Uint8Array): Promise<boolean> {
  const db = await openMemoryDb(bytes);
  try {
    const r = db.executeSync('PRAGMA quick_check;').rows[0];
    return !!r && Object.values(r)[0] === 'ok';
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Call after bootDatabase (sqlite loaded), before anything searches. */
export async function bootPacks(): Promise<Flusher> {
  const snap = await readSnapshot(PACKS_DB_NAME);
  // Handed over once: the opened database holds the data from then on.
  let bytes = snap && (await healthy(snap.bytes)) ? snap.bytes : null;
  const flusher = createFlusher(PACKS_DB_NAME, () => ({ bytes: getPacksDb().exportBytes(), schemaVersion: 0, savedAt: Date.now() }));
  registerDbSource(PACKS_DB_NAME, {
    bytes: () => {
      const b = bytes;
      bytes = null;
      return b;
    },
    onWrite: () => flusher.schedule(),
  });
  return flusher;
}
