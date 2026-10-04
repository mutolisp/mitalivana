/**
 * A plot-style survey drawn with the fixed plot's screen (2G-d): its Structure
 * values as the fixed plot's layer rows, and the code of the next subplot the
 * 小區 count adds (or quadrat the 小樣方 tab adds).
 *
 * Pure: check:survey-core runs it under Node.
 */
import type { ComponentValues } from '../registry';

export type LayerRow = {
  layer_index: number;
  cover_pct: number | null;
  height_cm: number | null;
  height_unit: 'cm' | 'm' | null;
  method: 'BB' | 'percent' | 'DBH' | null;
};

const at = (v: unknown, idx: number): unknown => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<number, unknown>)[idx] : undefined);
const num = (x: unknown) => (typeof x === 'number' ? x : null);

/** Layers 1…count of a Structure component's per-layer values (cover, height in cm, height unit, default method). */
export function layerRows(v: ComponentValues, count: number): LayerRow[] {
  return Array.from({ length: count }, (_, i) => {
    const idx = i + 1;
    const unit = at(v.height_unit, idx);
    const method = at(v.method, idx);
    return {
      layer_index: idx,
      cover_pct: num(at(v.cover_pct, idx)),
      height_cm: num(at(v.height_cm, idx)),
      height_unit: unit === 'cm' || unit === 'm' ? unit : null,
      method: method === 'BB' || method === 'percent' || method === 'DBH' ? method : null,
    };
  });
}

/** The cm / m a survey's Structure gives each layer (the heights a unit's layers show in, as the fixed plot's subplots). */
export function layerHeightUnit(surveyStructure: ComponentValues | undefined): (layerIdx: number) => 'cm' | 'm' {
  const units = surveyStructure?.height_unit;
  return (idx) => (at(units, idx) === 'm' ? 'm' : 'cm');
}

/** S1, S2 … as the fixed plot numbers its subplots (Q1, Q2 … its quadrats): the first free one. */
export function nextUnitCode(taken: readonly string[], prefix = 'S'): string {
  const used = new Set(taken);
  let k = 1;
  while (used.has(`${prefix}${k}`)) k++;
  return `${prefix}${k}`;
}
