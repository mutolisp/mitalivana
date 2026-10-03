/**
 * Bringing a checklist / plot-style survey file in (Phase 2E-a): an export
 * zip, a teammate's copy, or a merge backup's JSON. The file's template must
 * be one this app reads (an unknown component: update the app). The survey
 * before it on its plot comes along when this device lacks it (the recheck
 * needs its list). A survey not here lands finished, without a project; one
 * here (the same survey, or the same plot + template + number started on
 * another phone) is merged (the review), overwritten (its state kept as a
 * version first) or left.
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { getUserDb, withTransaction } from '~/db/init';
import { overwriteSurvey } from '~/db/recordVersions';
import { getSyncBase, setSyncBase } from '~/db/syncBase';
import { generateUuid } from '~/db/uuid';
import i18n from '~/i18n';
import { COMBINERS } from '~/lib/mergeDocs';
import { baseOf, diffSides, type SyncBlock } from '~/lib/mergeEngine';
import type { ImportedPhotoBlob } from '~/lib/recordImportZip';
import { usePendingMerge } from '~/lib/teamMergeFlow';
import { useToast } from '~/stores/toast';
import { useActiveSurvey } from './form/activeSurvey';
import * as core from './db/surveyDocCore';
import { modularIdByUuid, modularIdentity, modularIdForDoc, receivePrevious, surveyDoc, surveySide, type SurveyDoc } from './db/surveyDocs';
import { componentDef } from './registry';
import { addSurveyFileMedia, writeSurveyFiles } from './surveyFileMedia';
import { templateOf } from './export/surveyExportCore';
import { validateTemplate } from './template/validate';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const formHref = (id: number) => `/survey/form/${id}` as Href;

export type ModularImport = { survey: SurveyDoc; photos: ImportedPhotoBlob[]; audio: ImportedPhotoBlob[]; sync?: SyncBlock | null };

/** Why a survey file cannot be read here, or null. */
function unreadable(doc: SurveyDoc): string | null {
  const t = templateOf(doc);
  if (!t || doc.survey.style === 'individual') return i18n.t('surveyImport.invalid', { detail: 'template' });
  const unknown = [...new Set(t.components.map((c) => c.type).filter((type) => !componentDef(type)))];
  if (unknown.length) return i18n.t('surveyImport.newerApp', { types: unknown.join(', ') });
  const problems = validateTemplate(t);
  return problems.length ? i18n.t('surveyImport.invalid', { detail: problems.slice(0, 3).join('; ') }) : null;
}

const labelOf = (doc: SurveyDoc) => (doc.frame ? `${String(doc.frame.code)} #${String(doc.survey.census_no)}` : String(doc.survey.name ?? ''));

export async function finishModularImport(payload: ModularImport): Promise<void> {
  const t = i18n.t.bind(i18n);
  const doc = payload.survey;
  const why = unreadable(doc);
  if (why) {
    Alert.alert(t('recordCreate.importFailTitle'), why);
    return;
  }
  const hereId = modularIdForDoc(doc) ?? modularIdByUuid(String(doc.survey.uuid));
  if (hereId == null) return importNew(payload);

  const name = modularIdentity(hereId)?.label ?? labelOf(doc);
  const idx = await showActionSheet({
    title: t('surveyImport.existsTitle'),
    message: t('surveyImport.existsMsg', { name }),
    cancelLabel: t('common.cancel'),
    options: [{ label: t('teamMerge.merge') }, { label: t('recordCreate.overwrite'), destructive: true }],
  });
  if (idx < 0) return;
  // The survey before it, when this device lacks it (a plot code taken here leaves it out).
  receivePrevious(doc);
  if (idx === 0) return mergeIn(hereId, name, payload);

  const { doc: local, skipped } = await writeSurveyFiles(doc, payload.photos, payload.audio);
  const changed = overwriteSurvey(hereId, local);
  const here = surveyDoc(hereId);
  if (here) setSyncBase('modular', String(here.survey.uuid), baseOf(surveySide(here)));
  useActiveSurvey.getState().refresh();
  Alert.alert(t('surveyImport.overwrittenTitle'), [t('surveyImport.overwrittenMsg', { name, count: changed }), skipped ? t('surveyImport.photosSkipped', { count: skipped }) : ''].filter(Boolean).join('\n'));
  router.push(formHref(hereId));
}

async function importNew(payload: ModularImport): Promise<void> {
  const t = i18n.t.bind(i18n);
  const { doc: local, skipped } = await writeSurveyFiles(payload.survey, payload.photos, payload.audio);
  const { project_id: _p, ...fileDoc } = local;
  let id: number;
  try {
    id = withTransaction(() => {
      // From the file's own document (not a teammate's copy): the plot's morphospecies keep their photos.
      core.insertPreviousFromDoc(ctx(), fileDoc);
      const made = core.insertSurveyFromDoc(ctx(), fileDoc, { status: 'done', projectId: 0 });
      core.putBackMediaRows(ctx(), made, fileDoc, () => true);
      return made;
    });
  } catch (e) {
    if (e instanceof core.InsertSurveyError) {
      Alert.alert(t('recordCreate.importFailTitle'), e.code === 'frame_code_taken' ? t('teamSync.err.frame_code_taken') : t('surveyImport.numberTaken', { name: labelOf(local) }));
      return;
    }
    throw e;
  }
  // What was imported is what both sides now share.
  const stored = surveyDoc(id);
  if (stored) setSyncBase('modular', String(stored.survey.uuid), baseOf(surveySide(stored)));
  useToast.getState().show([t('surveyImport.done', { name: labelOf(local) }), skipped ? t('surveyImport.photosSkipped', { count: skipped }) : ''].filter(Boolean).join('\n'));
  router.push(formHref(id));
}

/** The file against the survey here: the review, or — nothing differing — its new photos only. */
async function mergeIn(hereId: number, name: string, payload: ModularImport): Promise<void> {
  const here = surveyDoc(hereId);
  if (!here) return;
  const local = surveySide(here);
  const remote = surveySide(core.surveyDocForPeer(payload.survey));
  const uuid = String(here.survey.uuid);
  const items = diffSides(local, remote, payload.sync?.base ?? null, COMBINERS.modular, getSyncBase('modular', uuid));
  if (items.length === 0) {
    setSyncBase('modular', uuid, baseOf(remote));
    await addSurveyFileMedia(hereId, payload.survey, payload.photos, payload.audio);
    Alert.alert(i18n.t('teamMerge.nothingTitle'), i18n.t('teamMerge.nothingMsg', { name }));
    router.push(formHref(hereId));
    return;
  }
  usePendingMerge.getState().set({
    kind: 'modular',
    localId: hereId,
    localUuid: uuid,
    label: name,
    items,
    remoteSide: remote,
    photos: payload.photos,
    audio: payload.audio,
    surveyFile: payload.survey,
  });
  router.push('/merge' as Href);
}
