/**
 * MIREN consistency rules — pure. Every rule only warns; nothing blocks
 * saving, closing blind recording or finishing a plot.
 *
 * Rules and their sources:
 *   missing-location   Road §2.5.1, p. 4: WGS 84 decimal degrees and elevation
 *   missing-date / missing-observers
 *                      Road §2.5, p. 4: "All data sheets must include date of
 *                      survey and names of recorders"
 *   percent-range      tree cover, bare ground, litter are percentages
 *                      (§2.5.2, p. 4; stored as % by project decision)
 *   additional-data    §2.5.2, p. 4: "text (up to 50 characters) with words
 *                      separated by an underscore"
 *   species-incomplete a cover-and-abundance plot needs both per species
 *   priority-plot      §2.4, p. 2: when not all three can be done, plots 1
 *                      and 3 come first (road only)
 */

import type { RouteKind } from './codes';
import { inScale, plotMeasures } from './scales';

export type PlotInput = {
  plotNo: number;
  sampled: boolean;
  lat: number | null;
  lon: number | null;
  elev: number | null;
  date: string | null;
  observers: string | null;
  treeCoverPct: number | null;
  bareGroundPct: number | null;
  litterPct: number | null;
  additionalData: string | null;
};

export type SpeciesInput = { coverClass: number | null; abundanceClass: number | null };

export type Issue =
  | { kind: 'missing-location' }
  | { kind: 'missing-date' }
  | { kind: 'missing-observers' }
  | { kind: 'percent-range'; field: 'treeCoverPct' | 'bareGroundPct' | 'litterPct' }
  | { kind: 'additional-data' }
  | { kind: 'species-incomplete'; index: number }
  | { kind: 'priority-plot'; plotNo: number };

export const ADDITIONAL_DATA_MAX = 50;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function additionalDataOk(s: string | null | undefined): boolean {
  if (!s) return true;
  return s.length <= ADDITIONAL_DATA_MAX && !/\s/.test(s);
}

export function checkPlot(kind: RouteKind, plot: PlotInput, species: readonly SpeciesInput[]): Issue[] {
  if (!plot.sampled) return [];
  const issues: Issue[] = [];
  if (plot.lat == null || plot.lon == null || plot.elev == null) issues.push({ kind: 'missing-location' });
  if (!plot.date || !ISO_DATE.test(plot.date)) issues.push({ kind: 'missing-date' });
  if (!plot.observers?.trim()) issues.push({ kind: 'missing-observers' });
  for (const field of ['treeCoverPct', 'bareGroundPct', 'litterPct'] as const) {
    const v = plot[field];
    if (v != null && (v < 0 || v > 100)) issues.push({ kind: 'percent-range', field });
  }
  if (!additionalDataOk(plot.additionalData)) issues.push({ kind: 'additional-data' });
  const m = plotMeasures(kind, plot.plotNo);
  if (m.mode === 'cover-abundance') {
    species.forEach((s, index) => {
      if (!inScale(m.cover, s.coverClass) || !inScale(m.abundance, s.abundanceClass)) {
        issues.push({ kind: 'species-incomplete', index });
      }
    });
  }
  return issues;
}

/** Road plots 1 and 3 not done at a site where anything was done. */
export function checkSitePriority(kind: RouteKind, sampledPlots: readonly number[]): Issue[] {
  if (kind !== 'road' || sampledPlots.length === 0) return [];
  return [1, 3].filter((n) => !sampledPlots.includes(n)).map((plotNo) => ({ kind: 'priority-plot' as const, plotNo }));
}
