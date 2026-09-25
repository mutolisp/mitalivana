/**
 * Summit base data and measurement points as CSV (UTF-8 BOM), in the columns
 * of sheet 00_ and 02_ — the same files the importers read back.
 */
import { File, Paths } from 'expo-file-system';
import { getUserDb } from '~/db/init';
import { listPoints, listSummits } from './db';
import { H00_PLOT_COORDINATES, H02_POINTS } from './export/sheetHeaders';
import { pointRows, summitRow, toCsv } from './export/sheetRows';

function write(name: string, csv: string) {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(csv);
  return { uri: file.uri, filename: name, mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' };
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

export async function exportSummitsCsv() {
  return write(`GLORIA_00_summits_${stamp()}.csv`, toCsv(H00_PLOT_COORDINATES, listSummits().map(summitRow)));
}

/** Every survey's 28 points, summit by summit, newest cycle first. */
export async function exportPointsCsv() {
  const summits = new Map(listSummits().map((s) => [s.id, s]));
  const surveys = (getUserDb().executeSync(`SELECT id, summit_id, mocy FROM gloria_surveys ORDER BY summit_id, mocy DESC`).rows ?? []) as Array<{
    id: number;
    summit_id: number;
    mocy: number;
  }>;
  const rows = surveys.flatMap((v) => {
    const sm = summits.get(v.summit_id);
    return sm ? pointRows(sm, v.mocy, listPoints(v.id)) : [];
  });
  return write(`GLORIA_02_points_${stamp()}.csv`, toCsv(H02_POINTS, rows));
}
