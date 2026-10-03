/**
 * Files of a synced record, on the database side (docs/planned/Media_sync.md
 * phase 2; the formats are in mediaRefsCore.ts):
 *   - listRecordMedia: every file a record refers to, with where it sits;
 *   - addRecordMedia: put a received file into its row, adding only.
 *
 * Rows are found by the keys that travel in the synced yml: occurrence_id for
 * species rows, unit code / point key / checklist item for GLORIA, logger and
 * visit uuid, a survey photo row's uuid (its unit / occurrence in the entry's
 * `meta.place`), a morphospecies' taxon|label; '' is the record's own row. `updated_at` is left alone: file
 * references are this device's and are not part of what merges compare.
 */
import { assertNever } from './assertNever';
import { getUserDb } from '~/db/init';
import type { MergeKind } from './mergeDocs';
import { itemsIn, MEDIA_COLUMN_KINDS, withAddition, type FileItem, type MediaMeta, type MediaRef } from './mediaRefsCore';
import { visitsOfSurvey } from '~/modules/gloria/loggerDb';
import { setPhotoCheck } from '~/modules/gloria/db';
import { unitKey } from '~/survey/db/surveyDocCore';

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
      // Quadrats (v77) by number, as the merge keys them.
      { table: 'plot_quadrats', key: 'idx', cols: colsOf('plot_quadrats'), where: 'plot_survey_id = ?' },
      { table: 'plot_surveys', key: null, cols: colsOf('plot_surveys'), where: 'id = ?' },
    ];
  if (kind === 'gloria')
    return [
      { table: 'gloria_units', key: 'code', cols: colsOf('gloria_units'), where: 'survey_id = ?' },
      { table: 'gloria_points', key: 'point_key', cols: colsOf('gloria_points'), where: 'survey_id = ?' },
      { table: 'gloria_photo_checks', key: 'item', cols: colsOf('gloria_photo_checks'), where: 'survey_id = ?' },
      { table: 'gloria_surveys', key: null, cols: colsOf('gloria_surveys'), where: 'id = ?' },
    ];
  // Photos are rows of their own, and the plot's morphospecies are keyed by taxon + label: below.
  if (kind === 'modular') return [];
  return assertNever(kind, 'merge kind');
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
  if (kind === 'modular') out.push(...modularMedia(id));
  return out;
}

/**
 * A checklist / plot-style survey's files: its photo rows (each says its
 * unit or occurrence, as the survey document keys them) and its plot's
 * morphospecies photos (keyed by taxon + label, as the merge keys them).
 * An interaction's photo says its interaction (2F-b).
 */
function modularMedia(id: number): Array<FileItem & { ref: MediaRef }> {
  const media = rows(
    `SELECT md.uuid, md.uri, md.component, md.kind, u.level_key, u.code, o.uuid AS occ, i.uuid AS inter FROM fw_media md
       LEFT JOIN fw_units u ON u.id = md.unit_id LEFT JOIN fw_occurrences o ON o.id = md.occurrence_id
       LEFT JOIN fw_interactions i ON i.id = md.interaction_id
      WHERE md.survey_id = ? ORDER BY md.id`,
    [id],
  ).map((r) => ({
    uri: String(r.uri),
    ref: { t: 'fw_media', k: String(r.uuid), c: 'uri' },
    meta: {
      place: {
        unit: r.level_key == null ? null : unitKey(r.level_key, r.code),
        occ: (r.occ as string | null) ?? null,
        ...(r.inter != null ? { inter: String(r.inter) } : {}),
        component: String(r.component),
        kind: String(r.kind),
      },
    },
  }));
  const labels = rows(
    `SELECT l.taxon_id, l.verbatim_identification, l.photo_uri FROM fw_frame_labels l JOIN fw_surveys s ON s.frame_id = l.frame_id
      WHERE s.id = ? AND l.photo_uri IS NOT NULL ORDER BY l.id`,
    [id],
  ).map((r) => ({ uri: String(r.photo_uri), ref: { t: 'fw_frame_labels', k: `${r.taxon_id}|${r.verbatim_identification}`, c: 'photo_uri' } }));
  return [...media, ...labels];
}

/** Place a teammate's survey photo (a new row) or morphospecies photo (an empty column); adding only. */
function addModularMedia(id: number, ref: MediaRef, uri: string, meta: MediaMeta | undefined, has: (uri: string) => boolean): boolean {
  const db = getUserDb();
  if (ref.t === 'fw_media' && ref.c === 'uri') {
    const place = meta?.place;
    if (!place || rows(`SELECT id FROM fw_media WHERE uuid = ?`, [ref.k]).length) return false;
    let unitId: number | null = null;
    if (place.unit != null) {
      const at = place.unit.indexOf(':');
      unitId = Number(rows(`SELECT id FROM fw_units WHERE survey_id = ? AND level_key = ? AND code = ?`, [id, place.unit.slice(0, at), place.unit.slice(at + 1)])[0]?.id ?? NaN);
      if (!Number.isFinite(unitId)) return false; // its unit is not merged yet
    }
    let occId: number | null = null;
    if (place.occ != null) {
      occId = Number(rows(`SELECT id FROM fw_occurrences WHERE survey_id = ? AND uuid = ?`, [id, place.occ])[0]?.id ?? NaN);
      if (!Number.isFinite(occId)) return false;
    }
    let interId: number | null = null;
    if (place.inter != null) {
      interId = Number(rows(`SELECT id FROM fw_interactions WHERE survey_id = ? AND uuid = ?`, [id, place.inter])[0]?.id ?? NaN);
      if (!Number.isFinite(interId)) return false; // its interaction is not merged yet
    }
    db.executeSync(`INSERT INTO fw_media (uuid, survey_id, unit_id, occurrence_id, interaction_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ref.k,
      id,
      unitId,
      occId,
      interId,
      place.component,
      place.kind,
      uri,
      Date.now(),
    ]);
    return true;
  }
  if (ref.t === 'fw_frame_labels' && ref.c === 'photo_uri') {
    const bar = ref.k.indexOf('|');
    const row = rows(
      `SELECT l.id, l.photo_uri AS v FROM fw_frame_labels l JOIN fw_surveys s ON s.frame_id = l.frame_id
        WHERE s.id = ? AND l.taxon_id = ? AND l.verbatim_identification = ?`,
      [id, ref.k.slice(0, bar), ref.k.slice(bar + 1)],
    )[0];
    if (!row) return false;
    const next = withAddition('single', row.v as string | null, uri, meta, has);
    if (next == null) return false;
    db.executeSync(`UPDATE fw_frame_labels SET photo_uri = ? WHERE id = ?`, [next, Number(row.id)]);
    return true;
  }
  return false;
}

/**
 * Add a received file (already on this device as `uri`) at `ref`. False when
 * the row is not here (not merged yet) or nothing changed (already there, or a
 * single-file column already filled).
 */
export function addRecordMedia(kind: MergeKind, id: number, ref: MediaRef, uri: string, meta: MediaMeta | undefined, has: (uri: string) => boolean): boolean {
  const colKind = MEDIA_COLUMN_KINDS[`${ref.t}.${ref.c}`];
  if (!colKind) return false;
  if (kind === 'modular') return addModularMedia(id, ref, uri, meta, has);
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
