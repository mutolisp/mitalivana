/**
 * Snapshot persistence: a fresh database is saved, survives a "reload",
 * a corrupt newest copy falls back to .prev, a newer-schema snapshot is
 * refused, and a second tab cannot take the lock.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bootDatabase, USER_DB_KEY } from '../src/host/boot';
import { closeDbs } from '../src/host/dbInit';
import { acquireTabLock, idbPut, readSnapshot, writeSnapshot } from '../src/host/persist';
import { upsertSummit, listSummits } from '~/modules/gloria/db';
import { LATEST_SCHEMA_VERSION } from '~/db/migrations';
import { openMemoryDb } from '../src/host/sqlite';

let n = 0;
const lock = () => `test-lock-${n++}`;

async function reboot() {
  closeDbs();
  const r = await bootDatabase({ lockName: lock() });
  if (!r.ok) throw new Error(`boot failed: ${r.reason}`);
  return r;
}

describe('snapshot persistence', () => {
  it('saves, reloads, and keeps a previous copy', async () => {
    const r1 = await reboot();
    upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN' });
    await r1.flusher.flushNow();
    expect(r1.flusher.state()).toBe('saved');
    const snap = await readSnapshot(USER_DB_KEY);
    expect(snap?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    const r2 = await reboot();
    expect(listSummits().map((s) => s.full_code)).toEqual(['TW-DAS-SUN']);
    // A second save keeps the first as .prev.
    upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'ANO' });
    await r2.flusher.flushNow();
    const prev = await readSnapshot(`${USER_DB_KEY}.prev`);
    const prevDb = await openMemoryDb(prev!.bytes);
    expect(prevDb.executeSync('SELECT full_code FROM gloria_summits').rows).toEqual([{ full_code: 'TW-DAS-SUN' }]);
    prevDb.close();
  });

  it('falls back to .prev when the newest copy is corrupt', async () => {
    const r = await reboot();
    upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'TWO' });
    await r.flusher.flushNow();
    const good = (await readSnapshot(USER_DB_KEY))!;
    // newest = garbage, prev = good
    await idbPut('db', `${USER_DB_KEY}.prev`, good);
    await idbPut('db', USER_DB_KEY, { ...good, bytes: new Uint8Array([1, 2, 3, 4]) });
    closeDbs();
    const again = await bootDatabase({ lockName: lock() });
    expect(again.ok && again.recoveredFromPrev).toBe(true);
    expect(listSummits().some((s) => s.full_code === 'TW-DAS-TWO')).toBe(true);
  });

  it('refuses a snapshot from a newer schema', async () => {
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    db.executeSync('INSERT INTO schema_version VALUES (?)', [LATEST_SCHEMA_VERSION + 1]);
    await writeSnapshot(USER_DB_KEY, { bytes: db.exportBytes(), schemaVersion: LATEST_SCHEMA_VERSION + 1, savedAt: 0 });
    db.close();
    closeDbs();
    const r = await bootDatabase({ lockName: lock() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('newer-schema');
  });

  it('a second tab cannot take the lock', async () => {
    const name = lock();
    expect(await acquireTabLock(name)).toBe(true);
    expect(await acquireTabLock(name)).toBe(false);
  });
});
