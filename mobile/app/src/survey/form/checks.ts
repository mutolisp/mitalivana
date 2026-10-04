/**
 * A survey's layer count, as its forms offer the layers. (Finishing counts its
 * occurrences with an error from the survey form's errorIds, 2G-e.)
 */
import type { SurveyTemplate } from '~/survey/template/types';
import { formComponents } from './occurrenceForm';

/** Layers an occurrence's Structure offers: the survey's own count, else the template's. */
export function layerCountOf(template: SurveyTemplate, surveyValues: Readonly<Record<string, { layer_count?: unknown }>>): number | undefined {
  const s = formComponents(template, 'survey').find((c) => c.type === 'structure');
  const own = s ? surveyValues[s.key]?.layer_count : undefined;
  if (typeof own === 'number') return own;
  const p = s?.params.layers ?? formComponents(template, 'occurrence').find((c) => c.type === 'structure')?.params.layers;
  return typeof p === 'number' ? p : undefined;
}
