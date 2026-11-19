/**
 * One GLORIA survey → the same zip the mobile app writes
 * (modules/gloria/export/bundle.ts assembles it for both).
 *
 * Mobile parts this does not have yet: docx/odt of the checklist (md only)
 * and the provenance signature (mobile also writes unsigned zips when signing
 * is not set up). Photos are stored without compression, as JPEGs gain
 * nothing from deflate and it keeps memory down on phones.
 */
import { zipSync, type Zippable } from 'fflate';
import {
  getGloriaSurvey, listPhotoChecks, listPoints, listSurveySpecies, listUnits, loadExportData, loadGloriaDoc, p5mOf,
} from '~/modules/gloria/db';
import { assembleGloriaEntries, type GloriaBundleInput } from '~/modules/gloria/export/bundle';
import { taxonToMarkdownItem } from '~/lib/bundleParts';
import { generateMarkdown } from '~/lib/markdown';
import type { Translate } from '~/lib/reportTypes';
import { syncBlockFor } from '~/db/syncBase';
import i18n, { fixedT } from '../host/i18n';
import { readMediaBytes } from '../host/mediaStore';

export type ExportOptions = { includePhotos: boolean; lang?: string; onPhotoProgress?: (done: number, total: number) => void };

export async function buildSurveyZip(surveyId: number, opts: ExportOptions): Promise<{ bytes: Uint8Array; filename: string; photoCount: number }> {
  const data = loadExportData(surveyId);
  const doc = loadGloriaDoc(surveyId);
  const survey = getGloriaSurvey(surveyId);
  if (!data || !doc || !survey) throw new Error(`GLORIA survey ${surveyId} not found`);

  // Species checklist: one entry per roster entry found in any unit (as mobile).
  const roster = new Map<number, ReturnType<typeof listSurveySpecies>[number]>();
  for (const s of listSurveySpecies(surveyId)) if (!roster.has(s.gloria_taxon_id)) roster.set(s.gloria_taxon_id, s);
  let checklist: GloriaBundleInput['checklist'] = null;
  if (roster.size) {
    const t = (await fixedT(opts.lang ?? i18n.language)) as unknown as Translate;
    const md = generateMarkdown(
      [...roster.values()].map((s) => ({ ...taxonToMarkdownItem(s.taxon_id, s), notes: s.verbatim_identification })),
      t,
      { project: survey.project_id !== 0 ? (doc.survey.project_name ?? '') : '', site: `${data.summit.full_code} mocy ${data.survey.mocy}` },
    );
    checklist = { md, doc: null };
  }

  const points = listPoints(surveyId);
  const { entries, folderName, photoCount } = await assembleGloriaEntries(
    {
      surveyId,
      data,
      doc: { ...doc, sync: syncBlockFor('gloria', data.survey.uuid) },
      points,
      units: listUnits(surveyId),
      checks: listPhotoChecks(surveyId),
      overviewPhotos: survey.overview_photos,
      p5m: p5mOf(points),
      checklist,
      includePhotos: opts.includePhotos,
    },
    { readMedia: readMediaBytes, onPhotoProgress: opts.onPhotoProgress },
  );

  const files: Zippable = {};
  for (const e of entries) {
    const store = /\/(photos|forms|loggers)\//.test(e.name) && /\.(jpe?g|png|heic|heif|pdf|zip)$/i.test(e.name);
    files[e.name] = [e.bytes, store ? { level: 0 } : (e.zipOpts ?? {})];
  }
  return { bytes: zipSync(files), filename: `${folderName}.zip`, photoCount };
}
