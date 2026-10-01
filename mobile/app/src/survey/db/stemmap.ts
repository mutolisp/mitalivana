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
/** Kept before a census goes: each quadrat with data and the census itself,
 *  so "recently deleted" can bring it back for 30 days. */
function keepBeforeDelete(id: number): void {
  for (const q of censusQuadratIds(id)) saveVersion('survey_quadrat', q, 'before_delete');
  saveVersion('survey', id, 'before_delete');
}

export const deleteCensus = (id: number) =>
  withTransaction(() => {
    // Refused before anything is kept: only the latest census of a series can go.
    core.assertDeletableCensus(ctx(), id);
    keepBeforeDelete(id);
    core.deleteCensus(ctx(), id);
  });
export const deleteCensuses = (ids: readonly number[]) =>
  withTransaction(() => {
    for (const id of ids) keepBeforeDelete(id);
    core.deleteCensuses(ctx(), ids);
  });
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
