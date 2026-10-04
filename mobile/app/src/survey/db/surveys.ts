/**
 * Checklist and plot-style surveys on the app's connection. The rules live in
 * surveyCore.ts and templatesCore.ts (tested under node by
 * check:survey-core); this file binds them to the user DB, the clock and uuid
 * generation, runs multi-row writes in a transaction, and keeps taxon names
 * readable offline. The screens are app/survey/form/ (Phase 2C-a).
 */
import { withTransaction } from '~/db/init';
import { dbFor, isPreviewId, transactionFor as tx } from '~/db/previewDb';
import { ensureTaxonSelfSufficient } from '~/db/taxonCache';
import { generateUuid } from '~/db/uuid';
import type { Sighting, RecheckOutcome } from '../form/recheck';
import type { ComponentValues } from '../registry';
import type { SurveyTemplate } from '../template/types';
import * as inter from './interactionCore';
import * as core from './surveyCore';
import type { ValueInput } from './stemmapCore';
import * as tpl from './templatesCore';

// By the id a call is about: a preview's ids live in its scratch file (previewDb.ts, 2G-e).
const ctx = (id?: number | null) => ({ db: dbFor(id), now: Date.now, uuid: generateUuid });
// The offline taxon-name cache is user.db's; a preview's species are not kept.
const cacheTaxon = (id: number, taxonId: string) => {
  if (!isPreviewId(id)) ensureTaxonSelfSufficient(taxonId);
};

// templates
export const listTemplates = (opts?: { archived?: 'exclude' | 'include' | 'only' }) => tpl.listTemplates(ctx(), opts);
export const getTemplate = (id: string, version?: number) => tpl.getTemplate(ctx(), id, version);
export const saveTemplate = (t: SurveyTemplate) => tpl.saveTemplate(ctx(), t);
export const upgradeSurvey = (surveyId: number, to: SurveyTemplate) => tpl.upgradeSurvey(ctx(surveyId), surveyId, to);
// The builder (2D-a, v86)
export type { TemplateDraft } from './templatesCore';
export const getDraft = (id: string) => tpl.getDraft(ctx(), id);
export const listDrafts = () => tpl.listDrafts(ctx());
export const saveDraft = (t: SurveyTemplate, baseVersion: number | null) => tpl.saveDraft(ctx(), t, baseVersion);
export const discardDraft = (id: string) => tpl.discardDraft(ctx(), id);
export const commitDraft = (id: string) => withTransaction(() => tpl.commitDraft(ctx(), id));
export const setTemplateArchived = (id: string, archived: boolean) => tpl.setTemplateArchived(ctx(), id, archived);
export const isTemplateArchived = (id: string) => tpl.isTemplateArchived(ctx(), id);
export const templateDeleteBlocker = (id: string) => tpl.templateDeleteBlocker(ctx(), id);
export const deleteTemplate = (id: string) => withTransaction(() => tpl.deleteTemplate(ctx(), id));
export const templateUseCounts = () => tpl.templateUseCounts(ctx());
export const upgradableSurveys = (t: SurveyTemplate) => tpl.upgradableSurveys(ctx(), t);
/** Move these surveys to `to` (each an additive change); returns how many moved. */
export const upgradeSurveys = (ids: readonly number[], to: SurveyTemplate) => withTransaction(() => ids.filter((id) => tpl.upgradeSurvey(ctx(), id, to)).length);

// surveys
export const getFwSurvey = (id: number) => core.getFwSurvey(ctx(id), id);
export const getActiveSurvey = () => core.getActiveSurvey(ctx());
export const seriesCodeNeeded = (frameId: number, templateId: string) => core.seriesCodeNeeded(ctx(), frameId, templateId);
export const listSurveys = (opts?: { frameId?: number }) => core.listSurveys(ctx(), opts);
export const createSurvey = (input: core.SurveyInput) => withTransaction(() => core.createSurvey(ctx(), input));
export const updateSurvey = (id: number, patch: core.SurveyPatch) => core.updateSurvey(ctx(id), id, patch);
export const noteTrackAltitude = (id: number, altitude: number) => core.noteTrackAltitude(ctx(id), id, altitude);
export const stampOccurrenceFix = (id: number, fix: Parameters<typeof core.stampOccurrenceFix>[2]) => core.stampOccurrenceFix(ctx(id), id, fix);
export const finishSurvey = (id: number, stopTs?: number | null) => core.finishSurvey(ctx(id), id, stopTs);
export const reopenSurvey = (id: number) => tx(id, () => core.reopenSurvey(ctx(id), id));
/** Snapshot first, so a checklist / plot-style survey can be recovered for 30 days (record versions; lazy: they import this module's neighbours). */
export const deleteSurvey = (id: number) => {
  (require('~/db/recordVersions') as typeof import('~/db/recordVersions')).saveVersion('modular', id, 'before_delete');
  tx(id, () => core.deleteSurvey(ctx(id), id));
};

// a frame's layout
export const listFrameUnits = (frameId: number, opts?: { includeRetired?: boolean }) => core.listFrameUnits(ctx(), frameId, opts);
export const getFrameUnit = (id: number) => core.getFrameUnit(ctx(), id);
export const frameUnitUsed = (id: number) => core.frameUnitUsed(ctx(), id);
export const addFrameUnit = (frameId: number, input: core.FrameUnitInput) => core.addFrameUnit(ctx(), frameId, input);
export const updateFrameUnit = (id: number, patch: core.FrameUnitPatch) => core.updateFrameUnit(ctx(), id, patch);
export const setFrameUnitRetired = (id: number, retired: boolean) => core.setFrameUnitRetired(ctx(), id, retired);
export const deleteFrameUnit = (id: number) => withTransaction(() => core.deleteFrameUnit(ctx(), id));

// units
export const listUnits = (surveyId: number) => core.listUnits(ctx(surveyId), surveyId);
export const getUnit = (id: number) => core.getUnit(ctx(id), id);
export const addUnit = (surveyId: number, input: core.UnitInput) => tx(surveyId, () => core.addUnit(ctx(surveyId), surveyId, input));
export const updateUnit = (id: number, patch: core.UnitPatch) => core.updateUnit(ctx(id), id, patch);
export const setUnitDone = (id: number, done: boolean) => core.setUnitDone(ctx(id), id, done);
export const deleteUnit = (id: number) => tx(id, () => core.deleteUnit(ctx(id), id));
export const deleteUnitWithContents = (id: number) => tx(id, () => core.deleteUnitWithContents(ctx(id), id));

// occurrences and values
export const listOccurrences = (surveyId: number, opts?: { unitId?: number | null }) => core.listOccurrences(ctx(surveyId), surveyId, opts);
export const getOccurrence = (id: number) => core.getOccurrence(ctx(id), id);
export const findOccurrence = (surveyId: number, unitId: number | null, taxonId: string, verbatim: string | null) =>
  core.findOccurrence(ctx(surveyId), surveyId, unitId, taxonId, verbatim);
export const occurrenceSealed = (o: Pick<core.OccurrenceRow, 'survey_id' | 'phase'>) => core.occurrenceSealed(ctx(o.survey_id), o);
export const addOccurrence = (surveyId: number, fields: core.OccurrenceFields & { taxon_id: string }) =>
  tx(surveyId, () => {
    cacheTaxon(surveyId, fields.taxon_id);
    return core.addOccurrence(ctx(surveyId), surveyId, fields);
  });
export const updateOccurrence = (id: number, patch: core.OccurrenceFields) =>
  tx(id, () => {
    if (patch.taxon_id) cacheTaxon(id, patch.taxon_id);
    core.updateOccurrence(ctx(id), id, patch);
  });
export const deleteOccurrence = (id: number) => tx(id, () => core.deleteOccurrence(ctx(id), id));
export const interactionCountOf = (occurrenceId: number) => core.interactionCountOf(ctx(occurrenceId), occurrenceId);
export const setValue = (owner: core.ValueOwner, component: string, field: string, value: ValueInput | null, idx = 0) =>
  core.setValue(ctx(owner.id), owner, component, field, value, idx);
export const listValues = (owner: core.ValueOwner) => core.listValues(ctx(owner.id), owner);
export const readComponent = (owner: core.ComponentOwner, key: string) => core.readComponent(ctx(owner.id), owner, key);
export const environmentCarried = (owner: { kind: 'survey' | 'unit'; id: number }) => core.environmentCarried(ctx(owner.id), owner);
export const writeComponent = (owner: core.ComponentOwner, key: string, patch: ComponentValues) => tx(owner.id, () => core.writeComponent(ctx(owner.id), owner, key, patch));
export const addMedia = (owner: core.ComponentOwner, key: string, uri: string) => core.addMedia(ctx(owner.id), owner, key, uri);
export const removeMedia = (owner: core.ComponentOwner, key: string, uri: string) => core.removeMedia(ctx(owner.id), owner, key, uri);
export const occurrenceMediaOf = (surveyId: number) => core.occurrenceMediaOf(ctx(surveyId), surveyId);
export const occurrenceValuesOf = (surveyId: number) => core.occurrenceValuesOf(ctx(surveyId), surveyId);

// blind phase and morphospecies
export const hasBlindPhase = (surveyId: number) => core.hasBlindPhase(ctx(surveyId), surveyId);
export const closeBlindPhase = (surveyId: number) => core.closeBlindPhase(ctx(surveyId), surveyId);
export const reopenBlindPhase = (surveyId: number) => tx(surveyId, () => core.reopenBlindPhase(ctx(surveyId), surveyId));
export const previousOccurrences = (surveyId: number) => core.previousOccurrences(ctx(surveyId), surveyId);
export const recheckState = (surveyId: number) => core.recheckState(ctx(surveyId), surveyId);
export const answerRecheck = (surveyId: number, candidate: Sighting, outcome: RecheckOutcome, occurrenceId: number | null = null) =>
  tx(surveyId, () => core.answerRecheck(ctx(surveyId), surveyId, candidate, outcome, occurrenceId));
export const listFrameLabels = (frameId: number) => core.listFrameLabels(ctx(), frameId);
export const frameLabelStatus = (surveyId: number, taxonId: string, verbatim: string | null) => core.frameLabelStatus(ctx(surveyId), surveyId, taxonId, verbatim);
export const addFrameLabel = (frameId: number, input: Parameters<typeof core.addFrameLabel>[2]) =>
  withTransaction(() => {
    ensureTaxonSelfSufficient(input.taxonId);
    return core.addFrameLabel(ctx(), frameId, input);
  });
export const updateFrameLabel = (id: number, patch: { note?: string | null; photoUri?: string | null }) => core.updateFrameLabel(ctx(), id, patch);

// interactions (2F, v87)
export type { Direction, InteractionInput, InteractionListRow, InteractionRow, InteractionType, Partner } from './interactionCore';
export const listInteractions = (surveyId: number, opts?: { occurrenceId?: number }) => inter.listInteractions(ctx(surveyId), surveyId, opts);
export const getInteraction = (id: number) => inter.getInteraction(ctx(id), id);
export const interactionSealed = (r: Pick<inter.InteractionRow, 'survey_id' | 'phase'>) => inter.interactionSealed(ctx(r.survey_id), r);
export const addInteraction = (input: inter.InteractionInput) =>
  tx(input.from, () => {
    if ('taxonId' in input.partner) cacheTaxon(input.from, input.partner.taxonId);
    return inter.addInteraction(ctx(input.from), input);
  });
export const updateInteraction = (id: number, input: inter.InteractionInput) =>
  tx(id, () => {
    if ('taxonId' in input.partner) cacheTaxon(id, input.partner.taxonId);
    inter.updateInteraction(ctx(id), id, input);
  });
export const deleteInteraction = (id: number) => tx(id, () => inter.deleteInteraction(ctx(id), id));
export const listInteractionPhotos = (id: number) => inter.listInteractionPhotos(ctx(id), id);
export const addInteractionPhoto = (id: number, uri: string) => inter.addInteractionPhoto(ctx(id), id, uri);
export const removeInteractionPhoto = (id: number, uri: string) => inter.removeInteractionPhoto(ctx(id), id, uri);
