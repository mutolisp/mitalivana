/**
 * 自訂選項欄 (2D-b): the codes of one of the template's code lists as chips;
 * one may be chosen, or several (`multi`). A code marked deprecated is no
 * longer offered, but still shows where it was chosen. The list comes with
 * the editor context (the survey's template snapshot).
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { Chip } from '~/components/ui/Chip';
import type { CodeItem, CodeList } from '~/survey/template/types';
import { labelText, ProblemLines, type EditorProps } from './shared';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

/** The list a choice names, from the template's code lists. */
export function choiceList(codelists: readonly CodeList[] | undefined, listId: unknown): CodeList | undefined {
  return codelists?.find((l) => l.id === listId);
}

export function codeLabel(t: TFunction, lang: string, item: CodeItem | undefined, code: string): string {
  return item ? labelText(t, lang, item.label, code) : code;
}

export function ChoiceEditor({ instance, values, onChange, problems, context, readOnly }: EditorProps) {
  const { t, i18n } = useTranslation();
  const codes = choiceList(context?.codelists, instance.params.list);
  const multi = instance.params.multi === true;
  const chosen = list(values.value);
  if (!codes) return <Text className="text-xs text-alert dark:text-alert-dark">{t('survey.editor.choice.noList')}</Text>;
  const shown = codes.items.filter((it) => !it.deprecated || chosen.includes(it.code));
  const toggle = (code: string) => {
    if (readOnly) return;
    if (multi) {
      const next = chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code];
      // In the list's order, whatever order they were tapped in.
      const ordered = codes.items.map((it) => it.code).filter((c) => next.includes(c));
      onChange({ value: ordered.length ? ordered : null });
    } else onChange({ value: chosen[0] === code ? null : code });
  };
  return (
    <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
      <View className="flex-row flex-wrap gap-2" accessibilityRole="tablist">
        {shown.map((it) => (
          <Chip key={it.code} label={codeLabel(t, i18n.language, it, it.code)} selected={chosen.includes(it.code)} onPress={() => toggle(it.code)} />
        ))}
      </View>
      {multi ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.editor.choice.multi')}</Text> : null}
      <ProblemLines problems={problems} />
    </View>
  );
}
