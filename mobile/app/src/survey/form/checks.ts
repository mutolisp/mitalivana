/**
 * What finishing a survey reminds of: occurrences whose components still have
 * an error (a required field, a value out of range), counted the way the
 * occurrence form shows them.
 */
import { componentProblems } from '~/survey/componentRules';
import { readComponent } from '~/survey/db/surveys';
import { componentDef } from '~/survey/registry';
import type { SurveyTemplate } from '~/survey/template/types';
import { formComponents } from './occurrenceForm';

export function occurrencesWithErrors(template: SurveyTemplate, occurrenceIds: readonly number[]): number {
  const comps = formComponents(template, 'occurrence');
  return occurrenceIds.filter((id) =>
    comps.some((c) => {
      const def = componentDef(c.type);
      return !!def && componentProblems(def, c.params, c.level, c.key, readComponent({ kind: 'occurrence', id }, c.key)).some((p) => p.severity === 'error');
    }),
  ).length;
}

/** Layers an occurrence's Structure offers: the survey's own count, else the template's. */
export function layerCountOf(template: SurveyTemplate, surveyValues: Readonly<Record<string, { layer_count?: unknown }>>): number | undefined {
  const s = formComponents(template, 'survey').find((c) => c.type === 'structure');
  const own = s ? surveyValues[s.key]?.layer_count : undefined;
  if (typeof own === 'number') return own;
  const p = s?.params.layers ?? formComponents(template, 'occurrence').find((c) => c.type === 'structure')?.params.layers;
  return typeof p === 'number' ? p : undefined;
}
