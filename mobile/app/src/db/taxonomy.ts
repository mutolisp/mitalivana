/**
 * Taxonomy tree query helpers.
 * Port of backend/api/taxonomy_api.py — MVP scope skips virus realm handling
 * (defer to iteration after first taxonomy ship).
 */
import type { DB } from '@op-engineering/op-sqlite';
import {
  availableNameDatasets,
  datasetScopeSig,
  getDatasetDb,
  onDatasetsChanged,
} from './datasets';
import { searchWithFuzzyFallback } from './fuzzy';
import {
  getEnabledRegions,
  regionOfTaxonId,
  normalizeSci,
  crossRegionVernacular,
  composeVernacular,
  getVernacularLangs,
} from './regions';
import {
  packInfraspeciesOf,
  packScopeSig,
  packSpeciesUnder,
  packTreeChildren,
  searchPackLineages,
  type PackSpeciesRow,
  type PackTreeNodeRow,
} from './regionpacks';
import { mergeScopeNodes } from './mergeScope';
import {
  INCOMPLETE_PHYLUM,
  manualKingdoms,
  manualScopeSig,
  manualSpeciesUnder,
  manualTreeChildren,
} from './manualTaxonomy';
import type { SearchResult } from './types';
import {
  arrangeChildren,
  chainForChild,
  childKeyOf,
  createChainResolver,
  createIntermediateNode,
  findIntermediate,
  placeChildren,
  hasOverride,
  RANK_LADDER,
  ranksBetween,
  type LadderRank,
  intermediateScopeSig,
  searchIntermediate,
  visiblePathOf,
  type IntermediateNode,
} from './intermediateTaxa';

/**
 * The query scope of each available checklist module.
 *
 * TW+JP used to be queried through the `all_names` UNION view, where a single
 * query kept `COUNT(DISTINCT …)` exact. A view cannot span files once the
 * checklists became separate modules, so this queries per module and merges in
 * JS — the same thing packs have been doing all along (this app never
 * ATTACHes).
 *
 * **The statistics trade-off**: child-rank counts are summed on merge, so with
 * TW and JP both enabled and a genus shared between them the number is slightly
 * high; that matches what `mergePackNodes` already does for packs (whose comment
 * also says it is an approximation). With Taiwan alone (the default) or Japan
 * alone there is a single scope and the numbers are exactly what they were
 * before the split. The leaf-level species list still de-duplicates row by row
 * and is unaffected.
 *
 * An empty array = no checklist module at all (packs only, or nothing downloaded
 * yet), and callers skip straight past.
 */
type NameScope = { id: string; db: DB; table: string; taiwanClause: string };

function nameScopes(): NameScope[] {
  const out: NameScope[] = [];
  for (const spec of availableNameDatasets()) {
    if (spec.tables.kind !== 'names') continue;
    const db = getDatasetDb(spec.id);
    if (!db) continue;
    out.push({
      id: spec.id,
      db,
      table: spec.tables.names,
      taiwanClause: spec.tables.scopeClause,
    });
  }
  return out;
}

/** Merge pack tree rows into bundled nodes: same-name nodes combine (stats
 *  added — an approximation, since a species present in two sources counts
 *  once per source at this level; leaf species lists DO dedupe), pack-only
 *  nodes are appended. Sorted by name to match the SQL ORDER BY. */
function mergePackNodes(
  bundled: TaxonNode[],
  packRows: PackTreeNodeRow[],
  rank: string,
  childRank: ChildRank,
  ancestors: Ancestors,
): TaxonNode[] {
  if (packRows.length === 0) return bundled;
  const byName = new Map(bundled.map((n) => [n.name, n]));
  for (const pr of packRows) {
    const existing = byName.get(pr.name);
    if (existing) {
      for (const [k, v] of Object.entries(pr.stats)) {
        existing.stats[k] = (existing.stats[k] ?? 0) + v;
      }
    } else {
      byName.set(pr.name, {
        name: pr.name,
        name_c: '',
        rank,
        rank_key: rank,
        child_rank: childRank,
        stats: pr.stats,
        ancestors,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const RANK_ORDER = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'] as const;
export type Rank = (typeof RANK_ORDER)[number];
export type ChildRank = Rank | 'species';

const RANK_C_COL: Record<string, string> = {
  kingdom: 'kingdom_c',
  phylum: 'phylum_c',
  class: 'class_c',
  order: 'order_c',
  family: 'family_c',
  genus: 'genus_c',
};

const VIRUS_KINGDOMS = new Set([
  'Bamfordvirae',
  'Heunggongvirae',
  'Orthornavirae',
  'Pararnavirae',
  'Shotokuvirae',
  'Ribozyviria kingdom incertae sedis',
  'Viruses kingdom incertae sedis',
]);

/**
 * Ancestor chain leading to a node (NOT including the node itself).
 * Empty for kingdom-level nodes. Required at every drill-down because
 * scientific names (especially genera like Taiwania, Pieris, Aotus) are
 * homonyms across kingdoms — ICN (plants) and ICZN (animals) don't enforce
 * uniqueness across each other. Filtering by immediate parent only would
 * mix species from the homonym in the other kingdom.
 */
export type Ancestors = Partial<Record<Rank, string>>;

export type TaxonNode = {
  name: string;
  name_c: string;
  rank: string;
  rank_key: string;
  child_rank: ChildRank;
  stats: Record<string, number>;
  ancestors: Ancestors;
  /** Intermediate-rank node only (subfamily, tribe …, see intermediateTaxa.ts):
   *  its TaiCOL taxon_id or user node id. For such a node `ancestors` is the
   *  fixed lineage INCLUDING its anchor, and `child_rank` the fixed rank (or
   *  species) its members have. */
  ref?: string;
  /** Intermediate refs between the anchor and this node, top-down. */
  via?: string[];
  /** Intermediate node the user created (editable / deletable). */
  user?: boolean;
};

function quoteCol(col: string): string {
  return col === 'order' || col === 'class' ? `"${col}"` : col;
}

/** Stable, lineage-unique key for a tree node. The same scientific name in
 *  two kingdoms (e.g. genus Taiwania in Plantae vs Animalia) collides under
 *  the naïve `${rank}:${name}` scheme — full-path keys keep both branches
 *  independent in expanded set / childrenMap / speciesMap. */
export function nodeKeyFor(node: {
  rank_key: string;
  name: string;
  ancestors: Ancestors;
  ref?: string;
  via?: string[];
}): string {
  const parts: string[] = [];
  for (const r of RANK_ORDER) {
    const v = node.ancestors[r];
    if (v) parts.push(`${r}:${v}`);
  }
  // A fixed-rank node's key ignores which intermediate it is shown under, so a
  // jump path (fixed ranks only) and the persisted expanded set keep working
  // when intermediates appear, move, or the display mode changes.
  if (node.ref) {
    for (const r of node.via ?? []) parts.push(`via:${r}`);
    parts.push(`${node.rank_key}:${node.ref}`);
  } else {
    parts.push(`${node.rank_key}:${node.name}`);
  }
  return parts.join('|');
}

/** Build `AND col = ?` fragments for every populated ancestor rank.
 *  Mutates `params` in place. Returns the SQL fragment (with leading space)
 *  or empty string if no ancestors. */
function buildAncestorWhere(ancestors: Ancestors | undefined, params: string[]): string {
  if (!ancestors) return '';
  let where = '';
  for (const r of RANK_ORDER) {
    const v = ancestors[r];
    if (v) {
      where += ` AND ${quoteCol(r)} = ?`;
      params.push(v);
    }
  }
  return where;
}

function buildStatsCols(rankIdx: number): string {
  const cols: string[] = [];
  for (const r of RANK_ORDER.slice(rankIdx + 1)) {
    cols.push(`COUNT(DISTINCT ${quoteCol(r)}) AS ${r}_count`);
  }
  cols.push("SUM(CASE WHEN rank='Species' THEN 1 ELSE 0 END) AS species_count");
  cols.push(
    "SUM(CASE WHEN rank IN ('Subspecies','Variety','Form') THEN 1 ELSE 0 END) AS infraspecific_count",
  );
  return cols.join(', ');
}

function buildStatsDict(row: Record<string, unknown>, rankIdx: number): Record<string, number> {
  // Keyed by language-independent rank-key (e.g. 'phylum', 'species',
  // 'infraspecific'); the tree row localizes via t('rank.'+key) at render so
  // the kingdom cache / fetched nodes re-localize on a language switch.
  const stats: Record<string, number> = {};
  for (const r of RANK_ORDER.slice(rankIdx + 1)) {
    const key = `${r}_count`;
    if (key in row) stats[r] = (row[key] as number) ?? 0;
  }
  stats['species'] = (row.species_count as number) ?? 0;
  const infra = (row.infraspecific_count as number) ?? 0;
  if (infra) stats['infraspecific'] = infra;
  return stats;
}

/** Module-level cache for the top-level kingdom listing. The bundled TaiCOL
 *  DB is read-only at runtime so the result never changes mid-session.
 *  Hit by `getTopLevel()` → triggered by every taxonomy tab mount; the
 *  uncached SQL runs ~200ms (GROUP BY + 7 aggregations over in-Taiwan
 *  accepted rows) which is enough to feel laggy when switching tabs. */
let CACHED_KINGDOMS: TaxonNode[] | null = null;
/** Region signature the kingdom cache was computed under; cache is invalid when
 *  the enabled regions change (JP toggled in settings). */
let CACHED_KINGDOMS_SCOPE: string | null = null;

/** 快取鍵含每個可用模組的**版本**，所以更新某個模組（整包換檔）會讓分類樹
 *  自動失效——不必額外呼叫清快取。 */
function scopeSig(): string {
  // The vernacular languages ride in the last segment: changing them re-reads
  // species names but, like a manual-taxon change, keeps the tree expanded.
  return `${datasetScopeSig()}|${packScopeSig()}|${manualScopeSig()}.${intermediateScopeSig()}~${getVernacularLangs().join(',')}`;
}

/** Exposed for the taxonomy screen: it must reset its in-memory tree when the
 *  dataset scope changed while it stayed mounted (the tab never remounts). */
export function taxonomyScopeSig(): string {
  return scopeSig();
}

function getTopLevel(): TaxonNode[] {
  const sig = scopeSig();
  if (CACHED_KINGDOMS === null || CACHED_KINGDOMS_SCOPE !== sig) {
    CACHED_KINGDOMS = computeTopLevel();
    CACHED_KINGDOMS_SCOPE = sig;
  }
  return CACHED_KINGDOMS;
}

/** Force-fill the kingdom cache. Mirrors `prewarmKeys()` / `prewarmFuzzyIndex()`:
 *  call from DBProvider after splash so the first taxonomy tab open is
 *  instant instead of paying the ~200ms SQL cost on mount. */
export function prewarmKingdoms(): void {
  getTopLevel();
}

/** Invalidate the kingdom cache — call when enabled regions change so the tree
 *  reflects the new dataset on next open. */
export function clearTaxonomyCache(): void {
  CACHED_KINGDOMS = null;
  CACHED_KINGDOMS_SCOPE = null;
}
// `scopeSig()` 已含模組版本，本來就會自癒；仍然註冊是為了刪除模組的當下立刻歸零，
// 而不是等到下一次比對 sig。
onDatasetsChanged(clearTaxonomyCache);

/**
 * Top-level: non-virus kingdoms.
 * (Virus realm handling deferred from MVP.)
 */
function computeTopLevel(): TaxonNode[] {
  let nodes: TaxonNode[] = [];
  for (const scope of nameScopes()) {
    const virusList = [...VIRUS_KINGDOMS].map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
    const statsCols = buildStatsCols(0);
    const cCol = RANK_C_COL.kingdom;
    const sql = `
      SELECT kingdom AS name, ${statsCols}, MAX(${cCol}) AS name_c
      FROM ${scope.table}
      WHERE usage_status='accepted'
        AND ${scope.taiwanClause}
        AND rank IN ('Species','Subspecies','Variety','Form')
        AND kingdom NOT IN (${virusList})
      GROUP BY kingdom
      HAVING name IS NOT NULL AND name != ''
      ORDER BY name
    `;
    const res = scope.db.executeSync(sql);
    const scopeNodes = ((res.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      name: row.name as string,
      name_c: (row.name_c as string) ?? '',
      rank: 'kingdom',
      rank_key: 'kingdom',
      child_rank: 'phylum' as ChildRank,
      stats: buildStatsDict(row, 0),
      ancestors: {},
    }));
    nodes = mergeScopeNodes(nodes, scopeNodes);
  }
  // Virus handling is deferred app-wide; GBIF-derived packs use the plain
  // kingdom name 'Viruses', which the bundled exclusion list doesn't carry.
  const packRows = packTreeChildren('kingdom', {}).filter(
    (r) => !VIRUS_KINGDOMS.has(r.name) && r.name !== 'Viruses',
  );
  nodes = mergePackNodes(nodes, packRows, 'kingdom', 'phylum', {});
  // User-created taxa contribute their kingdom too, or one created in a
  // kingdom no installed checklist covers would have no node to sit under and
  // would be unreachable in the tree.
  //
  // Viruses are NOT filtered out here, unlike the pack rows above. That filter
  // exists because the realm hierarchy viruses need is deferred app-wide; a
  // manual taxon has no realm either way, so it either has a complete
  // kingdom→genus chain or lands in the incomplete bucket, and both paths work.
  // Dropping it would only hide a species the user typed in themselves.
  return mergePackNodes(nodes, manualKingdoms(), 'kingdom', 'phylum', {});
}

export type ChildrenOptions = {
  rank: ChildRank;
  /**
   * Ancestors of the children we want. e.g. when loading genera under
   * Cupressaceae, pass `{kingdom:'Plantae', phylum:'Tracheophyta',
   * class:'Pinopsida', order:'Pinales', family:'Cupressaceae'}`. Pass
   * `undefined` / `{}` only for the top-level kingdom listing.
   */
  ancestors?: Ancestors;
  /** Intermediate refs already descended into below the anchor (listing the
   *  children of a subfamily node). Omitted = the anchor's own children. */
  via?: string[];
};

export function getTaxonChildren(opts: ChildrenOptions): TaxonNode[] {
  const hasAncestors = opts.ancestors && Object.keys(opts.ancestors).length > 0;
  if (opts.rank === 'kingdom' && !hasAncestors) return getTopLevel();
  if (opts.rank === 'species') return getSpeciesAsNodes();
  if (opts.rank === 'kingdom') return [];
  const nodes = fixedChildren(opts.rank, opts.ancestors);
  return arrangeRankNodes(nodes, opts.rank, opts.ancestors ?? {}, opts.via ?? []);
}

/** Children of fixed rank `rank` under `ancestors`, before intermediate
 *  grouping: every checklist module, region packs and manual taxa merged. */
function fixedChildren(rank: Rank, ancestorsIn: Ancestors | undefined): TaxonNode[] {
  const opts = { rank, ancestors: ancestorsIn };

  const rankIdx = RANK_ORDER.indexOf(opts.rank);
  if (rankIdx === -1) return [];

  const childRank: ChildRank = rankIdx + 1 < RANK_ORDER.length ? RANK_ORDER[rankIdx + 1] : 'species';
  const ancestors: Ancestors = opts.ancestors ?? {};
  let nodes: TaxonNode[] = [];
  for (const scope of nameScopes()) {
    const statsCols = buildStatsCols(rankIdx);
    const cCol = RANK_C_COL[opts.rank];
    const extraCols = cCol ? `, MAX(${cCol}) AS name_c` : '';
    const dbCol = quoteCol(opts.rank);

    let where = `usage_status='accepted' AND ${scope.taiwanClause} AND rank IN ('Species','Subspecies','Variety','Form')`;
    const params: string[] = [];
    where += buildAncestorWhere(opts.ancestors, params);

    const sql = `
      SELECT ${dbCol} AS name, ${statsCols} ${extraCols}
      FROM ${scope.table}
      WHERE ${where}
      GROUP BY ${dbCol}
      HAVING name IS NOT NULL AND name != ''
      ORDER BY name
    `;
    const res = scope.db.executeSync(sql, params);
    const scopeNodes = ((res.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      name: row.name as string,
      name_c: (row.name_c as string) ?? '',
      rank: opts.rank,
      rank_key: opts.rank,
      child_rank: childRank,
      stats: buildStatsDict(row, rankIdx),
      ancestors,
    }));
    nodes = mergeScopeNodes(nodes, scopeNodes);
  }
  nodes = mergePackNodes(
    nodes,
    packTreeChildren(opts.rank, opts.ancestors),
    opts.rank,
    childRank,
    ancestors,
  );
  // User-created taxa, merged the same way — `mergePackNodes` only needs
  // {name, stats}, and a manual genus under a checklist family is the same
  // shape of contribution a pack makes.
  const manual = manualTreeChildren(opts.rank, opts.ancestors);
  if (manual.length > 0) {
    nodes = mergePackNodes(nodes, manual, opts.rank, childRank, ancestors);
    // The incomplete bucket is a leaf-of-ranks: its children are species, not
    // the classes a real phylum would hold.
    nodes = nodes.map((n) =>
      n.name === INCOMPLETE_PHYLUM ? { ...n, child_rank: 'species' as ChildRank } : n,
    );
  }
  return nodes;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function intermediateToNode(
  n: IntermediateNode,
  lineage: Ancestors,
  childRank: ChildRank,
  via: string[],
  stats: Record<string, number>,
): TaxonNode {
  return {
    name: n.name,
    name_c: n.name_c,
    rank: capitalize(n.rank),
    rank_key: n.rank,
    child_rank: childRank,
    stats,
    ancestors: lineage,
    ref: n.ref,
    via,
    user: n.user,
  };
}

/** The fixed-rank anchor whose children of `rank` are being listed. */
function anchorOf(rank: ChildRank, lineage: Ancestors): { kingdom: string; anchorRank: Rank; anchorName: string } | null {
  const idx = rank === 'species' ? RANK_ORDER.length : RANK_ORDER.indexOf(rank);
  if (idx < 1) return null;
  const anchorRank = RANK_ORDER[idx - 1];
  const anchorName = lineage[anchorRank];
  const kingdom = lineage.kingdom;
  // The manual incomplete bucket is not a taxon; nothing hangs between it and
  // its species.
  if (!anchorName || !kingdom || lineage.phylum === INCOMPLETE_PHYLUM) return null;
  return { kingdom, anchorRank, anchorName };
}

/** Fold fixed-rank children into their intermediate groups (subfamily …). */
function arrangeRankNodes(nodes: TaxonNode[], rank: Rank, lineage: Ancestors, via: string[]): TaxonNode[] {
  const a = anchorOf(rank, lineage);
  if (!a) return via.length ? [] : nodes;
  const { direct, groups } = arrangeChildren({ ...a, childRank: rank }, nodes, via, (n) => n.name);
  if (groups.length === 0) return direct;
  const groupNodes = groups.map((g) => {
    const stats: Record<string, number> = { [rank]: g.members.length };
    for (const m of g.members) {
      for (const [k, v] of Object.entries(m.stats)) stats[k] = (stats[k] ?? 0) + v;
    }
    return intermediateToNode(g.node, lineage, rank, via, stats);
  });
  return [...groupNodes, ...direct];
}

const INFRA_MARKER = /\s+(subsp|ssp|var|subvar|f|fo|forma|subf)\.?\s.*$/;

/** The species binomial a species-level row belongs to (its own name for a
 *  species; the parent binomial for a subspecies / variety / form). */
function binomialOf(sp: TaxonSpecies): string {
  if (sp.rank === 'Species') return sp.simple_name;
  const stripped = sp.simple_name.replace(INFRA_MARKER, '');
  if (stripped !== sp.simple_name) return stripped;
  const tok = sp.simple_name.split(/\s+/);
  return tok.slice(0, tok[1] === '×' ? 3 : 2).join(' ');
}

/**
 * Split the species under a genus (or under one of its subgenus / section
 * nodes, `via`) into intermediate groups and the species sitting directly at
 * this level.
 */
export function arrangeSpecies(
  lineage: Ancestors,
  species: TaxonSpecies[],
  via: string[] = [],
): { groups: TaxonNode[]; direct: TaxonSpecies[] } {
  const a = anchorOf('species', lineage);
  if (!a) return { groups: [], direct: via.length ? [] : species };
  const { direct, groups } = arrangeChildren({ ...a, childRank: 'species' }, species, via, binomialOf);
  return {
    direct,
    groups: groups.map((g) => {
      const sp = g.members.filter((m) => m.rank === 'Species').length;
      const stats: Record<string, number> = { species: sp };
      if (g.members.length > sp) stats.infraspecific = g.members.length - sp;
      return intermediateToNode(g.node, lineage, 'species', via, stats);
    }),
  };
}

/**
 * Every species-level taxon under a tree node, fixed or intermediate — what a
 * bulk "add everything under it" means for that node.
 */
export function getSpeciesUnderNode(node: TaxonNode): TaxonSpecies[] {
  if (!node.ref) return getSpeciesUnder({ ...node.ancestors, [node.rank_key]: node.name });
  const lineage = node.ancestors;
  const a = anchorOf(node.child_rank, lineage);
  if (!a) return [];
  const via = node.via ?? [];
  if (node.child_rank === 'species') {
    const all = getSpeciesUnder(lineage);
    const g = arrangeChildren({ ...a, childRank: 'species' }, all, via, binomialOf).groups.find(
      (x) => x.node.ref === node.ref,
    );
    return g?.members ?? [];
  }
  const fixed = fixedChildren(node.child_rank as Rank, lineage);
  const g = arrangeChildren({ ...a, childRank: node.child_rank }, fixed, via, (n) => n.name).groups.find(
    (x) => x.node.ref === node.ref,
  );
  const out: TaxonSpecies[] = [];
  for (const m of g?.members ?? []) {
    out.push(...getSpeciesUnder({ ...lineage, [node.child_rank]: m.name }));
  }
  return out;
}

/**
 * The intermediate nodes (outermost first) that stand between a fixed-rank
 * parent and one of its children — what a tree jump must expand on the way.
 * `lineage` is the parent's lineage INCLUDING the parent.
 */
export function intermediateTrail(lineage: Ancestors, childRank: ChildRank, childName: string): TaxonNode[] {
  const a = anchorOf(childRank, lineage);
  if (!a) return [];
  const chain = chainForChild({ ...a, childRank }, childName);
  return chain.map((n, i) => intermediateToNode(n, lineage, childRank, chain.slice(0, i).map((x) => x.ref), {}));
}

// ── Export ──────────────────────────────────────────────────────────────────

/** DwC terms that name an intermediate rank (tdwg/dwc term list). Anything else
 *  — suborder, infraorder … — has no term and only reaches higherClassification. */
export type IntermediateDwcTerms = {
  superfamily: string;
  subfamily: string;
  tribe: string;
  subtribe: string;
  subgenus: string;
};

export type IntermediateClassification = {
  terms: IntermediateDwcTerms;
  /** Raw name per intermediate rank ('subfamily' → 'Ledrinae'). */
  names: Record<string, string>;
  /** Intermediate names right after each fixed rank, top-down, for
   *  `higherClassificationOf`. */
  after: Partial<Record<Rank, string[]>>;
};

/**
 * Classifier for export: a taxon's intermediate ranks from its fixed chain,
 * the user's placements applied, the display mode ignored.
 */
export function createIntermediateClassifier(): (t: {
  kingdom?: string | null;
  phylum?: string | null;
  class?: string | null;
  order?: string | null;
  family?: string | null;
  genus?: string | null;
  simple_name?: string | null;
  rank?: string | null;
}) => IntermediateClassification {
  const resolve = createChainResolver();
  return (t) => {
    const terms: IntermediateDwcTerms = { superfamily: '', subfamily: '', tribe: '', subtribe: '', subgenus: '' };
    const after: Partial<Record<Rank, string[]>> = {};
    const names: Record<string, string> = {};
    const kingdom = (t.kingdom ?? '').trim();
    if (!kingdom) return { terms, after, names };
    const vals: Record<Rank, string> = {
      kingdom,
      phylum: (t.phylum ?? '').trim(),
      class: (t.class ?? '').trim(),
      order: (t.order ?? '').trim(),
      family: (t.family ?? '').trim(),
      genus: (t.genus ?? '').trim(),
    };
    const take = (anchorRank: Rank, childRank: ChildRank, childName: string) => {
      const chain = resolve({ kingdom, anchorRank, anchorName: vals[anchorRank], childRank }, childName);
      if (chain.length === 0) return;
      after[anchorRank] = chain.map((n) => n.name);
      for (const n of chain) {
        names[n.rank] = n.name;
        if (n.rank === 'subgenus') terms.subgenus = vals.genus ? `${vals.genus} (${n.name})` : n.name;
        else if (n.rank in terms) terms[n.rank as keyof IntermediateDwcTerms] = n.name;
      }
    };
    for (let i = 1; i < RANK_ORDER.length; i++) {
      const anchor = RANK_ORDER[i - 1];
      const child = RANK_ORDER[i];
      if (vals[anchor] && vals[child]) take(anchor, child, vals[child]);
    }
    const name = (t.simple_name ?? '').trim();
    if (vals.genus && name.includes(' ')) {
      const binomial = binomialOf({ simple_name: name, rank: t.rank ?? 'Species' } as TaxonSpecies);
      take('genus', 'species', binomial);
    }
    return { terms, after, names };
  };
}

// ── Intermediate ranks on the manual-taxon form ────────────────────────────

/** The optional intermediate fields of the manual-taxon form, grouped by the
 *  fixed-rank anchor they hang under and the child that gets placed. */
export const MANUAL_INTERMEDIATE_GROUPS = [
  { anchor: 'order', child: 'family', ranks: ['superfamily'] },
  { anchor: 'family', child: 'genus', ranks: ['subfamily', 'tribe', 'subtribe'] },
  { anchor: 'genus', child: 'species', ranks: ['subgenus'] },
] as const;
export type ManualIntermediateRank = (typeof MANUAL_INTERMEDIATE_GROUPS)[number]['ranks'][number];
export type ManualIntermediates = Record<ManualIntermediateRank, string>;

type ManualLineage = {
  kingdom: string;
  order: string;
  family: string;
  genus: string;
  simple_name: string;
  rank: string;
};

/** Current values for the form: TaiCOL's placement with the user's applied. */
export function manualIntermediatesOf(t: ManualLineage & { phylum?: string; class?: string }): ManualIntermediates {
  const { names } = createIntermediateClassifier()({ ...t, rank: capitalize(t.rank) });
  return {
    superfamily: names.superfamily ?? '',
    subfamily: names.subfamily ?? '',
    tribe: names.tribe ?? '',
    subtribe: names.subtribe ?? '',
    subgenus: names.subgenus ?? '',
  };
}

/**
 * Apply what the user typed in the form's intermediate fields.
 *
 * Placement is per child, not per species: a subfamily moves the whole GENUS
 * (every species of it) in the tree; a subgenus moves this species. Nodes are
 * reused by name under the same anchor (TaiCOL's first), created otherwise.
 * Only a group the user actually changed is touched, so saving an unrelated
 * edit never pins TaiCOL's current placement as a user override.
 */
export function applyManualIntermediates(
  t: ManualLineage,
  before: ManualIntermediates,
  after: ManualIntermediates,
): void {
  const kingdom = t.kingdom.trim();
  if (!kingdom) return;
  const vals: Record<string, string> = {
    order: t.order.trim(),
    family: t.family.trim(),
    genus: t.genus.trim(),
    species: t.simple_name.includes(' ') ? binomialOf({ simple_name: t.simple_name.trim(), rank: capitalize(t.rank) } as TaxonSpecies) : '',
  };
  for (const g of MANUAL_INTERMEDIATE_GROUPS) {
    const changed = g.ranks.some((r) => before[r].trim() !== after[r].trim());
    const anchorName = vals[g.anchor];
    const childName = vals[g.child];
    if (!changed || !anchorName || !childName) continue;
    let parent: string | null = null;
    for (const r of g.ranks) {
      const name = after[r].trim();
      if (!name) continue;
      parent =
        findIntermediate(kingdom, g.anchor, anchorName, r, name) ??
        createIntermediateNode({ rank: r, simple_name: name, kingdom, anchorRank: g.anchor, anchorName, parentRef: parent });
    }
    // All fields cleared → the user took it out of TaiCOL's intermediate too.
    placeChildren([childKeyOf(kingdom, g.child, childName)], parent);
  }
}

// ── Editing intermediates (IntermediateEditor) ──────────────────────────────

/** Where children of `parent` live: the fixed lineage, their rank, and the
 *  intermediate path already descended into. */
export type LevelContext = {
  lineage: Ancestors;
  childRank: ChildRank;
  via: string[];
  /** Ref a new node under `parent` hangs from; null = the anchor itself. */
  parentRef: string | null;
  parentRank: string;
  kingdom: string;
  anchorRank: Rank;
  anchorName: string;
};

export function levelContext(parent: TaxonNode): LevelContext | null {
  if (parent.name === INCOMPLETE_PHYLUM) return null;
  const lineage: Ancestors = parent.ref ? parent.ancestors : { ...parent.ancestors, [parent.rank_key]: parent.name };
  const via = parent.ref ? [...(parent.via ?? []), parent.ref] : [];
  const a = anchorOf(parent.child_rank, lineage);
  if (!a) return null;
  return {
    lineage,
    childRank: parent.child_rank,
    via,
    parentRef: parent.ref ?? null,
    parentRank: parent.rank_key,
    ...a,
  };
}

/** Ranks a new node under `parent` may take. */
export function ranksForNewChild(parent: TaxonNode): LadderRank[] {
  const ctx = levelContext(parent);
  return ctx ? ranksBetween(ctx.parentRank, ctx.childRank) : [];
}

/** Key `placeChildren` / `clearPlacement` take for a tree node. */
export function placementKeyOf(node: TaxonNode): string | null {
  if (node.ref) return node.ref;
  const kingdom = node.ancestors.kingdom;
  if (!kingdom || node.rank_key === 'kingdom' || node.name === INCOMPLETE_PHYLUM) return null;
  return childKeyOf(kingdom, node.rank_key, node.name);
}

export function speciesPlacementKey(kingdom: string, sp: TaxonSpecies): string {
  return childKeyOf(kingdom, 'species', binomialOf(sp));
}

/** The user moved this child away from TaiCOL's placement. */
export function isPlacementOverridden(node: TaxonNode): boolean {
  const k = placementKeyOf(node);
  return !!k && !k.startsWith('un') && hasOverride(k);
}

export type PlacementCandidate = { key: string; name: string; name_c: string; rank: string; isGroup: boolean };

/** What sits directly at `parent`'s level — the choices for "move these into
 *  the node just created". Groups move with everything under them. */
export function placementCandidates(parent: TaxonNode, excludeRef?: string): PlacementCandidate[] {
  const ctx = levelContext(parent);
  if (!ctx) return [];
  const out: PlacementCandidate[] = [];
  if (ctx.childRank === 'species') {
    const { groups, direct } = arrangeSpecies(ctx.lineage, getSpeciesUnder(ctx.lineage), ctx.via);
    for (const g of groups) {
      if (g.ref === excludeRef) continue;
      out.push({ key: g.ref!, name: g.name, name_c: g.name_c, rank: g.rank_key, isGroup: true });
    }
    const seen = new Set<string>();
    for (const sp of direct) {
      if (sp.rank !== 'Species' || seen.has(sp.simple_name)) continue;
      seen.add(sp.simple_name);
      out.push({
        key: speciesPlacementKey(ctx.kingdom, sp),
        name: sp.simple_name,
        name_c: sp.common_name_c,
        rank: 'species',
        isGroup: false,
      });
    }
    return out;
  }
  for (const n of getTaxonChildren({ rank: ctx.childRank as Rank, ancestors: ctx.lineage, via: ctx.via })) {
    if (n.ref === excludeRef) continue;
    const key = placementKeyOf(n);
    if (!key) continue;
    out.push({ key, name: n.name, name_c: n.name_c, rank: n.rank_key, isGroup: !!n.ref });
  }
  return out;
}

export type ParentCandidate = { ref: string | null; name: string; name_c: string; rank: string; depth: number };

/**
 * Where `node` may be moved: any intermediate under the same anchor ranked
 * above it (never itself or its own descendants), or directly under the anchor.
 */
export function parentCandidates(node: TaxonNode): ParentCandidate[] {
  const lineage = node.ancestors;
  const childRank: ChildRank = node.ref ? node.child_rank : (node.rank_key as ChildRank);
  const a = anchorOf(childRank, lineage);
  if (!a) return [];
  const myIdx = RANK_LADDER.indexOf(node.rank_key as LadderRank);
  const out: ParentCandidate[] = [
    { ref: null, name: a.anchorName, name_c: lineageCname(lineage, a.anchorRank), rank: a.anchorRank, depth: 0 },
  ];
  const walk = (via: string[], depth: number) => {
    const groups =
      childRank === 'species'
        ? arrangeSpecies(lineage, getSpeciesUnder(lineage), via).groups
        : getTaxonChildren({ rank: childRank as Rank, ancestors: lineage, via }).filter((n) => !!n.ref);
    for (const g of groups) {
      if (g.ref === node.ref) continue; // itself and everything below it
      const gIdx = RANK_LADDER.indexOf(g.rank_key as LadderRank);
      if (myIdx < 0 || gIdx < 0 || gIdx < myIdx) {
        out.push({ ref: g.ref!, name: g.name, name_c: g.name_c, rank: g.rank_key, depth });
      }
      walk([...via, g.ref!], depth + 1);
    }
  };
  walk([], 1);
  return out;
}

function lineageCname(lineage: Ancestors, rank: Rank): string {
  const col = RANK_C_COL[rank];
  const name = lineage[rank];
  if (!col || !name) return '';
  for (const scope of nameScopes()) {
    const res = scope.db.executeSync(
      `SELECT ${col} AS c FROM ${scope.table} WHERE ${quoteCol(rank)} = ? AND ${col} IS NOT NULL AND ${col} != '' LIMIT 1`,
      [name],
    );
    const c = ((res.rows ?? [])[0] as { c?: string } | undefined)?.c;
    if (c) return c;
  }
  return '';
}

/** Same trail, ending at an intermediate node itself (tree search hit). */
function trailToRef(lineage: Ancestors, childRank: ChildRank, ref: string): TaxonNode[] {
  const path = visiblePathOf(ref);
  return path.map((n, i) => intermediateToNode(n, lineage, childRank, path.slice(0, i).map((x) => x.ref), {}));
}

export type TaxonSpecies = {
  taxon_id: string;
  simple_name: string;
  name_author: string;
  common_name_c: string;
  family: string;
  family_c: string;
  rank: string;
  is_endemic: string;
  alien_type: string;
  redlist: string;
  iucn: string;
  cites: string;
  protected: string;
  is_hybrid: string;
  kingdom: string;
  kingdom_c: string;
  phylum: string;
  phylum_c: string;
  class: string;
  class_c: string;
  order: string;
  order_c: string;
  genus: string;
  genus_c: string;
  alternative_name_c: string;
  nomenclature_name: string;
  alien_status_note: string;
  is_autonym: boolean;
  /** ISO country code of the region pack this row came from (GBIF-derived,
   *  not checklist-verified) — drives the provenance badge. */
  pack_country?: string;
};

/** Merge preference when the same scientific name appears in several sources:
 *  TaiCOL ('t…') carries the richest data, then YList ('y…'), then packs. */
function idPreference(taxonId: string): number {
  const c = taxonId.charAt(0);
  return c === 't' ? 0 : c === 'y' ? 1 : 2;
}

function packRowToTaxonSpecies(r: PackSpeciesRow): TaxonSpecies {
  // Pack ranks are lowercase; the tree's autonym check and rank chips expect
  // TaiCOL-style capitalized values.
  const rank = r.rank ? r.rank.charAt(0).toUpperCase() + r.rank.slice(1) : '';
  return {
    taxon_id: r.taxon_id,
    simple_name: r.simple_name,
    name_author: r.name_author,
    common_name_c: '',
    family: r.family,
    family_c: '',
    rank,
    is_endemic: '',
    alien_type: '',
    redlist: '',
    iucn: r.iucn,
    cites: '',
    protected: '',
    is_hybrid: '',
    kingdom: r.kingdom,
    kingdom_c: '',
    phylum: r.phylum,
    phylum_c: '',
    class: r.class,
    class_c: '',
    order: r.order,
    order_c: '',
    genus: r.genus,
    genus_c: '',
    alternative_name_c: '',
    nomenclature_name: '',
    alien_status_note: '',
    is_autonym: isAutonym(r.simple_name, rank),
    pack_country: r.country_code,
  };
}

function isAutonym(simpleName: string, rank: string): boolean {
  if (!['Subspecies', 'Variety', 'Form'].includes(rank)) return false;
  const parts = (simpleName || '').split(/\s+/);
  return parts.length >= 3 && parts[1] === parts[parts.length - 1];
}

const TAXON_SPECIES_COLUMNS = `
  taxon_id, simple_name, name_author, common_name_c, family, family_c, rank,
  is_endemic, alien_type, redlist, iucn, cites, protected, is_hybrid,
  kingdom, kingdom_c, phylum, phylum_c, class, class_c, "order", order_c,
  genus, genus_c, alternative_name_c, nomenclature_name, alien_status_note
`;

function taxonRowToSpecies(row: Record<string, unknown>): TaxonSpecies {
  return {
    taxon_id: (row.taxon_id as string) ?? '',
    simple_name: (row.simple_name as string) ?? '',
    name_author: (row.name_author as string) ?? '',
    common_name_c: (row.common_name_c as string) ?? '',
    family: (row.family as string) ?? '',
    family_c: (row.family_c as string) ?? '',
    rank: (row.rank as string) ?? '',
    is_endemic: (row.is_endemic as string) ?? '',
    alien_type: (row.alien_type as string) ?? '',
    redlist: (row.redlist as string) ?? '',
    iucn: (row.iucn as string) ?? '',
    cites: (row.cites as string) ?? '',
    protected: (row.protected as string) ?? '',
    is_hybrid: (row.is_hybrid as string) ?? '',
    kingdom: (row.kingdom as string) ?? '',
    kingdom_c: (row.kingdom_c as string) ?? '',
    phylum: (row.phylum as string) ?? '',
    phylum_c: (row.phylum_c as string) ?? '',
    class: (row.class as string) ?? '',
    class_c: (row.class_c as string) ?? '',
    order: (row.order as string) ?? '',
    order_c: (row.order_c as string) ?? '',
    genus: (row.genus as string) ?? '',
    genus_c: (row.genus_c as string) ?? '',
    alternative_name_c: (row.alternative_name_c as string) ?? '',
    nomenclature_name: (row.nomenclature_name as string) ?? '',
    alien_status_note: (row.alien_status_note as string) ?? '',
    is_autonym: isAutonym((row.simple_name as string) ?? '', (row.rank as string) ?? ''),
  };
}

export function getSpeciesUnder(ancestors?: Ancestors): TaxonSpecies[] {
  const regions = getEnabledRegions();
  const scopes = nameScopes();
  let species: TaxonSpecies[] = [];
  for (const scope of scopes) {
    let where = `usage_status='accepted' AND ${scope.taiwanClause} AND rank IN ('Species','Subspecies','Variety','Form')`;
    const params: string[] = [];
    where += buildAncestorWhere(ancestors, params);
    const sql = `SELECT ${TAXON_SPECIES_COLUMNS} FROM ${scope.table} WHERE ${where} ORDER BY simple_name`;
    const res = scope.db.executeSync(sql, params);
    species = species.concat(
      ((res.rows ?? []) as Array<Record<string, unknown>>).map(taxonRowToSpecies),
    );
  }
  // The incomplete bucket holds only manual taxa; no checklist or pack query
  // can match its sentinel phylum, so skip straight to them.
  if (ancestors?.phylum === INCOMPLETE_PHYLUM) return manualSpeciesUnder(ancestors);

  const packRows = packSpeciesUnder(ancestors).map(packRowToTaxonSpecies);
  // 兩個以上來源就要去重（共有種以 TaiCOL > YList > pack 為準）——來源現在是
  // 「可用模組數 + pack」，不再是 region 旗標。
  const manualRows = manualSpeciesUnder(ancestors);
  const multiSource = packRows.length > 0 || manualRows.length > 0 || scopes.length > 1;
  if (packRows.length > 0) species = species.concat(packRows);
  // Appended last on purpose. Manual ids start 'gm…', so `idPreference` scores
  // them 2 — tied with packs, beaten by TaiCOL/YList. The dedup keeps the
  // first row at the best score, so appending after packs makes a pack win the
  // tie. Either way a checklist row wins, which is what matters: a manual
  // taxon duplicating a checklist name is a mistake to hide, not to show twice.
  if (manualRows.length > 0) species = species.concat(manualRows);

  if (multiSource) {
    // Collapse shared species (same scientific name across sources) to one
    // row, preferring TaiCOL > YList > pack for hierarchy/conservation.
    const byKey = new Map<string, TaxonSpecies>();
    for (const sp of species) {
      const key = normalizeSci(sp.simple_name);
      const existing = byKey.get(key);
      if (!existing || idPreference(sp.taxon_id) < idPreference(existing.taxon_id)) {
        byKey.set(key, sp);
      }
    }
    species = [...byKey.values()].sort((a, b) => a.simple_name.localeCompare(b.simple_name));
  }
  if (regions.includes('TW') && regions.includes('JP')) {
    // Cross-region vernacular ("臺灣俗名 / 和名") only means something with
    // both bundled regions on.
    const cross = crossRegionVernacular(
      species.map((sp) => sp.taxon_id),
      regions,
    );
    const langs = getVernacularLangs();
    species = species.map((sp) => ({
      ...sp,
      common_name_c: composeVernacular(
        sp.common_name_c,
        regionOfTaxonId(sp.taxon_id),
        cross.get(sp.taxon_id),
        regions,
        langs,
      ),
    }));
  }
  return species;
}

function getSpeciesAsNodes(): TaxonNode[] {
  // The actual species rendering uses getSpeciesUnder + a different list UI.
  return [];
}

/** Accepted infraspecies (Subspecies / Variety / Form) sitting under a binomial
 *  species name. Used by the species detail panel to surface "下級分類群". The
 *  caller passes the binomial + the species' ancestor chain so we can defend
 *  against homonym genera by matching ancestors as well as the LIKE prefix. */
export function getInfraspeciesOf(
  speciesName: string,
  ancestors?: Ancestors,
): TaxonSpecies[] {
  if (!speciesName || speciesName.split(/\s+/).length !== 2) return [];
  const scopes = nameScopes();
  let out: TaxonSpecies[] = [];
  for (const scope of scopes) {
    const pattern = `${speciesName.replace(/%/g, '\\%').replace(/_/g, '\\_')} %`;
    const params: string[] = [pattern, speciesName];
    let where = `simple_name LIKE ? ESCAPE '\\'
        AND simple_name != ?
        AND rank IN ('Subspecies','Variety','Form')
        AND usage_status='accepted'
        AND ${scope.taiwanClause}`;
    where += buildAncestorWhere(ancestors, params);
    const sql = `SELECT ${TAXON_SPECIES_COLUMNS} FROM ${scope.table} WHERE ${where} ORDER BY simple_name`;
    const res = scope.db.executeSync(sql, params);
    out = out.concat(((res.rows ?? []) as Array<Record<string, unknown>>).map(taxonRowToSpecies));
  }
  const packRows = packInfraspeciesOf(speciesName, ancestors).map(packRowToTaxonSpecies);
  if (packRows.length > 0 || scopes.length > 1) {
    const byKey = new Map<string, TaxonSpecies>();
    for (const sp of [...out, ...packRows]) {
      const key = normalizeSci(sp.simple_name);
      const existing = byKey.get(key);
      if (!existing || idPreference(sp.taxon_id) < idPreference(existing.taxon_id)) {
        byKey.set(key, sp);
      }
    }
    out = [...byKey.values()].sort((a, b) => a.simple_name.localeCompare(b.simple_name));
  }
  return out;
}

/**
 * Taxonomy search: find taxa by Chinese / Latin name across all ranks.
 * Returns each match with the full ancestor path for tree expansion.
 *
 * Port of backend taxonomy_search (skips virus realm prefix for MVP).
 */
export type TaxonSearchHit = {
  display: string;
  name: string;
  cname: string;
  rank: string;
  author: string;
  path: Array<{ rank: Rank; value: string }>;
  /** Set when the user's query matched a synonym that resolved to this
   *  accepted name (mirrors SearchResult.matched_as in the main search). */
  matched_as?: { name: string; fullname: string; status: string };
  /** Set when this hit came from the fuzzy (Levenshtein) fallback. */
  fuzzy_match?: { query: string; matched: string; score: number };
  /** Intermediate-rank hit (subfamily …): its ref. `path` then ends at the
   *  fixed-rank anchor it hangs under. */
  ref?: string;
};

/** Fixed lineage of an anchor taxon, read off any accepted row under it. */
function anchorPath(kingdom: string, anchorRank: string, anchorName: string): Array<{ rank: Rank; value: string }> | null {
  const idx = RANK_ORDER.indexOf(anchorRank as Rank);
  if (idx < 0) return null;
  const col = quoteCol(anchorRank);
  for (const scope of nameScopes()) {
    const res = scope.db.executeSync(
      `SELECT kingdom, phylum, class, "order", family, genus FROM ${scope.table}
        WHERE kingdom = ? AND ${col} = ? AND usage_status='accepted' AND ${scope.taiwanClause}
          AND rank IN ('Species','Subspecies','Variety','Form')
        LIMIT 1`,
      [kingdom, anchorName],
    );
    const row = (res.rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!row) continue;
    const path: Array<{ rank: Rank; value: string }> = [];
    for (const r of RANK_ORDER.slice(0, idx + 1)) {
      const v = (row[r] as string) ?? '';
      if (!v) return null;
      path.push({ rank: r, value: v });
    }
    return path;
  }
  return null;
}

/** Intermediate nodes a search hit for an intermediate taxon must expand. */
export function trailForHit(hit: TaxonSearchHit): TaxonNode[] {
  if (!hit.ref || hit.path.length === 0) return [];
  const lineage: Ancestors = {};
  for (const p of hit.path) lineage[p.rank] = p.value;
  const anchorIdx = RANK_ORDER.indexOf(hit.path[hit.path.length - 1].rank);
  const childRank: ChildRank = anchorIdx + 1 < RANK_ORDER.length ? RANK_ORDER[anchorIdx + 1] : 'species';
  return trailToRef(lineage, childRank, hit.ref);
}

/** Map a species-level `SearchResult` (from the main search pipeline, which
 *  already does synonym resolution + fuzzy fallback) onto a `TaxonSearchHit`
 *  so the taxonomy tree can expand to it. The ancestor `path` is built from
 *  the accepted row's hierarchy columns. */
function resultToTaxonHit(r: SearchResult): TaxonSearchHit {
  const levelVals: Record<Rank, string> = {
    kingdom: r.kingdom,
    phylum: r.phylum,
    class: r.class_name,
    order: r.order,
    family: r.family,
    genus: r.genus,
  };
  const path: Array<{ rank: Rank; value: string }> = [];
  for (const level of RANK_ORDER) {
    const val = levelVals[level];
    if (val) path.push({ rank: level, value: val });
  }
  const display = r.cname ? `${r.cname} (${r.name})` : r.name;
  return {
    display,
    name: r.name,
    cname: r.cname,
    rank: r.rank,
    author: r.fullname.replace(r.name, '').trim(),
    path,
    matched_as: r.matched_as,
    fuzzy_match: r.fuzzy_match,
  };
}

function escapeLike(s: string): string {
  return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function normalizeTw(q: string): string[] {
  const variants = [q];
  if (q.includes('台')) variants.push(q.replaceAll('台', '臺'));
  else if (q.includes('臺')) variants.push(q.replaceAll('臺', '台'));
  return variants;
}

const RANK_PRIORITY: Record<string, number> = {
  Phylum: 1,
  Class: 2,
  Order: 3,
  Family: 4,
  Genus: 5,
  Species: 6,
  Subspecies: 6,
  Variety: 6,
  Form: 6,
};

export function searchTaxonomy(q: string): TaxonSearchHit[] {
  const trimmed = q.trim();
  if (trimmed.length < 1) return [];

  const variants = normalizeTw(trimmed);

  const conditions: string[] = [];
  const params: string[] = [];
  const cols = ['common_name_c', 'simple_name', 'family_c', 'family', 'genus', 'genus_c', 'order_c', 'class_c', 'phylum_c'];
  for (const v of variants) {
    const pattern = `%${escapeLike(v)}%`;
    for (const col of cols) {
      conditions.push(`${col} LIKE ? ESCAPE '\\'`);
      params.push(pattern);
    }
  }

  // 每個模組各自掃、各自吃 LIMIT 50，再在 JS 併起來（下面既有的 `rank:name`
  // 去重會把兩邊都有的分類群收斂成一筆）。
  let rows: Array<Record<string, unknown>> = [];
  for (const scope of nameScopes()) {
    const sql = `
      SELECT DISTINCT simple_name, common_name_c, rank,
             kingdom, kingdom_c, phylum, phylum_c,
             class, class_c, "order", order_c,
             family, family_c, genus, genus_c,
             name_author
      FROM ${scope.table}
      WHERE (${conditions.join(' OR ')})
        AND usage_status = 'accepted'
        AND ${scope.taiwanClause}
        AND rank IN ('Species', 'Subspecies', 'Variety', 'Form', 'Genus', 'Family', 'Order', 'Class', 'Phylum')
      LIMIT 50
    `;
    const res = scope.db.executeSync(sql, params);
    rows = rows.concat((res.rows ?? []) as Array<Record<string, unknown>>);
  }

  const hits: TaxonSearchHit[] = rows.map((r) => {
    const cname = (r.common_name_c as string) ?? '';
    const sname = (r.simple_name as string) ?? '';
    const rank = (r.rank as string) ?? '';
    const display = cname ? `${cname} (${sname})` : sname;

    const path: Array<{ rank: Rank; value: string }> = [];
    for (const level of RANK_ORDER) {
      const val = (r[level] as string) ?? '';
      if (val) path.push({ rank: level, value: val });
    }

    return {
      display,
      name: sname,
      cname,
      rank,
      author: (r.name_author as string) ?? '',
      path,
    };
  });

  // Pack higher-taxon hits, 照臺灣模式: TaiCOL's sweep above returns
  // family/genus-rank rows with rank badge + lineage; packs store only
  // genus-and-below, so equivalent hits are synthesized from distinct
  // lineages of matching pack rows. Species-level pack hits arrive via the
  // fuzzy augment below.
  const packSeen = new Set(hits.map((h) => `${h.rank}:${h.name}`));
  for (const rankName of ['family', 'genus'] as const) {
    for (const lin of searchPackLineages(rankName, variants)) {
      const name = rankName === 'genus' ? lin.genus : lin.family;
      if (!name) continue;
      // A TW/JP row of the same taxon already produced this hit (with its
      // Chinese name) — the synthesized pack hit would be a bare duplicate.
      const key = `${rankName === 'genus' ? 'Genus' : 'Family'}:${name}`;
      if (packSeen.has(key)) continue;
      packSeen.add(key);
      const path: Array<{ rank: Rank; value: string }> = [];
      for (const level of RANK_ORDER) {
        if (level === 'genus' && rankName === 'family') break;
        const val = lin[level];
        if (val) path.push({ rank: level, value: val });
      }
      hits.push({
        display: name,
        name,
        cname: '',
        rank: rankName === 'genus' ? 'Genus' : 'Family',
        author: '',
        path,
      });
    }
  }

  // Intermediate ranks (subfamily, tribe …; TaiCOL and user-created). Only
  // those whose anchor the tree can reach are offered.
  try {
    for (const n of searchIntermediate(trimmed)) {
      const path = anchorPath(n.kingdom, n.anchorRank, n.anchorName);
      if (!path) continue;
      hits.push({
        display: n.name_c ? `${n.name_c} (${n.name})` : n.name,
        name: n.name,
        cname: n.name_c,
        rank: capitalize(n.rank),
        author: n.name_author ?? '',
        path,
        ref: n.ref,
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[searchTaxonomy] intermediate search failed:', e);
  }

  // Augment with synonym + fuzzy species matches by reusing the main search
  // pipeline (searchWithFuzzyFallback already resolves synonyms to accepted
  // names and falls back to the Levenshtein cname index). The accepted row's
  // hierarchy gives us the ancestor path for tree expansion. Dedupe against
  // the LIKE hits above by rank:name so direct matches aren't doubled.
  const seen = new Set(hits.map((h) => `${h.rank}:${h.name}`));
  try {
    for (const r of searchWithFuzzyFallback({ q: trimmed })) {
      const key = `${r.rank}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(resultToTaxonHit(r));
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[searchTaxonomy] synonym/fuzzy augment failed:', e);
  }

  hits.sort((a, b) => {
    // 精確命中的俗名／學名永遠優先於 rank 高低。使用者打「櫸」要的是櫸樹
    // (Zelkova serrata)，不是櫸屬；而單字查詢會命中大量屬名／科名，高階類群
    // 在 RANK_PRIORITY 下一律排在 Species 前面 —— 沒有這一層，「芒」的精確列
    // 會落到第 47 名而被下面的 slice(0, 20) 整個切掉，使用者根本看不到。
    const exactRank = (h: TaxonSearchHit): number =>
      h.cname === trimmed ? 0 : h.name === trimmed ? 1 : 2;
    const ea = exactRank(a);
    const eb = exactRank(b);
    if (ea !== eb) return ea - eb;
    const pa = RANK_PRIORITY[a.rank] ?? 9;
    const pb = RANK_PRIORITY[b.rank] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  return hits.slice(0, 20);
}
