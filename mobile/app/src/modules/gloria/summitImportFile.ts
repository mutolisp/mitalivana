/**
 * Pick a CSV or .xlsx and parse it — summit base data (model/summitImport) or
 * measurement points (model/pointImport). The parsed result waits in a small
 * store for its review screen, which is a route of its own — too much to pass
 * as a route param.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { create } from 'zustand';
import { readXlsxFirstSheet } from '~/lib/xlsxRead';
import { parseCsv, tableToSummits, type ParsedSummits } from './model/summitImport';
import { tableToPoints, type ImportedPoint, type PointProblem } from './model/pointImport';

export type PendingSummitImport = { fileName: string; parsed: ParsedSummits };

export const usePendingSummitImport = create<{
  pending: PendingSummitImport | null;
  set: (p: PendingSummitImport | null) => void;
}>((set) => ({ pending: null, set: (pending) => set({ pending }) }));

export type PendingPointImport = { surveyId: number; fileName: string; rows: ImportedPoint[]; problems: PointProblem[] };

export const usePendingPointImport = create<{
  pending: PendingPointImport | null;
  set: (p: PendingPointImport | null) => void;
}>((set) => ({ pending: null, set: (pending) => set({ pending }) }));

/** The picked file as rows of cells; null when the user cancelled. Throws when it cannot be read. */
async function pickTable(): Promise<{ fileName: string; table: string[][] } | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: [
      'text/csv',
      'text/comma-separated-values',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '*/*',
    ],
    copyToCacheDirectory: true,
  });
  if (r.canceled || !r.assets?.[0]?.uri) return null;
  const asset = r.assets[0];
  const file = new File(asset.uri);
  const bytes = await file.bytes();
  // An .xlsx is a zip ("PK"), whatever the picker says the name is.
  const isXlsx = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const table = isXlsx ? readXlsxFirstSheet(bytes) : parseCsv(new TextDecoder('utf-8').decode(bytes));
  return { fileName: asset.name ?? '', table };
}

export async function pickSummitTable(): Promise<PendingSummitImport | null> {
  const p = await pickTable();
  return p ? { fileName: p.fileName, parsed: tableToSummits(p.table) } : null;
}

/** Pick → parse → open the point review screen for one survey. */
export async function startPointImport(surveyId: number, open: () => void, onError: (e: unknown) => void): Promise<void> {
  try {
    const p = await pickTable();
    if (!p) return;
    const { rows, problems } = tableToPoints(p.table);
    usePendingPointImport.getState().set({ surveyId, fileName: p.fileName, rows, problems });
    open();
  } catch (e) {
    onError(e);
  }
}

/** Pick → parse → open the review screen. Shared by the new-survey screen and the summit list. */
export async function startSummitImport(open: () => void, onError: (e: unknown) => void): Promise<void> {
  try {
    const p = await pickSummitTable();
    if (!p) return;
    usePendingSummitImport.getState().set(p);
    open();
  } catch (e) {
    onError(e);
  }
}
