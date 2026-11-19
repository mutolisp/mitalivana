/**
 * Importing a survey zip restores its form scans (forms/) and logger files
 * (loggers/): on another device the yml's file URIs point at the sender's
 * storage, so the copies in the zip are stored here and the records point at
 * them. On the same device the existing files are kept, not duplicated.
 * References that cannot be opened here are dropped.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDbs, initDb } from '../src/host/dbInit';
import { deleteMedia, putMedia, readMediaBytes } from '../src/host/mediaStore';
import { buildBatchZip, buildSurveyZip } from '../src/export/exportSurvey';
import { applyGloriaImport, readGloriaImports } from '../src/import/importZip';
import { createGloriaSurvey, loadGloriaDoc, updateGloriaSurvey, upsertSummit } from '~/modules/gloria/db';
import { addInstall, createLoggerVisit, updateLogger, updateVisit } from '~/modules/gloria/loggerDb';
import { parseFiles } from '~/modules/gloria/model/loggers';

const file = (name: string, ...b: number[]) => new File([new Uint8Array(b)], name);
const ref = (uri: string, name: string, size: number) => ({ uri, name, size });

async function fresh() {
  closeDbs();
  await initDb();
}

/** A survey with two Form 2 scans, a Form 1 scan, a Form 3 scan that lives on another phone, and a logger. */
async function setUp() {
  const summitId = upsertSummit({ country: 'AT', target_region: 'HSW', summit: 'GHK' });
  const surveyId = createGloriaSurvey({ summitId, recorded_by: 'A' });
  const f2a = await putMedia('files', file('sheet1.pdf', 0x25, 0x50, 1));
  const f2b = await putMedia('files', file('sheet2.pdf', 0x25, 0x50, 2));
  const f1 = await putMedia('files', file('form1.jpg', 0xff, 0xd8, 3));
  const data = await putMedia('files', file('E22a.csv', 4, 5));
  const f4 = await putMedia('files', file('form4.pdf', 0x25, 0x50, 6));
  updateGloriaSurvey(surveyId, {
    form1_files: JSON.stringify([ref(f1, 'form1.jpg', 3)]),
    form2_files: JSON.stringify([ref(f2a, 'sheet1.pdf', 3), ref(f2b, 'sheet2.pdf', 3)]),
    form3_files: JSON.stringify([ref('file:///var/mobile/Containers/Data/Application/X/Documents/files/f3.pdf', 'f3.pdf', 9)]),
  });
  const visitId = createLoggerVisit(summitId, { visitTs: Date.now(), surveyId });
  updateLogger(addInstall(visitId, 'E'), { serial: 'SN1', data_files: JSON.stringify([ref(data, 'E22a.csv', 2)]) });
  updateVisit(visitId, { form4_files: JSON.stringify([ref(f4, 'form4.pdf', 3)]) });
  return { surveyId, uris: [f2a, f2b, f1, data, f4] };
}

const bytesOf = async (json: string | null | undefined) =>
  Promise.all(parseFiles(json).map(async (f) => ({ name: f.name, local: f.uri.startsWith('webmedia:'), uri: f.uri, bytes: [...((await readMediaBytes(f.uri)) ?? [])] })));

describe('restoring attached files on import', () => {
  beforeEach(fresh);

  it('stores the zip copies on another device and drops what cannot be opened', async () => {
    const { surveyId, uris } = await setUp();
    const zip = await buildSurveyZip(surveyId, { includePhotos: false });
    // Another device: none of the sender's files exist here.
    for (const u of uris) await deleteMedia(u);
    await fresh();
    const [c] = readGloriaImports(zip.bytes, 'one.zip');
    if (!c.ok) throw new Error('not ok');
    const doc = loadGloriaDoc(await applyGloriaImport(c.doc, c.attached))!;

    const f2 = await bytesOf(doc.survey.form2_files);
    expect(f2.map((f) => [f.name, f.bytes])).toEqual([['sheet1.pdf', [0x25, 0x50, 1]], ['sheet2.pdf', [0x25, 0x50, 2]]]);
    expect(f2.every((f) => f.local && !uris.includes(f.uri))).toBe(true);
    expect((await bytesOf(doc.survey.form1_files)).map((f) => f.bytes)).toEqual([[0xff, 0xd8, 3]]);
    // The Form 3 scan was never in the zip (it lives on another phone).
    expect(doc.survey.form3_files).toBeNull();
    const v = doc.logger_visits![0];
    expect((await bytesOf(v.form4_files as string)).map((f) => [f.name, f.bytes])).toEqual([['form4.pdf', [0x25, 0x50, 6]]]);
    expect((await bytesOf(v.loggers[0].data_files as string)).map((f) => [f.name, f.bytes])).toEqual([['E22a.csv', [4, 5]]]);
  });

  it('keeps files already here instead of copying them again', async () => {
    const { surveyId, uris } = await setUp();
    const zip = await buildSurveyZip(surveyId, { includePhotos: false });
    await fresh();
    const [c] = readGloriaImports(zip.bytes, 'one.zip');
    if (!c.ok) throw new Error('not ok');
    const doc = loadGloriaDoc(await applyGloriaImport(c.doc, c.attached))!;
    expect(parseFiles(doc.survey.form2_files).map((f) => f.uri)).toEqual(uris.slice(0, 2));
  });

  it('restores from a bundle of several surveys too', async () => {
    const { surveyId, uris } = await setUp();
    const zip = await buildBatchZip([surveyId], { includePhotos: false });
    for (const u of uris) await deleteMedia(u);
    await fresh();
    const [c] = readGloriaImports(zip.bytes, 'bundle.zip');
    if (!c.ok) throw new Error('not ok');
    const doc = loadGloriaDoc(await applyGloriaImport(c.doc, c.attached))!;
    expect((await bytesOf(doc.survey.form2_files)).map((f) => f.bytes)).toEqual([[0x25, 0x50, 1], [0x25, 0x50, 2]]);
  });
});
