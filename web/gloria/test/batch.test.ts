/**
 * Several surveys in one bundle (the mobile bundleMany layout) and back:
 * folders + bundle_manifest.json out; every survey read back, flagged when it
 * is already here or is another copy of a summit's cycle, and restored
 * identically in a fresh database.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { closeDbs, initDb } from '../src/host/dbInit';
import { buildBatchZip, buildSurveyZip } from '../src/export/exportSurvey';
import { applyGloriaImport, readGloriaImports } from '../src/import/importZip';
import { addUnitSpecies, createGloriaSurvey, listUnits, loadGloriaDoc, upsertSummit } from '~/modules/gloria/db';

async function fresh() {
  closeDbs();
  await initDb();
}

const stable = (d: unknown) =>
  JSON.parse(JSON.stringify(d), (k, v) =>
    ['id', 'survey_id', 'summit_id', 'unit_id', 'gloria_taxon_id', 'prev_survey_id', 'stop_ts', 'sync'].includes(k) ? undefined : v,
  );

function twoSurveys() {
  const a = createGloriaSurvey({ summitId: upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN' }), recorded_by: 'A' });
  addUnitSpecies(listUnits(a).find((u) => u.code === 'N11')!.id, 't_x');
  const b = createGloriaSurvey({ summitId: upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'MOO' }), recorded_by: 'B' });
  return [a, b];
}

describe('batch export / import', () => {
  beforeEach(fresh);

  it('writes the mobile bundle layout and reads every survey back', async () => {
    const ids = twoSurveys();
    const docs = ids.map((id) => loadGloriaDoc(id)!);
    const zip = await buildBatchZip(ids, { includePhotos: false });
    expect(zip.exported).toBe(2);
    const files = unzipSync(zip.bytes);
    const manifest = JSON.parse(strFromU8(files['bundle_manifest.json']));
    expect(manifest.items.map((i: { folder: string }) => i.folder)).toEqual(['GLORIA_TW-DAS-SUN_mocy1', 'GLORIA_TW-DAS-MOO_mocy1']);
    expect(Object.keys(files).some((n) => n.startsWith('GLORIA_TW-DAS-MOO_mocy1/') && n.endsWith('.yml'))).toBe(true);

    // Same database: both already here.
    const here = readGloriaImports(zip.bytes, 'b.zip');
    expect(here.map((c) => c.ok && c.exists)).toEqual([true, true]);

    await fresh();
    const checks = readGloriaImports(zip.bytes, 'b.zip');
    expect(checks.map((c) => c.ok && !c.exists && !c.otherCopy)).toEqual([true, true]);
    const back = checks.map((c) => (c.ok ? loadGloriaDoc(applyGloriaImport(c.doc)) : null));
    expect(back.map(stable)).toEqual(docs.map(stable));
  });

  it('flags another copy of the same summit and cycle', async () => {
    const [a] = twoSurveys();
    const single = await buildSurveyZip(a, { includePhotos: false });
    await fresh();
    // Started here independently: same summit, same cycle, another uuid.
    createGloriaSurvey({ summitId: upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN' }), recorded_by: 'C' });
    const [c] = readGloriaImports(single.bytes, 'one.zip');
    expect(c.ok && c.otherCopy).toBe(true);
    expect(c.ok && c.exists).toBe(false);
  });

  it('marks records of other kinds in a bundle and keeps going', async () => {
    const [a] = twoSurveys();
    const files = unzipSync((await buildBatchZip([a], { includePhotos: false })).bytes);
    const manifest = JSON.parse(strFromU8(files['bundle_manifest.json']));
    manifest.items.push({ kind: 'session', id: 9, folder: 'some_checklist' });
    files['bundle_manifest.json'] = strToU8(JSON.stringify(manifest));
    const checks = readGloriaImports(zipSync(files), 'mixed.zip');
    expect(checks.map((c) => (c.ok ? 'ok' : c.reason))).toEqual(['ok', 'not-gloria']);
  });
});
