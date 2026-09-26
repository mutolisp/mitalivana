/**
 * Search results ordered by how often the user has recorded each taxon
 * (setting `search_usage_rank`). Pure — no RN, no DB — so check:usage-rank can
 * run it in Node; the counts come from src/db/usageCounts.ts.
 *
 * An exact match always stays first: a typed full name (common, scientific or
 * an alternative name) is a request for that taxon, however rarely used. Below
 * the exact matches, higher counts come first; equal counts (including never
 * used) keep the search's own order.
 */
export type Rankable = {
  taxon_id: string;
  name: string;
  _raw_cname: string;
  alternative_name_c: string;
};

/** Alternative common names are stored comma / semicolon separated. */
function altNames(r: Rankable): string[] {
  return (r.alternative_name_c ?? '')
    .split(/[,，;；、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isExactMatch(r: Rankable, q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  return r._raw_cname === t || r.name.toLowerCase() === t.toLowerCase() || altNames(r).includes(t);
}

export function rankByUsage<T extends Rankable>(results: T[], q: string, counts: ReadonlyMap<string, number>): T[] {
  const exact: T[] = [];
  const rest: Array<{ r: T; n: number; i: number }> = [];
  results.forEach((r, i) => {
    if (isExactMatch(r, q)) exact.push(r);
    else rest.push({ r, n: counts.get(r.taxon_id) ?? 0, i });
  });
  rest.sort((a, b) => b.n - a.n || a.i - b.i);
  return [...exact, ...rest.map((x) => x.r)];
}

/** Used taxa whose stored names contain the query — candidates the search's
 *  own cut-off may have dropped. Highest count first. */
export type UsedTaxon = { taxon_id: string; n: number; names: string[] };

export function usedMatching(used: UsedTaxon[], q: string, limit: number): UsedTaxon[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  return used
    .filter((u) => u.names.some((name) => name.toLowerCase().includes(t)))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/** Records per taxon across every record type, with names to match a query
 *  (run by src/db/usageCounts.ts; here so check:usage-rank can run it on the
 *  real migrated schema). */
export const USAGE_COUNTS_SQL = `SELECT u.taxon_id, u.n,
            COALESCE(c.simple_name, e.simple_name, '') AS sci,
            COALESCE(c.common_name_c, e.common_name_c, '') AS cname,
            COALESCE(c.alternative_name_c, '') AS alt
       FROM (SELECT taxon_id, COUNT(*) AS n FROM (
               SELECT taxon_id FROM checklist_records
               UNION ALL SELECT taxon_id FROM plot_species_records
               UNION ALL SELECT taxon_id FROM collection_specimens
               UNION ALL SELECT t.taxon_id FROM gloria_unit_species us JOIN gloria_taxa t ON t.id = us.gloria_taxon_id
             ) GROUP BY taxon_id) u
       LEFT JOIN taxon_name_cache c ON c.taxon_id = u.taxon_id
       LEFT JOIN external_taxa e ON e.taxon_id = u.taxon_id`;
