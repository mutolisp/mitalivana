/**
 * Web attachments end to end, with the file chooser mocked: a picked logger
 * data file and a camera photo go into IndexedDB under webmedia: URIs, the
 * logger row keeps the original name, and both the summit's logger zip and
 * the survey zip carry the bytes (loggers/, forms/, photos/).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';

const picked: File[][] = [];
vi.mock('../src/host/pickFiles', () => ({ chooseFiles: async () => picked.shift() ?? [] }));

import { closeDbs, initDb } from '../src/host/dbInit';
import { pickFiles, photoRef } from '../src/host/fileAttach';
import { captureEnvPhoto, pickPhotos } from '../src/host/photoCapture';
import { bundleLoggers } from '../src/host/bundleExport';
import { readUriBytes } from '../src/host/expoFs';
import { buildSurveyZip } from '../src/export/exportSurvey';
import { createGloriaSurvey, updateGloriaSurvey, upsertSummit } from '~/modules/gloria/db';
import { addInstall, createLoggerVisit, updateLogger, updateVisit } from '~/modules/gloria/loggerDb';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('web attachments', () => {
  beforeEach(async () => {
    closeDbs();
    await initDb();
    picked.length = 0;
  });

  it('stores picked files and photos and exports them', async () => {
    const summitId = upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN' });
    const surveyId = createGloriaSurvey({ summitId, recorded_by: 'T' });

    picked.push([new File([bytes(1, 2, 3)], 'E22a_data.csv', { type: 'text/csv' })]);
    const [ref] = await pickFiles();
    expect(ref.name).toBe('E22a_data.csv');
    expect(ref.uri).toMatch(/^webmedia:files\/[0-9a-f-]{36}\.csv$/);
    expect([...(await readUriBytes(ref.uri))!]).toEqual([1, 2, 3]);

    picked.push([new File([bytes(0xff, 0xd8, 9, 0xff, 0xd9)], 'IMG_1.JPG', { type: 'image/jpeg' })]);
    const photo = await captureEnvPhoto();
    expect(photo).toMatch(/^webmedia:photos\/.+\.jpg$/);

    picked.push([]); // cancelled
    expect(await pickPhotos()).toEqual([]);

    const visitId = createLoggerVisit(summitId, { visitTs: Date.now(), surveyId });
    const loggerId = addInstall(visitId, 'E');
    updateLogger(loggerId, { serial: 'SN1', data_files: JSON.stringify([ref]), photo_open_uri: photo });
    updateVisit(visitId, { form4_files: JSON.stringify([photoRef(photo!, 'form4.jpg')]) });
    updateGloriaSurvey(surveyId, { form1_files: JSON.stringify([photoRef(photo!, 'form1.jpg')]) });

    const loggers = await bundleLoggers(summitId, { includePhotos: true });
    const lz = unzipSync((await readUriBytes(loggers.uri))!);
    const names = Object.keys(lz);
    expect(names.some((n) => n.endsWith('_04_temperature_loggers.csv'))).toBe(true);
    const data = names.find((n) => /\/loggers\/.*E22a_data\.csv$/.test(n));
    expect(data && [...lz[data]]).toEqual([1, 2, 3]);
    expect(names.some((n) => /\/photos\/.*_open\.jpg$/.test(n))).toBe(true);

    const survey = unzipSync((await buildSurveyZip(surveyId, { includePhotos: false })).bytes);
    const sn = Object.keys(survey);
    expect(sn.some((n) => n.includes('/forms/'))).toBe(true);
    expect(sn.some((n) => n.includes('/loggers/'))).toBe(true);
    expect(sn.some((n) => n.includes('/photos/'))).toBe(false);
  });
});
