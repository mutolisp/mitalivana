/**
 * What an occurrence's form holds and whether a species added without it
 * (quick add) leaves an error to fill in. The taxon is given by the add
 * itself; its input is the species search, not the form.
 *
 * Pure: check:survey-core runs it under Node.
 */
import { componentProblems } from '../componentRules';
import { componentDef } from '../registry';
import type { ComponentInstance, SurveyTemplate } from '../template/types';

/** The components a level's form shows, in template order: survey, one unit level, or occurrence. */
export function formComponents(t: SurveyTemplate, level: 'survey' | 'occurrence' | { unit: string }): ComponentInstance[] {
  return t.components.filter((c) =>
    typeof level === 'object' ? c.level === 'unit' && c.unit === level.unit : c.level === level && c.type !== 'taxon',
  );
}

/** Whether a new occurrence with only its taxon already has an error (a field the template requires). */
export function blankOccurrenceHasErrors(t: SurveyTemplate): boolean {
  return formComponents(t, 'occurrence').some((c) => {
    const def = componentDef(c.type);
    return !!def && componentProblems(def, c.params, c.level, c.key, {}).some((p) => p.severity === 'error');
  });
}
