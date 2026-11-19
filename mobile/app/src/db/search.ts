import { datasetForTaxonId, getDatasetDb } from './datasets';
import i18n from '~/i18n';
import { isJpTaxonId, sourceOfTaxonId } from './regions';
import { externalToSearchResult, getExternalTaxon } from './externalTaxa';
import type { TaicolRow, SearchResult, AdvancedFilters, TaxonGroup } from './types';

export const TAXON_GROUP_FILTERS: Record<TaxonGroup, Partial<Record<'kingdom' | 'phylum' | 'class', string>>> = {
  Tracheophyta: { phylum: 'Tracheophyta' },
  Plantae: { kingdom: 'Plantae' },
  Aves: { class: 'Aves' },
  Fungi: { kingdom: 'Fungi' },
  Mammalia: { class: 'Mammalia' },
  Reptilia: { class: 'Reptilia' },
  Insecta: { class: 'Insecta' },
  Arachnida: { class: 'Arachnida' },
  Mollusca: { phylum: 'Mollusca' },
  Actinopterygii: { class: 'Actinopterygii' },
  Amphibia: { class: 'Amphibia' },
  Protozoa: { kingdom: 'Protozoa' },
  Animalia: { kingdom: 'Animalia' },
};

/**
 * Build an OR-combined taxon-group filter clause for `groups`. Within one
 * group the column conditions (kingdom/phylum/class) are AND-ed; the groups
 * themselves are OR-ed, so picking birds + mammals returns the union, not
 * the (empty) intersection. Bound values are pushed onto `params`. Returns
 * '' when there are no valid groups (i.e. all groups). Shared by `searchSpecies`
 * and the fuzzy fallback so both honour the same multi-select filter.
 */
export function groupFilterClause(
  groups: TaxonGroup[] | undefined,
  params: (string | number)[],
): string {
  if (!groups || groups.length === 0) return '';
  const ors: string[] = [];
  for (const g of groups) {
    const filter = TAXON_GROUP_FILTERS[g];
    if (!filter) continue;
    const ands: string[] = [];
    for (const [field, value] of Object.entries(filter)) {
      ands.push(`"${field}" = ?`);
      params.push(value);
    }
    if (ands.length > 0) ors.push(ands.length > 1 ? `(${ands.join(' AND ')})` : ands[0]);
  }
  return ors.length > 0 ? ` AND (${ors.join(' OR ')})` : '';
}

const ALIEN_TYPE_KEY: Record<string, string> = {
  native: 'alien.native',
  naturalized: 'alien.naturalized',
  invasive: 'alien.naturalized',
};

function mapAlienType(alienType: string, kingdom: string): string {
  if (alienType === 'cultured') return i18n.t(kingdom === 'Animalia' ? 'alien.captive' : 'alien.cultivated');
  return ALIEN_TYPE_KEY[alienType] ? i18n.t(ALIEN_TYPE_KEY[alienType]) : (alienType ?? '');
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

function isAutonym(simpleName: string, rank: string): boolean {
  if (!['Subspecies', 'Variety', 'Form'].includes(rank)) return false;
  const parts = simpleName.split(/\s+/);
  return parts.length >= 3 && parts[1] === parts[parts.length - 1];
}

function buildPtName(row: TaicolRow): string {
  const parts: string[] = [];
  if (row.phylum) parts.push(row.phylum);
  if (row.class) parts.push(row.class);
  return parts.length > 0 ? parts.join(' > ') : row.kingdom ?? '';
}

function rowToResult(
  row: TaicolRow,
  displayCname: string = '',
  matchedRow: TaicolRow | null = null,
): SearchResult {
  const fullname = row.name_author ? `${row.simple_name ?? ''} ${row.name_author}` : (row.simple_name ?? '');

  const result: SearchResult = {
    id: row.name_id,
    name: row.simple_name ?? '',
    fullname,
    cname: displayCname || (row.common_name_c ?? ''),
    _raw_cname: row.common_name_c ?? '',
    family: row.family ?? '',
    family_cname: row.family_c ?? '',
    iucn_category: row.iucn ?? '',
    redlist: row.redlist ?? '',
    endemic: row.is_endemic === 'true' ? 1 : 0,
    source: mapAlienType(row.alien_type ?? '', row.kingdom ?? ''),
    alien_type: row.alien_type ?? '',
    pt_name: buildPtName(row),
    taxon_id: row.taxon_id ?? '',
    usage_status: 'accepted',
    alternative_name_c: row.alternative_name_c ?? '',
    kingdom: row.kingdom ?? '',
    kingdom_c: row.kingdom_c ?? '',
    phylum: row.phylum ?? '',
    phylum_c: row.phylum_c ?? '',
    class_name: row.class ?? '',
    class_c: row.class_c ?? '',
    order: row.order ?? '',
    order_c: row.order_c ?? '',
    genus: row.genus ?? '',
    genus_c: row.genus_c ?? '',
    nomenclature_name: row.nomenclature_name ?? '',
    cites: row.cites ?? '',
    protected: row.protected ?? '',
    is_hybrid: row.is_hybrid ?? '',
    is_terrestrial: row.is_terrestrial ?? '',
    is_freshwater: row.is_freshwater ?? '',
    is_brackish: row.is_brackish ?? '',
    is_marine: row.is_marine ?? '',
    is_fossil: row.is_fossil ?? '',
    alien_status_note: row.alien_status_note ?? '',
    rank: row.rank ?? '',
    is_autonym: isAutonym(row.simple_name ?? '', row.rank ?? ''),
    is_sensu_lato: false,
    region: datasetForTaxonId(row.taxon_id ?? '')?.region ?? 'TW',
  };

  if (matchedRow && matchedRow.usage_status !== 'accepted') {
    const matchedFullname = matchedRow.name_author
      ? `${matchedRow.simple_name ?? ''} ${matchedRow.name_author}`
      : (matchedRow.simple_name ?? '');
    result.matched_as = {
      name: matchedRow.simple_name ?? '',
      fullname: matchedFullname,
      status: matchedRow.usage_status ?? '',
      // Only TaiCOL name_ids are stable identifiers. jp_names mints its own in
      // a private offset range that is renumbered on every wamei re-import, so
      // those must never be persisted on a record.
      ...(isJpTaxonId(matchedRow.taxon_id) ? {} : { name_id: matchedRow.name_id }),
    };
  }

  return result;
}

function markSensuLato(results: SearchResult[]): SearchResult[] {
  const db = getDatasetDb('tw-taicol');
  // With the module absent, mark nothing s.l. — there is no data to judge by,
  // and returning the results unchanged beats guessing.
  if (!db) return results;
  const speciesNames = results
    .filter((r) => r.usage_status === 'accepted' && !r.is_autonym && r.name && r.name.split(' ').length === 2)
    .map((r) => r.name);
  if (speciesNames.length === 0) return results;

  // One statement for the whole result set, not one per row.
  //
  // The old shape was `simple_name LIKE 'Genus species %'` per species, and it
  // cost ~17 ms EACH on a Mac — every keystroke in the search box paid it for
  // every binomial on screen. Two separate problems:
  //
  //  1. LIKE cannot use an index, so each call fell through to
  //     `idx_taicol_usage_status`, which matches roughly half the table.
  //  2. N statements meant N plan lookups and N result sets.
  //
  // Fixed by turning the prefix match into a RANGE (`>= 'X ' AND < 'X!'` —
  // exact, because ' ' is 0x20 and '!' is 0x21, so every string starting with
  // `'X '` sorts below `'X!'`), and joining all the ranges in one go through a
  // VALUES CTE. Each range is then an index seek on `idx_taicol_simple_name`.
  //
  // The unary `+` on `usage_status` is load-bearing: without it the planner
  // still prefers that low-selectivity index and the whole gain disappears
  // (measured: 34 ms with it left in, 0.06 ms with the `+`). Same trap as
  // memory `feedback-sql-estimate-vs-real-device`.
  //
  // Measured on the shipped module, 300 binomials: 4,923 ms → 9 ms, identical
  // results. Verify with EXPLAIN QUERY PLAN after any edit — the expected plan
  // is `SEARCH t USING INDEX idx_taicol_simple_name (simple_name>? AND simple_name<?)`.
  const slSpecies = new Set<string>();
  const ranges = speciesNames.map(() => '(?,?)').join(',');
  const rangeParams: string[] = [];
  for (const sp of speciesNames) rangeParams.push(`${sp} `, `${sp}!`);
  const res = db.executeSync(
    `WITH p(lo, hi) AS (VALUES ${ranges})
     SELECT DISTINCT t.simple_name FROM p JOIN taicol_names t
       ON t.simple_name >= p.lo AND t.simple_name < p.hi
      WHERE +t.usage_status = 'accepted'
        AND t.is_in_taiwan LIKE '%true%'
        AND t.rank IN ('Subspecies','Variety','Form')`,
    rangeParams,
  );
  // An infraspecific name's binomial is its first two tokens; intersecting with
  // what we asked for keeps a stray match from marking a species we never
  // queried.
  const asked = new Set(speciesNames);
  for (const row of (res.rows ?? []) as unknown as { simple_name: string }[]) {
    const binomial = (row.simple_name ?? '').split(/\s+/).slice(0, 2).join(' ');
    if (asked.has(binomial)) slSpecies.add(binomial);
  }

  return results.map((r) => (slSpecies.has(r.name) ? { ...r, is_sensu_lato: true } : r));
}

export type SearchOptions = {
  q: string;
  /** One or more taxon groups to restrict the search to (OR-combined). Empty
   *  / undefined = all groups (no restriction). */
  groups?: TaxonGroup[];
  advanced?: AdvancedFilters;
  limit?: number;
};

/** Lookup a taxon by its TaiCOL taxon_id, returning the full SearchResult
 *  shape so the result fits into existing UI like LookupResultSheet. */
export function searchByTaxonId(taxonId: string): SearchResult | null {
  if (!taxonId) return null;
  // Three namespaces, three homes. External ('g…') taxa live in user.db and
  // have no row in twnamelist.db at all — sending one to taicol_names is
  // exactly the silent-null that regions.ts warns about, and it is what made
  // an externally-added species un-openable and un-addable from Favorites.
  if (sourceOfTaxonId(taxonId) === 'external') {
    const ext = getExternalTaxon(taxonId);
    return ext ? externalToSearchResult(ext) : null;
  }
  // Prefix → module is decided by the registry (jp_names / taicol_names are no
  // longer hard-coded). With the module not installed, return null — that is the
  // existing "cannot resolve" contract, and every caller already handles it.
  const spec = datasetForTaxonId(taxonId);
  if (!spec || spec.tables.kind !== 'names') return null;
  const db = getDatasetDb(spec.id);
  if (!db) return null;
  // Query the dataset's real table directly (no UNION view). Prefer the
  // accepted row; fall back to any row so synonyms still surface basic
  // metadata.
  const table = spec.tables.names;
  // `+usage_status` keeps the taxon_id index (see resolveTaxa in taxonLookup.ts).
  let res = db.executeSync(
    `SELECT ${SEARCH_COLUMNS} FROM ${table} WHERE taxon_id = ? AND +usage_status = 'accepted' LIMIT 1`,
    [taxonId],
  );
  let row = (res.rows ?? [])[0] as TaicolRow | undefined;
  if (!row) {
    res = db.executeSync(`SELECT ${SEARCH_COLUMNS} FROM ${table} WHERE taxon_id = ? LIMIT 1`, [taxonId]);
    row = (res.rows ?? [])[0] as TaicolRow | undefined;
  }
  if (!row) return null;
  return rowToResult(row);
}

/** Explicit column list used by `searchSpecies` / `searchByTaxonId` / fuzzy —
 *  exactly the 33 fields `rowToResult` consumes. Selecting these instead of
 *  `SELECT *` cuts JSI marshalling cost roughly in half (taicol_names has
 *  ~70 columns; many are large nullable text like author / status notes
 *  that we don't need in the autocomplete row). Exported so `fuzzy.ts` can
 *  reuse the same projection. */
export const SEARCH_COLUMNS = [
  'name_id',
  'simple_name',
  'name_author',
  'common_name_c',
  'alternative_name_c',
  'family',
  'family_c',
  'iucn',
  'redlist',
  'is_endemic',
  'alien_type',
  'taxon_id',
  'usage_status',
  'kingdom',
  'kingdom_c',
  'phylum',
  'phylum_c',
  '"class"',
  'class_c',
  '"order"',
  'order_c',
  'genus',
  'genus_c',
  'nomenclature_name',
  'cites',
  'protected',
  'is_hybrid',
  'is_terrestrial',
  'is_freshwater',
  'is_brackish',
  'is_marine',
  'is_fossil',
  'alien_status_note',
  'rank',
].join(', ');

/**
 * Accepted-name lookup on an exactly equal name — the fast path for batch import.
 *
 * `searchSpecies`'s `LIKE '%q%'` is a full scan of 270k rows (measured ~95 ms per
 * call on a Mac), plus one more `markSensuLato` LIKE per result row (~17 ms per
 * row); pasting 100 species and pressing "Preview" pays these costs 100 times,
 * which on a real device is what the user called "pretty slow". But the usual
 * batch-import case is "the names are already typed correctly", and then an
 * equality query on idx_taicol_common_name / idx_taicol_simple_name takes only
 * ~0.03 ms (measured: 279 of 300 common names hit directly, 297 once the
 * nominal-infraspecific dedup below is counted).
 *
 * Answers only when **exactly one row** is exactly equal: 0 rows (typo, synonym)
 * or 2+ rows (different taxa sharing a common name, a species and its nominal
 * infraspecific) both return an empty array, so the caller takes the original
 * full search, and fuzzy matching, synonym resolution and multi-candidate
 * picking all behave exactly as before.
 */
export function lookupExactAccepted(q: string): SearchResult[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const db = getDatasetDb('tw-taicol');
  if (!db) return [];
  const variants = normalizeTw(trimmed);
  const pairs = variants.map(() => '(common_name_c = ? OR simple_name = ?)').join(' OR ');
  const params: string[] = [];
  for (const v of variants) params.push(v, v);
  // When the checklist was split into modules this function only swapped its
  // handle; **not one character of the SQL changed** — the part below was measured.
  //
  // The plus in `+usage_status` is not a typo: writing `usage_status = 'accepted'`
  // makes SQLite switch to idx_taicol_usage_status — a low-selectivity index where
  // almost the whole table holds the same value. Measured: 0.02 ms became 20 ms,
  // which makes the fast path pointless. SQLite's unary `+` keeps that condition
  // out of index selection, so the plan stays on MULTI-INDEX OR
  // (idx_taicol_common_name / idx_taicol_simple_name), while accepted names are
  // still filtered by SQL itself (so LIMIT does not cut off a common name like
  // 「馬鈴薯」, which over three hundred rows share).
  const res = db.executeSync(
    `SELECT ${SEARCH_COLUMNS} FROM taicol_names WHERE (${pairs}) ` +
      `AND +usage_status = 'accepted' AND is_in_taiwan LIKE '%true%' LIMIT 5`,
    params,
  );
  const rows = (res.rows ?? []) as unknown as TaicolRow[];
  const seen = new Set<string | number>();
  const unique: TaicolRow[] = [];
  for (const row of rows) {
    const key = row.taxon_id || row.name_id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  // The same "species + nominal infraspecific sharing a common name" dedup as
  // `searchSpecies`. Without it, a common pairing like 「豬殃殃」 (Galium spurium
  // and G. spurium fo. vaillantii share the common name) counts as multiple rows
  // and needlessly falls back to the full-table scan — 6% of a 300-name sample
  // are like this.
  const cnameSpecies = new Map<string, string>();
  for (const row of unique) {
    if (row.common_name_c && row.rank === 'Species') {
      cnameSpecies.set(row.common_name_c, row.simple_name ?? '');
    }
  }
  const kept = unique.filter((row) => {
    const cn = row.common_name_c ?? '';
    if (cn && ['Form', 'Variety', 'Subspecies'].includes(row.rank ?? '') && cnameSpecies.has(cn)) {
      if ((row.simple_name ?? '').startsWith(cnameSpecies.get(cn)!)) return false;
    }
    return true;
  });
  return kept.map((row) => rowToResult(row));
}

export function searchSpecies({ q, groups, advanced = {}, limit = 30 }: SearchOptions): SearchResult[] {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const db = getDatasetDb('tw-taicol');
  if (!db) return [];
  const variants = normalizeTw(trimmed);

  const likePatterns: string[] = [];
  const params: (string | number)[] = [];

  for (const v of variants) {
    const pattern = `%${escapeLike(v)}%`;
    likePatterns.push(
      "common_name_c LIKE ? ESCAPE '\\'",
      "alternative_name_c LIKE ? ESCAPE '\\'",
      "simple_name LIKE ? ESCAPE '\\'",
      "family LIKE ? ESCAPE '\\'",
      "family_c LIKE ? ESCAPE '\\'",
    );
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  // The filter clause and its params accumulate separately, so the "exact-row
  // top-up" below applies exactly the same conditions.
  const filterParams: (string | number)[] = [];
  let filterSql = groupFilterClause(groups, filterParams);

  if (advanced.rank) {
    if (advanced.rank === 'infraspecies') {
      filterSql += ` AND rank IN ('Subspecies','Variety','Form')`;
    } else {
      filterSql += ` AND rank = ?`;
      filterParams.push(advanced.rank);
    }
  }
  if (advanced.endemic === 'true') {
    filterSql += ` AND is_endemic = 'true'`;
  }
  if (advanced.alien_type) {
    filterSql += ` AND alien_type = ?`;
    filterParams.push(advanced.alien_type);
  }
  if (advanced.family) {
    filterSql += ` AND family = ?`;
    filterParams.push(advanced.family);
  }
  if (advanced.order) {
    filterSql += ` AND "order" = ?`;
    filterParams.push(advanced.order);
  }
  if (advanced.class_name) {
    filterSql += ` AND class = ?`;
    filterParams.push(advanced.class_name);
  }
  if (advanced.genus) {
    filterSql += ` AND genus = ?`;
    filterParams.push(advanced.genus);
  }

  const sql =
    `SELECT ${SEARCH_COLUMNS} FROM taicol_names WHERE (${likePatterns.join(' OR ')}) ` +
    `AND is_in_taiwan LIKE '%true%'${filterSql} LIMIT 100`;

  const res = db.executeSync(sql, [...params, ...filterParams]);
  const likeRows = (res.rows ?? []) as unknown as TaicolRow[];

  // Exact-row top-up. The LIKE query above has no ORDER BY, so when it hits more
  // than 100 rows, whether the exact-match row makes it into those 100 depends
  // purely on SQLite's scan order (effectively rowid), and rowid changes every
  // time the bundle DB is rebuilt — this is the cause of "it used to be found,
  // then the checklist was swapped and it isn't": measured, 7 of 47
  // single-character common names (科蓮桃蕨梅貓菱) had their exact row cut off
  // beyond 100, so the sort stage never saw it.
  //
  // Not solved with ORDER BY because sorting forces SQLite through every hit row:
  // a single Latin letter (typed on every keystroke while entering a scientific
  // name) hits 200k rows, measured going from ~0 ms to 89 ms, and several times
  // worse on a real device. Instead, issue a separate equality query on
  // idx_taicol_common_name / idx_taicol_simple_name, measured under 0.1 ms.
  // Duplicate rows are absorbed by the existing downstream taxon_id / name_id
  // dedup.
  const exactPairs = variants.map(() => '(common_name_c = ? OR simple_name = ?)').join(' OR ');
  const exactParams: (string | number)[] = [];
  for (const v of variants) exactParams.push(v, v);
  const exactSql =
    `SELECT ${SEARCH_COLUMNS} FROM taicol_names WHERE (${exactPairs}) ` +
    `AND is_in_taiwan LIKE '%true%'${filterSql} LIMIT 20`;
  const exactRes = db.executeSync(exactSql, [...exactParams, ...filterParams]);
  const exactRows = (exactRes.rows ?? []) as unknown as TaicolRow[];

  const rows = [...exactRows, ...likeRows];

  const acceptedEntries: Array<[TaicolRow, TaicolRow | null]> = [];
  const nonAccepted: TaicolRow[] = [];
  for (const row of rows) {
    if (row.usage_status === 'accepted') acceptedEntries.push([row, null]);
    else if (row.taxon_id) nonAccepted.push(row);
  }

  const seenTaxonIds = new Set(acceptedEntries.map(([r]) => r.taxon_id).filter(Boolean) as string[]);
  const needResolve = new Map<string, TaicolRow>();
  for (const row of nonAccepted) {
    if (row.taxon_id && !seenTaxonIds.has(row.taxon_id) && !needResolve.has(row.taxon_id)) {
      needResolve.set(row.taxon_id, row);
    }
  }

  if (needResolve.size > 0) {
    const ids = Array.from(needResolve.keys());
    const placeholders = ids.map(() => '?').join(',');
    // `+usage_status` keeps the taxon_id index (see resolveTaxa in taxonLookup.ts).
    const resolved = db.executeSync(
      `SELECT ${SEARCH_COLUMNS} FROM taicol_names WHERE taxon_id IN (${placeholders}) AND +usage_status='accepted' AND is_in_taiwan LIKE '%true%'`,
      ids,
    );
    for (const accRow of (resolved.rows ?? []) as unknown as TaicolRow[]) {
      acceptedEntries.push([accRow, needResolve.get(accRow.taxon_id ?? '') ?? null]);
    }
  }

  const seen = new Set<string | number>();
  const unique: Array<[TaicolRow, TaicolRow | null]> = [];
  for (const [accRow, matched] of acceptedEntries) {
    const key = accRow.taxon_id || accRow.name_id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([accRow, matched]);
  }

  // Dedup a Species and its nominal infraspecific that share a common name
  const cnameSpeciesMap = new Map<string, string>();
  for (const [row] of unique) {
    if (row.common_name_c && row.rank === 'Species') {
      cnameSpeciesMap.set(row.common_name_c, row.simple_name ?? '');
    }
  }
  const filteredUnique = unique.filter(([row]) => {
    const cn = row.common_name_c ?? '';
    if (cn && ['Form', 'Variety', 'Subspecies'].includes(row.rank ?? '') && cnameSpeciesMap.has(cn)) {
      const spName = cnameSpeciesMap.get(cn)!;
      if ((row.simple_name ?? '').startsWith(spName)) return false;
    }
    return true;
  });

  const matchIsAltName = (row: TaicolRow): boolean => {
    const cn = row.common_name_c ?? '';
    const alt = row.alternative_name_c ?? '';
    for (const v of variants) {
      if (cn.includes(v)) return false;
      if (alt.includes(v)) return true;
    }
    return false;
  };

  const cnameCounts = new Map<string, number>();
  for (const [row] of filteredUnique) {
    const cn = row.common_name_c ?? '';
    if (cn) cnameCounts.set(cn, (cnameCounts.get(cn) ?? 0) + 1);
  }

  const results: SearchResult[] = [];
  for (const [accRow, matchedNonAcc] of filteredUnique) {
    const cn = accRow.common_name_c ?? '';
    let displayCname = cn;

    if (matchIsAltName(accRow) && cn) {
      const alt = accRow.alternative_name_c ?? '';
      let matchedAlt = '';
      for (const v of variants) {
        for (const a of alt.split(',')) {
          if (a.trim().includes(v)) {
            matchedAlt = a.trim();
            break;
          }
        }
        if (matchedAlt) break;
      }
      if (matchedAlt && matchedAlt !== cn) displayCname = `${matchedAlt}(${cn})`;
    } else if (cn && (cnameCounts.get(cn) ?? 0) > 1) {
      const alt = accRow.alternative_name_c ?? '';
      const firstAlt = alt ? alt.split(',')[0].trim() : '';
      if (firstAlt) displayCname = `${cn}(${firstAlt})`;
    }

    results.push(rowToResult(accRow, displayCname, matchedNonAcc));
  }

  results.sort((a, b) => {
    const score = (r: SearchResult): number[] => [
      r._raw_cname === trimmed ? 0 : 1,
      r.name === trimmed ? 0 : 1,
      r._raw_cname.includes(trimmed) ? 0 : 1,
      r.alternative_name_c.split(',').some((x) => x.trim() === trimmed) ? 0 : 1,
      r.alternative_name_c.includes(trimmed) ? 0 : 1,
      r._raw_cname.startsWith(trimmed) ? 0 : 1,
      r._raw_cname.length,
    ];
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return a._raw_cname.localeCompare(b._raw_cname);
  });

  const top = results.slice(0, limit);
  return markSensuLato(top);
}

/** jp_import appended 「広義」「狹義」 to the end of the wamei of same-named sensu
 *  lato / sensu stricto taxa to tell them apart (2,267 rows in all). Strip it
 *  before exact comparison, otherwise a user typing 「コタニワタリ」 never gets
 *  「コタニワタリ広義」. Used only for comparison; the display keeps the suffix. */
function stripSensuSuffix(cname: string): string {
  return cname.replace(/(広義|狹義)$/, '');
}

/**
 * wamei stores synonym wamei in `alternative_name_c` (comma-separated) instead of
 * one row each as TaiCOL does, so there is no `usage_status` to go by — on an
 * alias hit we must fill in `matched_as` ourselves, or the UI's existing `≡`
 * marker and the "You entered: …" line never appear (`SearchBox` /
 * `SpeciesDetailPanel` both look only at this field).
 *
 * `acceptedHit` = the query string itself hits the accepted wamei (Hub name); in
 * that case it does not count as a synonym. `pick` decides which alias counts as
 * a hit: plain search uses `includes`, fuzzy search uses equality with the index
 * term. Returns the alias that hit, so ranking can move exact aliases forward.
 *
 * The alias is a wamei, not a scientific name: it is flagged `vernacular`, so the
 * UI shows it as plain text and `chooseNameUsage` never files it as the record's
 * scientific name.
 */
export function markJpAlias(
  result: SearchResult,
  acceptedCname: unknown,
  aliasField: unknown,
  acceptedHit: boolean,
  pick: (alias: string) => boolean,
): string | null {
  if (acceptedHit) return null;
  // A taxon with two accepted wamei stores them as 「A/B」 in common_name_c and
  // repeats both in alternative_name_c, so B is not a synonym of itself.
  const accepted = new Set(
    String(acceptedCname ?? '')
      .split('/')
      .flatMap((n) => [n.trim(), stripSensuSuffix(n.trim())]),
  );
  const alias = String(aliasField ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a && !accepted.has(a))
    .find(pick);
  if (!alias) return null;
  // status reuses TaiCOL's 'synonym' vocabulary, so the UI shows it exactly like a
  // Taiwan-side synonym; `vernacular` keeps it out of the scientific-name slot.
  result.matched_as = { name: alias, fullname: alias, status: 'synonym', vernacular: true };
  return alias;
}

/**
 * Search the Japan (YList) dataset in `jp_names`. Only called when the Japan
 * region is enabled. Simpler than `searchSpecies`: every row is accepted (wamei
 * synonyms live in the `alternative_name_c` column, not in separate rows; see
 * `markJpAlias`), no `is_in_taiwan` gate, and no sensu-lato marking. Same column
 * projection + `rowToResult` as TaiCOL, so results slot into the shared UI; the
 * region is inferred from the 'y…' taxon_id by `rowToResult`.
 */
export function searchSpeciesJp({ q, groups, advanced = {}, limit = 30 }: SearchOptions): SearchResult[] {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const db = getDatasetDb('jp-ylist');
  if (!db) return [];
  const pattern = `%${escapeLike(trimmed)}%`;
  const params: (string | number)[] = [pattern, pattern, pattern, pattern, pattern];

  let sql =
    `SELECT ${SEARCH_COLUMNS} FROM jp_names WHERE (` +
    "common_name_c LIKE ? ESCAPE '\\' OR " +
    "alternative_name_c LIKE ? ESCAPE '\\' OR " +
    "simple_name LIKE ? ESCAPE '\\' OR " +
    "family LIKE ? ESCAPE '\\' OR " +
    "family_c LIKE ? ESCAPE '\\')";

  const filterParams: (string | number)[] = [];
  let filterSql = groupFilterClause(groups, filterParams);

  if (advanced.rank) {
    if (advanced.rank === 'infraspecies') filterSql += ` AND rank IN ('Subspecies','Variety','Form')`;
    else {
      filterSql += ` AND rank = ?`;
      filterParams.push(advanced.rank);
    }
  }
  if (advanced.endemic === 'true') filterSql += ` AND is_endemic = 'true'`;
  if (advanced.family) {
    filterSql += ` AND family = ?`;
    filterParams.push(advanced.family);
  }
  if (advanced.order) {
    filterSql += ` AND "order" = ?`;
    filterParams.push(advanced.order);
  }
  if (advanced.class_name) {
    filterSql += ` AND class = ?`;
    filterParams.push(advanced.class_name);
  }
  if (advanced.genus) {
    filterSql += ` AND genus = ?`;
    filterParams.push(advanced.genus);
  }

  sql += `${filterSql} LIMIT 100`;

  // Exact-row top-up, for the same reason as searchSpecies. Japanese wamei add one
  // more layer: to tell same-named sensu lato / sensu stricto apart, jp_import
  // appended 「広義」「狹義」 to the end of common_name_c (2,267 rows in all), so the
  // equality match must also look up those two suffixed spellings, otherwise
  // typing 「コタニワタリ」 never matches 「コタニワタリ広義」.
  const exactVariants = [trimmed, `${trimmed}広義`, `${trimmed}狹義`];
  const exactSql =
    `SELECT ${SEARCH_COLUMNS} FROM jp_names WHERE (` +
    exactVariants.map(() => 'common_name_c = ?').join(' OR ') +
    ` OR simple_name = ?)${filterSql} LIMIT 20`;
  const exactRes = db.executeSync(exactSql, [...exactVariants, trimmed, ...filterParams]);
  const exactRows = (exactRes.rows ?? []) as unknown as TaicolRow[];

  const res = db.executeSync(sql, [...params, ...filterParams]);
  const rows = [...exactRows, ...((res.rows ?? []) as unknown as TaicolRow[])];

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const row of rows) {
    const key = row.taxon_id ?? String(row.name_id);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = rowToResult(row);
    markJpAlias(result, row.common_name_c, row.alternative_name_c, (row.common_name_c ?? '').includes(trimmed), (a) =>
      a.includes(trimmed),
    );
    results.push(result);
  }

  // Wamei ranking: exact → prefix → contains → length. An alias hit ranks after
  // accepted names in the same tier, but an exact alias must still beat an
  // accepted name that merely "contains" the query, or synonym searches get
  // buried beyond the top 30.
  results.sort((a, b) => {
    const score = (r: SearchResult): number[] => {
      const alias = r.matched_as?.name ?? '';
      const bare = stripSensuSuffix(r._raw_cname);
      return [
        bare === trimmed ? 0 : 1,
        alias === trimmed ? 0 : 1,
        r.name === trimmed ? 0 : 1,
        bare.startsWith(trimmed) ? 0 : 1,
        alias.startsWith(trimmed) ? 0 : 1,
        bare.includes(trimmed) ? 0 : 1,
        bare.length,
      ];
    };
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a._raw_cname.localeCompare(b._raw_cname);
  });

  return results.slice(0, limit);
}
