/**
 * GLORIA exports (zip or bare yml, from the mobile app or this one) → surveys
 * in this database. One file can hold one survey, or several in the mobile
 * bundle layout (a folder per record + bundle_manifest.json); each survey is
 * read by the mobile reader (readRecordImportFromBytes), so both apps accept
 * the same files.
 *
 * Same rules as mobile finishGloriaImport, minus team merge:
 *   - same survey uuid already here → the caller asks; `applyGloriaImport` overwrites;
 *   - same summit + cycle under another uuid → refused (that needs a merge).
 * Photos inside the zip are not restored, as on mobile: the yml names them.
 */
import { strFromU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { readRecordImportFromBytes } from '~/lib/recordImportZip';
import { validateGloriaDoc, type GloriaDoc } from '~/modules/gloria/export/yaml';
import { gloriaSurveyUuidExists, importGloriaDoc } from '~/modules/gloria/db';
import { getUserDb } from '~/db/init';

export type ImportCheck =
  | { ok: true; doc: GloriaDoc; exists: boolean; otherCopy: boolean; source: string }
  | { ok: false; reason: 'not-gloria' | 'invalid'; detail?: string; source: string };

/** The survey of the same summit and cycle here, if any (mobile merge.ts findGloriaSurveyFor). */
function surveyFor(doc: GloriaDoc): { id: number; uuid: string } | null {
  const r = getUserDb().executeSync(
    `SELECT v.id, v.uuid FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id WHERE s.full_code = ? AND v.mocy = ?`,
    [doc.summit.full_code, doc.survey.mocy],
  ).rows[0] as { id: number; uuid: string } | undefined;
  return r ?? null;
}

function check(bytes: Uint8Array, source: string): ImportCheck {
  let read;
  try {
    read = readRecordImportFromBytes(bytes);
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: e instanceof Error ? e.message : String(e), source };
  }
  if (read.kind !== 'gloria') return { ok: false, reason: 'not-gloria', detail: read.kind, source };
  const problems = validateGloriaDoc(read.gloria);
  if (problems.length) return { ok: false, reason: 'invalid', detail: problems.join('; '), source };
  const here = surveyFor(read.gloria);
  return {
    ok: true,
    doc: read.gloria,
    exists: gloriaSurveyUuidExists(read.gloria.survey.uuid),
    otherCopy: !!here && here.uuid !== read.gloria.survey.uuid,
    source,
  };
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

/** Every survey a file holds (one, or each folder of a bundle). */
export function readGloriaImports(bytes: Uint8Array, fileName = ''): ImportCheck[] {
  if (!isZip(bytes)) return [check(bytes, fileName)];
  // Only the small text entries: a bundle with photos can be large.
  const meta = unzipSync(bytes, { filter: (f) => /\.(ya?ml|json)$/i.test(f.name) });
  const manifestName = Object.keys(meta).find((n) => n === 'bundle_manifest.json');
  if (!manifestName) return [check(bytes, fileName)];
  let items: Array<{ kind?: string; folder?: string; error?: string }> = [];
  try {
    items = (JSON.parse(strFromU8(meta[manifestName])) as { items?: typeof items }).items ?? [];
  } catch {
    return [{ ok: false, reason: 'invalid', detail: 'bundle_manifest.json', source: fileName }];
  }
  return items.map((it) => {
    const source = `${fileName} › ${it.folder ?? it.kind ?? '?'}`;
    if (it.kind !== 'gloria') return { ok: false, reason: 'not-gloria', detail: it.kind, source } as const;
    if (!it.folder) return { ok: false, reason: 'invalid', detail: it.error, source } as const;
    // The record's own files as a zip of their own, for the single-record reader.
    const own: Unzipped = {};
    for (const [n, b] of Object.entries(meta)) if (n.startsWith(`${it.folder}/`)) own[n] = b;
    return check(zipSync(own), source);
  });
}

/** Single-file convenience (one survey expected). */
export function readGloriaImport(bytes: Uint8Array): ImportCheck {
  return readGloriaImports(bytes)[0] ?? { ok: false, reason: 'invalid', source: '' };
}

/** Throws when the summit already has this cycle under another survey (mobile message). */
export function applyGloriaImport(doc: GloriaDoc): number {
  return importGloriaDoc(doc).surveyId;
}
