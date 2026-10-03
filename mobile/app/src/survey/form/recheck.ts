/**
 * The recheck of a permanent plot after its blind phase (Modular_survey.md
 * §5.5; decided 2026-10-03 to keep an answer per taxon, as MIREN does): every
 * taxon the previous survey had in a unit but this survey's blind list has
 * not, in the same unit, needs an answer — found, not found, or re-identified
 * as an occurrence recorded this time. The answers tell "looked for and not
 * there" from "not looked for".
 *
 * Units are matched by their frame unit (fw_units.frame_unit_id); a previous
 * occurrence outside any unit matches this survey's occurrences outside any
 * unit. A unit this survey does not have (retired since) is not rechecked.
 * Taxa match on taxon id and label, as in MIREN (a morphospecies label keeps
 * it the same entity).
 *
 * Pure: check:survey-core runs it under Node.
 */
import { taxonKey, type RecheckOutcome } from '../../modules/miren/model/compare';

export type { RecheckOutcome };

/** A taxon in a place of the plot: a frame unit, or null for outside any unit. */
export type Sighting = { frameUnitId: number | null; taxonId: string; verbatim: string | null };

export function recheckKey(s: Sighting): string {
  return `${s.frameUnitId ?? ''}\u0001${taxonKey(s)}`;
}

/**
 * The previous survey's sightings that need an answer, in the previous order,
 * each once: not in this survey's blind list at the same place, and at a
 * place this survey has (`places`: its units' frame units, and null).
 */
export function recheckCandidates<T extends Sighting>(previous: readonly T[], blind: readonly Sighting[], places: ReadonlySet<number | null>): T[] {
  const have = new Set(blind.map(recheckKey));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of previous) {
    const k = recheckKey(p);
    if (!places.has(p.frameUnitId) || have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export type RecheckAnswer = { key: string; outcome: RecheckOutcome; occurrenceId: number | null };

/** How many candidates still need an answer: none yet, or a re-identification that names no occurrence. */
export function recheckOpen(candidates: readonly Sighting[], answers: readonly RecheckAnswer[]): number {
  const byKey = new Map(answers.map((a) => [a.key, a]));
  return candidates.filter((c) => {
    const a = byKey.get(recheckKey(c));
    return !a || (a.outcome === 'reidentified' && a.occurrenceId == null);
  }).length;
}
