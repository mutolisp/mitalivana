/**
 * Text parts with scientific names (src/lib/nameParts.ts), each name in
 * italics by its rank (ScientificName). Rendered inside a parent <Text>, so
 * the line keeps flowing around them. Merge rows, action sheets.
 */
import { ScientificName } from '~/components/ScientificName';
import { searchByTaxonId } from '~/db/search';
import type { NamePart } from '~/lib/nameParts';

/** `bold`: the line around it is semibold or bold (the scientific name takes the semibold files). */
export function NameParts({ parts, bold }: { parts: readonly NamePart[]; bold?: boolean }) {
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === 'string') return p;
        // Given the taxon instead of its rank (a converter with no checklist at hand).
        const hit = p.rank == null && p.taxonId ? searchByTaxonId(p.taxonId) : null;
        return (
          <ScientificName
            key={i}
            name={p.sci}
            rank={p.rank ?? hit?.rank ?? ''}
            kingdom={p.kingdom ?? hit?.kingdom ?? ''}
            className={bold ? 'font-semibold' : undefined}
          />
        );
      })}
    </>
  );
}
