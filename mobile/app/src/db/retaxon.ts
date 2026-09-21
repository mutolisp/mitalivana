/**
 * Re-identification — swap a record's taxon, keep the observation.
 *
 * One function for three record kinds, because re-identifying is one action
 * across three tables and the three columns it must write TOGETHER are named
 * identically in all of them (v28 added the adoption pair to all three in a
 * single migration).
 *
 * Writing it three times is what caused the defects this replaces: the plot and
 * specimen paths each set `taxon_id` alone, leaving `used_name_id` /
 * `used_scientific_name` pointing at the previous taxon's adopted name, and
 * neither copied the incoming taxon into the local caches.
 *
 * The table name comes from a literal union and is never user input — the same
 * rule `mediaUriReferenced` in records.ts follows.
 */
import { getUserDb } from './init';
import { ensureTaxonSelfSufficient } from './taxonCache';
import type { AdoptionInput } from './taxonLookup';

const TABLE = {
  session: 'checklist_records',
  plot: 'plot_species_records',
  collection: 'collection_specimens',
} as const;

export type RetaxonKind = keyof typeof TABLE;

/**
 * `occurrence_id` is deliberately untouched: it identifies the observation, not
 * the determination. The same organism was seen in the same place at the same
 * time whatever we later decide to call it, and a DwC occurrenceID that changed
 * on re-identification would break every reference already published.
 *
 * The adoption columns ARE rewritten. They record the name the record was filed
 * under, so after a re-identification the old pair describes a name no longer
 * on the record at all. No `adopted` clears them, which is the correct state
 * for a plain accepted name.
 */
export function retaxonRecord(
  kind: RetaxonKind,
  id: number,
  taxonId: string,
  adopted?: AdoptionInput | null,
): void {
  // Same invariant the four insert paths carry: once a record references a
  // taxon, that name has to outlive its data source. A re-identification
  // creates a NEW reference, so it needs this exactly as much as an insert.
  ensureTaxonSelfSufficient(taxonId);
  getUserDb().executeSync(
    `UPDATE ${TABLE[kind]}
        SET taxon_id = ?, used_name_id = ?, used_scientific_name = ?, updated_at = ?
      WHERE id = ?`,
    [taxonId, adopted?.name_id ?? null, adopted?.scientific_name ?? null, Date.now(), id],
  );
}
