/**
 * The 頻度 tab of a plot-style survey (2G-d3), the fixed plot's frequency tab
 * (src/components/quadrat/PlotFreqTab.tsx) over the template's Frequency
 * component: one grid per occurrence of the unit picked (the species tab's
 * scope, switched here too), entered with FrequencyPanel — brush, cell by
 * cell, or counts when the template keeps counts. The template fixes the
 * grid size, its top edge and the method, so only that method's inputs are offered.
 *
 * 「＋ 新物種」 adds the species to the unit picked (its layer asked when the
 * template has layers), with no dominance: that is entered on the 物種 tab,
 * and both tabs flag it until then (plotFreqIssueLines), as on the fixed plot.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import type { FrequencyGridHandle } from '~/components/quadrat/FrequencyGrid';
import { FrequencyPanel, type FreqItem } from '~/components/quadrat/FrequencyPanel';
import { topEdgeName } from '~/components/quadrat/names';
import { layerName, plotFreqIssueLines } from '~/components/quadrat/plotFreqIssueLines';
import { getActiveLayers, layerLabel, type FixedLayer, type PlotSpeciesRecordWithTaxon } from '~/db';
import type { AdoptionInput } from '~/db/taxonLookup';
import type { SearchResult } from '~/db/types';
import { kindForType } from '~/lib/dwcAbundanceCore';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useSettledCall } from '~/lib/useSettledCall';
import { useToast } from '~/stores/toast';
import { addOccurrence, writeComponent } from '~/survey/db/surveys';
import type { ComponentInstance } from '~/survey/template/types';
import { layerCountOf } from './checks';
import { formComponents } from './occurrenceForm';
import { formErrorText } from './text';
import { UnitScopeButton } from './UnitScopeButton';
import type { OccurrenceView, SurveyForm } from './useSurveyForm';
import type { UnitPick } from './viewState';

/** A cover only when the occurrence's quantity is a percentage (the fixed plot's rule). */
const coverOf = (o: OccurrenceView): number | null => {
  if (kindForType(o.organism_quantity_type) !== 'percent' || o.organism_quantity == null) return null;
  const v = Number(o.organism_quantity);
  return Number.isFinite(v) ? v : null;
};

export function PlotSurveyFreqTab({
  data,
  edit,
  freq,
  scope,
  onScope,
  onChanged,
  onGoSpecies,
}: {
  data: SurveyForm;
  edit: RecordEditing;
  /** The template's Frequency component on its occurrences. */
  freq: ComponentInstance;
  scope: UnitPick;
  onScope: (next: UnitPick) => void;
  onChanged: () => void;
  /** To the 物種 tab, where a new species gets its dominance. */
  onGoSpecies: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const { survey, template } = data;
  const [layer, setLayer] = useState<string | null>(null);
  const grid = useRef<FrequencyGridHandle>(null);
  // Strokes are written at once and patched in here; the screen's reload (and its undo step) waits until painting pauses.
  const [patched, setPatched] = useState<ReadonlyMap<number, { freq_cells?: string | null; freq_count?: number | null }>>(new Map());
  const settled = useSettledCall(() => {
    setPatched(new Map());
    onChanged();
  });
  const n = Number(freq.params.n) || 10;
  const mode: 'cells' | 'count' = freq.params.mode === 'count' ? 'count' : 'cells';
  const stratified = formComponents(template, 'occurrence').some((x) => x.type === 'structure');
  const scopeId = typeof scope === 'number' ? scope : null;
  const rows = data.occurrences
    .filter((o) => !o.via_interaction && (o.unit_id ?? null) === scopeId)
    .map((o) => ({ ...o, ...patched.get(o.id) }));
  const items: FreqItem[] = rows.map((o) => ({
    key: `o${o.id}`,
    taxon_id: o.taxon_id,
    name: o.common_name_c || o.simple_name || o.taxon_id,
    cname: o.common_name_c || null,
    sci: o.simple_name || null,
    qualifier: o.verbatim_identification,
    layer: o.layer ? layerName(o.layer) : null,
    cover: coverOf(o),
    freq_cells: o.freq_cells,
    freq_count: o.freq_count,
  }));
  const idOf = (key: string) => Number(key.slice(1));
  const owner = (id: number) => ({ kind: 'occurrence' as const, id });

  const writeFreq = (id: number, patch: { freq_cells?: string | null; freq_count?: number | null }) => {
    if (edit.refuse()) return;
    try {
      writeComponent(owner(id), freq.key, patch);
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    setPatched((m) => new Map(m).set(id, { ...m.get(id), ...patch }));
    settled.schedule();
  };
  const layers = [...new Set(items.map((i) => i.layer).filter((l): l is string => !!l))];
  // The fixed plot's dominance ⇄ frequency rule; its rows carry the same fields an occurrence has.
  const issues = plotFreqIssueLines(t, rows as unknown as PlotSpeciesRecordWithTaxon[], mode);

  /** Into the unit picked: its layer first when the template has layers. */
  const add = async (r: SearchResult, adopted?: AdoptionInput | null): Promise<string | null> => {
    if (edit.refuse() || !r.taxon_id) return null;
    const name = r.cname || r.name;
    let code: FixedLayer | null = null;
    Keyboard.dismiss();
    if (stratified) {
      const active = getActiveLayers(layerCountOf(template, data.surveyValues) ?? 4);
      code = active.find((l) => layerName(l) === layer) ?? (active.length === 1 ? active[0] : null);
      if (!code) {
        const i = await showActionSheet({ title: t('plot.quadrats.pickLayer', { name }), options: active.map((l) => ({ label: layerLabel(l) })) });
        if (i < 0) return null;
        code = active[i];
      }
    }
    // Already in this unit and layer: paint that one instead of a second.
    const same = rows.find((x) => x.taxon_id === r.taxon_id && (x.layer ?? null) === code && !x.verbatim_identification);
    if (same) return `o${same.id}`;
    settled.flush();
    let id = 0;
    try {
      id = addOccurrence(survey.id, {
        taxon_id: r.taxon_id,
        unit_id: scopeId,
        layer: code,
        ...(adopted ? { used_name_id: adopted.name_id ?? null, used_scientific_name: adopted.scientific_name } : {}),
      });
    } catch (e) {
      toast(formErrorText(t, e));
      return null;
    }
    onChanged();
    toast(t('plot.quadrats.addedNoDom', { name, layer: code ? layerName(code) : '' }), { action: { label: t('plot.quadrats.goDom'), onPress: onGoSpecies } });
    return `o${id}`;
  };

  return (
    <View className="flex-1">
      {data.units.length ? (
        <View className="flex-row items-center border-b border-gray-100 bg-card py-2 dark:border-gray-800 dark:bg-gray-900">
          <UnitScopeButton data={data} scope={scope} onScope={onScope} />
        </View>
      ) : null}
      {!items.length && edit.locked ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-gray-500 dark:text-gray-400">{t('plot.quadrats.noPlotSpecies')}</Text>
        </View>
      ) : (
        <FrequencyPanel
          key={`${n}:${mode}:${scopeId ?? 'none'}`}
          items={items}
          n={n}
          storedMode={mode}
          topEdgeLabel={`▲ ${t('plot.quadrats.topEdgeLabel', { edge: topEdgeName(t, String(freq.params.top_edge ?? 'N')) })}`}
          ro={edit.locked}
          layer={layer}
          onFilter={
            layers.length > 1
              ? async () => {
                  const opts: (string | null)[] = [null, ...layers];
                  const i = await showActionSheet({
                    title: t('plot.quadrats.filter'),
                    options: opts.map((l) => ({
                      label: t('plot.quadrats.filterLayer', { layer: l ?? t('plot.quadrats.all'), n: l ? items.filter((x) => x.layer === l).length : items.length }),
                      selected: layer === l,
                    })),
                  });
                  if (i >= 0) setLayer(opts[i]);
                }
              : undefined
          }
          refused={edit.refuse}
          onMask={(key, mask) => writeFreq(idOf(key), { freq_cells: mask })}
          onCount={(key, v) => writeFreq(idOf(key), { freq_count: v })}
          onAdd={add}
          emptyHint={t('plot.quadrats.noPlotSpeciesAdd')}
          issues={issues.length ? { title: t('plot.quadrats.domFreqTitle'), lines: issues } : null}
          gridRef={grid}
        />
      )}
    </View>
  );
}
