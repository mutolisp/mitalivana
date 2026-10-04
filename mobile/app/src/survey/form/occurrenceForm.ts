/**
 * What an occurrence's form holds and whether a species added without it
 * (quick add) leaves an error to fill in. The taxon is given by the add
 * itself; its input is the species search, not the form.
 *
 * Pure: check:survey-core runs it under Node.
 */
import { instanceProblems } from '../componentRules';
import type { ComponentValues } from '../registry';
import type { ComponentInstance, SurveyTemplate } from '../template/types';

/** The components a level's form shows, in template order: survey, one unit level, or occurrence. */
export function formComponents(t: SurveyTemplate, level: 'survey' | 'occurrence' | { unit: string }): ComponentInstance[] {
  return t.components.filter((c) =>
    typeof level === 'object' ? c.level === 'unit' && c.unit === level.unit : c.level === level && c.type !== 'taxon',
  );
}

/** Whether a new occurrence with only its taxon already has an error (a field the template requires, or one its author made 必填). */
export function blankOccurrenceHasErrors(t: SurveyTemplate): boolean {
  return formComponents(t, 'occurrence').some((c) => instanceProblems(c, {}).some((p) => p.severity === 'error'));
}

/** The occurrences with an error — a value that does not fit, or 必填未填 — from all their values read at once (occurrenceValuesOf). */
export function occurrenceErrorIds(t: SurveyTemplate, values: ReadonlyMap<number, Readonly<Record<string, ComponentValues>>>): Set<number> {
  const comps = formComponents(t, 'occurrence');
  const out = new Set<number>();
  for (const [id, byComp] of values) if (comps.some((c) => instanceProblems(c, byComp[c.key] ?? {}).some((p) => p.severity === 'error'))) out.add(id);
  return out;
}
