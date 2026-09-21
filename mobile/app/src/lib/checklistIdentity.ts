/**
 * What counts as "the same species" in a checklist DOCUMENT.
 *
 * Pure, so `npm run check:checklistid` can hold it to the rules below without a
 * device — same contract as dwcArchive.ts / bundleYaml.ts.
 *
 * Not the taxon_id alone. The same taxon recorded under two names is two
 * deliberate taxonomic opinions (v28), and a determination that stopped at a
 * family or genus distinguishes its morphospecies only by the verbatim label
 * (v39) — `Orchidaceae sp1` and `sp2` share a taxon_id and are two species.
 *
 * The occurrence outputs (CSV, DwC-A) never use this: one row per record is
 * what an Occurrence IS, and the same species seen five times is five records.
 */
export function checklistIdentity(r: {
  taxon_id: string;
  used_scientific_name?: string | null;
  verbatim_identification?: string | null;
}): string {
  return `${r.taxon_id}|${r.used_scientific_name ?? ''}|${r.verbatim_identification ?? ''}`;
}

/**
 * One row per checklist identity, FIRST occurrence wins.
 *
 * Not `new Map(rows.map(...))` — a Map keeps the LAST value for a repeated key,
 * which is how the plot export used to behave while the collection export (a
 * `seen` Set) kept the first. Records arrive ordered by observation time, so
 * first means earliest, and a checklist entry should carry the sighting that
 * put the species on the list.
 */
export function uniqueByIdentity<
  T extends { taxon_id: string; used_scientific_name?: string | null; verbatim_identification?: string | null },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = checklistIdentity(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
