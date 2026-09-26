/**
 * GLORIA summit statistics: diversity per unit type, per direction, and the
 * comparison with the previous monitoring cycle. Pure (no RN / DB), so
 * check:gloria-stats runs it in Node.
 *
 * What each unit type contributes as a species' quantity:
 *   - 1×1 m quadrats: cover %, summed over the quadrats selected;
 *   - SAS: the abundance class converted to % (below), summed over the SAS
 *     selected;
 *   - 10×10 m squares: point hits as cover (hits / 4 of 400 points), summed.
 * The indices themselves come from src/lib/diversity.ts (formulas checked
 * against their sources there) — this module only builds the input.
 *
 * Summit species richness is the union of the SAS lists, the GLORIA
 * convention for the whole summit.
 */
import { computeDiversity, type DiversityRecord, type DiversityResult } from '../../../lib/diversity';
import { BB_COVER_PCT } from '../../../lib/vegMatrix';
import { popcount } from './grid';
import type { Direction } from './units';
import { coverFromHits } from './walk';

/**
 * SAS abundance class → Braun-Blanquet class, then % through the app's BB
 * table (BB_COVER_PCT, JUICE manual). A provisional convention set by the
 * user (2026-09-26), NOT from the GLORIA manual: Work Step K defines only d
 * by cover (> 50 %) and says c covers < 50 %; r!, r and s are described in
 * words. Reports print this table with that caveat.
 */
export const GLORIA_TO_BB: Record<string, string> = { d: '4', c: '3', s: '2', r: '1', 'r!': 'r' };

export function sasPercent(abundance: string | null): number | null {
  if (!abundance) return null;
  const bb = GLORIA_TO_BB[abundance];
  return bb != null ? (BB_COVER_PCT[bb] ?? null) : null;
}

export type UnitKind = 'quadrat' | 'sas' | 'square';

/** One species row of one unit, as the statistics need it. */
export type SpeciesFieldRow = {
  unit_code: string;
  unit_type: UnitKind;
  taxon_id: string;
  name: string;
  cover_pct: number | null;
  freq_cells: string | null;
  freq_count: number | null;
  point_hits: string | null;
  legacy_hits: number | null;
  abundance: string | null;
};

export type StatsFilter = {
  /** Directions to include; all four when empty. */
  dirs: Direction[];
};

function inDirs(code: string, dirs: Direction[]): boolean {
  return dirs.length === 0 || dirs.includes(code[0] as Direction);
}

function quantityOf(r: SpeciesFieldRow): number | null {
  if (r.unit_type === 'quadrat') return r.cover_pct;
  if (r.unit_type === 'sas') return sasPercent(r.abundance);
  const hits = r.point_hits != null ? popcount(r.point_hits) : r.legacy_hits;
  return hits != null ? coverFromHits(hits, 400) : null;
}

export function frequencyOf(r: SpeciesFieldRow): number | null {
  if (r.freq_cells != null) return popcount(r.freq_cells);
  return r.freq_count;
}

/**
 * Per species: the summed quantity over the units kept (null when no row had
 * one — the species still counts toward richness), and the name.
 */
export function abundanceVector(
  rows: SpeciesFieldRow[],
  type: UnitKind,
  filter: StatsFilter,
): Map<string, { name: string; value: number | null }> {
  const out = new Map<string, { name: string; value: number | null }>();
  for (const r of rows) {
    if (r.unit_type !== type || !inDirs(r.unit_code, filter.dirs)) continue;
    const q = quantityOf(r);
    const cur = out.get(r.taxon_id) ?? { name: r.name, value: null };
    if (q != null) cur.value = (cur.value ?? 0) + q;
    out.set(r.taxon_id, cur);
  }
  return out;
}

export type TypeStats = DiversityResult & {
  /** Species listed without a usable quantity (counted in richness only). */
  unquantified: number;
  /** Units of this type with at least one species, among those selected. */
  units: number;
};

export function typeStats(rows: SpeciesFieldRow[], type: UnitKind, filter: StatsFilter): TypeStats {
  const vec = abundanceVector(rows, type, filter);
  // One record per species carrying the summed %: diversity.ts reads a
  // species' percent records as their maximum, so the sum is passed in whole.
  const records: DiversityRecord[] = [...vec].map(([taxon_id, v]) => ({
    taxon_id,
    organism_quantity: v.value != null ? String(v.value) : null,
    organism_quantity_type: '% cover',
  }));
  const units = new Set(rows.filter((r) => r.unit_type === type && inDirs(r.unit_code, filter.dirs)).map((r) => r.unit_code));
  return {
    ...computeDiversity(records),
    unquantified: [...vec.values()].filter((v) => v.value == null).length,
    units: units.size,
  };
}

/** Summit richness: the species of the SAS kept (all eight by default). */
export function summitSpecies(rows: SpeciesFieldRow[], filter: StatsFilter): Set<string> {
  return new Set(rows.filter((r) => r.unit_type === 'sas' && inDirs(r.unit_code, filter.dirs)).map((r) => r.taxon_id));
}

export type SpeciesChange = {
  taxon_id: string;
  name: string;
  before: number | null;
  after: number | null;
  delta: number;
};

export type SurveyComparison = {
  /** Species of the chosen type(s) new this cycle / not recorded this cycle. */
  gained: Array<{ taxon_id: string; name: string }>;
  lost: Array<{ taxon_id: string; name: string }>;
  /** 1×1 m, per species: summed cover and summed frequency, before → after. */
  cover: SpeciesChange[];
  frequency: SpeciesChange[];
};

function namesOf(rows: SpeciesFieldRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.taxon_id, r.name]));
}

/**
 * This cycle against the previous one, species matched by taxon_id.
 * `types` decides which lists define gained / lost: SAS alone is the summit
 * list; several types are pooled.
 */
export function compareSurveys(
  cur: SpeciesFieldRow[],
  prev: SpeciesFieldRow[],
  types: UnitKind[],
  filter: StatsFilter,
): SurveyComparison {
  const pick = (rows: SpeciesFieldRow[]) =>
    new Set(rows.filter((r) => types.includes(r.unit_type) && inDirs(r.unit_code, filter.dirs)).map((r) => r.taxon_id));
  const a = pick(prev);
  const b = pick(cur);
  const names = new Map([...namesOf(prev), ...namesOf(cur)]);
  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
  const gained = [...b].filter((id) => !a.has(id)).map((id) => ({ taxon_id: id, name: names.get(id) ?? id })).sort(byName);
  const lost = [...a].filter((id) => !b.has(id)).map((id) => ({ taxon_id: id, name: names.get(id) ?? id })).sort(byName);

  const sums = (rows: SpeciesFieldRow[], value: (r: SpeciesFieldRow) => number | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (r.unit_type !== 'quadrat' || !inDirs(r.unit_code, filter.dirs)) continue;
      const v = value(r);
      if (v != null) m.set(r.taxon_id, (m.get(r.taxon_id) ?? 0) + v);
    }
    return m;
  };
  const changes = (before: Map<string, number>, after: Map<string, number>): SpeciesChange[] =>
    [...new Set([...before.keys(), ...after.keys()])]
      .map((id) => {
        const x = before.get(id) ?? null;
        const y = after.get(id) ?? null;
        return { taxon_id: id, name: names.get(id) ?? id, before: x, after: y, delta: (y ?? 0) - (x ?? 0) };
      })
      .filter((c) => c.delta !== 0)
      .sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || p.name.localeCompare(q.name));

  return {
    gained,
    lost,
    cover: changes(
      sums(prev, (r) => r.cover_pct),
      sums(cur, (r) => r.cover_pct),
    ),
    frequency: changes(sums(prev, frequencyOf), sums(cur, frequencyOf)),
  };
}

/**
 * Whether the previous cycle may be shown at all: only once this survey is
 * finished. During a resurvey nothing from before is shown (manual Box 4.5,
 * "blind"); the check is made when the report is built, since a survey can be
 * reopened.
 */
export function comparisonAllowed(status: string): boolean {
  return status === 'done';
}
