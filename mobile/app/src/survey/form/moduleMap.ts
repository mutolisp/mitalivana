/**
 * Which existing screen block shows each component of a template (2G;
 * Modular_survey.md §9): a checklist-style survey is drawn with 快速名錄's
 * screen, so an occurrence's components land in the species detail sheet's
 * own fields where it has one (count, notes, coordinate, photos, recordings,
 * attributes) and after them otherwise, in template order; the survey's
 * time and investigators are the context strip's chips, and all of its
 * components the 調查資料 page's four groups (surveyGroups.ts, 2G-f).
 *
 * Pure: check:survey-core runs it under Node.
 */
import { ABUNDANCE_TYPE, PHENOLOGY_FIELDS } from '../registry';
import type { ComponentInstance, SurveyTemplate } from '../template/types';
import { formComponents } from './occurrenceForm';

export type PhenologyField = (typeof PHENOLOGY_FIELDS)[number];

export type OccurrenceModules = {
  abundance: ComponentInstance | null;
  /** Individuals are one of its scales: the list's − n ＋ and "+1" on adding a species again. */
  counts: boolean;
  /** Individuals are its only scale: the sheet's own count field instead of the scale picker. */
  countOnly: boolean;
  comments: ComponentInstance | null;
  location: ComponentInstance | null;
  photos: ComponentInstance | null;
  audio: ComponentInstance | null;
  phenology: ComponentInstance | null;
  /** The attributes the phenology component asks for, in the block's order. */
  phenologyFields: PhenologyField[];
  interaction: ComponentInstance | null;
  /** The rest, after the sheet's own fields, in template order. */
  extras: ComponentInstance[];
};

const NATIVE = new Set(['abundance', 'comments', 'location', 'photos', 'audio', 'phenology', 'interaction']);

export function occurrenceModules(t: SurveyTemplate): OccurrenceModules {
  const comps = formComponents(t, 'occurrence');
  const of = (type: string) => comps.find((c) => c.type === type) ?? null;
  const abundance = of('abundance');
  const kinds = abundance && Array.isArray(abundance.params.kinds) ? (abundance.params.kinds as string[]) : [];
  const phenology = of('phenology');
  const asked = phenology && Array.isArray(phenology.params.fields) ? (phenology.params.fields as string[]) : [];
  return {
    abundance,
    counts: kinds.includes('count'),
    countOnly: kinds.length === 1 && kinds[0] === 'count',
    comments: of('comments'),
    location: of('location'),
    photos: of('photos'),
    audio: of('audio'),
    phenology,
    phenologyFields: PHENOLOGY_FIELDS.filter((f) => asked.includes(f)),
    interaction: of('interaction'),
    extras: comps.filter((c) => !NATIVE.has(c.type)),
  };
}

/** Whether a stored abundance is counted individuals (or nothing yet): the row's − n ＋ steps it. */
export const isIndividuals = (type: string | null | undefined) => type == null || type === '' || type === ABUNDANCE_TYPE.count;

export type SurveyModules = {
  /** The context strip's time chip. */
  timestamp: ComponentInstance | null;
  /** The context strip's surveyors chip. */
  investigators: ComponentInstance | null;
  /** The 調查資料 page, in template order. */
  data: ComponentInstance[];
};

export function surveyModules(t: SurveyTemplate): SurveyModules {
  const comps = formComponents(t, 'survey');
  return {
    timestamp: comps.find((c) => c.type === 'timestamp') ?? null,
    investigators: comps.find((c) => c.type === 'investigators') ?? null,
    data: comps.filter((c) => c.type !== 'timestamp' && c.type !== 'investigators'),
  };
}

