/**
 * User-created taxa as a source for the taxonomy tree.
 *
 * `external_taxa` holds three kinds of row (`manual` / `gbif` / `inat`); only
 * `manual` — the ones the user typed themselves — is surfaced here. The cached
 * GBIF/iNat rows are lookup residue, not something the user chose to keep, and
 * putting them in the tree would fill it with names nobody meant to add.
 *
 * Two placements, because the creation form only requires a scientific name and
 * a kingdom (`GbifLookupHost`), leaving phylum…genus optional:
 *
 *   - **Complete chain** (kingdom, phylum, class, order, family AND genus all
 *     filled) — merged into its real position, exactly like a region pack. The
 *     whole chain is required because each level of the tree filters on every
 *     ancestor above it; a blank family means no family node ever matches, and
 *     the taxon would be unreachable however far the user drilled.
 *   - **Anything else** — collected under one bucket node per kingdom, reached
 *     through the `INCOMPLETE_PHYLUM` sentinel. A taxon nobody can find is
 *     worse than one sitting in an obviously-provisional drawer.
 *
 * Rows live in user.db, the checklists in read-only dataset files, and this app
 * never ATTACHes — so this merges in JS, the same way packs already do.
 */
import { getUserDb } from './init';
// Types only. `taxonomy.ts` imports the functions below, so a VALUE import
// back would be a runtime require cycle — `RANK_ORDER` would be undefined
// during module init depending on which side loads first. The chain is
// restated as a local constant instead; the type assertion below is what keeps
// it honest if `Rank` ever changes.
import type { Ancestors, ChildRank, Rank, TaxonSpecies } from './taxonomy';

/**
 * Stands in for the phylum of a manual taxon that has no placeable chain.
 *
 * A control character so it can never collide with a real phylum name, and so
 * a stray copy of it in a lineage key is visible rather than plausible.
 */
export const INCOMPLETE_PHYLUM = '\u0001manual-incomplete';

/** Every rank the tree walks through before it reaches species. Must stay in
 *  step with `RANK_ORDER` in taxonomy.ts; typed as `Rank[]` so adding a rank
 *  there fails the build here rather than silently skipping a level. */
const CHAIN: readonly Rank[] = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];

const col = (r: Rank) => (r === 'order' || r === 'class' ? `"${r}"` : r);

/** SQL true when every rank from kingdom to genus is filled in. */
const COMPLETE_CHAIN = CHAIN.map((r) => `${col(r)} IS NOT NULL AND ${col(r)} != ''`).join(' AND ');

const MANUAL = `source = 'manual'`;

/** `AND col = ?` for each populated ancestor; mutates `params`. */
function ancestorWhere(ancestors: Ancestors | undefined, params: string[]): string {
  if (!ancestors) return '';
  let sql = '';
  for (const r of CHAIN) {
    const v = ancestors[r];
    if (!v) continue;
    sql += ` AND ${col(r)} = ?`;
    params.push(v);
  }
  return sql;
}

function rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
  try {
    const res = getUserDb().executeSync(sql, params);
    return (res.rows ?? []) as Record<string, unknown>[];
  } catch {
    // The tree must survive a user DB that is mid-migration or absent; a
    // missing manual-taxon contribution is a gap, not a crash.
    return [];
  }
}

export type ManualTreeNode = { name: string; stats: Record<string, number> };

/** Aggregate counts for the ranks BELOW `rankIdx`, matching buildStatsCols. */
function statsCols(rankIdx: number): string {
  const out = CHAIN.slice(rankIdx + 1).map((r) => `COUNT(DISTINCT ${col(r)}) AS ${r}_count`);
  out.push(`SUM(CASE WHEN rank = 'Species' THEN 1 ELSE 0 END) AS species_count`);
  out.push(
    `SUM(CASE WHEN rank IN ('Subspecies','Variety','Form') THEN 1 ELSE 0 END) AS infraspecific_count`,
  );
  return out.join(', ');
}

function statsDict(row: Record<string, unknown>, rankIdx: number): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const r of CHAIN.slice(rankIdx + 1)) {
    const key = `${r}_count`;
    if (key in row) stats[r] = (row[key] as number) ?? 0;
  }
  stats['species'] = (row.species_count as number) ?? 0;
  const infra = (row.infraspecific_count as number) ?? 0;
  if (infra) stats['infraspecific'] = infra;
  return stats;
}

/** How many manual taxa in this kingdom cannot be placed. */
export function incompleteCount(kingdom: string): number {
  if (!kingdom) return 0;
  const r = rows(
    `SELECT COUNT(*) AS n FROM external_taxa
      WHERE ${MANUAL} AND kingdom = ? AND NOT (${COMPLETE_CHAIN})`,
    [kingdom],
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * Nodes of `rank` under `ancestors` contributed by manual taxa, in the shape
 * `mergePackNodes` already consumes.
 */
export function manualTreeChildren(rank: ChildRank, ancestors?: Ancestors): ManualTreeNode[] {
  if (rank === 'species') return [];
  // Nothing below the bucket is a rank node — its children are species.
  if (ancestors?.phylum === INCOMPLETE_PHYLUM) return [];
  const rankIdx = CHAIN.indexOf(rank as Rank);
  if (rankIdx === -1) return [];

  const params: string[] = [];
  const where = `${MANUAL} AND ${COMPLETE_CHAIN}${ancestorWhere(ancestors, params)}`;
  const out = rows(
    `SELECT ${col(rank as Rank)} AS name, ${statsCols(rankIdx)}
       FROM external_taxa
      WHERE ${where}
      GROUP BY name
     HAVING name IS NOT NULL AND name != ''
      ORDER BY name`,
    params,
  ).map((row) => ({ name: row.name as string, stats: statsDict(row, rankIdx) }));

  // The bucket hangs where phyla hang, so it is one tap from its kingdom.
  if (rank === 'phylum' && ancestors?.kingdom) {
    const n = incompleteCount(ancestors.kingdom);
    if (n > 0) out.push({ name: INCOMPLETE_PHYLUM, stats: { species: n } });
  }
  return out;
}

const SPECIES_COLS = `taxon_id, simple_name, name_author, rank, common_name_c,
  kingdom, phylum, class, "order", family, genus`;

function toTaxonSpecies(row: Record<string, unknown>): TaxonSpecies {
  const s = (v: unknown) => (v == null ? '' : String(v));
  return {
    taxon_id: s(row.taxon_id),
    simple_name: s(row.simple_name),
    name_author: s(row.name_author),
    common_name_c: s(row.common_name_c),
    family: s(row.family),
    family_c: '',
    rank: s(row.rank) || 'Species',
    // A user-created taxon carries none of the checklist's attributes, and
    // guessing any of them would put unverified conservation status on screen.
    is_endemic: '',
    alien_type: '',
    redlist: '',
    iucn: '',
    cites: '',
    protected: '',
    is_hybrid: '',
    kingdom: s(row.kingdom),
    kingdom_c: '',
    phylum: s(row.phylum),
    phylum_c: '',
    class: s(row.class),
    class_c: '',
    order: s(row.order),
    order_c: '',
    genus: s(row.genus),
    genus_c: '',
    alternative_name_c: '',
    nomenclature_name: '',
    alien_status_note: '',
    is_autonym: false,
  };
}

/** Manual taxa sitting under `ancestors`, including the incomplete bucket. */
export function manualSpeciesUnder(ancestors?: Ancestors): TaxonSpecies[] {
  if (ancestors?.phylum === INCOMPLETE_PHYLUM) {
    if (!ancestors.kingdom) return [];
    return rows(
      `SELECT ${SPECIES_COLS} FROM external_taxa
        WHERE ${MANUAL} AND kingdom = ? AND NOT (${COMPLETE_CHAIN})
        ORDER BY simple_name`,
      [ancestors.kingdom],
    ).map(toTaxonSpecies);
  }
  const params: string[] = [];
  const where = `${MANUAL} AND ${COMPLETE_CHAIN}${ancestorWhere(ancestors, params)}`;
  return rows(
    `SELECT ${SPECIES_COLS} FROM external_taxa WHERE ${where} ORDER BY simple_name`,
    params,
  ).map(toTaxonSpecies);
}

/**
 * Signature of the manual-taxon set, folded into the tree's scope signature.
 *
 * Without it the cached kingdom list would not notice a taxon the user just
 * created — `datasetScopeSig()` only tracks the read-only modules, which a
 * manual taxon never touches. COUNT catches creates and deletes; MAX
 * (`updateExternalTaxon` always bumps `fetched_at`) catches edits, so moving a
 * taxon between kingdoms re-lists both.
 */
export function manualScopeSig(): string {
  const r = rows(
    `SELECT COUNT(*) AS n, COALESCE(MAX(fetched_at), 0) AS t
       FROM external_taxa WHERE ${MANUAL}`,
    [],
  );
  return `m${Number(r[0]?.n ?? 0)}.${Number(r[0]?.t ?? 0)}`;
}

/** Kingdoms that only manual taxa occupy, as tree nodes to merge at the root. */
export function manualKingdoms(): ManualTreeNode[] {
  return rows(
    `SELECT kingdom AS name, ${statsCols(-1)}
       FROM external_taxa
      WHERE ${MANUAL}
      GROUP BY kingdom
     HAVING name IS NOT NULL AND name != ''
      ORDER BY name`,
    [],
  ).map((row) => ({ name: row.name as string, stats: statsDict(row, -1) }));
}
