/**
 * Where the user's own taxa (`external_taxa`) sit in the taxonomy tree, and
 * the tree's view of them (asked 2026-10-04: GBIF and iNat taxa go into the
 * tree too, each with its source badge; placed on TaiCOL's hierarchy).
 *
 *   - **manual** (自建): its own chain, as typed, when every rank from kingdom
 *     to genus is filled; otherwise the kingdom's incomplete bucket.
 *   - **gbif / inat**: GBIF's higher classification is not TaiCOL's (monocots
 *     are Liliopsida there, Magnoliopsida here), so its own chain would grow a
 *     parallel branch. Walking up from the genus, the first of genus, family,
 *     order, class that a checklist knows (in the same kingdom) decides: the
 *     ranks above it come from the checklist, that rank and those below from
 *     the taxon. Nothing known, or a rank below it blank → the bucket.
 *
 * Each level of the tree filters on every ancestor above it, so a placement
 * is all six ranks or none.
 *
 * Pure: check:external-tree runs it under Node.
 */

export const CHAIN = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'] as const;
export type ChainRank = (typeof CHAIN)[number];
export type Chain = Record<ChainRank, string>;
export type Ancestors = Partial<Record<ChainRank, string>>;

/** The ranks a gbif / inat taxon is matched on, lowest first. */
export const MATCH_RANKS = ['genus', 'family', 'order', 'class'] as const;
export type MatchRank = (typeof MATCH_RANKS)[number];

/**
 * A checklist's ranks above `rank` for a taxon named `name` there (kingdom
 * first), or null when no checklist has it in `kingdom` (any kingdom when
 * blank). The caller reads the checklists; memoize it, it is asked per row.
 */
export type ChecklistLookup = (rank: MatchRank, name: string, kingdom: string) => Partial<Chain> | null;

export type ExternalRow = {
  taxon_id: string;
  source: 'gbif' | 'inat' | 'manual';
  simple_name: string;
  name_author: string;
  rank: string;
  common_name_c: string;
} & Chain;

/**
 * The query behind a ChecklistLookup on one checklist table: the ranks above
 * `rank` for a name, the most common chain when rows disagree, from the rows
 * the tree itself is built from (accepted, in scope, species and below).
 * `+kingdom` / `+usage_status` keep SQLite on the name's own index — the
 * low-selectivity kingdom index would otherwise scan every plant or animal
 * (planned on tw-taicol 2026-10-04). Params: the name, then the kingdom when
 * `withKingdom`.
 */
export function checklistAboveSql(rank: MatchRank, table: string, scopeClause: string, withKingdom: boolean): string {
  const q = (r: ChainRank) => (r === 'order' || r === 'class' ? `"${r}"` : r);
  const cols = CHAIN.slice(0, CHAIN.indexOf(rank)).map(q).join(', ');
  return `SELECT ${cols}, COUNT(*) AS n FROM ${table}
    WHERE ${q(rank)} = ?${withKingdom ? ' AND +kingdom = ?' : ''} AND +usage_status = 'accepted' AND ${scopeClause}
      AND rank IN ('Species','Subspecies','Variety','Form')
    GROUP BY ${cols} ORDER BY n DESC LIMIT 1`;
}

/** A row and where the tree shows it: `chain` null = the kingdom's incomplete bucket. */
export type TreeRow = { row: ExternalRow; chain: Chain | null };

const complete = (c: Chain) => CHAIN.every((r) => !!c[r]);
const own = (r: ExternalRow): Chain => ({ kingdom: r.kingdom, phylum: r.phylum, class: r.class, order: r.order, family: r.family, genus: r.genus });

export function placeRow(row: ExternalRow, lookup: ChecklistLookup): Chain | null {
  const mine = own(row);
  if (row.source === 'manual') return complete(mine) ? mine : null;
  for (const rank of MATCH_RANKS) {
    if (!mine[rank]) continue;
    const above = lookup(rank, mine[rank], mine.kingdom);
    if (!above) continue;
    const at = CHAIN.indexOf(rank);
    const chain = Object.fromEntries(CHAIN.map((r, i) => [r, (i < at ? above[r] : mine[r]) ?? ''])) as Chain;
    return complete(chain) ? chain : null;
  }
  return null;
}

/** 'SPECIES' (GBIF) and 'species' read as the tree's 'Species'. */
export const treeRank = (rank: string): string => (rank ? rank.charAt(0).toUpperCase() + rank.slice(1).toLowerCase() : 'Species');

const INFRA = new Set(['Subspecies', 'Variety', 'Form']);

const under = (c: Chain, a: Ancestors | undefined) => CHAIN.every((r) => !a?.[r] || c[r] === a[r]);

/**
 * Child counts as the checklist tree gives them: distinct names of every
 * rank below `rankIdx`, species, and infraspecific taxa when there are any.
 */
export function statsOf(rows: readonly TreeRow[], rankIdx: number): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const r of CHAIN.slice(rankIdx + 1)) stats[r] = new Set(rows.map((x) => (x.chain ?? own(x.row))[r]).filter(Boolean)).size;
  stats.species = rows.filter((x) => treeRank(x.row.rank) === 'Species').length;
  const infra = rows.filter((x) => INFRA.has(treeRank(x.row.rank))).length;
  if (infra) stats.infraspecific = infra;
  return stats;
}

export type TreeNodeRow = { name: string; stats: Record<string, number> };

/** Nodes of `rank` under `ancestors` that placed rows make, by name. */
export function childrenOf(rows: readonly TreeRow[], rank: ChainRank, ancestors: Ancestors | undefined): TreeNodeRow[] {
  const at = CHAIN.indexOf(rank);
  const groups = new Map<string, TreeRow[]>();
  for (const x of rows) {
    if (!x.chain || !under(x.chain, ancestors)) continue;
    const name = x.chain[rank];
    (groups.get(name) ?? groups.set(name, []).get(name)!).push(x);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, g]) => ({ name, stats: statsOf(g, at) }));
}

/** Kingdoms holding any row: placed ones by their chain, bucket ones by their own kingdom.
 *  Counted from phylum down, as the checklist's kingdoms are (a kingdom row read 「界 1」 before). */
export function kingdomsOf(rows: readonly TreeRow[]): TreeNodeRow[] {
  const groups = new Map<string, TreeRow[]>();
  for (const x of rows) {
    const k = x.chain?.kingdom ?? x.row.kingdom;
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, g]) => ({ name, stats: statsOf(g, 0) }));
}

/** The kingdom's incomplete bucket. */
export const bucketOf = (rows: readonly TreeRow[], kingdom: string): TreeRow[] => (kingdom ? rows.filter((x) => !x.chain && x.row.kingdom === kingdom) : []);

/** Placed rows under `ancestors`, by scientific name. */
export const placedUnder = (rows: readonly TreeRow[], ancestors: Ancestors | undefined): TreeRow[] =>
  rows.filter((x) => x.chain && under(x.chain, ancestors)).sort((a, b) => (a.row.simple_name < b.row.simple_name ? -1 : a.row.simple_name > b.row.simple_name ? 1 : 0));
