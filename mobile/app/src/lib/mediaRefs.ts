/**
 * Files of a synced record, on the database side (docs/planned/Media_sync.md
 * phase 2; the formats are in mediaRefsCore.ts):
 *   - listRecordMedia: every file a record refers to, with where it sits;
 *   - addRecordMedia: put a received file into its row, adding only.
 *
 * Rows are found by the keys that travel in the synced yml: occurrence_id for
 * species rows, unit code / point key / checklist item for GLORIA, logger and
 * visit uuid; '' is the record's own row. `updated_at` is left alone: file
 * references are this device's and are not part of what merges compare.
 */
import { getUserDb } from '~/db/init';
import type { MergeKind } from './mergeDocs';
import { itemsIn, MEDIA_COLUMN_KINDS, withAddition, type FileItem, type MediaMeta, type MediaRef } from './mediaRefsCore';
import { visitsOfSurvey } from '~/modules/gloria/loggerDb';
import { setPhotoCheck } from '~/modules/gloria/db';

type Row = Record<string, unknown>;
const rows = (sql: string, args: Array<string | number>) => (getUserDb().executeSync(sql, args).rows ?? []) as Row[];

/** Tables per record kind: how to list the record's rows and what their key is. */
type TableSpec = { table: string; key: string | null; cols: string[]; where: string };

function specs(kind: MergeKind): TableSpec[] {
  const colsOf = (table: string) =>
    Object.keys(MEDIA_COLUMN_KINDS)
      .filter((k) => k.startsWith(`${table}.`))
      .map((k) => k.slice(table.length + 1));
  if (kind === 'session') return [{ table: 'checklist_records', key: 'occurrence_id', cols: colsOf('checklist_records'), where: 'session_id = ?' }];
  if (kind === 'plot')
    return [
      { table: 'plot_species_records', key: 'occurrence_id', cols: colsOf('plot_species_records'), where: 'plot_survey_id = ?' },
      { table: 'plot_surveys', key: null, cols: colsOf('plot_surveys'), where: 'id = ?' },
    ];
  return [
    { table: 'gloria_units', key: 'code', cols: colsOf('gloria_units'), where: 'survey_id = ?' },
    { table: 'gloria_points', key: 'point_key', cols: colsOf('gloria_points'), where: 'survey_id = ?' },
    { table: 'gloria_photo_checks', key: 'item', cols: colsOf('gloria_photo_checks'), where: 'survey_id = ?' },
    { table: 'gloria_surveys', key: null, cols: colsOf('gloria_surveys'), where: 'id = ?' },
  ];
}

/** Every file the record refers to, where it sits, and its note. */
export function listRecordMedia(kind: MergeKind, id: number): Array<FileItem & { ref: MediaRef }> {
  const out: Array<FileItem & { ref: MediaRef }> = [];
  const take = (table: string, key: string, row: Row, cols: string[]) => {
    for (const c of cols) {
      const k = MEDIA_COLUMN_KINDS[`${table}.${c}`];
      for (const it of itemsIn(k, row[c] as string | null)) out.push({ ...it, ref: { t: table, k: key, c } });
    }
  };
  for (const s of specs(kind)) {
    for (const r of rows(`SELECT ${[s.key ?? 'id', ...s.cols].join(', ')} FROM ${s.table} WHERE ${s.where}`, [id])) {
      take(s.table, s.key ? String(r[s.key] ?? '') : '', r, s.cols);
    }
  }
  // GLORIA temperature loggers: the visits of this survey's cycle (the yml carries the same).
  if (kind === 'gloria') {
    for (const v of visitsOfSurvey(id)) {
      const vr = rows(`SELECT uuid, form4_files FROM gloria_logger_visits WHERE id = ?`, [v.id])[0];
      if (vr) take('gloria_logger_visits', String(vr.uuid), vr, ['form4_files']);
      for (const lr of rows(`SELECT uuid, photo_open_uri, photo_closed_uri, data_files FROM gloria_loggers WHERE visit_id = ?`, [v.id])) {
        take('gloria_loggers', String(lr.uuid), lr, ['photo_open_uri', 'photo_closed_uri', 'data_files']);
      }
    }
  }
  return out;
}

/**
 * Add a received file (already on this device as `uri`) at `ref`. False when
 * the row is not here (not merged yet) or nothing changed (already there, or a
 * single-file column already filled).
 */
export function addRecordMedia(kind: MergeKind, id: number, ref: MediaRef, uri: string, meta: MediaMeta | undefined, has: (uri: string) => boolean): boolean {
  const colKind = MEDIA_COLUMN_KINDS[`${ref.t}.${ref.c}`];
  if (!colKind) return false;
  const db = getUserDb();
  const spec = specs(kind).find((s) => s.table === ref.t);
  let where: string;
  let args: Array<string | number>;
  if (spec) {
    where = spec.key ? `${spec.where} AND ${spec.key} = ?` : spec.where;
    args = spec.key ? [id, ref.k] : [id];
  } else if (kind === 'gloria' && (ref.t === 'gloria_logger_visits' || ref.t === 'gloria_loggers')) {
    where = 'uuid = ?';
    args = [ref.k];
  } else return false;
  const row = rows(`SELECT id, ${ref.c} AS v FROM ${ref.t} WHERE ${where}`, args)[0];
  if (!row) {
    // A checklist item without a row yet: setPhotoCheck creates it (and ticks it, as a photo does).
    if (ref.t === 'gloria_photo_checks') {
      setPhotoCheck(id, ref.k, { photo_uri: uri });
      return true;
    }
    return false;
  }
  const next = withAddition(colKind, row.v as string | null, uri, meta, has);
  if (next == null) return false;
  if (ref.t === 'gloria_photo_checks') {
    setPhotoCheck(id, ref.k, { photo_uri: next });
    return true;
  }
  db.executeSync(`UPDATE ${ref.t} SET ${ref.c} = ? WHERE id = ?`, [next, Number(row.id)]);
  return true;
}
