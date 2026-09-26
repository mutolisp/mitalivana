/**
 * Team merge for GLORIA (see src/lib/mergeEngine.ts): several surveyors of the
 * same summit and monitoring cycle, typically each on their own aspects.
 *
 * The survey is matched by summit + mocy, not uuid: each device may have
 * started its own copy of the cycle. Units match by code and points by point
 * key (both fixed sets); species by occurrence_id, or — for the "same quadrat,
 * same taxon" check — by unit + taxon. Roster serials are per device, so a
 * species arriving from the other side is re-numbered into this roster.
 *
 * Units and points are never inserted or deleted: every survey has all 28 and
 * all measurement points. Media paths are not merged (device URIs).
 */
import { getUserDb, withTransaction } from '~/db/init';
import { writeInsert, writeUpdate } from '~/db/teamMerge';
import type { MergeOp } from '~/lib/mergeEngine';
import { ensureRosterTaxon, getGloriaSurvey, loadGloriaDoc, nextUnitPosition, setPhotoCheck } from './db';
import type { GloriaDoc } from './export/yaml';

/** This device's survey of the same summit and cycle, if any. */
export function findGloriaSurveyFor(doc: GloriaDoc): number | null {
  const res = getUserDb().executeSync(
    `SELECT sv.id FROM gloria_surveys sv JOIN gloria_summits s ON s.id = sv.summit_id
      WHERE s.full_code = ? AND sv.mocy = ?`,
    [doc.summit.full_code, doc.survey.mocy],
  );
  return (res.rows?.[0] as { id?: number } | undefined)?.id ?? null;
}

/** As a file would carry it, so both sides normalize alike. */
export function localGloriaDoc(surveyId: number): GloriaDoc | null {
  const doc = loadGloriaDoc(surveyId);
  return doc ? (JSON.parse(JSON.stringify(doc)) as GloriaDoc) : null;
}

export function applyGloriaMerge(surveyId: number, ops: MergeOp[]): void {
  withTransaction(() => {
    const db = getUserDb();
    const survey = getGloriaSurvey(surveyId);
    if (!survey) throw new Error(`GLORIA survey ${surveyId} not found`);
    const now = Date.now();
    const unitId = (code: string) =>
      (db.executeSync(`SELECT id FROM gloria_units WHERE survey_id = ? AND code = ?`, [surveyId, code]).rows?.[0] as
        | { id: number }
        | undefined)?.id ?? null;

    for (const op of ops) {
      if (op.tbl === 'survey' && op.op === 'update') {
        const { grid_ok, ...rest } = { ...op.data, ...op.extra } as Record<string, unknown>;
        const grid = grid_ok as { N?: number; E?: number; S?: number; W?: number } | undefined;
        writeUpdate(
          'gloria_surveys',
          {
            ...rest,
            ...(grid ? { grid_ok_n: grid.N ?? 0, grid_ok_e: grid.E ?? 0, grid_ok_s: grid.S ?? 0, grid_ok_w: grid.W ?? 0 } : {}),
          },
          'id = ?',
          [surveyId],
          true,
        );
      } else if (op.tbl === 'point' && op.op === 'update') {
        writeUpdate('gloria_points', op.data, 'survey_id = ? AND point_key = ?', [surveyId, op.key], false);
      } else if (op.tbl === 'unit' && op.op === 'update') {
        writeUpdate('gloria_units', op.data, 'survey_id = ? AND code = ?', [surveyId, op.key], true);
      } else if (op.tbl === 'check' && op.op !== 'delete') {
        const data = op.op === 'insert' ? op.row.data : op.data;
        setPhotoCheck(surveyId, op.op === 'insert' ? op.row.key : op.key, { checked: !!data.checked });
      }
    }

    // Species after the units they belong to.
    for (const op of ops) {
      if (op.tbl !== 'sp') continue;
      if (op.op === 'delete') {
        db.executeSync(
          `DELETE FROM gloria_unit_species WHERE occurrence_id = ? AND unit_id IN (SELECT id FROM gloria_units WHERE survey_id = ?)`,
          [op.key, surveyId],
        );
        continue;
      }
      const data = op.op === 'insert' ? op.row.data : op.data;
      const extra = op.op === 'insert' ? op.row.extra : op.extra;
      // The file names the unit by code and the taxon by id; the columns hold
      // this device's unit and roster rows.
      const cols: Record<string, unknown> = { ...data };
      delete cols.unit;
      delete cols.taxon_id;
      const uid = data.unit != null ? unitId(String(data.unit)) : null;
      if (uid != null) cols.unit_id = uid;
      if (data.taxon_id != null) {
        const gid = ensureRosterTaxon(surveyId, String(data.taxon_id));
        cols.gloria_taxon_id = gid;
        if (op.op === 'insert' && (extra?.used_name_id != null || extra?.used_scientific_name)) {
          writeUpdate(
            'gloria_taxa',
            { used_name_id: extra?.used_name_id ?? null, used_scientific_name: extra?.used_scientific_name ?? null },
            'id = ? AND used_name_id IS NULL AND used_scientific_name IS NULL',
            [gid],
            false,
          );
        }
      }
      if (op.op === 'update') {
        writeUpdate(
          'gloria_unit_species',
          cols,
          'occurrence_id = ? AND unit_id IN (SELECT id FROM gloria_units WHERE survey_id = ?)',
          [op.key, surveyId],
          true,
        );
      } else {
        if (uid == null) throw new Error(`unit ${String(data.unit)} not in this survey`);
        writeInsert('gloria_unit_species', {
          ...cols,
          occurrence_id: op.row.key,
          sort_order: nextUnitPosition(uid),
          created_at: now,
          updated_at: now,
        });
      }
    }
    db.executeSync(`UPDATE gloria_surveys SET updated_at = ? WHERE id = ?`, [now, surveyId]);
  });
}
