/**
 * A large test plot for the 1E stress test (docs/planned/Modular_survey.md §9,
 * Stem_mapping.md「效能」): 25 ha with about 20 000 trees, or 50 ha with
 * about 50 000, two censuses. Written through the same functions as the tree
 * form (saveTreeDraft, correctIndividual), so the data is what field work
 * makes and the time to write it is what saving costs.
 *
 * Deterministic: one seed gives the same plot, so numbers from two devices
 * compare. The plan is built first (in memory), then written in chunks the
 * caller runs in transactions — the app screen yields between chunks.
 *
 * Pure: check:census-stress runs it under Node.
 */
import { correctIndividual, createFrame, saveTreeDraft, startCensus, type Ctx, type TreeDraft } from '../db/stemmapCore';
import type { SurveyTemplate } from '../template/types';

/** Common trees of Taiwan's lowland forests (TaiCOL ids, accepted names). */
export const STRESS_TAXA: ReadonlyArray<{ id: string; name: string }> = [
  { id: 't0040235', name: 'Ardisia sieboldii' },
  { id: 't0073627', name: 'Daphniphyllum glaucescens' },
  { id: 't0053423', name: 'Diospyros morrisiana' },
  { id: 't0103659', name: 'Elaeocarpus sylvestris' },
  { id: 't0057320', name: 'Engelhardia roxburghiana' },
  { id: 't0046293', name: 'Ficus benjamina' },
  { id: 't0046305', name: 'Ficus microcarpa' },
  { id: 't0053909', name: 'Helicia formosana' },
  { id: 't0054097', name: 'Itea parviflora' },
  { id: 't0058462', name: 'Lithocarpus glaber' },
  { id: 't0074608', name: 'Litsea acuminata' },
  { id: 't0054368', name: 'Machilus thunbergii' },
  { id: 't0054369', name: 'Machilus zuihoensis' },
  { id: 't0058499', name: 'Mallotus japonicus' },
  { id: 't0054546', name: 'Neolitsea acuminatissima' },
  { id: 't0054987', name: 'Psychotria rubra' },
  { id: 't0059166', name: 'Randia cochinchinensis' },
  { id: 't0055514', name: 'Symplocos theophrastifolia' },
];

export type StressSize = '20k' | '50k';

export const STRESS_SIZES: Record<StressSize, { code: string; xM: number; yM: number; trees: number }> = {
  '20k': { code: 'STRESS-20K', xM: 500, yM: 500, trees: 20_000 },
  '50k': { code: 'STRESS-50K', xM: 1000, yM: 500, trees: 50_000 },
};

/** mulberry32: small, fast, and the same everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TreeSpec = {
  tag: string;
  taxon: { id: string; name: string };
  x: number;
  y: number;
  stems: { dbh: number; codes: string[] }[];
  heightM: number | null;
  /** In census 2 (only quadrats of its first half are recensused). */
  fate: 'grow' | 'die' | 'missed';
};

export type StressPlan = { size: StressSize; trees: TreeSpec[]; recruits: TreeSpec[]; corrections: number };

const round1 = (v: number) => Math.round(v * 10) / 10;

/** A diameter (cm, ≥ 1): most trees small, a few large (roughly as in a lowland forest). */
function dbhOf(r: () => number): number {
  const u = r();
  if (u < 0.7) return round1(1 + r() * 9);
  if (u < 0.95) return round1(10 + r() * 30);
  return round1(40 + r() * 60);
}

/** Quadrat densities vary (×0.3–2), so some quadrats are crowded. */
export function buildStressPlan(size: StressSize, seed = 20261001): StressPlan {
  const r = prng(seed);
  const { xM, yM, trees: n } = STRESS_SIZES[size];
  const cols = xM / 20;
  const rows = yM / 20;
  const weights = Array.from({ length: cols * rows }, () => 0.3 + r() * 1.7);
  const total = weights.reduce((a, b) => a + b, 0);
  const spec = (tag: number): TreeSpec => {
    // Pick a quadrat by weight, then a point in it.
    let pick = r() * total;
    let q = 0;
    while (pick > weights[q] && q < weights.length - 1) pick -= weights[q++];
    const col = Math.floor(q / rows);
    const row = q % rows;
    const stemCount = r() < 0.75 ? 1 : r() < 0.7 ? 2 : 3;
    const fateRoll = r();
    return {
      tag: String(tag),
      taxon: STRESS_TAXA[Math.floor(r() * STRESS_TAXA.length)],
      x: round1(col * 20 + 0.05 + r() * 19.9),
      y: round1(row * 20 + 0.05 + r() * 19.9),
      stems: Array.from({ length: stemCount }, () => ({ dbh: dbhOf(r), codes: r() < 0.08 ? ['L'] : [] })),
      heightM: r() < 0.15 ? round1(3 + r() * 25) : null,
      fate: fateRoll < 0.92 ? 'grow' : fateRoll < 0.97 ? 'die' : 'missed',
    };
  };
  const trees = Array.from({ length: n }, (_, i) => spec(i + 1));
  const recruits = Array.from({ length: Math.round(n * 0.03) }, (_, i) => spec(n + i + 1));
  return { size, trees, recruits, corrections: Math.round(n * 0.005) };
}

/** Census 2 covers the first half of the quadrats (column-major), as a census under way. */
export const inRecensus = (size: StressSize, t: { x: number }) => t.x < STRESS_SIZES[size].xM / 2;

const newTree = (t: TreeSpec): TreeDraft => ({
  individualId: null,
  tag: t.tag,
  taxon: { taxonId: t.taxon.id, usedScientificName: t.taxon.name },
  location: { method: 'xy', x: t.x, y: t.y },
  notes: null,
  heightM: t.heightM,
  treeCodes: [],
  mainStemNo: 1,
  stems: t.stems.map((s) => ({ stemNo: null, dbhCm: s.dbh, pomM: 1.3, stemDead: false, codes: s.codes, notes: null })),
  recordedBy: 'stress',
});

export function createStressPlot(ctx: Ctx, size: StressSize, template: SurveyTemplate): { frameId: number; census1: number } {
  const { code, xM, yM } = STRESS_SIZES[size];
  const frameId = createFrame(ctx, { code, sizeXM: xM, sizeYM: yM, name: 'stress test' });
  return { frameId, census1: startCensus(ctx, { frameId, template }) };
}

/** Census 1: trees [from, to) of the plan. Returns tree ids by tag. In a transaction. */
export function writeCensus1(ctx: Ctx, census1: number, plan: StressPlan, from: number, to: number, ids: Map<string, number>): void {
  for (const t of plan.trees.slice(from, to)) ids.set(t.tag, saveTreeDraft(ctx, census1, newTree(t)));
}

/**
 * Census 2 (first half of the plot): trees [from, to) re-measured with growth
 * (0–6 %), dead (code DS) or not reached; then the recruits and a few species
 * corrections (`last` chunk). In a transaction.
 */
export function writeCensus2(ctx: Ctx, census2: number, plan: StressPlan, from: number, to: number, ids: Map<string, number>, last: boolean): void {
  const r = prng(from + 7);
  for (const t of plan.trees.slice(from, to)) {
    if (!inRecensus(plan.size, t) || t.fate === 'missed') continue;
    const id = ids.get(t.tag)!;
    saveTreeDraft(ctx, census2, {
      ...newTree(t),
      individualId: id,
      tag: null,
      taxon: null,
      location: null,
      treeCodes: t.fate === 'die' ? ['DS'] : [],
      stems: t.stems.map((s, k) => ({
        stemNo: k + 1,
        dbhCm: t.fate === 'die' ? null : round1(s.dbh * (1 + r() * 0.06)),
        pomM: 1.3,
        stemDead: false,
        codes: t.fate === 'die' ? [] : s.codes,
        notes: null,
      })),
    });
  }
  if (!last) return;
  for (const t of plan.recruits) if (inRecensus(plan.size, t)) ids.set(t.tag, saveTreeDraft(ctx, census2, newTree(t)));
  const step = Math.max(1, Math.floor(plan.trees.length / Math.max(1, plan.corrections)));
  for (let i = 0; i < plan.trees.length; i += step) {
    const t = plan.trees[i];
    if (!inRecensus(plan.size, t)) continue;
    const other = STRESS_TAXA[(STRESS_TAXA.indexOf(t.taxon) + 1) % STRESS_TAXA.length];
    correctIndividual(ctx, ids.get(t.tag)!, { taxon: { taxonId: other.id, usedScientificName: other.name } }, { surveyId: census2, reason: 'stress test', by: 'stress' });
  }
}
