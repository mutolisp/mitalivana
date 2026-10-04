import { distance } from 'fastest-levenshtein';
import { pinyin } from 'pinyin-pro';
import { getDatasetDb, getSpec, onDatasetsChanged, type DatasetId } from './datasets';
import { SEARCH_COLUMNS, searchSpecies, searchSpeciesJp, groupFilterClause, markJpAlias } from './search';
import { getEnabledRegions, crossRegionVernacular, getVernacularLangs, normalizeSci } from './regions';
import { composeByLangs } from './mergeScope';
import { searchExternalTaxa } from './externalTaxa';
import { searchPackTaxa } from './regionpacks';
import type { SearchResult, TaxonGroup } from './types';

type FuzzyOptions = {
  q: string;
  groups?: TaxonGroup[];
  excludeIds?: Set<number>;
  limit?: number;
  /** Enable toneless-pinyin (phonetic) fallback for homophone garbles, e.g.
   *  voice dictation. Off by default so per-keystroke SearchBox queries never
   *  pay the extra pinyin sweep. */
  phonetic?: boolean;
};

type CnameEntry = { cname: string; nameIds: number[]; pinyin: string };

// One index per checklist module. The JP one has no pinyin column (pinyin is
// Mandarin-specific), so loading fills '' to let both share a type;
// `fuzzySearchJp` does not take the pinyin path either.
const indexes = new Map<DatasetId, CnameEntry[]>();
const indexMissing = new Set<DatasetId>();

/** Convert a query string to a list of toneless pinyin syllables. Non-Han
 *  output (latin letters from scientific names, punctuation) is dropped so it
 *  never spuriously matches Chinese candidate syllables. Mirrors the build-time
 *  conversion in `scripts/build_pinyin_index.mjs` (same lib, same options). */
function toPinyinSyllables(s: string): string[] {
  try {
    return (pinyin(s, { toneType: 'none', type: 'array' }) as string[]).filter((x) =>
      /^[a-z]+$/.test(x),
    );
  } catch {
    return [];
  }
}

/** Levenshtein distance over two syllable sequences (one edit = one syllable). */
function seqDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Load one checklist module's fuzzy-match index (the whole thing into the JS
 * heap, scanned by every later query).
 *
 * Neither a missing table nor a missing pinyin column is fatal: the module may
 * have been built by an older pipeline. Throwing an uncaught exception inside
 * the search debounce's setTimeout has been observed to take the Hermes runtime
 * down, so this degrades rather than throws.
 */
function loadFuzzyIndex(datasetId: DatasetId): CnameEntry[] | null {
  const cached = indexes.get(datasetId);
  if (cached) return cached;
  if (indexMissing.has(datasetId)) return null;
  const spec = getSpec(datasetId);
  if (spec.tables.kind !== 'names' || !spec.tables.fuzzyIndex) return null;
  const table = spec.tables.fuzzyIndex;
  const db = getDatasetDb(datasetId);
  if (!db) return null;
  // The fuzzy index is built by `backend/scripts/build_mobile_fuzzy_index.py`
  // before the asset DB is bundled. Older bundles (or bundles built without
  // that step) won't have it — fail gracefully instead of throwing on every
  // keystroke (an uncaught throw inside the search-debounce setTimeout has
  // been observed to destabilize the Hermes runtime).
  try {
    const exists = db.executeSync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}' LIMIT 1`,
    );
    if (!((exists.rows ?? []) as unknown[]).length) {
      indexMissing.add(datasetId);
      // eslint-disable-next-line no-console
      console.warn(`[fuzzy] ${table} missing — fuzzy fallback disabled for ${datasetId}`);
      return null;
    }
    // `pinyin` is filled by `scripts/build_pinyin_index.mjs` after the python
    // index build. 舊模組可能沒有這一欄 —— 降級成只比對漢字（pinyin = ''），
    // 而不是整個關掉模糊比對。
    const cols = db.executeSync(`PRAGMA table_info(${table})`);
    const hasPinyin = ((cols.rows ?? []) as Array<Record<string, unknown>>).some(
      (c) => c.name === 'pinyin',
    );
    const res = db.executeSync(
      hasPinyin
        ? `SELECT cname, name_ids, pinyin FROM ${table}`
        : `SELECT cname, name_ids FROM ${table}`,
    );
    const loaded = ((res.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      cname: row.cname as string,
      nameIds: (row.name_ids as string).split(',').map((s) => parseInt(s, 10)),
      pinyin: (row.pinyin as string) ?? '',
    }));
    indexes.set(datasetId, loaded);
    return loaded;
  } catch (e) {
    indexMissing.add(datasetId);
    // eslint-disable-next-line no-console
    console.warn(`[fuzzy] failed to load ${table}, disabling fuzzy for ${datasetId}:`, e);
    return null;
  }
}

/**
 * 索引一次掃完，取距離 ≤1；只有在 ≤1 太稀疏時才放寬到 ≤2 —— 與原本「先掃一次
 * ≤1，不夠再整個重掃一次 ≤2」完全同義，但索引只走一趟。
 *
 * `Math.abs(長度差) > 2` 直接跳過不算 Levenshtein：編輯距離至少等於長度差，
 * 所以這些項目不可能 ≤2，是純剪枝不改結果。6.3 萬筆索引實測 8.2ms → 2.5ms
 * （Mac；實機再放大數倍），批次匯入每個沒打中的名字都要付一次這個成本。
 */
function sweep<T extends { cname: string }>(index: T[], q: string): Array<{ entry: T; dist: number }> {
  const near: Array<{ entry: T; dist: number }> = [];
  const wider: Array<{ entry: T; dist: number }> = [];
  for (const entry of index) {
    if (Math.abs(entry.cname.length - q.length) > 2) continue;
    const dist = distance(q, entry.cname);
    if (dist <= 1) near.push({ entry, dist });
    else if (dist === 2) wider.push({ entry, dist });
  }
  if (near.length >= 3 || q.length < 3) return near;
  return [...near, ...wider];
}

export function fuzzySearch({
  q,
  groups,
  excludeIds,
  limit = 10,
  phonetic = false,
}: FuzzyOptions): SearchResult[] {
  if (!q || q.length < 2) return [];

  const index = loadFuzzyIndex('tw-taicol');
  if (!index) return [];

  let matches = sweep(index, q);

  // Phonetic (toneless pinyin) fallback for homophone garbles from voice
  // dictation, e.g. 台灣時力 / 臺灣實例 → 臺灣石櫟 (all "tai wan shi li").
  // Only when the caller opts in AND hanzi matching is sparse: keeps the
  // default SearchBox path (phonetic=false) free of the extra pinyin sweep,
  // and avoids drowning a good hanzi hit in homophone noise.
  if (phonetic && matches.length < 3) {
    const qSyl = toPinyinSyllables(q);
    if (qSyl.length > 0) {
      const seen = new Set(matches.map((m) => m.entry.cname));
      const maxDist = qSyl.length >= 3 ? 1 : 0;
      const phon = index
        .filter((e) => e.pinyin && !seen.has(e.cname))
        .map((e) => ({ entry: e, dist: seqDistance(qSyl, e.pinyin.split(' ')) }))
        .filter((m) => m.dist <= maxDist)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20);
      matches = matches.concat(phon);
    }
  }

  if (matches.length === 0) return [];

  matches.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return Math.abs(a.entry.cname.length - q.length) - Math.abs(b.entry.cname.length - q.length);
  });

  const matchedNameIds: number[] = [];
  const fuzzyInfo = new Map<number, { matched: string; score: number }>();
  for (const m of matches.slice(0, 15)) {
    for (const nameId of m.entry.nameIds) {
      if (excludeIds?.has(nameId)) continue;
      if (!fuzzyInfo.has(nameId)) {
        matchedNameIds.push(nameId);
        fuzzyInfo.set(nameId, { matched: m.entry.cname, score: m.dist });
      }
    }
  }

  if (matchedNameIds.length === 0) return [];

  const db = getDatasetDb('tw-taicol');
  if (!db) return [];
  const placeholders = matchedNameIds.map(() => '?').join(',');
  // Honor the user's taxon-group filter — without this the fuzzy index sweeps
  // across all 62k cnames and returns matches from any kingdom, so picking
  // "維管束植物" had no effect on fuzzy results (only exact-search was filtered).
  let sql = `SELECT ${SEARCH_COLUMNS} FROM taicol_names WHERE name_id IN (${placeholders})`;
  const params: (string | number)[] = [...matchedNameIds];
  sql += groupFilterClause(groups, params);
  const res = db.executeSync(sql, params);

  const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
  const results: SearchResult[] = [];
  for (const row of rows) {
    const nameId = row.name_id as number;
    const info = fuzzyInfo.get(nameId);
    if (!info) continue;
    results.push(buildFuzzyResult(row, q, info));
  }

  results.sort((a, b) => (a.fuzzy_match?.score ?? 99) - (b.fuzzy_match?.score ?? 99));
  return results.slice(0, limit);
}

/** Map a taicol_names / jp_names row (same column shape) to a fuzzy
 *  SearchResult. Region is inferred from the 'y…' taxon_id. Shared by the
 *  TaiCOL and YList fuzzy paths. */
function buildFuzzyResult(
  row: Record<string, unknown>,
  query: string,
  info: { matched: string; score: number },
): SearchResult {
  const taxonId = (row.taxon_id as string) ?? '';
  return {
    id: row.name_id as number,
    name: (row.simple_name as string) ?? '',
    fullname: row.name_author
      ? `${(row.simple_name as string) ?? ''} ${row.name_author as string}`
      : ((row.simple_name as string) ?? ''),
    cname: (row.common_name_c as string) ?? '',
    _raw_cname: (row.common_name_c as string) ?? '',
    family: (row.family as string) ?? '',
    family_cname: (row.family_c as string) ?? '',
    iucn_category: (row.iucn as string) ?? '',
    redlist: (row.redlist as string) ?? '',
    endemic: row.is_endemic === 'true' ? 1 : 0,
    source: '',
    alien_type: (row.alien_type as string) ?? '',
    pt_name: '',
    taxon_id: taxonId,
    usage_status: 'accepted',
    alternative_name_c: (row.alternative_name_c as string) ?? '',
    kingdom: (row.kingdom as string) ?? '',
    kingdom_c: (row.kingdom_c as string) ?? '',
    phylum: (row.phylum as string) ?? '',
    phylum_c: (row.phylum_c as string) ?? '',
    class_name: (row.class as string) ?? '',
    class_c: (row.class_c as string) ?? '',
    order: (row.order as string) ?? '',
    order_c: (row.order_c as string) ?? '',
    genus: (row.genus as string) ?? '',
    genus_c: (row.genus_c as string) ?? '',
    nomenclature_name: (row.nomenclature_name as string) ?? '',
    cites: (row.cites as string) ?? '',
    protected: (row.protected as string) ?? '',
    is_hybrid: (row.is_hybrid as string) ?? '',
    is_terrestrial: (row.is_terrestrial as string) ?? '',
    is_freshwater: (row.is_freshwater as string) ?? '',
    is_brackish: (row.is_brackish as string) ?? '',
    is_marine: (row.is_marine as string) ?? '',
    is_fossil: (row.is_fossil as string) ?? '',
    alien_status_note: (row.alien_status_note as string) ?? '',
    rank: (row.rank as string) ?? '',
    is_autonym: false,
    is_sensu_lato: false,
    region: taxonId.charAt(0) === 'y' ? 'JP' : 'TW',
    fuzzy_match: { query, matched: info.matched, score: info.score },
  };
}

/** Fuzzy-match 和名 (katakana) against the Japan dataset (接受和名 + 別名). Mirrors `fuzzySearch`
 *  but over `cname_fuzzy_index_jp` → `jp_names`; no pinyin path. */
export function fuzzySearchJp({ q, groups, excludeIds, limit = 10 }: FuzzyOptions): SearchResult[] {
  if (!q || q.length < 2) return [];
  const index = loadFuzzyIndex('jp-ylist');
  if (!index) return [];

  let matches = sweep(index, q);
  if (matches.length === 0) return [];

  matches.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return Math.abs(a.entry.cname.length - q.length) - Math.abs(b.entry.cname.length - q.length);
  });

  const matchedNameIds: number[] = [];
  const fuzzyInfo = new Map<number, { matched: string; score: number }>();
  for (const m of matches.slice(0, 15)) {
    for (const nameId of m.entry.nameIds) {
      if (excludeIds?.has(nameId)) continue;
      if (!fuzzyInfo.has(nameId)) {
        matchedNameIds.push(nameId);
        fuzzyInfo.set(nameId, { matched: m.entry.cname, score: m.dist });
      }
    }
  }
  if (matchedNameIds.length === 0) return [];

  const db = getDatasetDb('jp-ylist');
  if (!db) return [];
  const placeholders = matchedNameIds.map(() => '?').join(',');
  let sql = `SELECT ${SEARCH_COLUMNS} FROM jp_names WHERE name_id IN (${placeholders})`;
  const params: (string | number)[] = [...matchedNameIds];
  sql += groupFilterClause(groups, params);
  const res = db.executeSync(sql, params);

  const results: SearchResult[] = [];
  for (const row of (res.rows ?? []) as Array<Record<string, unknown>>) {
    const info = fuzzyInfo.get(row.name_id as number);
    if (!info) continue;
    const result = buildFuzzyResult(row, q, info);
    // 索引同時收接受和名與別名，命中的若不是接受和名就是別名 → 補 ≡ 標記。
    markJpAlias(result, row.alternative_name_c, info.matched === row.common_name_c, (a) => a === info.matched);
    results.push(result);
  }
  results.sort((a, b) => (a.fuzzy_match?.score ?? 99) - (b.fuzzy_match?.score ?? 99));
  return results.slice(0, limit);
}

/** Dedupe `extra` into `primary` by normalized scientific name — primary wins,
 *  so a shared species found in both TaiCOL and YList shows once (as the TaiCOL
 *  row). Used to merge regional result lists. */
function mergeBySciNorm(primary: SearchResult[], extra: SearchResult[]): SearchResult[] {
  const seen = new Set(primary.map((r) => normalizeSci(r.name)));
  const out = [...primary];
  for (const r of extra) {
    const key = normalizeSci(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Show each result's vernacular in the user's chosen languages and order
 *  (`getVernacularLangs`), so e.g. a TaiCOL row gains its 和名 ("糯米條 /
 *  タイワンツクバネウツギ") or shows only it. Mutates in place. The row's own
 *  language keeps its display decoration on `cname`; a language not chosen is
 *  still searched, just not shown. */
function enrichSharedVernacular(results: SearchResult[], regions: ('TW' | 'JP')[]): void {
  if (results.length === 0) return;
  const cross = crossRegionVernacular(
    results.map((r) => r.taxon_id).filter(Boolean),
    regions,
  );
  const langs = getVernacularLangs();
  for (const r of results) {
    const c = cross.get(r.taxon_id);
    const ownJp = r.region === 'JP';
    // The other region's name, unless it is the row's own name again.
    const other = ownJp ? c?.tw : c?.jp;
    const otherName = other && other !== r._raw_cname ? other : undefined;
    const tw = ownJp ? (regions.includes('TW') ? otherName : undefined) : r.cname;
    const jp = ownJp ? r.cname : regions.includes('JP') ? otherName : undefined;
    r.cname = composeByLangs({ 'zh-TW': tw || undefined, ja: jp || undefined }, langs, r.cname);
  }
}

/**
 * Combined search: exact/like first, fall back to fuzzy if results are sparse.
 * Mirrors backend search_api logic. When the Japan region is enabled, also
 * searches YList and merges shared species (same scientific name) so their
 * Taiwanese + Japanese vernacular names appear together. With only ['TW'] this
 * is byte-identical to the pre-region behavior.
 */
/**
 * The bundled checklists, then the user's own external taxa.
 *
 * External ('g…') taxa live in user.db while the checklists live in
 * twnamelist.db, and this app never ATTACHes, so they cannot be part of the
 * SQL above — they are merged in here instead. Without this a species the
 * user added from GBIF stays invisible to the search box that offered to add
 * it, and the app would keep offering to add it again.
 */
export function searchWithFuzzyFallback(opts: {
  q: string;
  groups?: TaxonGroup[];
  phonetic?: boolean;
}): SearchResult[] {
  const local = searchBundledChecklists(opts);
  let external: SearchResult[] = [];
  try {
    const groupParams: (string | number)[] = [];
    external = searchExternalTaxa(opts.q, 10, groupFilterClause(opts.groups, groupParams), groupParams);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[search] external taxa search failed:', e);
  }
  // Country region packs come last: also bulk data, but GBIF-derived rather
  // than checklist-verified, and duplicating a bundled species under a second
  // identity would split its records.
  let pack: SearchResult[] = [];
  try {
    pack = searchPackTaxa(opts.q, opts.groups);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[search] pack taxa search failed:', e);
  }
  if (external.length === 0 && pack.length === 0) return local;
  // Bundled results first: a species that IS in the checklist must keep its
  // local identity, and the external row is at best a duplicate of it.
  const seen = new Set(local.map((r) => r.taxon_id));
  const merged = [...local, ...external.filter((r) => !seen.has(r.taxon_id))];
  if (pack.length === 0) return merged;
  // Pack rows dedupe by identity AND by scientific name: the same organism
  // in TaiCOL/YList/external_taxa carries a different taxon_id than the pack's
  // 'g' + backbone key, and only the name reveals the duplicate.
  const seenIds = new Set(merged.map((r) => r.taxon_id));
  const seenSci = new Set(merged.map((r) => normalizeSci(r.name)));
  return [
    ...merged,
    ...pack.filter((r) => !seenIds.has(r.taxon_id) && !seenSci.has(normalizeSci(r.name))),
  ];
}

function searchBundledChecklists(opts: {
  q: string;
  groups?: TaxonGroup[];
  /** Forwarded to `fuzzySearch` — enable toneless-pinyin homophone matching
   *  (voice / batch import). Off for the live SearchBox path. */
  phonetic?: boolean;
}): SearchResult[] {
  const regions = getEnabledRegions();
  const tw = regions.includes('TW');
  const jp = regions.includes('JP');

  let exact: SearchResult[] = [];
  if (tw) {
    try {
      exact = searchSpecies({ q: opts.q, groups: opts.groups, limit: 30 });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[search] exact search failed:', e);
      return [];
    }
  }

  // ── Taiwan-only path (default): byte-identical to the pre-region behavior ──
  if (tw && !jp) {
    if (exact.length >= 5) return exact;
    try {
      const excludeIds = new Set(exact.map((r) => r.id));
      const fuzzy = fuzzySearch({ q: opts.q, groups: opts.groups, excludeIds, phonetic: opts.phonetic });
      return [...exact, ...fuzzy];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[search] fuzzy fallback failed:', e);
      return exact;
    }
  }

  // ── Neither bundled region enabled (packs-only mode): the pack/external
  //    merge in searchWithFuzzyFallback is the whole result set. ──
  if (!tw && !jp) return [];

  // ── Regional path: whichever of TaiCOL / YList is enabled, merged by
  //    scientific name. With TW off this is the JP-only path — new since TW
  //    became toggleable, so it deliberately reuses the exact same legs. ──
  let jpExact: SearchResult[] = [];
  if (jp) {
    try {
      jpExact = searchSpeciesJp({ q: opts.q, groups: opts.groups, limit: 30 });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[search] JP exact search failed:', e);
    }
  }
  let combined = mergeBySciNorm(exact, jpExact);

  if (combined.length < 5) {
    try {
      const excludeIds = new Set(combined.map((r) => r.id));
      const twFuzzy = tw
        ? fuzzySearch({ q: opts.q, groups: opts.groups, excludeIds, phonetic: opts.phonetic })
        : [];
      let jpFuzzy: SearchResult[] = [];
      if (jp) {
        try {
          jpFuzzy = fuzzySearchJp({ q: opts.q, groups: opts.groups, excludeIds });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[search] JP fuzzy failed:', e);
        }
      }
      combined = mergeBySciNorm(combined, [...twFuzzy, ...jpFuzzy]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[search] fuzzy fallback failed:', e);
    }
  }

  // Cross-region "中文名 / 和名" enrichment only means something with both on.
  if (tw && jp) enrichSharedVernacular(combined, regions);
  return combined;
}

/** 模組安裝 / 更新 / 刪除後清掉所有模組的索引**與 missing 旗標**——少清旗標，
 *  剛裝好的模組會被當成「這台裝置沒有模糊比對」直到下次重開 app。 */
export function clearFuzzyIndexCache(): void {
  indexes.clear();
  indexMissing.clear();
}
onDatasetsChanged(clearFuzzyIndexCache);

/**
 * Force-load the 62k cname fuzzy index into JS heap. Call this off the
 * critical path (e.g. `setTimeout(prewarmFuzzyIndex, 0)` on SearchBox mount)
 * so the *first* user query doesn't pay the ~200-500ms cold-load cost.
 */
export function prewarmFuzzyIndex(): void {
  // 只暖臺灣那份。**不要**「順手」改成迴圈掃所有已安裝模組：日本索引有 3 萬筆，
  // 對從不開日本名錄的人是白佔 heap，它在第一次日文查詢時才載入就好。
  loadFuzzyIndex('tw-taicol');
}
