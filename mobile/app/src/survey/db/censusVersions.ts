/**
 * Census pieces of record versions (src/db/recordVersions.ts) on the app's
 * connection: a quadrat's slice ('survey_quadrat') and a census header
 * ('survey', kept when a census is deleted). The rules are in sliceCore.ts.
 */
import { getUserDb, withTransaction } from '~/db/init';
import { generateUuid } from '~/db/uuid';
import { clearCensusUndo } from '../undo';
import * as sl from './sliceCore';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const rows = <T>(sql: string, args: (string | number)[] = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];

type QuadratRef = { id: number; uuid: string; survey_id: number; quadrat_code: string; census_no: number; frame_code: string };

function quadratRef(id: number): QuadratRef | null {
  return (
    rows<QuadratRef>(
      `SELECT q.id, q.uuid, q.survey_id, q.quadrat_code, s.census_no, f.code AS frame_code
         FROM fw_survey_quadrats q JOIN fw_surveys s ON s.id = q.survey_id JOIN fw_frames f ON f.id = s.frame_id WHERE q.id = ?`,
      [id],
    )[0] ?? null
  );
}

/** Version label: language-neutral, like GLORIA's "code mocy n". */
const quadratLabel = (q: QuadratRef) => `${q.frame_code} #${q.census_no} ${q.quadrat_code}`;

export function quadratIdentity(id: number): { uuid: string; label: string } | null {
  const q = quadratRef(id);
  return q ? { uuid: q.uuid, label: quadratLabel(q) } : null;
}

export function quadratIdByUuid(uuid: string): number | null {
  return rows<{ id: number }>(`SELECT id FROM fw_survey_quadrats WHERE uuid = ?`, [uuid])[0]?.id ?? null;
}

/** The fw_survey_quadrats row of a census quadrat (versions are kept per row). */
export function quadratRowId(surveyId: number, code: string): number | null {
  return rows<{ id: number }>(`SELECT id FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = ?`, [surveyId, code])[0]?.id ?? null;
}

export function quadratSlice(id: number): sl.CensusSlice | null {
  const q = quadratRef(id);
  return q ? sl.buildSlice(ctx(), q.survey_id, [q.quadrat_code]) : null;
}

/** What restoring `target` reaches, kept as the version before it (code review M11). */
export function quadratSliceForRestore(id: number, target: sl.CensusSlice): sl.CensusSlice | null {
  const q = quadratRef(id);
  return q ? sl.sliceForRestore(ctx(), q.survey_id, target) : null;
}

export function restoreQuadrat(id: number, slice: sl.CensusSlice): number {
  const q = quadratRef(id);
  if (!q) throw new Error('quadrat not found');
  const n = withTransaction(() => sl.restoreSlice(ctx(), q.survey_id, slice));
  // Undo steps from before the restore would undo it in part (code review H1).
  clearCensusUndo(q.survey_id);
  return n;
}

export function censusIdentity(surveyId: number): { uuid: string; label: string } | null {
  const c = sl.censusIdentity(ctx(), surveyId);
  return c ? { uuid: c.uuid, label: `${c.frameCode} #${c.censusNo}` } : null;
}

export function censusIdByUuid(uuid: string): number | null {
  return rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE uuid = ?`, [uuid])[0]?.id ?? null;
}

export const censusHeader = (surveyId: number) => sl.censusHeaderDoc(ctx(), surveyId);

/** Every quadrat row of a census that holds data (for before_delete versions). */
export function censusQuadratIds(surveyId: number): number[] {
  return rows<{ id: number }>(`SELECT id FROM fw_survey_quadrats WHERE survey_id = ? ORDER BY quadrat_code`, [surveyId]).map((r) => r.id);
}

/** Quadrats changed since their latest version (versions to keep when a census is finished). */
export function changedQuadratIds(surveyId: number): number[] {
  return rows<{ id: number }>(
    `SELECT q.id FROM fw_survey_quadrats q
      WHERE q.survey_id = ? AND q.updated_at > COALESCE((SELECT MAX(v.updated_at) FROM record_versions v WHERE v.record_kind = 'survey_quadrat' AND v.record_uuid = q.uuid), 0)`,
    [surveyId],
  ).map((r) => r.id);
}

export function recoverCensusFrom(header: sl.CensusHeaderDoc, slices: sl.CensusSlice[]): number {
  return withTransaction(() => sl.recoverCensus(ctx(), header, slices));
}

export { censusSide, headerSide, CENSUS_COMBINERS, RecoverCensusError, type CensusHeaderDoc, type CensusSlice } from './sliceCore';
