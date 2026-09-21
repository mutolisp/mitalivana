/**
 * Is the recorded total vegetation cover consistent with the species?
 *
 * Species covers are projected crowns and they overlap, so their sum is an
 * upper bound on what the plot's canopy actually covers:
 *
 *     Σ species cover  ≥  total vegetation cover
 *
 * A total ABOVE the sum cannot happen in the field — it means cover was
 * recorded for vegetation that no species accounts for, so either the total is
 * too high or a species is missing. Below is perfectly normal (overlap), and
 * so is a plot still being surveyed, which is why this only ever warns.
 *
 * Only applies when every layer that holds records measures in per cent. A DBH
 * layer contributes no cover at all, so its species would be missing from the
 * sum and the check would fire on every mixed-method plot — a warning that is
 * always wrong is worse than no warning. Braun-Blanquet is excluded for the
 * same reason plus one more: its class midpoints are estimates, and an estimate
 * has no business deciding whether real data is contradictory.
 *
 * Pure — `npm run check:plotcover` holds it to these rules without a device.
 */

/** The per-cent quantity type, as persisted (see dwcAbundance QUANTITY_TYPES). */
const PERCENT_TYPE = '% cover';

export type CoverCheckLayer = { layer_index: number; method: string };
export type CoverCheckSpecies = {
  layer: string | null;
  organism_quantity: string | null;
  organism_quantity_type: string | null;
};

export type CoverCheck =
  /** Nothing to say: no total recorded, no species yet, or a method that
   *  cannot be summed as cover. `reason` is for the caller's own logging, not
   *  for the user — silence is the right UI here. */
  | { kind: 'not-applicable'; reason: 'no-total' | 'no-species' | 'non-percent-method' }
  | { kind: 'ok'; total: number; speciesSum: number }
  | { kind: 'total-exceeds-species'; total: number; speciesSum: number };

/** `E3` → 3. Anything else (transect's 'T', null) → null. */
function layerIndexOf(layer: string | null): number | null {
  const m = /^E(\d+)$/.exec(layer ?? '');
  return m ? Number(m[1]) : null;
}

export function checkPlotCover(
  totalCoverPct: number | null | undefined,
  layers: CoverCheckLayer[],
  species: CoverCheckSpecies[],
): CoverCheck {
  if (totalCoverPct == null) return { kind: 'not-applicable', reason: 'no-total' };
  if (species.length === 0) return { kind: 'not-applicable', reason: 'no-species' };

  // Only the layers that actually hold records matter: an empty DBH layer the
  // surveyor never used should not silence the check.
  const methodByIndex = new Map(layers.map((l) => [l.layer_index, l.method]));
  const usedIndices = new Set(
    species.map((s) => layerIndexOf(s.layer)).filter((i): i is number => i !== null),
  );
  for (const i of usedIndices) {
    if (methodByIndex.get(i) !== 'percent') {
      return { kind: 'not-applicable', reason: 'non-percent-method' };
    }
  }

  let speciesSum = 0;
  let counted = 0;
  for (const s of species) {
    if (s.organism_quantity_type !== PERCENT_TYPE) continue;
    const v = Number(s.organism_quantity);
    if (!Number.isFinite(v)) continue;
    speciesSum += v;
    counted += 1;
  }
  if (counted === 0) return { kind: 'not-applicable', reason: 'no-species' };

  // Rounded to one decimal before comparing: 60 vs 59.999999999999996 is a
  // float artefact, not a contradiction worth interrupting anyone for.
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return round1(totalCoverPct) > round1(speciesSum)
    ? { kind: 'total-exceeds-species', total: totalCoverPct, speciesSum: round1(speciesSum) }
    : { kind: 'ok', total: totalCoverPct, speciesSum: round1(speciesSum) };
}
