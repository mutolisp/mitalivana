/**
 * Frequency of one occurrence: a cell grid painted with a finger
 * (src/components/quadrat/FrequencyGrid.tsx, as on plot frequency) or a count
 * of cells, on the template's grid (one grid for every unit of a survey, v78).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { LabeledNumField } from '~/components/form/LabeledField';
import { FrequencyGrid, type FrequencyGridHandle } from '~/components/quadrat/FrequencyGrid';
import { topEdgeName } from '~/components/quadrat/names';
import { emptyMask, isMask, popcount } from '~/lib/grid';
import { ProblemLines, type EditorProps } from './shared';

const KEY = 'occurrence';

export function FrequencyEditor({ instance, values, onChange, problems, readOnly }: EditorProps) {
  const { t } = useTranslation();
  const n = Number(instance.params.n) || 10;
  const cells = n * n;
  const stored = typeof values.freq_cells === 'string' && isMask(values.freq_cells, cells) ? values.freq_cells : emptyMask(cells);
  const [mask, setMask] = useState(stored);
  const grid = useRef<FrequencyGridHandle>(null);
  if (instance.params.mode === 'count') {
    return (
      <View className="gap-1">
        <LabeledNumField
          label={t('survey.editor.frequency.count', { n, cells })}
          value={typeof values.freq_count === 'number' ? values.freq_count : null}
          min={0}
          max={cells}
          onSave={(v) => onChange({ freq_count: v == null ? null : Math.round(v) })}
        />
        <ProblemLines problems={problems} />
      </View>
    );
  }
  return (
    <View className="gap-2">
      <FrequencyGrid
        ref={grid}
        n={n}
        masks={{ [KEY]: mask }}
        active={KEY}
        mode="brush"
        topEdgeLabel={`▲ ${t('plot.quadrats.topEdgeLabel', { edge: topEdgeName(t, String(instance.params.top_edge ?? 'N')) })}`}
        locked={!!readOnly}
        readMask={() => mask}
        onPaint={(_, m) => setMask(m)}
        onCommit={(_, m) => {
          setMask(m);
          onChange({ freq_cells: popcount(m) === 0 ? null : m });
        }}
        accessibilityLabel={t('survey.editor.frequency.grid', { n })}
      />
      <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-2 dark:text-gray-400">
        {t('survey.editor.frequency.cells', { k: popcount(mask), cells })}
      </Text>
      <ProblemLines problems={problems} />
    </View>
  );
}
