/**
 * Web export → zip → import, through the shared bundle assembler and the
 * mobile zip reader: photos stored in IndexedDB land in photos/ byte for
 * byte, the survey comes back identical, a re-import is reported as existing.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { closeDbs, initDb } from '../src/host/dbInit';
import { putMedia } from '../src/host/mediaStore';
import { buildSurveyZip } from '../src/export/exportSurvey';
import { applyGloriaImport, readGloriaImport } from '../src/import/importZip';
import {
  addUnitSpecies, createGloriaSurvey, listUnits, loadGloriaDoc, updateUnit, updateUnitSpecies, upsertSummit,
} from '~/modules/gloria/db';

async function freshDb() {
  closeDbs();
  await initDb();
}

const stable = (d: unknown) =>
  JSON.parse(JSON.stringify(d), (k, v) =>
    ['id', 'survey_id', 'summit_id', 'unit_id', 'gloria_taxon_id', 'prev_survey_id', 'stop_ts', 'sync'].includes(k) ? undefined : v,
  );

describe('web export / import', () => {
  beforeEach(freshDb);

  it('round-trips a survey with a photo through the zip', async () => {
    const summitId = upsertSummit({ country: 'TW', target_region: 'SAC', summit: 'JIA' });
    const surveyId = createGloriaSurvey({ summitId, recorded_by: 'Tester' });
    const q = listUnits(surveyId).find((u) => u.code === 'N11')!;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const uri = await putMedia('photos', new File([jpeg], 'IMG_0001.JPG', { type: 'image/jpeg' }));
    expect(uri).toMatch(/^webmedia:photos\/[0-9a-f-]{36}\.jpg$/);
    updateUnit(q.id, { photo_paths: JSON.stringify([uri]) });
    const us = addUnitSpecies(q.id, 't_test_1');
    updateUnitSpecies(us, { cover_pct: 2 });

    const { bytes, filename, photoCount } = await buildSurveyZip(surveyId, { includePhotos: true, lang: 'zh-TW' });
    expect(filename).toBe('GLORIA_TW-SAC-JIA_mocy1.zip');
    expect(photoCount).toBe(1);
    const files = unzipSync(bytes);
    const photo = Object.keys(files).find((n) => n.includes('/photos/'))!;
    expect(photo).toMatch(/\/photos\/01_TW_SAC_JIA_N11______\d{8}_00001\.jpg$/);
    expect([...files[photo]]).toEqual([...jpeg]);
    const manifest = JSON.parse(strFromU8(files['GLORIA_TW-SAC-JIA_mocy1/manifest.json']));
    expect([manifest.kind, manifest.photo_count]).toEqual(['gloria', 1]);
    const md = strFromU8(files[Object.keys(files).find((n) => n.endsWith('_checklist.md'))!]);
    // Rendered with real zh-TW strings (lazy-loaded), not raw keys.
    expect(md).not.toMatch(/checklistDoc\./);

    const original = loadGloriaDoc(surveyId)!;
    // Same database: reported as existing.
    const again = readGloriaImport(bytes);
    expect(again.ok && again.exists).toBe(true);

    await freshDb();
    const check = readGloriaImport(bytes);
    expect(check.ok && !check.exists).toBe(true);
    if (!check.ok) return;
    const id = await applyGloriaImport(check.doc);
    const back = loadGloriaDoc(id)!;
    expect(stable(back)).toEqual(stable(original));
    // The photo reference survives (the bytes stay in this browser's media store).
    expect(back.units.find((u) => u.code === 'N11')?.photo_paths).toContain(uri);
  });

  it('rejects a zip that is not a GLORIA export', () => {
    expect(readGloriaImport(new Uint8Array([1, 2, 3])).ok).toBe(false);
  });
});
