/**
 * Phenology, Traits and Environment inputs.
 *   - Phenology: the species attributes block quick records already use
 *     (SpeciesAttributesBlock), limited to the template's fields.
 *   - Traits: one number per trait the template declares, with its unit and
 *     range (refused out of range, as on the plot screen).
 *   - Environment: the plot screen's environment fields, against props; the
 *     ground covers show their total, and the last blank one takes what is
 *     left when there is room (EnvTab's rule).
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { LabeledField, LabeledNumField } from '~/components/form/LabeledField';
import { Chip } from '~/components/ui/Chip';
import { SpeciesAttributesBlock, type SpeciesAttributesDraft } from '~/components/SpeciesAttributesBlock';
import { COVER_FIELDS, type EnvironmentField, type TraitDef } from '~/survey/registry';
import type { Label } from '~/survey/template/types';
import { choiceList, codeLabel } from './ChoiceEditor';
import { labelText, ProblemLines, type EditorProps } from './shared';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function PhenologyEditor({ instance, values, onChange, problems, context, readOnly }: EditorProps) {
  const fields = (Array.isArray(instance.params.fields) ? instance.params.fields : []) as (keyof SpeciesAttributesDraft)[];
  const draft: SpeciesAttributesDraft = {
    sex: text(values.sex),
    life_stage: text(values.life_stage),
    reproductive_condition: list(values.reproductive_condition),
    leaf_phenology: list(values.leaf_phenology),
    degree_of_establishment: text(values.degree_of_establishment),
  };
  return (
    <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
      <SpeciesAttributesBlock
        kingdom={context?.kingdom}
        className={context?.className}
        value={draft}
        fields={fields}
        defaultOpen
        onChange={(next) => onChange(Object.fromEntries(fields.map((f) => [f, Array.isArray(next[f]) ? (next[f] as string[]) : (next[f] as string | null)])))}
      />
      <ProblemLines problems={problems} />
    </View>
  );
}

export function TraitsEditor({ instance, values, onChange, problems, readOnly }: EditorProps) {
  const { t, i18n } = useTranslation();
  const traits = (Array.isArray(instance.params.traits) ? instance.params.traits : []) as TraitDef[];
  return (
    <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
      {traits.map((tr) => (
        <View key={tr.id}>
          <LabeledNumField
            label={labelText(t, i18n.language, tr.label as Label, tr.id)}
            suffix={tr.unit}
            value={num(values[tr.id])}
            min={tr.min}
            max={tr.max}
            onSave={(n) => onChange({ [tr.id]: n == null ? null : tr.integer ? Math.round(n) : n })}
          />
          <ProblemLines problems={problems} field={tr.id} />
        </View>
      ))}
    </View>
  );
}

/** Each environment field's name: the plot screen's own labels (literal keys, so check:i18n sees them). Also the builder's. */
export function envLabel(t: TFunction, f: EnvironmentField): string {
  switch (f) {
    case 'elevation_m':
      return t('plot.elevation');
    case 'slope_deg':
      return t('plot.slope');
    case 'aspect_deg':
      return t('plot.aspect');
    case 'openness':
      return t('surveyForm.env.openness');
    case 'terrain_position':
      return t('plot.terrainPosition');
    case 'vascular_cover_pct':
      return t('plot.vascularCover');
    case 'bryophyte_cover_pct':
      return t('plot.bryophyteCover');
    case 'lichen_cover_pct':
      return t('plot.lichenCover');
    case 'litter_cover_pct':
      return t('plot.litterCover');
    case 'rock_cover_pct':
      return t('plot.rockCover');
    case 'gravel_cover_pct':
      return t('plot.gravelCover');
    case 'bareland_cover_pct':
      return t('plot.bareCover');
  }
}
const RANGE: Readonly<Partial<Record<EnvironmentField, [number, number]>>> = { slope_deg: [0, 90], aspect_deg: [0, 359] };

export function EnvironmentEditor({ instance, values, onChange, problems, context, readOnly }: EditorProps) {
  const { t, i18n } = useTranslation();
  const fields = (Array.isArray(instance.params.fields) ? instance.params.fields : []) as EnvironmentField[];
  const covers = COVER_FIELDS.filter((f) => fields.includes(f));
  const total = Math.round(covers.reduce((s, f) => s + (num(values[f]) ?? 0), 0) * 100) / 100;
  const setCover = (field: EnvironmentField, v: number | null, done: boolean) => {
    const next: Record<string, number | null> = { [field]: v };
    // The last blank cover takes what is left, when there is room (never past 100 %) — once the number is typed in full.
    const blanks = covers.filter((f) => f !== field && num(values[f]) == null);
    if (done && v != null && blanks.length === 1) {
      const filled = covers.filter((f) => f !== blanks[0]).reduce((s, f) => s + (f === field ? v : (num(values[f]) ?? 0)), 0);
      const rest = Math.round((100 - filled) * 100) / 100;
      if (rest >= 0) next[blanks[0]] = rest;
    }
    onChange(next);
  };
  return (
    <View className="gap-1" pointerEvents={readOnly ? 'none' : 'auto'}>
      {fields.map((f) => {
        const label = envLabel(t, f);
        if (f === 'terrain_position') {
          return <LabeledField key={f} label={label} value={text(values[f]) ?? ''} onSave={(v) => onChange({ [f]: v.trim() || null })} />;
        }
        if (f === 'openness') {
          // A grade from the template's own list, else sky openness in % (2G-f).
          const grades = typeof instance.params.openness_list === 'string' ? choiceList(context?.codelists, instance.params.openness_list) : undefined;
          if (grades) {
            const chosen = text(values.openness_grade);
            return (
              <View key={f} className="gap-2 py-1">
                <Text className="text-sm text-ink dark:text-gray-100">{label}</Text>
                <View className="flex-row flex-wrap gap-2">
                  {grades.items
                    .filter((it) => !it.deprecated || it.code === chosen)
                    .map((it) => (
                      <Chip key={it.code} label={codeLabel(t, i18n.language, it, it.code)} selected={chosen === it.code} onPress={() => onChange({ openness_grade: chosen === it.code ? null : it.code })} />
                    ))}
                </View>
              </View>
            );
          }
          return (
            <LabeledNumField key={f} label={t('surveyForm.env.opennessPct')} suffix="%" value={num(values.openness_pct)} min={0} max={100} onSave={(v) => onChange({ openness_pct: v })} />
          );
        }
        const cover = (COVER_FIELDS as readonly string[]).includes(f);
        const [min, max] = RANGE[f] ?? (cover ? [0, 100] : [undefined, undefined]);
        return (
          <LabeledNumField
            key={f}
            label={label}
            suffix={cover ? '%' : f === 'elevation_m' ? 'm' : '°'}
            value={num(values[f])}
            min={min}
            max={max}
            onSave={(v, done) =>
              cover
                ? setCover(f, v, done)
                : // The survey's own elevation says where it came from (v88): typed here, as on a fixed plot.
                  onChange(f === 'elevation_m' && instance.level === 'survey' ? { elevation_m: v, elevation_source: v == null ? null : 'manual' } : { [f]: v })
            }
          />
        );
      })}
      {covers.length > 1 ? (
        <Text style={{ fontVariant: ['tabular-nums'] }} className={`text-xs ${total > 100 ? 'text-alert dark:text-alert-dark' : 'text-ink-2 dark:text-gray-400'}`}>
          {t('survey.editor.environment.coverTotal', { total })}
        </Text>
      ) : null}
      <ProblemLines problems={problems} />
    </View>
  );
}
