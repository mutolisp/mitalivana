/**
 * 調查法 (2G-f; canvas 16j–16k): the method, picked from the built-in list
 * (codesets/samplingMethods.ts; a 15A sheet grouped by taxon group, with
 * search) or typed as one's own, then what that method is measured by: an
 * area as width × length, a length or a duration with its unit, an effort,
 * and a note. A template may fix the method (no picker) or offer only some.
 * On a plot-style survey with quadrats, the size every quadrat takes.
 *
 * Names follow the app's language: the regulation's Chinese in Chinese, the
 * English (what DwC gets) otherwise (decided 2026-10-04).
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { LabeledField, LabeledNumField } from '~/components/form/LabeledField';
import { Seg } from '~/components/form/Segmented';
import { promptText } from '~/components/TextPromptModal';
import { useThemeColors } from '~/theme/colors';
import { CUSTOM_METHOD, METHOD_GROUPS, methodKey, methodOf, SAMPLING_METHODS, SIZE_UNITS, type MethodGroup, type SamplingMethod } from '~/survey/codesets/samplingMethods';
import { ProblemLines, type EditorProps } from './shared';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** i18n keys (literal, so check:i18n sees them). */
export const METHOD_GROUP_KEY: Readonly<Record<MethodGroup, string>> = {
  vegetation: 'surveyForm.method.group.vegetation',
  birds: 'surveyForm.method.group.birds',
  mammals: 'surveyForm.method.group.mammals',
  herps: 'surveyForm.method.group.herps',
  insects: 'surveyForm.method.group.insects',
  general: 'surveyForm.method.group.general',
};
const EFFORT_KEY: Readonly<Record<string, string>> = {
  'camera-hours': 'surveyForm.method.effort.cameraHours',
  'trap-nights': 'surveyForm.method.effort.trapNights',
  'net-hours': 'surveyForm.method.effort.netHours',
  'person-hours': 'surveyForm.method.effort.personHours',
  'trap-hours': 'surveyForm.method.effort.trapHours',
  'trap-days': 'surveyForm.method.effort.trapDays',
  'recorder-hours': 'surveyForm.method.effort.recorderHours',
};

/** A method's name in the app's language: the regulation's Chinese, else its English. */
export function methodName(m: SamplingMethod, lang: string): string {
  return lang.startsWith('zh') ? m.zh : m.en;
}

export function MethodEditor({ instance, values, onChange, problems, context, readOnly }: EditorProps) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const p = instance.params;
  const fixed = typeof p.fixed === 'string' ? p.fixed : null;
  const key = methodKey(values, p);
  const m = methodOf(key);
  const custom = key === CUSTOM_METHOD;
  const offered = SAMPLING_METHODS.filter((x) => !Array.isArray(p.methods) || !p.methods.length || p.methods.includes(x.key));
  const name = custom ? text(values.protocol_name) || t('surveyForm.method.custom') : m ? methodName(m, i18n.language) : '';

  const pick = async () => {
    if (readOnly || fixed) return;
    const groupName = (g: MethodGroup) => t(METHOD_GROUP_KEY[g]);
    const options = [
      ...offered.map((x) => ({
        key: x.key,
        label: methodName(x, i18n.language),
        description: x.en === methodName(x, i18n.language) ? undefined : x.en,
        section: groupName(x.group),
        keywords: `${x.zh} ${x.en}`,
        selected: key === x.key,
      })),
      ...(p.custom === false ? [] : [{ key: CUSTOM_METHOD, label: t('surveyForm.method.customPick'), section: t('surveyForm.method.custom'), selected: custom }]),
    ];
    const groups = METHOD_GROUPS.filter((g) => offered.some((x) => x.group === g));
    const i = await showActionSheet({
      title: t('surveyForm.method.title'),
      options,
      filters: groups.length > 1 ? groups.map((g) => ({ label: groupName(g), match: (o) => o.section === groupName(g) })) : undefined,
      recentKey: 'survey.method',
    });
    if (i < 0) return;
    const picked = options[i].key;
    if (picked === CUSTOM_METHOD) {
      const typed = await promptText({ title: t('surveyForm.method.customName'), defaultValue: text(values.protocol_name) });
      if (!typed?.trim()) return;
      onChange({ protocol: CUSTOM_METHOD, protocol_name: typed.trim() });
      return;
    }
    // Another method measures something else: its old size and effort go with it.
    onChange(picked === key ? {} : { protocol: picked, protocol_name: null, width_m: null, length_m: null, size_value: null, size_unit: null, effort_value: null, effort_unit: null });
  };

  const size = custom ? 'any' : m?.size;
  const units = size === 'any' ? [...new Set(Object.values(SIZE_UNITS).flat())] : size && size !== 'area' ? SIZE_UNITS[size] : [];
  const unit = text(values.size_unit) || units[0];
  const effortLabel = m?.effort && EFFORT_KEY[m.effort] ? t(EFFORT_KEY[m.effort]) : t('surveyForm.method.effortAny');
  const area = num(values.width_m) != null && num(values.length_m) != null ? Math.round((num(values.width_m) as number) * (num(values.length_m) as number) * 10000) / 10000 : null;

  return (
    <View className="gap-2">
      <Pressable
        onPress={() => void pick()}
        disabled={readOnly || !!fixed}
        accessibilityRole="button"
        accessibilityLabel={`${t('surveyForm.method.title')}: ${name || t('surveyForm.method.none')}`}
        className="min-h-14 flex-row items-center gap-2 py-1 active:opacity-70"
      >
        <View className="flex-1">
          <Text className="text-xs text-ink-3 dark:text-gray-400">{t('surveyForm.method.title')}</Text>
          <Text className={`text-base font-bold ${name ? 'text-ink dark:text-gray-100' : 'text-ink-3 dark:text-gray-400'}`}>{name || t('surveyForm.method.none')}</Text>
          {m ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t(METHOD_GROUP_KEY[m.group])}</Text> : null}
        </View>
        {fixed || readOnly ? null : <Ionicons name="chevron-forward" size={18} color={c.ink3} />}
      </Pressable>

      {size === 'area' ? (
        <View className="gap-1">
          <View className="flex-row items-baseline">
            <Text className="flex-1 text-sm font-semibold text-ink dark:text-gray-100">{t('surveyForm.method.size')}</Text>
            {area != null ? <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{`${area} m²`}</Text> : null}
          </View>
          <View className="flex-row gap-3" pointerEvents={readOnly ? 'none' : 'auto'}>
            <View className="flex-1">
              <LabeledNumField label={t('plot.width')} suffix="m" value={num(values.width_m)} min={0} onSave={(v) => onChange({ width_m: v })} />
            </View>
            <View className="flex-1">
              <LabeledNumField label={t('plot.length')} suffix="m" value={num(values.length_m)} min={0} onSave={(v) => onChange({ length_m: v })} />
            </View>
          </View>
        </View>
      ) : null}
      {units.length ? (
        <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
          <LabeledNumField label={t('surveyForm.method.size')} value={num(values.size_value)} min={0} onSave={(v) => onChange({ size_value: v, size_unit: v == null ? null : unit })} />
          {units.length > 1 ? <Seg value={unit} options={units.map((u) => ({ value: u, label: u }))} onChange={(u) => onChange({ size_unit: u })} /> : null}
        </View>
      ) : null}
      {m?.effort || custom ? (
        <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
          <LabeledNumField label={effortLabel} value={num(values.effort_value)} min={0} onSave={(v) => onChange({ effort_value: v, ...(m?.effort ? { effort_unit: v == null ? null : m.effort } : {}) })} />
          {custom ? (
            <LabeledField label={t('surveyForm.method.effortUnit')} value={text(values.effort_unit)} placeholder="person-hours" onSave={(v) => onChange({ effort_unit: v.trim() || null })} />
          ) : null}
        </View>
      ) : null}

      {context?.quadrats ? (
        <View className="gap-1 border-t border-line pt-2 dark:border-line-dark" pointerEvents={readOnly ? 'none' : 'auto'}>
          <Text className="text-sm font-semibold text-ink dark:text-gray-100">{t('surveyForm.method.quadratSize')}</Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <LabeledNumField label={t('plot.width')} suffix="m" value={num(values.quadrat_w_m)} min={0} onSave={(v) => onChange({ quadrat_w_m: v })} />
            </View>
            <View className="flex-1">
              <LabeledNumField label={t('plot.length')} suffix="m" value={num(values.quadrat_l_m)} min={0} onSave={(v) => onChange({ quadrat_l_m: v })} />
            </View>
          </View>
        </View>
      ) : null}

      <View pointerEvents={readOnly ? 'none' : 'auto'}>
        <LabeledField label={t('surveyForm.method.description')} value={text(values.description)} multiline onSave={(v, done) => done && onChange({ description: v.trim() || null })} />
      </View>
      <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('surveyForm.method.source')}</Text>
      <ProblemLines problems={problems} />
    </View>
  );
}
