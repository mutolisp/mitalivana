/**
 * Bringing a tree census file in (Modular_survey.md §9 1D; the rules are in
 * db/censusExportCore.ts), on the app's connection: re-point taxa this
 * device's checklist lacks, save the photos, ask what to do with censuses
 * already here (merge / overwrite / skip, decided 2026-10-01), write, and
 * hand the censuses to merge to the census merge (censusSync.ts,
 * app/survey/merge.tsx). Like other imports, a census created from a file is
 * finished; reopen it to keep recording.
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { getUserDb, withTransaction } from '~/db/init';
import { searchByTaxonId } from '~/db/search';
import { ensureTaxonSelfSufficient } from '~/db/taxonCache';
import { generateUuid } from '~/db/uuid';
import i18n from '~/i18n';
import { importPhotosToLibrary } from '~/lib/photoCapture';
import type { ImportedPhotoBlob } from '~/lib/recordImportZip';
import { matchScientificName } from '~/lib/sciMatch';
import { runTask } from '~/stores/taskProgress';
import { useToast } from '~/stores/toast';
import { censusQuadratIds } from './db/censusVersions';
import { importCensusDoc, planCensusImport, type CensusExportDoc, type ImportChoice } from './db/censusExportCore';
import { ALL_QUADRATS, censusIdent } from './db/censusSyncCore';
import { keepQuadratVersions } from './db/stemmap';
import { getSurvey } from './db/stemmapCore';
import { mergeBlockQuietly, useCensusMerge, type CensusBlockUpload, type PendingCensusMerge } from './censusSync';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });

/** Taxon ids this checklist lacks → the same scientific name here, when there is one. Returns how many stay unknown. */
function remapTaxa(doc: CensusExportDoc): number {
  const to = new Map<string, string>();
  let unresolved = 0;
  for (const id of new Set(doc.trees.map((t) => String(t.taxon_id)))) {
    if (!id || searchByTaxonId(id)) continue;
    const name = doc.taxa[id];
    const hit = name ? matchScientificName({ name }) : null;
    if (hit?.kind === 'matched') to.set(id, hit.taxon_id);
    else unresolved += 1;
  }
  if (to.size) for (const t of doc.trees) if (to.has(String(t.taxon_id))) t.taxon_id = to.get(String(t.taxon_id))!;
  return unresolved;
}

export async function finishCensusImport(payload: { census: CensusExportDoc; photos: ImportedPhotoBlob[] }): Promise<void> {
  const t = i18n.t.bind(i18n);
  const doc = payload.census;
  const code = String(doc.frame.code);
  const plan = planCensusImport(ctx(), doc);
  if (plan.frameCodeTaken) {
    Alert.alert(t('recordCreate.importFailTitle'), t('teamSync.err.frame_code_taken'));
    return;
  }
  const here = plan.censuses.filter((x) => x.localId != null);
  let choice: ImportChoice = 'skip';
  if (here.length) {
    const idx = await showActionSheet({
      title: t('survey.import.existsTitle'),
      message: t('survey.import.existsMsg', { code, list: here.map((x) => x.censusNo).join(/^(zh|ja)/.test(i18n.language) ? '、' : ', ') }),
      cancelLabel: t('common.cancel'),
      options: [{ label: t('teamMerge.merge') }, { label: t('recordCreate.overwrite'), destructive: true }, { label: t('survey.import.skip') }],
    });
    if (idx < 0) return;
    choice = idx === 0 ? 'merge' : idx === 1 ? 'overwrite' : 'skip';
  }
  const unresolved = remapTaxa(doc);
  // Writing a large census holds the JS thread for seconds (1E): on the progress panel.
  const { res, reviews, merged } = await runTask(async (report) => {
    let uriByName = new Map<string, string>();
    if (payload.photos.length) {
      await report.step('task.photos');
      ({ uriByName } = await importPhotosToLibrary(payload.photos, (done, total) => void report.progress(done, total)));
    }
    // What an overwrite replaces stays restorable (record versions, v73
    // reason). Kept before the import's transaction so the bar can move; if
    // the import then fails they are versions of quadrats left unchanged.
    if (choice === 'overwrite') await keepQuadratVersions(here.flatMap((x) => censusQuadratIds(x.localId!)), 'before_import', report);
    // One transaction, so no progress inside it: the step and the spinner.
    await report.step('task.writingTrees', { count: doc.trees.length });
    const res = withTransaction(() => importCensusDoc(ctx(), doc, choice, (file) => uriByName.get(file) ?? null));
    for (const id of new Set(doc.trees.map((tr) => String(tr.taxon_id)))) ensureTaxonSelfSufficient(id);

    // Censuses to merge: quietly when nothing needs a person, else the review, one after another.
    const ident = (n: number) => censusIdent(String(doc.frame.uuid), String(doc.series.uuid), n);
    const reviews: PendingCensusMerge[] = [];
    let merged = 0;
    if (res.merges.length) await report.step('task.merging');
    for (const [i, m] of res.merges.entries()) {
      await report.progress(i, res.merges.length);
      const s = getSurvey(ctx(), m.surveyId)!;
      const upload: CensusBlockUpload = {
        record_type: 'census_block',
        schema: 1,
        ident: ident(s.census_no),
        block: ALL_QUADRATS,
        block_quadrats: 0,
        slice: m.slice,
        sync: { base: m.base },
      };
      const r = mergeBlockQuietly(m.surveyId, upload, null);
      if (r.kind === 'merged') merged += 1;
      if (r.kind !== 'review') continue;
      reviews.push({ surveyId: m.surveyId, censusUuid: s.uuid, label: `${code} #${s.census_no}`, doc: upload, from: null, fromAt: null });
    }
    return { res, reviews, merged };
  });

  const lines = [
    res.created.length ? t('survey.import.created', { count: res.created.length }) : '',
    res.overwritten.length ? t('survey.import.overwritten', { count: res.overwritten.length }) : '',
    res.skipped.length ? t('survey.import.skipped', { count: res.skipped.length }) : '',
    res.templateDiffers.length ? t('survey.import.templateDiffers', { count: res.templateDiffers.length }) : '',
    merged ? t('survey.import.merged', { count: merged }) : '',
    reviews.length ? t('survey.import.toReview', { count: reviews.length }) : '',
    unresolved ? t('survey.import.unresolvedTaxa', { count: unresolved }) : '',
  ].filter(Boolean);
  // The census the file was exported from (its last), here.
  const lastUuid = String(doc.censuses[doc.censuses.length - 1].survey.uuid);
  const lastHere = planCensusImport(ctx(), doc).censuses.find((x) => x.uuid === lastUuid)?.localId ?? null;
  if (lastHere != null) router.push(`/survey/${lastHere}` as Href);
  if (reviews.length) {
    const [first, ...rest] = reviews;
    useCensusMerge.getState().set({ ...first, next: rest });
    router.push('/survey/merge' as Href);
  }
  if (lines.length) useToast.getState().show(lines.join('\n'), { durationMs: 8000 });
}
