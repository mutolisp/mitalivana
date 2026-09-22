/**
 * taxon_id namespace rules — pure, no DB, no React.
 *
 * The first character is the whole discriminator: TaiCOL `t…`, Japan `y…`,
 * external `g…`. Within `g` the second character separates the sources:
 * `gi` iNaturalist, `gm` manually entered, plain `g` GBIF (see
 * `externalTaxa.externalTaxonId`, which mints them).
 *
 * This lives in `lib/` rather than `db/` so the rules can be exercised by a
 * check script without dragging in op-sqlite. `db/regions.ts` delegates here
 * so there is exactly one definition of "external prefix".
 */

/** taxon_id was minted locally for a species absent from the bundled
 *  checklists; its row lives in user.db's `external_taxa`. */
export function isExternalTaxonId(taxonId: string | null | undefined): boolean {
  return !!taxonId && taxonId.charAt(0) === 'g';
}

/**
 * The `taxonID` to publish, as opposed to the one we store.
 *
 * Local ids mean nothing to a receiving system — `g2492463` / `gi58583` /
 * `gm3f2a…` are minted by this app, so putting them in a Darwin Core Archive
 * claims an identifier nobody can resolve. GBIF and iNaturalist both have
 * stable public URIs for exactly these keys; emit those.
 *
 * Manually entered taxa have no external identity at all, and an empty
 * `taxonID` is the honest answer: `scientificName` carries the claim, and
 * inventing an id would be worse than admitting there is none.
 *
 * ⚠️ **Published archive only** (`dwcRows.ts`). The yml and the CSVs keep the
 * local id, because those are our own round-trip format — `sessionImport.ts`
 * reads `taxonID` straight back to rebuild a record, so a URI there would
 * break import. Two different jobs, two different values.
 */
export function publishedTaxonId(taxonId: string): string {
  if (!isExternalTaxonId(taxonId)) return taxonId; // TaiCOL 't…' / Japan 'y…'
  if (taxonId.startsWith('gm')) return ''; // manual entry — no external identity
  if (taxonId.startsWith('gi')) return `https://www.inaturalist.org/taxa/${taxonId.slice(2)}`;
  return `https://www.gbif.org/species/${taxonId.slice(1)}`;
}
