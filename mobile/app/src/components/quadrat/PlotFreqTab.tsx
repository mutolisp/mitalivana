/**
 * The fixed plot's 「頻度」 tab (v78, user decision 2026-09-29): the whole
 * plot is one grid, and its species are the plot list's records — one grid
 * per record, so a taxon in two layers has two. Same entry as a quadrat's
 * and GLORIA's frequency (FrequencyPanel). Cover stays on the 物種 tab; a
 * record's cover counts here only when it was recorded as a percentage.
 *
 * 「＋ 新物種」 adds the species to the plot list (layer, and subplot when
 * the plot has them, asked for), with no dominance: that is entered on the
 * 物種 tab, and until then both tabs flag it (plotFreqIssueLines).
 *
 * No lock of its own: the plot's end / lock covers it (useRecordEditing).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import {
  addPlotSpecies,
  getActiveLayers,
  layerLabel,
  listPlotSpecies,
  listSubplots,
  type FixedLayer,
  type PlotSpeciesRecordWithTaxon,
  type PlotSurvey,
} from '~/db/plots';
import { parseQuadratConfig, QuadratError, setPlotSpeciesFreq, switchPlotFreqMode } from '~/db/quadrats';
import type { AdoptionInput } from '~/db/taxonLookup';
import type { SearchResult } from '~/db/types';
import { kindForType } from '~/lib/dwcAbundanceCore';
import { useSettledCall } from '~/lib/useSettledCall';
import { useToast } from '~/stores/toast';
import type { FrequencyGridHandle } from './FrequencyGrid';
import { FrequencyPanel, type FreqItem } from './FrequencyPanel';
import { topEdgeName } from './names';
import { layerName, plotFreqIssueLines } from './plotFreqIssueLines';

/** A cover only when the record's quantity is a percentage. The stored type
 *  is the DwC string ('% cover'), not the input kind: ask kindForType. */
const coverOf = (r: PlotSpeciesRecordWithTaxon): number | null => {
  if (kindForType(r.organism_quantity_type) !== 'percent' || r.organism_quantity == null) return null;
  const v = Number(r.organism_quantity);
  return Number.isFinite(v) ? v : null;
};

export function PlotFreqTab({
  plot,
  locked,
  refuse,
  onChanged,
  onGoSpecies,
}: {
  plot: PlotSurvey;
  locked: boolean;
  refuse: () => boolean;
  onChanged: () => void;
  /** To the 物種 tab, where a new species gets its dominance. */
  onGoSpecies: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [records, setRecords] = useState<PlotSpeciesRecordWithTaxon[]>([]);
  const [layer, setLayer] = useState<string | null>(null);
  const grid = useRef<FrequencyGridHandle>(null);
  const load = useCallback(() => setRecords(listPlotSpecies(plot.id)), [plot.id]);
  useFocusEffect(load);

  // From the plot row, not a DB read: the React Compiler would keep a read
  // keyed on the id alone, and the plot is re-read after every change.
  const cfg = parseQuadratConfig(plot.quadrat_config);
  const rows = records.filter((r) => r.layer !== 'T');
  const items: FreqItem[] = rows.map((r) => ({
    key: `r${r.id}`,
    taxon_id: r.taxon_id,
    name: r.common_name_c || r.simple_name || r.taxon_id,
    cname: r.common_name_c || null,
    sci: r.simple_name || null,
    qualifier: r.verbatim_identification,
    layer: layerName(r.layer),
    cover: coverOf(r),
    freq_cells: r.freq_cells,
    freq_count: r.freq_count,
  }));
  const idOf = (key: string) => Number(key.slice(1));
  // Strokes and counts: the row is written at once and patched into the list
  // here; the plot screen's reload (and its undo snapshot) waits until the
  // painting pauses — reloading after every tap made the brush lag.
  const settled = useSettledCall(onChanged);
  const writeFreq = (id: number, patch: { freq_cells?: string | null; freq_count?: number | null }) => {
    if (refuse()) return;
    try {
      setPlotSpeciesFreq(id, patch);
    } catch (e) {
      if (!(e instanceof QuadratError)) throw e;
      toast(t('plot.quadrats.gridLockedHint'));
      return;
    }
    setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    settled.schedule();
  };
  const write = (fn: () => void) => {
    if (refuse()) return false;
    settled.flush();
    try {
      fn();
    } catch (e) {
      if (!(e instanceof QuadratError)) throw e;
      toast(t('plot.quadrats.gridLockedHint'));
      return false;
    }
    load();
    onChanged();
    return true;
  };
  const layers = [...new Set(items.map((i) => i.layer).filter((l): l is string => !!l))];
  const issues = plotFreqIssueLines(t, rows, cfg.freqMode);

  /** Into the plot list: the layer (the filtered one, if any), then the subplot. */
  const add = async (r: SearchResult, adopted?: AdoptionInput | null): Promise<string | null> => {
    if (refuse()) return null;
    const name = r.cname || r.name;
    const active = getActiveLayers(plot.layer_count);
    let code: FixedLayer | undefined = active.find((l) => layerName(l) === layer) ?? (active.length === 1 ? active[0] : undefined);
    Keyboard.dismiss();
    if (!code) {
      const i = await showActionSheet({ title: t('plot.quadrats.pickLayer', { name }), options: active.map((l) => ({ label: layerLabel(l) })) });
      if (i < 0) return null;
      code = active[i];
    }
    const subs = listSubplots(plot.id);
    let subplot: number | null = null;
    if (subs.length) {
      const i = await showActionSheet({ title: t('plot.quadrats.pickSubplot', { name }), options: subs.map((s) => ({ label: s.label })) });
      if (i < 0) return null;
      subplot = subs[i].id;
    }
    // Already on the list there: paint that record instead of a second one.
    const same = records.find((x) => x.taxon_id === r.taxon_id && x.layer === code && (x.subplot_id ?? null) === subplot);
    if (same) return `r${same.id}`;
    let id = 0;
    const layerCode = code;
    if (!write(() => void (id = addPlotSpecies({ plot_survey_id: plot.id, taxon_id: r.taxon_id, layer: layerCode, subplot_id: subplot, adopted })))) return null;
    toast(t('plot.quadrats.addedNoDom', { name, layer: layerName(layerCode) }), {
      action: { label: t('plot.quadrats.goDom'), onPress: onGoSpecies },
    });
    return `r${id}`;
  };

  if (!items.length && locked) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">{t('plot.quadrats.noPlotSpecies')}</Text>
      </View>
    );
  }
  return (
    <FrequencyPanel
      key={`${cfg.freqGridN}:${cfg.freqMode}`}
      items={items}
      n={cfg.freqGridN}
      storedMode={cfg.freqMode}
      topEdgeLabel={`▲ ${t('plot.quadrats.topEdgeLabel', { edge: topEdgeName(t, cfg.freqTopEdge) })}`}
      ro={locked}
      layer={layer}
      onFilter={
        layers.length > 1
          ? async () => {
              const opts: (string | null)[] = [null, ...layers];
              const i = await showActionSheet({
                title: t('plot.quadrats.filter'),
                options: opts.map((l) => ({
                  label: `${layer === l ? '✓ ' : ''}${t('plot.quadrats.filterLayer', {
                    layer: l ?? t('plot.quadrats.all'),
                    n: l ? items.filter((x) => x.layer === l).length : items.length,
                  })}`,
                })),
              });
              if (i >= 0) setLayer(opts[i]);
            }
          : undefined
      }
      refused={refuse}
      onMask={(key, mask) => writeFreq(idOf(key), { freq_cells: mask })}
      onCount={(key, v) => writeFreq(idOf(key), { freq_count: v })}
      onSwitchMode={(toCount) => write(() => switchPlotFreqMode(plot.id, toCount ? 'count' : 'cells'))}
      onAdd={add}
      emptyHint={t('plot.quadrats.noPlotSpeciesAdd')}
      issues={issues.length ? { title: t('plot.quadrats.domFreqTitle'), lines: issues } : null}
      gridRef={grid}
    />
  );
}
