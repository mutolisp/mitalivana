/**
 * MIREN recording scales — stored as the class number, never as a converted
 * percentage. Which scale a plot uses follows from the route kind and the
 * plot number (`plotMeasures`), so it is not stored.
 *
 * Range labels are written as the sources write them:
 *   road cover   Road protocol §2.5.2.2, p. 5 (with the indicative max. area)
 *   trail cover  Trail protocol (4) 3, p. 6
 *   abundance    Road §2.5.2, p. 4 (1–3); Trail (4) 2, p. 6 adds 0 = absent
 *
 * Liedtke et al. 2020 (p. 1125) writes the trail classes' bounds differently
 * (1 = 0–1 %, 2 = 2–5 %, 3 = 6–25 % …); same classes, so the stored numbers
 * are unaffected. The trail protocol's wording is the one shown.
 */

import type { RouteKind } from './codes';

export type ScaleClass = { value: number; label: string; area?: string };

export const ROAD_COVER: readonly ScaleClass[] = [
  { value: 1, label: '<0.1', area: '0.1 × 1' },
  { value: 2, label: '0.1–1', area: '1 × 1' },
  { value: 3, label: '2–5', area: '1 × 5' },
  { value: 4, label: '6–10', area: '1 × 10' },
  { value: 5, label: '11–25', area: '1 × 25' },
  { value: 6, label: '26–50', area: '1 × 50' },
  { value: 7, label: '51–75', area: '1.5 × 50' },
  { value: 8, label: '76–100', area: '2 × 50' },
];

/** Species cover in the 2×10 m trail plots, and the trail plot's
 *  environmental covers ((3) v–aa, p. 6 refer to the same increments). */
export const TRAIL_COVER: readonly ScaleClass[] = [
  { value: 0, label: '0' },
  { value: 1, label: '1' },
  { value: 2, label: '1–5' },
  { value: 3, label: '5–25' },
  { value: 4, label: '25–50' },
  { value: 5, label: '50–75' },
  { value: 6, label: '75–95' },
  { value: 7, label: '95–99' },
  { value: 8, label: '99–100' },
];

export const ROAD_ABUNDANCE: readonly ScaleClass[] = [
  { value: 1, label: '1–10' },
  { value: 2, label: '11–100' },
  { value: 3, label: '>100' },
];

export const TRAIL_ABUNDANCE: readonly ScaleClass[] = [{ value: 0, label: '0' }, ...ROAD_ABUNDANCE];

export type PlotMeasures =
  | { mode: 'cover-abundance'; cover: readonly ScaleClass[]; abundance: readonly ScaleClass[] }
  | { mode: 'presence' };

/**
 * What is recorded per species in a plot. Trail plot 1 is the optional
 * 2×50 m trailside plot: presence only ((4) 1, p. 6); the 2×10 m plots 2–4
 * take cover and abundance ((4) 2–3). Every road plot takes both.
 */
export function plotMeasures(kind: RouteKind, plotNo: number): PlotMeasures {
  if (kind === 'road') return { mode: 'cover-abundance', cover: ROAD_COVER, abundance: ROAD_ABUNDANCE };
  if (plotNo === 1) return { mode: 'presence' };
  return { mode: 'cover-abundance', cover: TRAIL_COVER, abundance: TRAIL_ABUNDANCE };
}

export function inScale(scale: readonly ScaleClass[], value: number | null | undefined): boolean {
  return value != null && scale.some((c) => c.value === value);
}

/** Chip text, e.g. `3 · 2–5%`. Abundance has no unit. */
export function classLabel(c: ScaleClass, unit: '%' | '' = '%'): string {
  return `${c.value} · ${c.label}${unit}`;
}
