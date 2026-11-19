/**
 * A GLORIA export (zip or bare yml, from the mobile app or this one) → a
 * survey in this database. Reading the file is the mobile reader
 * (readRecordImportFromBytes), so both apps accept the same files.
 *
 * Same rules as mobile finishGloriaImport, minus team merge:
 *   - same survey uuid already here → the caller decides; `replace` overwrites;
 *   - same summit + cycle under another uuid → refused (merging is a later
 *     phase on the web).
 * Photos inside the zip are not restored, as on mobile: the yml names them.
 */
import { readRecordImportFromBytes } from '~/lib/recordImportZip';
import { validateGloriaDoc, type GloriaDoc } from '~/modules/gloria/export/yaml';
import { gloriaSurveyUuidExists, importGloriaDoc } from '~/modules/gloria/db';

export type ImportCheck =
  | { ok: true; doc: GloriaDoc; exists: boolean }
  | { ok: false; reason: 'not-gloria' | 'invalid'; detail?: string };

export function readGloriaImport(bytes: Uint8Array): ImportCheck {
  let read;
  try {
    read = readRecordImportFromBytes(bytes);
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: String(e) };
  }
  if (read.kind !== 'gloria') return { ok: false, reason: 'not-gloria', detail: read.kind };
  const problems = validateGloriaDoc(read.gloria);
  if (problems.length) return { ok: false, reason: 'invalid', detail: problems.join('; ') };
  return { ok: true, doc: read.gloria, exists: gloriaSurveyUuidExists(read.gloria.survey.uuid) };
}

/** Throws when the summit already has this cycle under another survey (mobile message). */
export function applyGloriaImport(doc: GloriaDoc): number {
  return importGloriaDoc(doc).surveyId;
}
