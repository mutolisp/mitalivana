/**
 * Everything a checklist / plot-style survey's screens read: the survey, its
 * template snapshot, its units (in walking order) and its occurrences with
 * their names resolved for display (offline: the taxon cache), and the state
 * of a recheck. Re-read on focus, since the occurrence and unit screens write
 * behind the survey screen.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { isPreviewId } from '~/db/previewDb';
import { getProject, type Project } from '~/db/projects';
import { getSite, type Site } from '~/db/sites';
import { applyAdoptedName, EMPTY_TAXON_FIELDS, resolveAdoptedNames, resolveTaxa, type AdoptionStatus, type TaxonFields } from '~/db/taxonLookup';
import { snapshotOf, unitLevelsOf, type FwSurveyRow, type OccurrenceRow, type RecheckState, type UnitRow } from '~/survey/db/surveyCore';
import { environmentCarried, getFwSurvey, getTemplate, hasBlindPhase, listInteractions, listOccurrences, listUnits, occurrenceMediaOf, occurrenceValuesOf, readComponent, recheckState } from '~/survey/db/surveys';
import { classifyChange } from '~/survey/template/validate';
import type { ComponentValues } from '~/survey/registry';
import { getFrame } from '~/survey/db/stemmap';
import type { SurveyTemplate } from '~/survey/template/types';
import { formComponents, occurrenceErrorIds } from './occurrenceForm';
import { unitRows, type UnitRowOf } from './units';

export type Named<T> = T & TaxonFields & AdoptionStatus;

export type OccurrenceView = Named<OccurrenceRow> & {
  sealed: boolean;
  unitPath: string;
  /** Its Abundance values, for the list's summary (read here, not while rendering). */
  abundance: ComponentValues | null;
  /** Its own photos and recordings (the list's thumbnail, the detail sheet). */
  photos: string[];
  audio: string[];
};

export type SurveyForm = {
  survey: FwSurveyRow;
  template: SurveyTemplate;
  levelKeys: string[];
  units: UnitRowOf<UnitRow>[];
  occurrences: OccurrenceView[];
  frameCode: string | null;
  /** A recheck of a permanent plot (it starts blind). */
  recheck: boolean;
  /** Once the blind phase is closed: candidates and answers. */
  recheckState: RecheckState | null;
  /** The survey-level components' values, by component key. */
  surveyValues: Record<string, ComponentValues>;
  /** An open survey whose template has a newer version it can take (an additive change), offered on its screen. */
  upgradeTo: SurveyTemplate | null;
  /** Survey-level environment values that are still the previous survey's. */
  carried: ReturnType<typeof environmentCarried>;
  /** How many interactions it holds; null when its template has no Interaction component (2F). */
  interactions: number | null;
  /** Its occurrences with an error (a value that does not fit, or 必填未填; 2G-e): the rows' markers, the finish reminder. */
  errorIds: ReadonlySet<number>;
  /** Its project and 地理樣區, read here: read while rendering, a name changed elsewhere stayed old under the compiler (code review L23). */
  project: Project | null;
  site: Site | null;
};

/** Rows with their taxon's display names (accepted name, or the adopted one recorded). */
export function withNames<T extends { taxon_id: string; used_name_id: number | null; used_scientific_name: string | null }>(rows: readonly T[]): Named<T>[] {
  if (!rows.length) return [];
  const taxa = resolveTaxa(rows.map((r) => r.taxon_id));
  const adopted = resolveAdoptedNames(rows.map((r) => ({ used_name_id: r.used_name_id, used_scientific_name: r.used_scientific_name })));
  return rows.map((r) => ({ ...r, ...applyAdoptedName(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS, r, adopted) }));
}

function upgradeOf(survey: FwSurveyRow, snapshot: SurveyTemplate): SurveyTemplate | null {
  // A preview runs the draft itself, never a saved version of it.
  if (survey.status !== 'active' || isPreviewId(survey.id)) return null;
  const latest = getTemplate(survey.template_id);
  return latest && latest.version > survey.template_version && classifyChange(snapshot, latest) === 'additive' ? latest : null;
}

export function loadSurveyForm(id: number): SurveyForm | null {
  const survey = getFwSurvey(id);
  if (!survey || survey.style === 'individual') return null;
  const template = snapshotOf(survey);
  const levelKeys = unitLevelsOf(survey).map((u) => u.key);
  const units = unitRows(levelKeys, survey.style === 'plot' ? listUnits(id) : []);
  const pathOf = new Map(units.map((u) => [u.unit.id, u.path]));
  const sealedBlind = survey.blind_closed_at != null;
  const abundance = formComponents(template, 'occurrence').find((c) => c.type === 'abundance');
  const media = occurrenceMediaOf(id);
  const occurrences = withNames(listOccurrences(id)).map((o) => ({
    ...o,
    sealed: sealedBlind && o.phase === 'blind',
    unitPath: o.unit_id == null ? '' : (pathOf.get(o.unit_id) ?? ''),
    abundance: abundance ? readComponent({ kind: 'occurrence', id: o.id }, abundance.key) : null,
    photos: media.get(o.id)?.photo ?? [],
    audio: media.get(o.id)?.audio ?? [],
  }));
  const recheck = hasBlindPhase(id);
  return {
    survey,
    template,
    levelKeys,
    units,
    occurrences,
    frameCode: survey.frame_id == null ? null : (getFrame(survey.frame_id)?.code ?? null),
    recheck,
    recheckState: recheck && sealedBlind ? recheckState(id) : null,
    surveyValues: Object.fromEntries(formComponents(template, 'survey').map((c) => [c.key, readComponent({ kind: 'survey', id }, c.key)])),
    upgradeTo: upgradeOf(survey, template),
    carried: environmentCarried({ kind: 'survey', id }),
    interactions: template.components.some((c) => c.type === 'interaction') ? listInteractions(id).length : null,
    errorIds: occurrenceErrorIds(template, occurrenceValuesOf(id)),
    project: getProject(survey.project_id),
    site: survey.site_id != null ? getSite(survey.site_id) : null,
  };
}

export function useSurveyForm(id: number): { data: SurveyForm | null; reload: () => void } {
  const [data, setData] = useState<SurveyForm | null>(() => loadSurveyForm(id));
  const reload = useCallback(() => setData(loadSurveyForm(id)), [id]);
  useFocusEffect(reload);
  return { data, reload };
}

/** What a list shows for an occurrence: its label, else its common and scientific names. */
export function occurrenceTitle(o: Pick<Named<OccurrenceRow>, 'verbatim_identification' | 'common_name_c' | 'simple_name' | 'taxon_id'>): string {
  return o.verbatim_identification || [o.common_name_c, o.simple_name].filter(Boolean).join(' ') || o.taxon_id;
}
