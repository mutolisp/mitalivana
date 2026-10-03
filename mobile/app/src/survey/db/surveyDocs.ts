/**
 * Checklist / plot-style surveys as documents on the app's connection (record
 * versions, team merge and sync; rules in surveyDocCore.ts, tested by
 * check:survey-doc).
 */
import { File } from 'expo-file-system';
import { getUserDb, withTransaction } from '~/db/init';
import { generateUuid } from '~/db/uuid';
import { safeAppFileUri } from '~/lib/appFiles';
import { resolveTaxa } from '~/db/taxonLookup';
import type { MergeOp } from '~/lib/mergeEngine';
import * as core from './surveyDocCore';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const rows = <T>(sql: string, args: (string | number)[] = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];

export type { Sealed, SurveyDoc } from './surveyDocCore';
export { SURVEY_DOC_COMBINERS, isSurveyDoc, sealedOccurrences, surveyDocForPeer, surveyIdent, withoutSealed } from './surveyDocCore';

/** The survey as a document, or null when it is gone (or a census). `previous`: carry the one before it (team sync). */
export function surveyDoc(id: number, opts: { previous?: boolean } = {}): core.SurveyDoc | null {
  try {
    return core.buildSurveyDoc(ctx(), id, opts);
  } catch {
    return null;
  }
}

/** Merge rows with display names from the checklists (or the taxon cache). */
export function surveySide(doc: core.SurveyDoc, opts: { frame?: boolean } = {}) {
  const ids = [...new Set([...doc.occurrences.map((o) => String(o.taxon_id)), ...doc.rechecks.map((r) => String(r.prev_taxon_id))])];
  const taxa = resolveTaxa(ids);
  return core.surveyDocSide(doc, { ...opts, names: (t) => taxa.get(t)?.simple_name || null });
}

/** uuid and a language-neutral label ("name", or "plot #n name" on a plot). */
export function modularIdentity(id: number): { uuid: string; label: string } | null {
  const r = rows<{ uuid: string; name: string | null; census_no: number | null; code: string | null }>(
    `SELECT s.uuid, s.name, s.census_no, f.code FROM fw_surveys s LEFT JOIN fw_frames f ON f.id = s.frame_id WHERE s.id = ? AND s.style <> 'individual'`,
    [id],
  )[0];
  if (!r) return null;
  // On a plot the name defaults to the plot code: said once.
  const name = r.name && r.name !== r.code ? r.name : '';
  return { uuid: r.uuid, label: r.code ? `${r.code} #${r.census_no} ${name}`.trim() : (r.name ?? '') };
}

/** The survey's uuid and its team-sync identity (surveyIdent: plot + template + number on a plot, else its uuid). */
export function modularSyncIdent(id: number): { uuid: string; ident: string } | null {
  const r = rows<{ uuid: string; frame_uuid: string | null; template_id: string; census_no: number | null }>(
    `SELECT s.uuid, f.uuid AS frame_uuid, s.template_id, s.census_no FROM fw_surveys s LEFT JOIN fw_frames f ON f.id = s.frame_id WHERE s.id = ? AND s.style <> 'individual'`,
    [id],
  )[0];
  if (!r) return null;
  return { uuid: r.uuid, ident: core.surveyIdent({ frame: r.frame_uuid ? { uuid: r.frame_uuid } : null, survey: { uuid: r.uuid, template_id: r.template_id, census_no: r.census_no } }) };
}

/** The local survey a teammate's document is (same identity), if any. */
export function modularIdForDoc(doc: core.SurveyDoc): number | null {
  return core.surveyByIdent(ctx(), doc);
}

/** A teammate's survey new on this device, with the survey before it when it carries one and this device lacks it: both land finished, without a project. Throws InsertSurveyError. */
export function receiveSurvey(doc: core.SurveyDoc): number {
  const peer = core.surveyDocForPeer(doc);
  return withTransaction(() => {
    core.insertPreviousFromDoc(ctx(), peer);
    return core.insertSurveyFromDoc(ctx(), peer, { status: 'done', projectId: 0 });
  });
}

/** The survey before a teammate's (already here) when this device lacks it; a plot code taken by another plot leaves it out. */
export function receivePrevious(doc: core.SurveyDoc): number | null {
  try {
    return withTransaction(() => core.insertPreviousFromDoc(ctx(), core.surveyDocForPeer(doc)));
  } catch (e) {
    if (e instanceof core.InsertSurveyError) return null;
    throw e;
  }
}

export function modularIdByUuid(uuid: string): number | null {
  return rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE uuid = ? AND style <> 'individual'`, [uuid])[0]?.id ?? null;
}

/** A version's photo is put back only if it is still here, in the media folders (security audit S1). */
const fileHere = (uri: string) => {
  if (!uri.startsWith('file:')) return true;
  const safe = safeAppFileUri(uri);
  return safe != null && new File(safe).exists;
};

/** Write merge / restore operations (one transaction). Returns the rows written. */
export function applySurveyOps(id: number, ops: readonly MergeOp[]): number {
  return withTransaction(() => core.applySurveyDocOps(ctx(), id, ops));
}

/** Photo and recording rows of a version whose file is still here, back in place (not onto sealed blind records). */
export function putBackSurveyMedia(id: number, doc: core.SurveyDoc, sealed: ReadonlySet<string> = new Set()): number {
  return withTransaction(() => core.putBackMediaRows(ctx(), id, doc, fileHere, sealed));
}

/** A deleted survey again, under its own uuid; it lands finished. Returns its id. */
export function recoverSurvey(doc: core.SurveyDoc): number {
  return withTransaction(() => {
    const id = core.insertSurveyFromDoc(ctx(), doc, { status: 'done', projectId: doc.project_id ?? 0 });
    core.putBackMediaRows(ctx(), id, doc, fileHere);
    return id;
  });
}

export { InsertSurveyError } from './surveyDocCore';
