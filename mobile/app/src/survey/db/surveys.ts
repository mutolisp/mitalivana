/**
 * Checklist and plot-style surveys on the app's connection. The rules live in
 * surveyCore.ts and templatesCore.ts (tested under node by
 * check:survey-core); this file binds them to the user DB, the clock and uuid
 * generation, runs multi-row writes in a transaction, and keeps taxon names
 * readable offline. The screens are app/survey/form/ (Phase 2C-a).
 */
import { getUserDb, withTransaction } from '~/db/init';
import { ensureTaxonSelfSufficient } from '~/db/taxonCache';
import { generateUuid } from '~/db/uuid';
import type { Sighting, RecheckOutcome } from '../form/recheck';
import type { ComponentValues } from '../registry';
import type { SurveyTemplate } from '../template/types';
import * as core from './surveyCore';
import type { ValueInput } from './stemmapCore';
import * as tpl from './templatesCore';

const ctx = () => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });

// templates
export const listTemplates = (opts?: { archived?: 'exclude' | 'include' | 'only' }) => tpl.listTemplates(ctx(), opts);
export const getTemplate = (id: string, version?: number) => tpl.getTemplate(ctx(), id, version);
export const saveTemplate = (t: SurveyTemplate) => tpl.saveTemplate(ctx(), t);
export const upgradeSurvey = (surveyId: number, to: SurveyTemplate) => tpl.upgradeSurvey(ctx(), surveyId, to);
// The builder (2D-a, v86)
export type { TemplateDraft } from './templatesCore';
export const getDraft = (id: string) => tpl.getDraft(ctx(), id);
export const listDrafts = () => tpl.listDrafts(ctx());
export const saveDraft = (t: SurveyTemplate, baseVersion: number | null) => tpl.saveDraft(ctx(), t, baseVersion);
export const discardDraft = (id: string) => tpl.discardDraft(ctx(), id);
export const commitDraft = (id: string) => withTransaction(() => tpl.commitDraft(ctx(), id));
export const setTemplateArchived = (id: string, archived: boolean) => tpl.setTemplateArchived(ctx(), id, archived);
export const isTemplateArchived = (id: string) => tpl.isTemplateArchived(ctx(), id);
export const templateUseCounts = () => tpl.templateUseCounts(ctx());
export const upgradableSurveys = (t: SurveyTemplate) => tpl.upgradableSurveys(ctx(), t);
/** Move these surveys to `to` (each an additive change); returns how many moved. */
export const upgradeSurveys = (ids: readonly number[], to: SurveyTemplate) => withTransaction(() => ids.filter((id) => tpl.upgradeSurvey(ctx(), id, to)).length);

// surveys
export const getFwSurvey = (id: number) => core.getFwSurvey(ctx(), id);
export const getActiveSurvey = () => core.getActiveSurvey(ctx());
export const seriesCodeNeeded = (frameId: number, templateId: string) => core.seriesCodeNeeded(ctx(), frameId, templateId);
export const listSurveys = (opts?: { frameId?: number }) => core.listSurveys(ctx(), opts);
export const createSurvey = (input: core.SurveyInput) => withTransaction(() => core.createSurvey(ctx(), input));
export const updateSurvey = (id: number, patch: core.SurveyPatch) => core.updateSurvey(ctx(), id, patch);
export const finishSurvey = (id: number, stopTs?: number | null) => core.finishSurvey(ctx(), id, stopTs);
export const reopenSurvey = (id: number) => withTransaction(() => core.reopenSurvey(ctx(), id));
/** Snapshot first, so a checklist / plot-style survey can be recovered for 30 days (record versions; lazy: they import this module's neighbours). */
export const deleteSurvey = (id: number) => {
  (require('~/db/recordVersions') as typeof import('~/db/recordVersions')).saveVersion('modular', id, 'before_delete');
  withTransaction(() => core.deleteSurvey(ctx(), id));
};

// a frame's layout
export const listFrameUnits = (frameId: number, opts?: { includeRetired?: boolean }) => core.listFrameUnits(ctx(), frameId, opts);
export const frameUnitUsed = (id: number) => core.frameUnitUsed(ctx(), id);
export const addFrameUnit = (frameId: number, input: core.FrameUnitInput) => core.addFrameUnit(ctx(), frameId, input);
export const updateFrameUnit = (id: number, patch: core.FrameUnitPatch) => core.updateFrameUnit(ctx(), id, patch);
export const setFrameUnitRetired = (id: number, retired: boolean) => core.setFrameUnitRetired(ctx(), id, retired);
export const deleteFrameUnit = (id: number) => withTransaction(() => core.deleteFrameUnit(ctx(), id));

// units
export const listUnits = (surveyId: number) => core.listUnits(ctx(), surveyId);
export const getUnit = (id: number) => core.getUnit(ctx(), id);
export const addUnit = (surveyId: number, input: core.UnitInput) => withTransaction(() => core.addUnit(ctx(), surveyId, input));
export const updateUnit = (id: number, patch: core.UnitPatch) => core.updateUnit(ctx(), id, patch);
export const deleteUnit = (id: number) => withTransaction(() => core.deleteUnit(ctx(), id));

// occurrences and values
export const listOccurrences = (surveyId: number, opts?: { unitId?: number | null }) => core.listOccurrences(ctx(), surveyId, opts);
export const getOccurrence = (id: number) => core.getOccurrence(ctx(), id);
export const findOccurrence = (surveyId: number, unitId: number | null, taxonId: string, verbatim: string | null) =>
  core.findOccurrence(ctx(), surveyId, unitId, taxonId, verbatim);
export const occurrenceSealed = (o: Pick<core.OccurrenceRow, 'survey_id' | 'phase'>) => core.occurrenceSealed(ctx(), o);
export const addOccurrence = (surveyId: number, fields: core.OccurrenceFields & { taxon_id: string }) =>
  withTransaction(() => {
    ensureTaxonSelfSufficient(fields.taxon_id);
    return core.addOccurrence(ctx(), surveyId, fields);
  });
export const updateOccurrence = (id: number, patch: core.OccurrenceFields) =>
  withTransaction(() => {
    if (patch.taxon_id) ensureTaxonSelfSufficient(patch.taxon_id);
    core.updateOccurrence(ctx(), id, patch);
  });
export const deleteOccurrence = (id: number) => withTransaction(() => core.deleteOccurrence(ctx(), id));
export const setValue = (owner: core.ValueOwner, component: string, field: string, value: ValueInput | null, idx = 0) =>
  core.setValue(ctx(), owner, component, field, value, idx);
export const listValues = (owner: core.ValueOwner) => core.listValues(ctx(), owner);
export const readComponent = (owner: core.ComponentOwner, key: string) => core.readComponent(ctx(), owner, key);
export const environmentCarried = (owner: { kind: 'survey' | 'unit'; id: number }) => core.environmentCarried(ctx(), owner);
export const writeComponent = (owner: core.ComponentOwner, key: string, patch: ComponentValues) => withTransaction(() => core.writeComponent(ctx(), owner, key, patch));
export const addMedia = (owner: core.ComponentOwner, key: string, uri: string) => core.addMedia(ctx(), owner, key, uri);
export const removeMedia = (owner: core.ComponentOwner, key: string, uri: string) => core.removeMedia(ctx(), owner, key, uri);

// blind phase and morphospecies
export const hasBlindPhase = (surveyId: number) => core.hasBlindPhase(ctx(), surveyId);
export const closeBlindPhase = (surveyId: number) => core.closeBlindPhase(ctx(), surveyId);
export const reopenBlindPhase = (surveyId: number) => withTransaction(() => core.reopenBlindPhase(ctx(), surveyId));
export const previousOccurrences = (surveyId: number) => core.previousOccurrences(ctx(), surveyId);
export const recheckState = (surveyId: number) => core.recheckState(ctx(), surveyId);
export const answerRecheck = (surveyId: number, candidate: Sighting, outcome: RecheckOutcome, occurrenceId: number | null = null) =>
  withTransaction(() => core.answerRecheck(ctx(), surveyId, candidate, outcome, occurrenceId));
export const listFrameLabels = (frameId: number) => core.listFrameLabels(ctx(), frameId);
export const frameLabelStatus = (surveyId: number, taxonId: string, verbatim: string | null) => core.frameLabelStatus(ctx(), surveyId, taxonId, verbatim);
export const addFrameLabel = (frameId: number, input: Parameters<typeof core.addFrameLabel>[2]) =>
  withTransaction(() => {
    ensureTaxonSelfSufficient(input.taxonId);
    return core.addFrameLabel(ctx(), frameId, input);
  });
export const updateFrameLabel = (id: number, patch: { note?: string | null; photoUri?: string | null }) => core.updateFrameLabel(ctx(), id, patch);
