/**
 * GLORIA consistency rules — pure. Every rule only warns; nothing blocks
 * saving or ending a survey (field conditions come first).
 *
 * Rules and their sources (Pauli et al. 2015):
 *   top-cover-sum        p.40  "the sum of the top cover values of all present
 *                              surface types adds up to 100%"
 *   vascular-exceeds-species
 *                        p.41  "The total cover sum of all vascular plant species
 *                              may exceed but should not fall below the top cover
 *                              estimated for vascular plants" (sheet 11_
 *                              check_totalCoverCorrect)
 *   subtype-range        p.40  subtypes are "a percentage of the respective
 *                              surface type cover"
 *   cover-no-freq / freq-no-cover
 *                        cross-check of the two 1×1 m methods on the same
 *                        species list (project rule, not in the manual)
 *   sas-missing          p.42  upper SAS lists "must also contain all species
 *                              found in the quadrats that lie within this section"
 *   point-inconsistent   p.41 / p.58  a surface is recorded only where no
 *                              vascular plant was hit
 *   p5m                  Form 1 note 5: exactly one of 11 / 31 per direction
 *   required             project rule (2026-09-27): the fields the team
 *                        must fill on a unit once it is started — see
 *                        missingRequired
 */

import { DIRECTIONS, quadratsOf, upperSasOf } from './units';
import type { Direction, P5mCorner } from './units';
import { SURFACE_UNVISITED, SURFACE_VASCULAR, popcount } from './grid';

export type TopCover = {
  vascular: number | null;
  solidRock: number | null;
  scree: number | null;
  lichens: number | null;
  bryophytes: number | null;
  bareGround: number | null;
  litter: number | null;
};

export type UnitSpecies = {
  /** Stable key of the survey roster entry. */
  key: string;
  name: string;
  cover_pct: number | null;
  freq_cells: string | null;
  /** Count-only frequency (cells not recorded), 0–100. */
  freq_count?: number | null;
  point_hits: string | null;
};

/** Cells occupied: from the cell mask when there is one, else the count-only value. */
export function freqOf(s: { freq_cells: string | null; freq_count?: number | null }): number {
  return s.freq_cells != null ? popcount(s.freq_cells) : (s.freq_count ?? 0);
}

export type QuadratInput = {
  code: string;
  top: TopCover;
  subtypes: Array<number | null>;
  species: UnitSpecies[];
  /** Frequency was done for this quadrat (any grazing mask or species mask set). */
  freqDone: boolean;
  point_surface: string | null;
};

export type SasInput = { code: string; top: TopCover; species: UnitSpecies[] };
export type SquareInput = { code: string; species: UnitSpecies[]; point_surface: string | null };

export type Issue =
  | { unit: string; kind: 'top-cover-sum'; sum: number }
  | { unit: string; kind: 'vascular-exceeds-species'; vascular: number; speciesSum: number }
  | { unit: string; kind: 'subtype-range'; index: number; value: number }
  | { unit: string; kind: 'cover-no-freq'; species: string; cover: number }
  | { unit: string; kind: 'freq-no-cover'; species: string; cells: number }
  | { unit: string; kind: 'sas-missing'; species: string[] }
  | { unit: string; kind: 'point-inconsistent'; points: number[] }
  | { unit: string; kind: 'p5m'; direction: Direction }
  | { unit: string; kind: 'required'; fields: RequiredField[]; species: string[] };

/** Required fields of a unit, in screen order. */
export type RequiredField =
  | 'researchers'
  | 'aspect'
  | 'slope'
  | 'time'
  | 'freqTime'
  | 'topCover'
  | 'subtypes'
  | 'method';

/**
 * What a started 1×1 m quadrat or SAS must have (project rule). Both: the
 * researchers (the unit's or the survey's), a start with a time and an end,
 * all seven top covers, every species' value (quadrat: cover; SAS:
 * abundance). A quadrat also: aspect, slope, all six subtypes, and frequency
 * or point-framing — unless skipped for shrubs, which drops both and their
 * times. Frequency times are asked for when frequency was done;
 * point-framing times never (the sheet has no column for them).
 */
export type RequiredInput = {
  code: string;
  type: 'quadrat' | 'sas';
  researchers: string | null;
  start_ts: number | null;
  stop_ts: number | null;
  date_only: number | null;
  top: TopCover;
  species: Array<{ name: string; value: number | string | null }>;
  aspect_deg?: number | null;
  slope_deg?: number | null;
  subtypes?: Array<number | null>;
  skipped?: boolean;
  freqDone?: boolean;
  pfDone?: boolean;
  freq_start_ts?: number | null;
  freq_stop_ts?: number | null;
};

export function missingRequired(r: RequiredInput): Issue[] {
  const f: RequiredField[] = [];
  if (!r.researchers?.trim()) f.push('researchers');
  if (r.type === 'quadrat') {
    if (r.aspect_deg == null) f.push('aspect');
    if (r.slope_deg == null) f.push('slope');
  }
  if (r.start_ts == null || r.date_only === 1 || r.stop_ts == null) f.push('time');
  if (r.type === 'quadrat' && !r.skipped && r.freqDone && (r.freq_start_ts == null || r.freq_stop_ts == null)) f.push('freqTime');
  if (topValues(r.top).some((v) => v == null)) f.push('topCover');
  if (r.type === 'quadrat' && (r.subtypes ?? []).some((v) => v == null)) f.push('subtypes');
  if (r.type === 'quadrat' && !r.skipped && !r.freqDone && !r.pfDone) f.push('method');
  const species = r.species.filter((s) => s.value == null || s.value === '').map((s) => s.name);
  return f.length || species.length ? [{ unit: r.code, kind: 'required', fields: f, species }] : [];
}

const EPS = 1e-9; // float noise only; real covers go down to 0.001
/**
 * Sums are made from the values as entered — some covers are as low as
 * 0.001%, so nothing is rounded. This only strips binary floating-point
 * noise (0.1 + 0.2 = 0.30000000000000004) so a sum prints as it was typed.
 */
export const exactSum = (x: number) => Number(x.toFixed(10));
const EQ = 1e-9;

function topValues(t: TopCover): Array<number | null> {
  return [t.vascular, t.solidRock, t.scree, t.lichens, t.bryophytes, t.bareGround, t.litter];
}

/** Surface top covers: checked once any value is entered. */
export function checkTopCover(unit: string, top: TopCover): Issue[] {
  const vals = topValues(top);
  if (vals.every((v) => v == null)) return [];
  const sum = vals.reduce<number>((a, v) => a + (v ?? 0), 0);
  return Math.abs(exactSum(sum) - 100) > EQ ? [{ unit, kind: 'top-cover-sum', sum: exactSum(sum) }] : [];
}

export function speciesCoverSum(species: UnitSpecies[]): number {
  return species.reduce((a, s) => a + (s.cover_pct ?? 0), 0);
}

/** p.41: Σ species cover ≥ vascular top cover. Sheet 11_ check_totalCoverCorrect. */
export function vascularCoverOk(top: TopCover, species: UnitSpecies[]): boolean | null {
  if (top.vascular == null) return null;
  if (!species.some((s) => s.cover_pct != null)) return null;
  return top.vascular <= speciesCoverSum(species) + EPS;
}

export function checkQuadrat(q: QuadratInput): Issue[] {
  const out: Issue[] = [...checkTopCover(q.code, q.top)];

  if (vascularCoverOk(q.top, q.species) === false) {
    out.push({
      unit: q.code,
      kind: 'vascular-exceeds-species',
      vascular: q.top.vascular as number,
      speciesSum: exactSum(speciesCoverSum(q.species)),
    });
  }

  q.subtypes.forEach((v, index) => {
    if (v != null && (v < 0 || v > 100)) out.push({ unit: q.code, kind: 'subtype-range', index, value: v });
  });

  if (q.freqDone) {
    for (const s of q.species) {
      const cells = freqOf(s);
      if ((s.cover_pct ?? 0) > 0 && cells === 0) {
        out.push({ unit: q.code, kind: 'cover-no-freq', species: s.name, cover: s.cover_pct as number });
      } else if (cells > 0 && !((s.cover_pct ?? 0) > 0)) {
        out.push({ unit: q.code, kind: 'freq-no-cover', species: s.name, cells });
      }
    }
  }

  out.push(...checkPoints(q.code, q.point_surface, q.species));
  return out;
}

/**
 * A point is consistent when exactly one holds: some species is hit there and
 * the surface char is '-', or no species is hit and the char is a surface code.
 * Unvisited points ('.') must carry no species hit.
 */
export function checkPoints(unit: string, surface: string | null, species: UnitSpecies[]): Issue[] {
  if (surface == null) return [];
  const bad: number[] = [];
  for (let i = 0; i < surface.length; i++) {
    const ch = surface[i];
    const hit = species.some((s) => s.point_hits != null && s.point_hits.charCodeAt(i) === 49);
    const ok = ch === SURFACE_UNVISITED ? !hit : ch === SURFACE_VASCULAR ? hit : !hit;
    if (!ok) bad.push(i);
  }
  return bad.length ? [{ unit, kind: 'point-inconsistent', points: bad }] : [];
}


/** Upper SAS must list every species present in the quadrats of its direction. */
export function checkSasContainsQuadrats(sas: SasInput, quadrats: QuadratInput[]): Issue[] {
  if (!sas.code.endsWith('05')) return [];
  const inSas = new Set(sas.species.map((s) => s.key));
  const missing = new Map<string, string>();
  for (const q of quadrats) {
    if (upperSasOf(q.code) !== sas.code) continue;
    for (const s of q.species) if (!inSas.has(s.key)) missing.set(s.key, s.name);
  }
  return missing.size ? [{ unit: sas.code, kind: 'sas-missing', species: [...missing.values()] }] : [];
}

export function checkP5m(p5m: Partial<Record<Direction, P5mCorner | null>>): Issue[] {
  return DIRECTIONS.filter((d) => p5m[d] !== '11' && p5m[d] !== '31').map((d) => ({
    unit: d,
    kind: 'p5m' as const,
    direction: d,
  }));
}

export type SurveyInput = {
  p5m: Partial<Record<Direction, P5mCorner | null>>;
  quadrats: QuadratInput[];
  sas: SasInput[];
  squares: SquareInput[];
  /** Started quadrats and SAS, for the required-field check. */
  required?: RequiredInput[];
};

/** Every issue of a survey, grouped by nothing — callers group by `unit`. */
export function validateSurvey(s: SurveyInput): Issue[] {
  const out: Issue[] = [...checkP5m(s.p5m)];
  for (const q of s.quadrats) out.push(...checkQuadrat(q));
  for (const a of s.sas) {
    out.push(...checkTopCover(a.code, a.top));
    out.push(...checkSasContainsQuadrats(a, s.quadrats));
  }
  for (const q of s.squares) {
    out.push(...checkPoints(q.code, q.point_surface, q.species));
    }
  for (const r of s.required ?? []) out.push(...missingRequired(r));
  return out;
}

/** Quadrats of a square's direction — the species the manual says to add first (p.58 §5.3.2). */
export function squareQuadratSpecies(direction: Direction, quadrats: QuadratInput[]): Map<string, string> {
  const codes = new Set(quadratsOf(direction));
  const out = new Map<string, string>();
  for (const q of quadrats) {
    if (!codes.has(q.code)) continue;
    for (const s of q.species) out.set(s.key, s.name);
  }
  return out;
}

/**
 * When six of the seven top covers are filled, the last one is the rest of
 * 100% (manual p.40: they add up to 100%). Same rule as the plot screen:
 * never fill the field just edited (clearing it to retype must stay
 * possible), and never go negative — an over-100 total is the user's to fix.
 */
export function autoFillLast<K extends string>(
  values: Record<K, number | null>,
  keys: readonly K[],
  edited: K,
): { key: K; value: number } | null {
  const blanks = keys.filter((k) => values[k] == null);
  if (blanks.length !== 1 || blanks[0] === edited) return null;
  const filled = keys.reduce((s, k) => s + (k === blanks[0] ? 0 : (values[k] ?? 0)), 0);
  const rest = exactSum(100 - filled);
  return rest >= 0 ? { key: blanks[0], value: rest } : null;
}
