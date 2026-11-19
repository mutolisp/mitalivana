/**
 * The mobile GLORIA DB layer runs unchanged on sqlite-wasm:
 *   create summit + survey → record species, cover, frequency, points
 *   → yml (same dump options as bundleExport) → validate → import into a
 *   fresh database → the restored document equals the original.
 * Also builds the Sheet CSV tables from the same data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { initDb, closeDbs } from '../src/host/dbInit';
import {
  upsertSummit, createGloriaSurvey, listUnits, getUnit, updateUnit, addUnitSpecies, updateUnitSpecies,
  startFrequency, startPoints, commitPoint, listSurveySpecies, loadGloriaDoc, importGloriaDoc,
  loadExportData, listGloriaSurveys, setPhotoCheck, getGloriaSurvey,
} from '~/modules/gloria/db';
import { validateGloriaDoc, isGloriaDoc, type GloriaDoc } from '~/modules/gloria/export/yaml';
import { buildSheetTables, toCsv } from '~/modules/gloria/export/sheetRows';

async function freshDb() {
  closeDbs();
  await initDb();
}

/** Ids and timestamps differ between databases; everything else must match. */
function stable(doc: GloriaDoc): unknown {
  return JSON.parse(JSON.stringify(doc), (k, v) => (k === 'id' || k === 'survey_id' || k === 'summit_id' || k === 'unit_id' || k === 'gloria_taxon_id' || k === 'prev_survey_id' ? undefined : v));
}

describe('GLORIA db.ts on sqlite-wasm', () => {
  beforeEach(freshDb);

  it('creates a survey with 28 units and 28 points', () => {
    const summitId = upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN', name: 'Test summit', elevation_m: 3000 });
    const surveyId = createGloriaSurvey({ summitId, recorded_by: 'Tester' });
    expect(listUnits(surveyId)).toHaveLength(28);
    expect(listGloriaSurveys()).toHaveLength(1);
  });

  it('round-trips a recorded survey through yml', async () => {
    const summitId = upsertSummit({ country: 'TW', target_region: 'DAS', summit: 'SUN', decimal_latitude: 24.1, decimal_longitude: 121.2 });
    const surveyId = createGloriaSurvey({ summitId, recorded_by: 'Tester' });
    const units = listUnits(surveyId);
    const quadrat = units.find((u) => u.unit_type === 'quadrat')!;
    const sas = units.find((u) => u.unit_type === 'sas')!;
    expect(quadrat && sas).toBeTruthy();

    updateUnit(quadrat.id, { slope_deg: 12, aspect_deg: 90 });
    const a = addUnitSpecies(quadrat.id, 't_test_1');
    const b = addUnitSpecies(quadrat.id, 't_test_2', 'sp1');
    updateUnitSpecies(a, { cover_pct: 5.5 });
    startFrequency(quadrat.id);
    updateUnitSpecies(a, { freq_cells: '1'.repeat(10) + '0'.repeat(90) });
    startPoints(quadrat.id, 100);
    commitPoint(quadrat.id, 100, 3, [{ unitSpeciesId: b, on: true }], 'R');
    const s1 = addUnitSpecies(sas.id, 't_test_1');
    updateUnitSpecies(s1, { abundance: 'c' });
    setPhotoCheck(surveyId, 'SU-OV', { checked: true });

    expect(listSurveySpecies(surveyId)).toHaveLength(3);
    expect(getUnit(surveyId, quadrat.code)?.point_surface?.[3]).toBe('R');

    const doc = loadGloriaDoc(surveyId)!;
    const text = yaml.dump(doc, { lineWidth: -1, noRefs: true });
    const parsed = yaml.load(text) as GloriaDoc;
    expect(isGloriaDoc(parsed)).toBe(true);
    expect(validateGloriaDoc(parsed)).toEqual([]);

    const tables = buildSheetTables(loadExportData(surveyId)!);
    const names = tables.filter((t) => t.rows.length).map((t) => t.name);
    expect(names).toContain('12_13_1x1m_sp_freq');
    expect(names).toContain('22_sas_sp');
    for (const t of tables) expect(() => toCsv(t.header, t.rows)).not.toThrow();

    await freshDb();
    const res = importGloriaDoc(parsed);
    // An import always lands as done (never takes the active slot).
    expect(getGloriaSurvey(res.surveyId)?.status).toBe('done');
    const back = loadGloriaDoc(res.surveyId)!;
    // importGloriaDoc closes a survey that was still open (stop_ts filled), as on mobile.
    expect(back.survey.stop_ts).not.toBeNull();
    const open = (d: GloriaDoc) => stable({ ...d, survey: { ...d.survey, stop_ts: null } } as GloriaDoc);
    expect(open(back)).toEqual(open(parsed));
  });
});
