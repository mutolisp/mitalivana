/**
 * One GLORIA survey → the same zip the mobile app writes
 * (modules/gloria/export/bundle.ts assembles it for both).
 *
 * Mobile parts this does not have yet: docx/odt of the checklist (md only)
 * and the provenance signature (mobile also writes unsigned zips when signing
 * is not set up). Photos are stored without compression, as JPEGs gain
 * nothing from deflate and it keeps memory down on phones.
 */
import {
  getGloriaSurvey, listPhotoChecks, listPoints, listSurveySpecies, listUnits, loadExportData, loadGloriaDoc, p5mOf,
} from '~/modules/gloria/db';
import { assembleGloriaEntries, type GloriaBundleInput } from '~/modules/gloria/export/bundle';
import { taxonToMarkdownItem, type BuiltZipEntry } from '~/lib/bundleParts';
import { generateMarkdown } from '~/lib/markdown';
import type { Translate } from '~/lib/reportTypes';
import { syncBlockFor } from '~/db/syncBase';
import i18n, { fixedT } from '../host/i18n';
import { readMediaBytes } from '../host/mediaStore';
import { zipEntries } from './zip';
import { strToU8 } from 'fflate';
import { createFolderNamer, moveUnder } from '~/lib/zipEntryNames';

export type ExportOptions = { includePhotos: boolean; lang?: string; onPhotoProgress?: (done: number, total: number) => void };

/** One survey's zip entries, under its own folder (as on mobile). */
export async function buildSurveyEntries(surveyId: number, opts: ExportOptions) {
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

  return { entries, folderName, photoCount };
}

export async function buildSurveyZip(surveyId: number, opts: ExportOptions): Promise<{ bytes: Uint8Array; filename: string; photoCount: number }> {
  const { entries, folderName, photoCount } = await buildSurveyEntries(surveyId, opts);
  return { bytes: zipEntries(entries), filename: `${folderName}.zip`, photoCount };
}

/**
 * Several surveys in one zip, in the mobile app's bundle layout
 * (bundleExport.ts bundleMany): one folder per survey at the root and a
 * bundle_manifest.json listing them; a survey that fails is listed with its
 * error instead of stopping the batch.
 */
export async function buildBatchZip(
  surveyIds: number[],
  opts: ExportOptions & { onSurvey?: (done: number, total: number) => void },
): Promise<{ bytes: Uint8Array; filename: string; exported: number }> {
  const all: BuiltZipEntry[] = [];
  const items: Array<Record<string, unknown>> = [];
  const claim = createFolderNamer();
  let exported = 0;
  for (let i = 0; i < surveyIds.length; i++) {
    opts.onSurvey?.(i, surveyIds.length);
    const id = surveyIds[i];
    try {
      const built = await buildSurveyEntries(id, opts);
      const folder = claim(built.folderName);
      for (const e of built.entries) all.push(folder === built.folderName ? e : { ...e, name: moveUnder(e.name, built.folderName, folder) });
      items.push({ kind: 'gloria', id, folder });
      exported += 1;
    } catch (e) {
      items.push({ kind: 'gloria', id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const manifest = {
    app: 'mitalivana',
    schema_version: 1,
    created_at: new Date().toISOString(),
    item_count: surveyIds.length,
    items,
    includePhotos: opts.includePhotos,
  };
  all.push({ name: 'bundle_manifest.json', bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { bytes: zipEntries(all), filename: `GLORIA_bundle_${ts}.zip`, exported };
}
