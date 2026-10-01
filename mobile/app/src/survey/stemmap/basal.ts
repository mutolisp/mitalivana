/**
 * Basal area of a tree's stems and the circle drawn for it on the stem map:
 * circle AREA ∝ basal area, so the radius is ∝ the equivalent diameter
 * √(Σ d²). Areas come from the shared basalArea() (cm²), as the plot screens'.
 *
 * Pure: check:stemmap runs it under Node.
 */
import { basalArea } from '../../lib/dwcAbundanceCore';

/** Basal area (cm²) of the live stems that have a diameter. */
export function treeBasalAreaCm2(stemDbhCm: readonly (number | null)[]): number {
  return basalArea(stemDbhCm.filter((d): d is number => d != null && d > 0));
}

/** Diameter (cm) of one stem with the same basal area as all of them. */
export function equivalentDbhCm(stemDbhCm: readonly (number | null)[]): number {
  return Math.sqrt(stemDbhCm.reduce<number>((s, d) => (d != null && d > 0 ? s + d * d : s), 0));
}

/** Map radius in plot metres; `cmPerMetre` sets the exaggeration (a 10 cm
 *  tree drawn 1:1 would be a 5 cm dot), `minM` keeps saplings visible. */
export function circleRadiusM(stemDbhCm: readonly (number | null)[], cmPerMetre = 25, minM = 0.15): number {
  return Math.max(minM, equivalentDbhCm(stemDbhCm) / cmPerMetre);
}
