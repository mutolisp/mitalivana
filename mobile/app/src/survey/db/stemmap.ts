/**
 * Tree census on the app's connection. The rules live in stemmapCore.ts
 * (tested under node by check:survey-db); this file binds them to the user
 * DB, the clock and uuid generation, runs multi-row writes in a transaction,
 * and keeps taxon names readable offline.
 */
import { getUserDb, withTransaction } from '~/db/init';
import { ensureTaxonSelfSufficient } from '~/db/taxonCache';
import { generateUuid } from '~/db/uuid';
import * as core from './stemmapCore';
import { censusQuadratIds } from './censusVersions';
import { saveVersion } from '~/db/recordVersions';
import type { TaskReporter } from '~/stores/taskProgress';
import type { SurveyTemplate } from '../template/types';
import { getTagRollStart } from '../tagRoll';

export {
  SurveyError,
  type CensusListRow,
  frameGeometry,
  type FrameInput,
  type FramePatch,
  type FrameRow,
  type IndividualRow,
  type LocationInput,
  type MeasurePatch,
  type MeasureRow,
  type StemDraft,
  type StemRow,
  type StemView,
  type SurveyErrorCode,
  type FgQuadratRow,
  type SurveyRow,
  TAG_ORDER,
  type TaxonInput,
  type TreeDraft,
  type TreeState,
  type TreeView,
} from './stemmapCore';

const ctx = (): core.Ctx => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });

// frames
export const listFrames = () => core.listFrames(ctx());
export const getFrame = (id: number) => core.getFrame(ctx(), id);
export const frameHasSurveys = (id: number) => core.frameHasSurveys(ctx(), id);
export const createFrame = (input: core.FrameInput) => core.createFrame(ctx(), input);
export const updateFrame = (id: number, patch: core.FramePatch) => core.updateFrame(ctx(), id, patch);
export const deleteFrame = (id: number) => withTransaction(() => core.deleteFrame(ctx(), id));

// censuses
export const getSurvey = (id: number) => core.getSurvey(ctx(), id);
export const listCensuses = (frameId: number | null = null) => core.listCensuses(ctx(), frameId);
/** Photos a census export carries (it and the earlier censuses of its series), as photo lists, and its tree count (size estimate). */
export function censusExportSizeInput(surveyId: number): { photos: { photo_paths: string | null }[]; trees: number } {
  const s = core.getSurvey(ctx(), surveyId);
  if (!s) return { photos: [], trees: 0 };
  const db = getUserDb();
  const uris = (db.executeSync(
    `SELECT md.uri FROM fw_media md JOIN fw_surveys sv ON sv.id = md.survey_id WHERE sv.series_id = ? AND sv.census_no <= ?`,
    [s.series_id, s.census_no],
  ).rows ?? []) as { uri: string }[];
  const trees = core.listCensuses(ctx(), s.frame_id).find((c) => c.id === surveyId)?.tree_count ?? 0;
  return { photos: uris.map((r) => ({ photo_paths: JSON.stringify([r.uri]) })), trees };
}
export const startCensus = (input: {
  frameId: number;
  template: SurveyTemplate;
  seriesCode?: string;
  investigators?: string | null;
  syncBlockQuadrats?: number | null;
  startTs?: number;
}) => withTransaction(() => core.startCensus(ctx(), input));
export const finishCensus = (id: number, stopTs?: number) => core.finishCensus(ctx(), id, stopTs);
export const reopenCensus = (id: number) => core.reopenCensus(ctx(), id);
export const previousCensusId = (id: number) => core.previousCensusId(ctx(), id);
export const isFirstCensus = (id: number) => core.isFirstCensus(ctx(), id);
export const assertDeletableCensuses = (ids: readonly number[]) => core.assertDeletableCensuses(ctx(), ids);
/**
 * Delete censuses (in each series only its last ones; newest first). Each
 * quadrat with data is kept first, a version each, so "recently deleted" can
 * bring the census back for 30 days. Those are saved outside the delete's
 * transaction, so `report` can count them (most of the 25 s a 20 000-tree
 * census took on the emulator, 1E); if the delete then fails they are
 * versions of quadrats left as they were. The census versions and the delete
 * are one transaction.
 */
export async function deleteCensuses(ids: readonly number[], report?: TaskReporter): Promise<void> {
  // Refused before anything is kept.
  core.assertDeletableCensuses(ctx(), ids);
  await keepQuadratVersions(
    ids.flatMap((id) => censusQuadratIds(id)),
    'before_delete',
    report,
  );
  await report?.step('task.deleting');
  withTransaction(() => {
    for (const id of ids) saveVersion('survey', id, 'before_delete');
    core.deleteCensuses(ctx(), ids);
  });
}
export const deleteCensus = (id: number, report?: TaskReporter) => deleteCensuses([id], report);

/** A version of each quadrat, 20 to a transaction (one commit each would be
 *  625 for a 25 ha census), counted on the progress panel between them. */
export async function keepQuadratVersions(quadratIds: readonly number[], reason: 'before_delete' | 'before_import', report?: TaskReporter): Promise<void> {
  if (!quadratIds.length) return;
  await report?.step('task.versions');
  for (let i = 0; i < quadratIds.length; i += 20) {
    const part = quadratIds.slice(i, i + 20);
    withTransaction(() => {
      for (const q of part) saveVersion('survey_quadrat', q, reason);
    });
    await report?.progress(Math.min(quadratIds.length, i + 20), quadratIds.length);
  }
}
export const setCensusProject = (id: number, projectId: number) => core.setCensusProject(ctx(), id, projectId);
export const updateCensus = (id: number, patch: { investigators?: string | null; notes?: string | null }) => core.updateCensus(ctx(), id, patch);

// quadrats
export const listFgQuadrats = (surveyId: number) => core.listFgQuadrats(ctx(), surveyId);
export const setFgQuadratStatus = (surveyId: number, code: string, status: 'open' | 'done') =>
  core.setFgQuadratStatus(ctx(), surveyId, code, status);
export const setFgQuadratRecorder = (surveyId: number, code: string, recordedBy: string | null) => core.setFgQuadratRecorder(ctx(), surveyId, code, recordedBy);
export const loadFgQuadrat = (surveyId: number, code: string) => core.loadFgQuadrat(ctx(), surveyId, code);
export const loadTree = (surveyId: number, individualId: number) => core.loadTree(ctx(), surveyId, individualId);
export const loadCensus = (surveyId: number) => core.loadCensus(ctx(), surveyId);
export const treeQuadratCodes = (surveyId: number) => core.treeQuadratCodes(ctx(), surveyId);
export const loadCensusQuadrats = (surveyId: number, codes: readonly string[]) => core.loadCensusQuadrats(ctx(), surveyId, codes);
export const censusTreeStates = (surveyId: number) => core.censusTreeStates(ctx(), surveyId);

// trees
export const getIndividual = (id: number) => core.getIndividual(ctx(), id);
export const suggestTag = (frame: core.FrameRow, p: { x: number; y: number }) => core.suggestTag(ctx(), frame, p, getTagRollStart(frame.uuid));
export const addIndividual = (input: Parameters<typeof core.addIndividual>[1]) =>
  withTransaction(() => {
    ensureTaxonSelfSufficient(input.taxon.taxonId);
    return core.addIndividual(ctx(), input);
  });
export const correctIndividual = (
  id: number,
  change: Parameters<typeof core.correctIndividual>[2],
  meta: Parameters<typeof core.correctIndividual>[3],
) =>
  withTransaction(() => {
    if (change.taxon) ensureTaxonSelfSufficient(change.taxon.taxonId);
    core.correctIndividual(ctx(), id, change, meta);
  });

/** The whole tree form of one census, in one transaction. */
export const saveTreeDraft = (surveyId: number, draft: core.TreeDraft) =>
  withTransaction(() => {
    if (draft.taxon) ensureTaxonSelfSufficient(draft.taxon.taxonId);
    return core.saveTreeDraft(ctx(), surveyId, draft);
  });
export const mainStemId = (surveyId: number, individualId: number) => core.mainStemId(ctx(), surveyId, individualId);
export const listTreeMedia = (surveyId: number, individualId: number) => core.listTreeMedia(ctx(), surveyId, individualId);
export const addTreeMedia = (surveyId: number, individualId: number, uri: string) => core.addTreeMedia(ctx(), surveyId, individualId, uri);
export const removeTreeMedia = (surveyId: number, individualId: number, uri: string) => core.removeTreeMedia(ctx(), surveyId, individualId, uri);

// stems and measurements
export const addStem = (individualId: number, surveyId: number) => withTransaction(() => core.addStem(ctx(), individualId, surveyId));
export const ensureMeasure = (surveyId: number, stemId: number) => core.ensureMeasure(ctx(), surveyId, stemId);
export const updateMeasure = (measureId: number, patch: core.MeasurePatch) => core.updateMeasure(ctx(), measureId, patch);
export const setMainStem = (surveyId: number, individualId: number, stemId: number) =>
  withTransaction(() => core.setMainStem(ctx(), surveyId, individualId, stemId));
export const setStemCodes = (measureId: number, codes: readonly string[]) =>
  withTransaction(() => core.setStemCodes(ctx(), measureId, codes));
export const setTreeCodes = (surveyId: number, individualId: number, codes: readonly string[]) =>
  core.setTreeCodes(ctx(), surveyId, individualId, codes);
export const setHeight = (surveyId: number, individualId: number, heightM: number | null) =>
  core.setHeight(ctx(), surveyId, individualId, heightM);
