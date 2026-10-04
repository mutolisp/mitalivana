/**
 * The user's own taxa (`external_taxa`) as a source for the taxonomy tree:
 * the ones they typed (自建, `manual`) and the ones taken from GBIF or iNat
 * (2026-10-04: these go in too, each with its source badge). Where each one
 * sits is decided in externalTreeCore.ts — a manual taxon on its own chain, a
 * GBIF / iNat one on the checklist's hierarchy from its genus (else family,
 * order, class) — and a taxon that cannot be placed waits in its kingdom's
 * incomplete bucket, reached through the `INCOMPLETE_PHYLUM` sentinel. A taxon
 * nobody can find is worse than one in an obviously-provisional drawer.
 *
 * Rows live in user.db, the checklists in read-only dataset files, and this app
 * never ATTACHes — so the placements are worked out in JS once per change of
 * either (`treeRows`), and every tree query reads that list.
 */
import { availableNameDatasets, datasetScopeSig, getDatasetDb } from './datasets';
import {
  bucketOf,
  CHAIN,
  checklistAboveSql,
  childrenOf,
  kingdomsOf,
  placedUnder,
  placeRow,
  treeRank,
  type Chain,
  type ExternalRow,
  type MatchRank,
  type TreeRow,
} from './externalTreeCore';
import { getUserDb } from './init';
// Types only. `taxonomy.ts` imports the functions below, so a VALUE import
// back would be a runtime require cycle.
import type { Ancestors, ChildRank, Rank, TaxonSpecies } from './taxonomy';

/**
 * Stands in for the phylum of a taxon that has no placeable chain.
 *
 * A control character so it can never collide with a real phylum name, and so
 * a stray copy of it in a lineage key is visible rather than plausible.
 */
export const INCOMPLETE_PHYLUM = '\u0001manual-incomplete';

// `CHAIN` must stay in step with `RANK_ORDER` in taxonomy.ts; this fails the
// build if a rank is added there.
const _sameRanks: readonly Rank[] = CHAIN;
void _sameRanks;

function rows(sql: string, params: (string | number)[]): Record<string, unknown>[] {
  try {
    const res = getUserDb().executeSync(sql, params);
    return (res.rows ?? []) as Record<string, unknown>[];
  } catch {
    // The tree must survive a user DB that is mid-migration or absent; a
    // missing contribution is a gap, not a crash.
    return [];
  }
}

const str = (v: unknown) => (v == null ? '' : String(v));

/** The checklists' ranks above `rank` for `name`, in module order (TaiCOL first). */
function checklistAbove(rank: MatchRank, name: string, kingdom: string): Partial<Chain> | null {
  const above = CHAIN.slice(0, CHAIN.indexOf(rank));
  for (const spec of availableNameDatasets()) {
    if (spec.tables.kind !== 'names') continue;
    const db = getDatasetDb(spec.id);
    if (!db) continue;
    try {
      const res = db.executeSync(checklistAboveSql(rank, spec.tables.names, spec.tables.scopeClause, !!kingdom), kingdom ? [name, kingdom] : [name]);
      const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
      if (row) return Object.fromEntries(above.map((r) => [r, str(row[r])]));
    } catch {
      // A module mid-replacement answers nothing; the next module may.
    }
  }
  return null;
}

let cache: { sig: string; rows: TreeRow[] } | null = null;

/** Count and newest edit of `external_taxa` (`updateExternalTaxon` bumps `fetched_at`). */
function rowsSig(): string {
  const r = rows(`SELECT COUNT(*) AS n, COALESCE(MAX(fetched_at), 0) AS t FROM external_taxa`, []);
  return `m${Number(r[0]?.n ?? 0)}.${Number(r[0]?.t ?? 0)}`;
}

/** Every row and its place, recomputed when the rows or the checklists change. */
function treeRows(): TreeRow[] {
  const sig = `${rowsSig()}|${datasetScopeSig()}`;
  if (cache?.sig === sig) return cache.rows;
  const memo = new Map<string, Partial<Chain> | null>();
  const lookup = (rank: MatchRank, name: string, kingdom: string) => {
    const k = `${rank}|${kingdom}|${name}`;
    if (!memo.has(k)) memo.set(k, checklistAbove(rank, name, kingdom));
    return memo.get(k) ?? null;
  };
  const list = rows(
    `SELECT taxon_id, source, simple_name, name_author, rank, common_name_c, kingdom, phylum, class, "order", family, genus
       FROM external_taxa ORDER BY simple_name`,
    [],
  ).map((r) => {
    const row = {
      taxon_id: str(r.taxon_id),
      source: str(r.source) as ExternalRow['source'],
      simple_name: str(r.simple_name),
      name_author: str(r.name_author),
      rank: str(r.rank),
      common_name_c: str(r.common_name_c),
      ...(Object.fromEntries(CHAIN.map((c) => [c, str(r[c]).trim()])) as Chain),
    };
    return { row, chain: placeRow(row, lookup) };
  });
  cache = { sig, rows: list };
  return list;
}

/** How many of the user's taxa in this kingdom cannot be placed. */
export function incompleteCount(kingdom: string): number {
  return bucketOf(treeRows(), kingdom).length;
}

export type ManualTreeNode = { name: string; stats: Record<string, number> };

/**
 * Nodes of `rank` under `ancestors` contributed by the user's taxa, in the
 * shape `mergePackNodes` already consumes.
 */
export function manualTreeChildren(rank: ChildRank, ancestors?: Ancestors): ManualTreeNode[] {
  if (rank === 'species') return [];
  // Nothing below the bucket is a rank node — its children are species.
  if (ancestors?.phylum === INCOMPLETE_PHYLUM) return [];
  if (!CHAIN.includes(rank)) return [];
  const all = treeRows();
  const out = childrenOf(all, rank, ancestors);
  // The bucket hangs where phyla hang, so it is one tap from its kingdom.
  if (rank === 'phylum' && ancestors?.kingdom) {
    const n = bucketOf(all, ancestors.kingdom).length;
    if (n > 0) out.push({ name: INCOMPLETE_PHYLUM, stats: { species: n } });
  }
  return out;
}

/** Where the tree shows taxon `taxonId` of the user's own (for a search hit to expand to), or null. */
export function externalTreePath(taxonId: string): Ancestors | null {
  const x = treeRows().find((r) => r.row.taxon_id === taxonId);
  if (!x) return null;
  if (x.chain) return { ...x.chain };
  return x.row.kingdom ? { kingdom: x.row.kingdom, phylum: INCOMPLETE_PHYLUM } : null;
}

/** A row as the tree lists it: on its placed chain (its own when in the bucket). */
function toTaxonSpecies({ row, chain }: TreeRow): TaxonSpecies {
  const c = chain ?? row;
  return {
    taxon_id: row.taxon_id,
    simple_name: row.simple_name,
    name_author: row.name_author,
    common_name_c: row.common_name_c,
    family: c.family,
    family_c: '',
    rank: treeRank(row.rank),
    // A user-created taxon carries none of the checklist's attributes, and
    // guessing any of them would put unverified conservation status on screen.
    is_endemic: '',
    alien_type: '',
    redlist: '',
    iucn: '',
    cites: '',
    protected: '',
    is_hybrid: '',
    kingdom: c.kingdom,
    kingdom_c: '',
    phylum: c.phylum,
    phylum_c: '',
    class: c.class,
    class_c: '',
    order: c.order,
    order_c: '',
    genus: c.genus,
    genus_c: '',
    alternative_name_c: '',
    nomenclature_name: '',
    alien_status_note: '',
    is_autonym: false,
    external_source: row.source,
  };
}

/** The user's taxa sitting under `ancestors`, including the incomplete bucket. */
export function manualSpeciesUnder(ancestors?: Ancestors): TaxonSpecies[] {
  const all = treeRows();
  if (ancestors?.phylum === INCOMPLETE_PHYLUM) return bucketOf(all, ancestors.kingdom ?? '').map(toTaxonSpecies);
  return placedUnder(all, ancestors).map(toTaxonSpecies);
}

/**
 * Signature of the user's taxa, folded into the tree's scope signature.
 *
 * Without it the cached kingdom list would not notice a taxon just created or
 * taken from GBIF — `datasetScopeSig()` only tracks the read-only modules.
 * COUNT catches creates and deletes; MAX (`updateExternalTaxon` always bumps
 * `fetched_at`) catches edits, so moving a taxon between kingdoms re-lists both.
 */
export function manualScopeSig(): string {
  return rowsSig();
}

/** Kingdoms the user's taxa occupy, as tree nodes to merge at the root. */
export function manualKingdoms(): ManualTreeNode[] {
  return kingdomsOf(treeRows());
}
