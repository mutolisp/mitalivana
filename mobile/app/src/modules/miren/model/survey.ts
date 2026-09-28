/**
 * Which plots a new MIREN survey starts with, and what is carried from the
 * previous survey of the same route — pure.
 *
 * Carried: where each plot was actually laid out (lat / lon / elev) and
 * whether it lies in a protected area. Never species, covers or abundances:
 * resurveys are recorded blind (Road protocol §2.5.3, p. 5).
 *
 * A relocated site (suffix `a`, §2.5.3) replaces the original from then on;
 * it is a new place, so nothing is carried to it (matched by site id).
 * Trail plot 1, the optional 2×50 m plot, starts as not sampled unless the
 * previous survey sampled it, so a region that does it keeps doing it.
 */

import type { RouteKind } from './codes';
import { PLOT_NUMBERS } from './codes';

export type SiteRef = { id: number; site_no: number; suffix: '' | 'a' };
export type PrevPlot = {
  site_id: number;
  plot_no: number;
  sampled: number;
  lat: number | null;
  lon: number | null;
  elev: number | null;
  protected_area: number | null;
};

export type NewPlot = {
  site_id: number;
  plot_no: number;
  sampled: 0 | 1;
  lat: number | null;
  lon: number | null;
  elev: number | null;
  protected_area: number | null;
};

/** The site in use for each site number: the relocated one when there is one. */
export function currentSites(sites: readonly SiteRef[]): SiteRef[] {
  const byNo = new Map<number, SiteRef>();
  for (const s of sites) {
    const have = byNo.get(s.site_no);
    if (!have || s.suffix === 'a') byNo.set(s.site_no, s);
  }
  return [...byNo.values()].sort((a, b) => a.site_no - b.site_no);
}

export function planSurveyPlots(kind: RouteKind, sites: readonly SiteRef[], prev: readonly PrevPlot[]): NewPlot[] {
  const prevOf = new Map(prev.map((p) => [`${p.site_id}.${p.plot_no}`, p]));
  const out: NewPlot[] = [];
  for (const site of currentSites(sites)) {
    for (const plot_no of PLOT_NUMBERS[kind]) {
      const p = prevOf.get(`${site.id}.${plot_no}`);
      const optional = kind === 'trail' && plot_no === 1;
      out.push({
        site_id: site.id,
        plot_no,
        sampled: optional ? (p?.sampled ? 1 : 0) : 1,
        lat: p?.lat ?? null,
        lon: p?.lon ?? null,
        elev: p?.elev ?? null,
        protected_area: p?.protected_area ?? null,
      });
    }
  }
  return out;
}

export type PlotState = 'skip' | 'todo' | 'blind' | 'recheck' | 'done';

/** A plot's place in the blind → recheck → done sequence, for the overview. */
export function plotState(p: {
  sampled: number;
  start_ts: number | null;
  species_count: number;
  blind_closed_at: number | null;
  compared_at: number | null;
}): PlotState {
  if (!p.sampled) return 'skip';
  if (p.compared_at != null) return 'done';
  if (p.blind_closed_at != null) return 'recheck';
  if (p.start_ts != null || p.species_count > 0) return 'blind';
  return 'todo';
}

/** The next plot to work on, in site order (low → high unless `descending`),
 *  plot order within a site: the first one sampled and not done. */
export function nextPlot<T extends Parameters<typeof plotState>[0] & { site_no: number; plot_no: number }>(
  plots: readonly T[],
  descending = false,
): T | null {
  const order = [...plots].sort((a, b) => (descending ? b.site_no - a.site_no : a.site_no - b.site_no) || a.plot_no - b.plot_no);
  return order.find((p) => {
    const s = plotState(p);
    return s !== 'skip' && s !== 'done';
  }) ?? null;
}
