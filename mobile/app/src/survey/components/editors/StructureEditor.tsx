/**
 * Vegetation layers (Structure), on three levels as plot surveys have them:
 *   - the survey: how many layers (E1–E6) and each layer's cover, height and
 *     abundance method — the plot screen's LayerSection, written against
 *     props instead of plot_survey_layers;
 *   - a unit: each layer's cover and height (SubplotSection's layers), the
 *     height in the unit the survey gives that layer;
 *   - an occurrence: which layer it is in.
 * Heights are stored in cm; the unit is how the layer shows it (v17).
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { LabeledNumField } from '~/components/form/LabeledField';
import { Seg } from '~/components/form/Segmented';
import { CodeChips } from '~/survey/components/CodeChips';
import { LAYER_METHODS, MAX_LAYERS } from '~/survey/registry';
import { useThemeColors } from '~/theme/colors';
import { ProblemLines, type EditorProps } from './shared';

type PerLayer = Readonly<Record<number, number | string>>;
const perLayer = (v: unknown): PerLayer => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as PerLayer) : {});
const layerKey = (i: number) => `E${i}`;

export function StructureEditor({ instance, values, onChange, problems, context, readOnly }: EditorProps) {
  const { t } = useTranslation();
  const c = useThemeColors();
  if (instance.level === 'occurrence') {
    const count = context?.layerCount ?? (Number(instance.params.layers) || 4);
    const layer = typeof values.layer === 'string' ? values.layer : null;
    return (
      <View className="gap-1">
        <CodeChips
          codes={Array.from({ length: count }, (_, i) => layerKey(i + 1))}
          selected={layer ? [layer] : []}
          single
          disabled={readOnly}
          onChange={(next) => onChange({ layer: next[0] ?? null })}
          labelOf={(k) => t('plotValue.layer', { layer: k })}
        />
        <ProblemLines problems={problems} />
      </View>
    );
  }
  const onSurvey = instance.level === 'survey';
  const count = onSurvey ? (typeof values.layer_count === 'number' ? values.layer_count : Number(instance.params.layers) || 4) : (context?.layerCount ?? (Number(instance.params.layers) || 4));
  const cover = perLayer(values.cover_pct);
  const height = perLayer(values.height_cm);
  const unit = perLayer(values.height_unit);
  const method = perLayer(values.method);
  const methods = (Array.isArray(instance.params.methods) ? instance.params.methods : LAYER_METHODS) as string[];
  const setAt = (field: string, current: PerLayer, i: number, v: number | string | null) => onChange({ [field]: { ...current, [i]: v } as Record<number, number | string> });
  const step = (d: number) => {
    const next = Math.min(MAX_LAYERS, Math.max(1, count + d));
    if (next !== count) onChange({ layer_count: next });
  };
  return (
    <View className="gap-2" pointerEvents={readOnly ? 'none' : 'auto'}>
      {onSurvey ? (
        <View className="flex-row items-center gap-3">
          <Text className="text-xs font-medium text-ink-2 dark:text-gray-400">{t('plot.layerCount')}</Text>
          <Pressable onPress={() => step(-1)} disabled={count <= 1} accessibilityRole="button" accessibilityLabel={t('survey.editor.structure.fewer')} className="h-9 w-9 items-center justify-center rounded-full bg-disc dark:bg-disc-dark">
            <Ionicons name="remove" size={18} color={count <= 1 ? c.ink3 : c.ink} />
          </Pressable>
          <Text style={{ fontVariant: ['tabular-nums'] }} className="min-w-[24px] text-center text-lg font-semibold text-ink dark:text-gray-100">
            {count}
          </Text>
          <Pressable onPress={() => step(1)} disabled={count >= MAX_LAYERS} accessibilityRole="button" accessibilityLabel={t('survey.editor.structure.more')} className="h-9 w-9 items-center justify-center rounded-full bg-disc dark:bg-disc-dark">
            <Ionicons name="add" size={18} color={count >= MAX_LAYERS ? c.ink3 : c.ink} />
          </Pressable>
        </View>
      ) : null}
      {Array.from({ length: count }, (_, k) => k + 1).map((i) => {
        // A unit's layer shows its height in the unit the survey gives that layer, as the fixed plot's subplots do.
        const u = onSurvey ? (unit[i] === 'm' ? 'm' : 'cm') : (context?.heightUnitOf?.(i) ?? 'cm');
        const h = typeof height[i] === 'number' ? (height[i] as number) : null;
        return (
          <View key={i} className="gap-1 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
            <Text className="text-sm font-semibold text-ink dark:text-gray-100">{layerKey(i)}</Text>
            <View className="flex-row gap-3">
              <View className="flex-1">
                <LabeledNumField label={t('survey.editor.structure.cover')} suffix="%" value={typeof cover[i] === 'number' ? (cover[i] as number) : null} min={0} max={100} onSave={(n) => setAt('cover_pct', cover, i, n)} />
              </View>
              <View className="flex-1">
                <LabeledNumField
                  label={t('survey.editor.structure.height')}
                  suffix={u}
                  value={h == null ? null : u === 'm' ? h / 100 : h}
                  min={0}
                  onSave={(n) => setAt('height_cm', height, i, n == null ? null : u === 'm' ? n * 100 : n)}
                />
                {onSurvey ? <Seg value={u} options={(['cm', 'm'] as const).map((x) => ({ value: x, label: x }))} onChange={(x) => setAt('height_unit', unit, i, x)} /> : null}
              </View>
            </View>
            {onSurvey && methods.length > 1 ? (
              <Seg
                value={typeof method[i] === 'string' ? (method[i] as string) : methods[0]}
                options={methods.map((m) => ({ value: m, label: m === 'percent' ? '%' : m }))}
                onChange={(m) => setAt('method', method, i, m)}
              />
            ) : null}
          </View>
        );
      })}
      <ProblemLines problems={problems} />
    </View>
  );
}
