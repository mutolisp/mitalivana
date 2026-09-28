/**
 * The recheck after blind recording (Road protocol §2.5.3, p. 5 and
 * §2.5.3.2, p. 6): once a plot's blind list is closed, every taxon the
 * previous survey had in the same plot but this one has not is shown, and
 * each needs an answer — found, not found, or re-identified as another taxon.
 *
 * Taxa are matched by (taxon_id, verbatim_identification), because rosters
 * belong to their survey and ids differ between years; a morphospecies name
 * such as `Acacia MTN1` keeps it the same entity.
 */

export type TaxonKey = { taxonId: string; verbatim: string | null };
export type RecheckOutcome = 'found' | 'not_found' | 'reidentified';

export function taxonKey(t: TaxonKey): string {
  return `${t.taxonId}\u0000${t.verbatim?.trim() ?? ''}`;
}

/** Previous-survey taxa missing from the current plot, in the previous order,
 *  each once. */
export function recheckCandidates<T extends TaxonKey>(previous: readonly T[], current: readonly TaxonKey[]): T[] {
  const have = new Set(current.map(taxonKey));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of previous) {
    const k = taxonKey(p);
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export type RecheckAnswer = { key: string; outcome: RecheckOutcome; newTaxon?: TaxonKey | null };

/** A plot can be finished when every candidate has an answer, and each
 *  re-identification names the taxon it became. A first survey has no
 *  candidates and is finished at once. */
export function recheckComplete(candidates: readonly TaxonKey[], answers: readonly RecheckAnswer[]): boolean {
  const byKey = new Map(answers.map((a) => [a.key, a]));
  return candidates.every((c) => {
    const a = byKey.get(taxonKey(c));
    if (!a) return false;
    return a.outcome !== 'reidentified' || !!a.newTaxon?.taxonId;
  });
}

/** `Found after recheck`: 1 for a species added in the recheck phase. */
export function foundAfterRecheck(phase: 'blind' | 'recheck'): 0 | 1 {
  return phase === 'recheck' ? 1 : 0;
}
