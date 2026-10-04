/**
 * Words the checklist / plot-style screens share: refusals from surveyCore
 * as sentences, a unit level's name, and a template's name.
 */
import type { TFunction } from 'i18next';
import { errText } from '~/lib/errText';
import { envLabel } from '~/survey/components/editors/AttributeEditors';
import { labelText } from '~/survey/components/editors/shared';
import type { EnvironmentField } from '~/survey/registry';
import { SurveyError } from '~/survey/db/stemmapCore';
import type { SurveyTemplate } from '~/survey/template/types';

/** A refusal the user can act on, as a sentence; anything else as its message. */
export function formErrorText(t: TFunction, e: unknown): string {
  if (!(e instanceof SurveyError)) return errText(e);
  switch (e.code) {
    case 'unit_taken':
      return t('surveyForm.err.unitTaken', { code: e.detail ?? '' });
    case 'frame_unit_locked':
      return t('surveyForm.err.frameUnitLocked');
    case 'blind_sealed':
      return t('surveyForm.err.blindSealed');
    case 'recheck_begun':
      return t('surveyForm.err.recheckBegun');
    case 'unit_done':
      return t('surveyForm.err.unitDone', { code: e.detail ?? '' });
    case 'label_taken':
      return t('surveyForm.err.labelTaken', { label: e.detail ?? '' });
    case 'bad_value':
      return t('surveyForm.err.badValue');
    default:
      return errText(e);
  }
}

/** A unit level's name in the app's language (the template's words). */
export function levelLabel(t: TFunction, lang: string, template: SurveyTemplate, key: string): string {
  return labelText(t, lang, template.units?.find((u) => u.key === key)?.label, key);
}

/** Under an environment card: which of its values are the previous survey's (surveyCore.environmentCarried). */
export function carriedNotes(t: TFunction, carried: { census: number | null; fields: Record<string, string[]> }): Record<string, string> {
  if (carried.census == null) return {};
  return Object.fromEntries(
    Object.entries(carried.fields).map(([key, fields]) => [key, t('surveyForm.carried', { n: carried.census, fields: fields.map((f) => envLabel(t, f as EnvironmentField)).join(t('builder.listSep')) })]),
  );
}

export function templateName(t: TFunction, lang: string, template: SurveyTemplate): string {
  return labelText(t, lang, template.name, template.id);
}
