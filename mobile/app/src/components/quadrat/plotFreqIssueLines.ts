/**
 * The fixed plot's dominance ⇄ frequency mismatches as banner lines, shown on
 * both the 「頻度」 and the 「物種」 tab (lib/quadratIssues.plotFreqIssues).
 */
import type { TFunction } from 'i18next';
import { layerLabel, type PlotSpeciesRecordWithTaxon } from '~/db/plots';
import { plotFreqIssues } from '~/lib/quadratIssues';
import { compactSpeciesLabel } from '~/lib/speciesLabel';

/** "E3 草本層" → "草本層": a tag or a parenthesis has no room for the code. */
export const layerName = (l: string) => layerLabel(l as never).replace(/^E\d\s*/, '');

export const recordLabel = (r: PlotSpeciesRecordWithTaxon) =>
  compactSpeciesLabel({ cname: r.common_name_c || null, sci: r.simple_name || null, qualifier: r.verbatim_identification, fallback: r.taxon_id });

export function plotFreqIssueLines(t: TFunction, records: readonly PlotSpeciesRecordWithTaxon[], mode: 'cells' | 'count'): string[] {
  const { domNoFreq, freqNoDom } = plotFreqIssues(records, mode);
  const names = (rs: PlotSpeciesRecordWithTaxon[]) => rs.map((r) => `${recordLabel(r)}（${layerName(r.layer)}）`).join('、');
  return [
    domNoFreq.length ? t('plot.quadrats.domNoFreq', { names: names(domNoFreq) }) : null,
    freqNoDom.length ? t('plot.quadrats.freqNoDom', { names: names(freqNoDom) }) : null,
  ].filter((l): l is string => l != null);
}
