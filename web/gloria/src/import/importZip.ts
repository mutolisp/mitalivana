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
 *
 * Form scans (forms/) and logger files (loggers/) inside the zip are restored:
 * the yml still holds the sender's file URIs, which no other device can open,
 * and the zip names each file from the same records (planFormScans,
 * planLoggerFiles), so planning again from the yml finds every file. A file
 * reference neither restored nor readable here is dropped rather than listed
 * as a file that cannot be opened. Photos are not restored, as on mobile.
 */
import { strFromU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { readRecordImportFromBytes } from '~/lib/recordImportZip';
import { validateGloriaDoc, type GloriaDoc } from '~/modules/gloria/export/yaml';
import { gloriaSurveyUuidExists, importGloriaDoc } from '~/modules/gloria/db';
import { getUserDb } from '~/db/init';
import { planFormScans, SCAN_FORMS, type ScanSurvey, type ScanUnit } from '~/modules/gloria/model/formScans';
import { planLoggerFiles, type ExportVisit } from '~/modules/gloria/export/loggerRows';
import { parseFiles } from '~/modules/gloria/model/loggers';
import { getMediaBlob, putMedia } from '../host/mediaStore';

/** Attached files of one survey, by their path inside its folder: `forms/<name>`, `loggers/<name>`. */
export type Attached = Record<string, Uint8Array>;

export type ImportCheck =
  | { ok: true; doc: GloriaDoc; exists: boolean; otherCopy: boolean; source: string; attached: Attached }
  | { ok: false; reason: 'not-gloria' | 'invalid'; detail?: string; source: string };

/** The survey of the same summit and cycle here, if any (mobile merge.ts findGloriaSurveyFor). */
function surveyFor(doc: GloriaDoc): { id: number; uuid: string } | null {
  const r = getUserDb().executeSync(
    `SELECT v.id, v.uuid FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id WHERE s.full_code = ? AND v.mocy = ?`,
    [doc.summit.full_code, doc.survey.mocy],
  ).rows[0] as { id: number; uuid: string } | undefined;
  return r ?? null;
}

const ATTACHED_RE = /(?:^|\/)((?:forms|loggers)\/[^/]+)$/;
const isAttached = (name: string) => ATTACHED_RE.test(name);

/** forms/ and loggers/ entries of an unzipped survey, keyed `forms/<name>` / `loggers/<name>`. */
function attachedOf(files: Unzipped): Attached {
  const out: Attached = {};
  for (const [n, b] of Object.entries(files)) {
    const m = ATTACHED_RE.exec(n);
    if (m) out[m[1]] = b;
  }
  return out;
}

function check(bytes: Uint8Array, source: string, attached: Attached = {}): ImportCheck {
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
    attached,
  };
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

/** Every survey a file holds (one, or each folder of a bundle). */
export function readGloriaImports(bytes: Uint8Array, fileName = ''): ImportCheck[] {
  if (!isZip(bytes)) return [check(bytes, fileName)];
  // Text entries and the attached files only: photos can make a zip large.
  const meta = unzipSync(bytes, { filter: (f) => /\.(ya?ml|json)$/i.test(f.name) || isAttached(f.name) });
  const manifestName = Object.keys(meta).find((n) => n === 'bundle_manifest.json');
  if (!manifestName) return [check(bytes, fileName, attachedOf(meta))];
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
    return check(zipSync(own), source, attachedOf(own));
  });
}

/** Single-file convenience (one survey expected). */
export function readGloriaImport(bytes: Uint8Array): ImportCheck {
  return readGloriaImports(bytes)[0] ?? { ok: false, reason: 'invalid', source: '' };
}

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', csv: 'text/csv', txt: 'text/plain' };

async function readableHere(uri: string): Promise<boolean> {
  return uri.startsWith('webmedia:') && (await getMediaBlob(uri)) != null;
}

/**
 * The document with its form scans and logger files pointing at copies of
 * the zip's files stored here. Files already readable here keep their URI.
 */
export async function restoreAttachedFiles(doc: GloriaDoc, attached: Attached): Promise<GloriaDoc> {
  const plan = [
    ...planFormScans(doc.summit.full_code, doc.survey as unknown as ScanSurvey, doc.units as unknown as ScanUnit[]).map((f) => ({ ...f, path: `forms/${f.name}` })),
    ...planLoggerFiles(doc.survey.mocy, doc.summit, (doc.logger_visits ?? []) as unknown as ExportVisit[]).map((f) => ({ ...f, path: `loggers/${f.name}` })),
  ];
  const to = new Map<string, string | null>();
  for (const f of plan) {
    if (to.has(f.uri)) continue;
    if (await readableHere(f.uri)) {
      to.set(f.uri, f.uri);
      continue;
    }
    const bytes = attached[f.path];
    if (!bytes) {
      to.set(f.uri, null);
      continue;
    }
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(f.name)?.[1]?.toLowerCase() ?? '';
    to.set(f.uri, await putMedia('files', new File([bytes as BlobPart], f.name, { type: MIME[ext] ?? 'application/octet-stream' })));
  }
  // Rewrite a JSON FileRef[] column; references nobody can open are dropped.
  const rewrite = (json: unknown): string | null => {
    if (typeof json !== 'string') return null;
    const files = parseFiles(json)
      .map((f) => ({ ...f, uri: to.get(f.uri) ?? null }))
      .filter((f): f is typeof f & { uri: string } => !!f.uri);
    return files.length ? JSON.stringify(files) : null;
  };
  const survey = { ...doc.survey } as GloriaDoc['survey'] & Record<string, unknown>;
  for (const f of SCAN_FORMS) survey[f.column] = rewrite(survey[f.column]);
  return {
    ...doc,
    survey,
    ...(doc.logger_visits
      ? {
          logger_visits: doc.logger_visits.map((v) => ({
            ...v,
            form4_files: rewrite(v.form4_files),
            loggers: v.loggers.map((l) => ({ ...l, data_files: rewrite(l.data_files) })),
          })),
        }
      : {}),
  };
}

/**
 * Restores the attached files, then imports. Throws when the summit already
 * has this cycle under another survey (mobile message).
 */
export async function applyGloriaImport(doc: GloriaDoc, attached: Attached = {}): Promise<number> {
  return importGloriaDoc(await restoreAttachedFiles(doc, attached)).surveyId;
}
