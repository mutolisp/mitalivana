/**
 * Identification keys read-only query layer (mobile).
 *
 * The keys live in their own module (`tw-keys`), a separate SQLite file from the
 * Taiwan checklist (`tw-taicol`). This app never ATTACHes, so **this file never
 * queries the checklist directly**: whenever a scientific name or rank is
 * needed it goes through the `taxonNameRow` seam, which takes
 * the checklist module's handle themselves. With the module absent they return
 * empty, and the key UI already behaves as "not found, not shown".
 *
 * Updating the module (a new key revision) only means re-downloading ~0.3 MB of
 * tw-keys — no app release, and no re-downloading the checklist.
 */
import { getDatasetDb, onDatasetsChanged } from './datasets';
import { buildScopeIndex, lookupScope } from '~/lib/keyScopeIndex';

export type IdentificationKey = {
  id: number;
  scope_taxon_id: string | null;
  scope_rank: string;
  scope_name: string;
  scope_cname: string | null;
  title: string;
  source: string | null;
  mode: string;
  parent_key_id: number | null;
  notes: string | null;
  /** JSON array string of alternative names that should also match this key
   *  during scope lookup. Bridges single-genus family worksheets named at
   *  family rank (Davalliaceae ↔ Davallia) — see `~/lib/keyScopeIndex`.
   *
   *  ⚠️ Does NOT currently bridge TaiCOL genus moves (Amauropelta ↔
   *  Parathelypteris). The code that did was only reachable from a lookup the
   *  UI stopped using, and was removed with it; the shipped module has no
   *  alias for those. Logged in `mobile/docs/Plan.md` under 功能缺口 (feature gaps). */
  aliases: string | null;
  updated_at: number | null;
};

export type KeyLeadTargetType = 'couplet' | 'taxon' | 'subkey' | 'unresolved';

/** Multi-access (matrix) key feature definition. One row per filterable
 *  character. `values_json` is a JSON-encoded string[] of allowed categorical
 *  states (null for numeric/text — UI infers numeric range from taxon values
 *  and treats text as display-only). */
export type KeyFeature = {
  id: number;
  key_id: number;
  name: string;
  type: 'categorical' | 'numeric' | 'text' | string;
  values_json: string | null;
  category: string | null;
  sort_order: number | null;
};

/** One value of a multi-access feature for a taxon. Multi-value cells in the
 *  source sheet (`橫走|短直立`) become multiple rows sharing
 *  (key_id, taxon_id, feature_id) with different `value`. */
export type KeyTaxonFeatureRow = {
  id: number;
  key_id: number;
  taxon_id: string;
  feature_id: number;
  value: string;
};

export type KeyCouplet = {
  id: number;
  key_id: number;
  number: number;
  lead_a_text: string;
  lead_a_target_type: KeyLeadTargetType;
  lead_a_target_id: string | null;
  lead_a_taxon_marker: string | null;
  lead_a_taxon_status: string | null;
  lead_b_text: string;
  lead_b_target_type: KeyLeadTargetType;
  lead_b_target_id: string | null;
  lead_b_taxon_marker: string | null;
  lead_b_taxon_status: string | null;
};

/** Lightweight taxon info joined by taxon_id; mirrors what the key UI needs. */
export type KeyTaxonInfo = {
  taxon_id: string;
  simple_name: string;
  name_author: string;
  common_name_c: string;
  alternative_name_c: string;
  family: string;
  family_c: string;
  rank: string;
  kingdom: string;
  redlist: string;
  iucn: string;
  cites: string;
  protected: string;
  is_endemic: string;
  alien_type: string;
};

/** Plain key SQL — no child_count subquery. The previous version joined a
 *  per-key COUNT subquery over 251k taicol_names rows; on real device that
 *  was measured at 15s for 895 keys (correlated subqueries + LIKE filter on
 *  is_in_taiwan can't use an index). Since child_count was decorative-only,
 *  it was dropped rather than precomputed. */
const KEY_SELECT_SQL = `SELECT k.* FROM identification_keys k`;

export function listIdentificationKeys(): IdentificationKey[] {
  const db = getDatasetDb('tw-keys');
  if (!db) return [];
  // Order by mode so two rows sharing the same (scope_rank, scope_name) —
  // one dichotomous, one multi_access — appear in a consistent order
  // (dichotomous first, then multi_access, then any future 'both' merge).
  const res = db.executeSync(
    `${KEY_SELECT_SQL} ORDER BY k.scope_rank, k.scope_name,
       CASE k.mode
         WHEN 'dichotomous'  THEN 0
         WHEN 'multi_access' THEN 1
         WHEN 'both'         THEN 2
         ELSE 3
       END`,
  );
  return ((res.rows ?? []) as unknown) as IdentificationKey[];
}

/** Module-level cache for the full keys list. The bundled TaiCOL DB is
 *  read-only at runtime, so the SQL result can't change mid-session.
 *  Cache once, reuse forever. */
let CACHED_KEYS: IdentificationKey[] | null = null;

/** Reverse index for TaxonRow's per-row "is there a matching key" lookup. Built
 *  alongside CACHED_KEYS in prewarmKeys / getCachedKeys. Indexing and lookup
 *  rules live in `~/lib/keyScopeIndex` (pure) so `check:keys` can exercise
 *  them against the real tw-keys module. */
let SCOPE_INDEX: Map<string, IdentificationKey[]> | null = null;

/** Returns cached keys, computing on first call. Used by KeyListView. */
export function getCachedKeys(): IdentificationKey[] {
  if (CACHED_KEYS === null) {
    CACHED_KEYS = listIdentificationKeys();
    SCOPE_INDEX = buildScopeIndex(CACHED_KEYS);
  }
  return CACHED_KEYS;
}

/** Force-fill the cache. Called from DBProvider after splash so the first
 *  tap on the Key tab / KeyPopup / the taxonomy tree's key icon is instant. SQL itself is
 *  now ~5ms (plain `SELECT * FROM identification_keys` after child_count was
 *  dropped); kept as a marker so future heavy joins re-introduce the same
 *  prewarm slot. */
export function prewarmKeys(): void {
  if (CACHED_KEYS === null) {
    CACHED_KEYS = listIdentificationKeys();
    SCOPE_INDEX = buildScopeIndex(CACHED_KEYS);
  }
}

/** Once the keys module is installed / updated / deleted, the whole cache and the
 *  scope index are no longer valid. */
export function clearKeysCache(): void {
  CACHED_KEYS = null;
  SCOPE_INDEX = null;
}
onDatasetsChanged(clearKeysCache);

/** O(1) lookup for taxonomy tree's per-row key chip. Returns the list of
 *  IdentificationKey rows matching this scope (rank + name) — typically
 *  0 (no key for this scope), 1 (dichotomous OR multi-access), or 2 (both).
 *  Returns empty array if `prewarmKeys()` hasn't been called yet — fail
 *  open so tree rendering doesn't depend on key cache being ready. */
export function getKeysForScope(rank: string, name: string): IdentificationKey[] {
  return lookupScope(SCOPE_INDEX, rank, name);
}

export function getIdentificationKey(id: number): IdentificationKey | null {
  const db = getDatasetDb('tw-keys');
  if (!db) return null;
  const res = db.executeSync(`${KEY_SELECT_SQL} WHERE k.id = ?`, [id]);
  const rows = (res.rows ?? []) as unknown as IdentificationKey[];
  return rows[0] ?? null;
}

export function listKeyCouplets(keyId: number): KeyCouplet[] {
  const db = getDatasetDb('tw-keys');
  if (!db) return [];
  const res = db.executeSync(
    `SELECT * FROM key_couplets WHERE key_id = ? ORDER BY number ASC`,
    [keyId],
  );
  return ((res.rows ?? []) as unknown) as KeyCouplet[];
}

/** Features for a multi-access key, ordered by header column position. */
export function listKeyFeatures(keyId: number): KeyFeature[] {
  const db = getDatasetDb('tw-keys');
  if (!db) return [];
  const res = db.executeSync(
    `SELECT id, key_id, name, type, values_json, category, sort_order
       FROM key_features
      WHERE key_id = ?
      ORDER BY COALESCE(sort_order, 0) ASC, id ASC`,
    [keyId],
  );
  return ((res.rows ?? []) as unknown) as KeyFeature[];
}

/** Taxon × feature value rows for a multi-access key. Caller indexes by
 *  taxon_id / feature_id; runtime cost is O(rows) and the typical scope
 *  (≤ ~100 taxa × ~20 features × multi-value ≈ a few thousand rows) fits
 *  comfortably in JS memory. */
export function listKeyTaxonFeatures(keyId: number): KeyTaxonFeatureRow[] {
  const db = getDatasetDb('tw-keys');
  if (!db) return [];
  const res = db.executeSync(
    `SELECT id, key_id, taxon_id, feature_id, value
       FROM key_taxon_features
      WHERE key_id = ?`,
    [keyId],
  );
  return ((res.rows ?? []) as unknown) as KeyTaxonFeatureRow[];
}

/** Parse a `KeyFeature.values_json` JSON-encoded string[] into an array.
 *  Returns [] for null / malformed (treated as "no declared palette"). */
export function parseFeatureValues(values_json: string | null): string[] {
  if (!values_json) return [];
  try {
    const parsed = JSON.parse(values_json);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string');
  } catch {
    // ignore corrupt JSON
  }
  return [];
}

/** Build a number → couplet lookup for fast traversal. */
export function indexCoupletsByNumber(couplets: KeyCouplet[]): Map<number, KeyCouplet> {
  const map = new Map<number, KeyCouplet>();
  for (const c of couplets) map.set(c.number, c);
  return map;
}

/**
 * Look up a more specific identification key for a terminal taxon
 * ("subkey chain"). Returns the genus key when a key-runner terminates at
 * a genus row, the family key when it terminates at a family, etc.
 *
 * Matching rule: a key whose `scope_name` (and matching `scope_rank`)
 * equals the terminal taxon's `simple_name`. We do NOT trust
 * `scope_taxon_id` because the import pipeline currently leaves it null.
 *
 * Returns null when the taxon row can't be located, the rank isn't one of
 * the supported scopes, or no key exists for that scope. Callers should
 * gate the "Continue key within genus" button on this being non-null.
 */
const RANK_TO_SCOPE: Record<string, string> = {
  Family: 'family',
  Subfamily: 'subfamily',
  Tribe: 'tribe',
  Genus: 'genus',
  Subgenus: 'subgenus',
};

// ── Checklist-side queries: the single seam ──────────────────────────────────
//
// Keys and the checklist are two independent modules (two SQLite files) and this
// app never ATTACHes, so key code **must not** query taicol_names directly. Every
// place that needs the checklist goes through the two functions below, which
// fetch the Taiwan checklist module's handle themselves and return empty when
// they can't get it — the key UI already behaves as "not found, not shown".

/** taxon_id → the accepted name's {simple_name, rank}; falls back to any row
 *  when there is no accepted name. */
function taxonNameRow(taxonId: string): { simple_name: string; rank: string } | null {
  const db = getDatasetDb('tw-taicol');
  if (!db) return null;
  for (const extra of [` AND usage_status = 'accepted'`, '']) {
    const res = db.executeSync(
      `SELECT simple_name, rank FROM taicol_names WHERE taxon_id = ?${extra} LIMIT 1`,
      [taxonId],
    );
    const row = (res.rows ?? [])[0] as { simple_name: string; rank: string } | undefined;
    if (row) return row;
  }
  return null;
}




/** Finds keys by scope_name (preferring a matching scope_rank when given),
 *  also matching a key whose `aliases` JSON array contains the token. Returns ALL matches
 *  (one per mode). The same scope can carry both a dichotomous and a
 *  multi_access key — the runner offers a button for each.
 *
 *  Sort order matches the singular version (preferredRank wins, then by
 *  rank specificity), with mode as the tiebreaker so dichotomous comes
 *  before multi_access. */
export function findSubkeysByScopeName(
  token: string,
  preferredRank?: string,
): IdentificationKey[] {
  const t = (token ?? '').trim();
  if (!t) return [];
  const db = getDatasetDb('tw-keys');
  if (!db) return [];
  const rankOrder = preferredRank
    ? `CASE WHEN k.scope_rank = ? THEN 0 ELSE 1 END,`
    : '';
  const rankSpecificity = `CASE k.scope_rank
    WHEN 'genus' THEN 1
    WHEN 'subgenus' THEN 2
    WHEN 'tribe' THEN 3
    WHEN 'subfamily' THEN 4
    WHEN 'family' THEN 5
    ELSE 9 END`;
  const modeOrder = `CASE k.mode
    WHEN 'dichotomous' THEN 0
    WHEN 'multi_access' THEN 1
    WHEN 'both' THEN 2
    ELSE 3 END`;
  // Placeholder order: scope_name, alias_value, optional rank for ORDER BY.
  // Placeholder order is scope_name, alias_value, then (optionally) scope_rank
  // for the ORDER BY tiebreaker — pass params in exactly that order.
  const params: any[] = preferredRank ? [t, t, preferredRank] : [t, t];
  const sql = `${KEY_SELECT_SQL}
    WHERE k.scope_name = ?
       OR (k.aliases IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(k.aliases) WHERE value = ?
          ))
    ORDER BY ${rankOrder} ${rankSpecificity}, ${modeOrder}
    LIMIT 8`;
  const res = db.executeSync(sql, params);
  return ((res.rows ?? []) as unknown) as IdentificationKey[];
}

/** All subkeys (one per mode) for the taxon's rank-mapped scope.
 *  Empty array if none. */
export function findSubkeysForTaxon(taxonId: string): IdentificationKey[] {
  if (!taxonId) return [];
  const row = taxonNameRow(taxonId);
  if (!row || !row.simple_name) return [];
  const scope = RANK_TO_SCOPE[row.rank];
  return findSubkeysByScopeName(row.simple_name, scope);
}


/**
 * Lookup taxon info by taxon_id. Prefers the accepted-name row; falls back
 * to any row matching the id (so synonym-only ids still produce sensible UI).
 */
export function getKeyTaxonInfo(taxonId: string): KeyTaxonInfo | null {
  const db = getDatasetDb('tw-taicol');
  if (!db) return null;
  // accepted first
  // `+usage_status` keeps the taxon_id index (see resolveTaxa in taxonLookup.ts).
  let res = db.executeSync(
    `SELECT taxon_id, simple_name, name_author, common_name_c, alternative_name_c,
            family, family_c, rank, kingdom,
            redlist, iucn, cites, protected, is_endemic, alien_type
       FROM taicol_names
      WHERE taxon_id = ? AND +usage_status = 'accepted'
      LIMIT 1`,
    [taxonId],
  );
  let row = (res.rows ?? [])[0] as KeyTaxonInfo | undefined;
  if (row) return row;
  res = db.executeSync(
    `SELECT taxon_id, simple_name, name_author, common_name_c, alternative_name_c,
            family, family_c, rank, kingdom,
            redlist, iucn, cites, protected, is_endemic, alien_type
       FROM taicol_names
      WHERE taxon_id = ?
      LIMIT 1`,
    [taxonId],
  );
  row = (res.rows ?? [])[0] as KeyTaxonInfo | undefined;
  return row ?? null;
}
