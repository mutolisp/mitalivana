/**
 * One stem's AMS entries in the tree form (ForestGEO tree mortality and
 * damage protocol, Arellano, Zuleta & Davies 2021; src/survey/codesets/
 * forestgeoAms2021.ts). Every variable is per stem (p.1); "?" is "I can't tell
 * in 30 seconds without binoculars" (p.3) and is offered on every variable.
 * Numbers stay text until the form is saved; a marker ('?', '<POM', 'NA')
 * replaces the number.
 *
 * Labels are looked up by variable and code (survey.ams.<field>.label /
 * .c_<code>); check:templates fails when one is missing.
 */
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { AMS_UNSURE, AMS_VARIABLES, type AmsVariable } from '~/survey/codesets/forestgeoAms2021';
import { CodeChips } from '~/survey/components/CodeChips';
import { DraftNum } from '~/survey/components/DraftNum';
import type { AmsForm } from '~/survey/stemmap/treeForm';

/** i18n key of a variable's name, or of one of its codes. */
export const amsLabelKey = (field: string, code?: string) => (code == null ? `survey.ams.${field}.label` : `survey.ams.${field}.c_${code}`);

export function AmsStemFields({ value, onChange, stemTag }: { value: AmsForm; onChange: (next: AmsForm) => void; stemTag: string }) {
  const { t } = useTranslation();
  const set = (field: string, v: string | readonly string[] | null) => {
    const next: Record<string, string | readonly string[]> = { ...value };
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete next[field];
    else next[field] = v;
    onChange(next);
  };
  const codeName = (v: AmsVariable, code: string) => (code === AMS_UNSURE ? t('survey.ams.unsure') : t(amsLabelKey(v.field, code)));
  return (
    <View className="gap-2 border-t border-line pt-2 dark:border-line-dark">
      <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('survey.ams.title')}</Text>
      {AMS_VARIABLES.map((v) => {
        const label = t(amsLabelKey(v.field));
        const a11y = `${stemTag} ${label}`;
        const cur = value[v.field];
        if (v.kind === 'number') {
          const markers = [AMS_UNSURE, ...(v.special ?? [])];
          const text = typeof cur === 'string' ? cur : '';
          const marker = markers.includes(text) ? text : null;
          return (
            <View key={v.field} className="gap-1">
              <Text className="text-xs text-ink-2 dark:text-gray-400">{label}</Text>
              <View className="flex-row flex-wrap items-center gap-1.5">
                <DraftNum value={marker ? '' : text} onChange={(x) => set(v.field, x)} accessibilityLabel={a11y} width={68} />
                <Text className="text-xs text-ink-2 dark:text-gray-400">{v.unit}</Text>
                <CodeChips
                  codes={markers}
                  selected={marker ? [marker] : []}
                  single
                  onChange={(next) => set(v.field, next[0] ?? null)}
                  labelOf={(code) => (code === AMS_UNSURE ? t('survey.ams.unsure') : t(amsLabelKey(v.field, code === '<POM' ? 'belowPom' : code)))}
                />
              </View>
            </View>
          );
        }
        const codes = v.kind === 'flag' ? ['Y', 'N', AMS_UNSURE] : [...v.choices.map((c) => c.code), AMS_UNSURE];
        const selected = Array.isArray(cur) ? cur : typeof cur === 'string' ? [cur] : [];
        return (
          <View key={v.field} className="gap-1">
            <Text className="text-xs text-ink-2 dark:text-gray-400">{label}</Text>
            <CodeChips
              codes={codes}
              selected={selected}
              single={v.kind !== 'multi'}
              onChange={(next) => set(v.field, v.kind === 'multi' ? next : (next[0] ?? null))}
              labelOf={(code) => (v.kind === 'flag' ? (code === 'Y' ? t('survey.ams.yes') : code === 'N' ? t('survey.ams.no') : t('survey.ams.unsure')) : codeName(v, code))}
            />
          </View>
        );
      })}
      <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('survey.ams.deathHint')}</Text>
    </View>
  );
}
