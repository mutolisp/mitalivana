/**
 * What every component input shares (src/survey/registry.ts components): its
 * props, the template label of a component or trait, and the problem lines
 * under it. An input edits values only; the host stores them
 * (surveyCore.writeComponent, or a form that saves as a whole) and passes back
 * what componentRules found.
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import type { ComponentValues, FieldValue, Problem } from '~/survey/registry';
import type { CodeList, ComponentInstance, Label } from '~/survey/template/types';

export type EditorContext = {
  /** Phenology shows plant or animal fields by the taxon's kingdom and class. */
  kingdom?: string | null;
  className?: string | null;
  /** Structure on an occurrence: how many layers the survey has (E1–En). */
  layerCount?: number;
  /** Photos and audio are rows of their own: the host adds and removes them. */
  onAddMedia?: (uri: string) => void;
  onRemoveMedia?: (uri: string) => void;
  /** No input takes the focus on its own (a whole template's preview, not one record). */
  noAutoFocus?: boolean;
  /** The template's own code lists (a choice's codes). */
  codelists?: readonly CodeList[];
};

export type EditorProps = {
  instance: ComponentInstance;
  values: ComponentValues;
  /** Some fields changed (null clears one). */
  onChange: (patch: Record<string, FieldValue>) => void;
  problems: readonly Problem[];
  context?: EditorContext;
  readOnly?: boolean;
};

/** A template label in the app's language: a built-in's i18n key, else the user's text or its translation. */
export function labelText(t: TFunction, lang: string, label: Label | undefined | null, fallback = ''): string {
  if (!label) return fallback;
  if ('i18n' in label) return t(label.i18n);
  const tr = label.tr ?? {};
  return tr[lang] ?? tr[lang.split('-')[0]] ?? label.text;
}

/** The problem codes componentRules and the registry rules produce, as text. */
export function problemText(t: TFunction, p: Problem): string {
  switch (p.code) {
    case 'required':
      return t('survey.editor.problem.required');
    case 'not_a_number':
      return t('survey.editor.problem.notANumber');
    case 'below_min':
    case 'above_max':
    case 'out_of_range':
      return t('survey.editor.problem.outOfRange');
    case 'not_integer':
      return t('survey.editor.problem.notInteger');
    case 'not_allowed':
      return t('survey.editor.problem.notAllowed');
    case 'not_a_list':
    case 'not_per_layer':
    case 'not_a_mask':
      return t('survey.editor.problem.malformed');
    case 'ends_before_start':
      return t('survey.editor.problem.endsBeforeStart');
    case 'covers_over_100':
      return t('survey.editor.problem.coversOver100');
    case 'layer_out_of_range':
      return t('survey.editor.problem.layerOutOfRange');
    default:
      return p.code;
  }
}

/** The problems of one field (all of them when `field` is omitted), one line each. */
export function ProblemLines({ problems, field }: { problems: readonly Problem[]; field?: string | null }) {
  const { t } = useTranslation();
  const mine = field === undefined ? problems : problems.filter((p) => p.field === field);
  if (!mine.length) return null;
  return (
    <View className="gap-0.5">
      {mine.map((p, i) => (
        <Text key={`${p.field}:${p.idx ?? ''}:${p.code}:${i}`} className={`text-xs ${p.severity === 'error' ? 'text-alert dark:text-alert-dark' : 'text-acorn-deep dark:text-acorn'}`}>
          {problemText(t, p)}
        </Text>
      ))}
    </View>
  );
}
