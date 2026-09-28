/**
 * Scans of the paper field forms kept with a survey — pure, so check:gloria
 * runs it in Node.
 *
 *   - Form 1 (measurement protocol), Form 2 (1-m² quadrat), Form 3 (summit
 *     area section) and Form 6-S (10 m × 10 m square); manual Annex II
 *     pp.115–122. Form 4 scans belong to the logger visit (loggers.ts).
 *   - Each form holds any number of files (photos or PDF): Form 2 alone is
 *     16 sheets plus notes pages.
 *   - Sheet 01_ names each form by an identifier; the Taiwan sheet's rows read
 *     mocy4_TW-SAC-JIA_2_1x1_20260805, the middle number being the column's
 *     slot (0 summit-overview, 1 temperature logger, 2 1x1, 3 SAS, 4 10x10).
 *     Form 1 takes the summit-overview slot, the only one left for it.
 *   - The date is the day that method started: the earliest start among its
 *     units, else the survey's start (Form 1 always the survey's).
 */
import { parseFiles, ymd, type FileRef } from './loggers';
import type { UnitType } from './units';

export type ScanForm = '1' | '2' | '3' | '6S';
export type ScanColumn = 'form1_files' | 'form2_files' | 'form3_files' | 'form6s_files';

export const SCAN_FORMS: ReadonlyArray<{
  form: ScanForm;
  column: ScanColumn;
  /** Sheet 01_ column holding the identifier. */
  sheetColumn: 'summitOverview' | 'vegdata_1x1_form' | 'vegdata_sas' | 'vegdata_10x10';
  slot: number;
  kind: string;
  unitType: UnitType | null;
}> = [
  { form: '1', column: 'form1_files', sheetColumn: 'summitOverview', slot: 0, kind: 'summit-overview', unitType: null },
  { form: '2', column: 'form2_files', sheetColumn: 'vegdata_1x1_form', slot: 2, kind: '1x1', unitType: 'quadrat' },
  { form: '3', column: 'form3_files', sheetColumn: 'vegdata_sas', slot: 3, kind: 'SAS', unitType: 'sas' },
  { form: '6S', column: 'form6s_files', sheetColumn: 'vegdata_10x10', slot: 4, kind: '10x10', unitType: 'square' },
];

export type ScanSurvey = { mocy: number; start_ts: number } & Partial<Record<ScanColumn, string | null>>;
export type ScanUnit = { unit_type: UnitType; start_ts: number | null };

function formDate(f: (typeof SCAN_FORMS)[number], sv: ScanSurvey, units: ReadonlyArray<ScanUnit>): number {
  if (!f.unitType) return sv.start_ts;
  const starts = units.filter((u) => u.unit_type === f.unitType && u.start_ts != null).map((u) => u.start_ts as number);
  return starts.length ? Math.min(...starts) : sv.start_ts;
}

/** Sheet 01_ identifier of each form that has a scan; forms without one are absent. */
export function formScanIds(fullCode: string, sv: ScanSurvey, units: ReadonlyArray<ScanUnit>): Partial<Record<ScanForm, string>> {
  const out: Partial<Record<ScanForm, string>> = {};
  for (const f of SCAN_FORMS)
    if (parseFiles(sv[f.column]).length) out[f.form] = `mocy${sv.mocy}_${fullCode}_${f.slot}_${f.kind}_${ymd(formDate(f, sv, units))}`;
  return out;
}

/** Zip file name of every scan: the form's identifier, -2, -3 … for later files, with the file's own extension. */
export function planFormScans(fullCode: string, sv: ScanSurvey, units: ReadonlyArray<ScanUnit>): Array<{ uri: string; name: string }> {
  const ids = formScanIds(fullCode, sv, units);
  return SCAN_FORMS.flatMap((f) =>
    parseFiles(sv[f.column]).map((file: FileRef, i) => {
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1]?.toLowerCase() ?? 'jpg';
      return { uri: file.uri, name: `${ids[f.form]}${i ? `-${i + 1}` : ''}.${ext}` };
    }),
  );
}
