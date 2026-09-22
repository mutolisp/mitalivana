/**
 * The scope → identification-key index, as a pure function of the key rows.
 *
 * Split out of `src/db/keys.ts` so `scripts/check-keys.mjs` can build it from
 * the REAL `tw-keys` module and assert on the answers. The bug this guards
 * against was invisible to every tool the project had: the index was built,
 * the lookup succeeded, and the answer was simply empty for seven scopes.
 */

/** Minimal shape needed to index a key; the real row has much more. */
export type IndexableKey = {
  id: number;
  scope_rank: string;
  scope_name: string;
  /** JSON array of alternative scope names, or null. */
  aliases: string | null;
};

/**
 * Aliases are indexed under this instead of a real rank.
 *
 * An alias exists precisely BECAUSE the name's rank differs from the key's
 * own `scope_rank` — the whole point of Davalliaceae's alias `Davallia` is
 * that a genus node should find a family-scoped key. Indexing it under the
 * key's own rank stored it at `family:Davallia`, a coordinate nothing ever
 * looks up, so every single-genus-family alias was dead.
 *
 * The SQL sibling `findSubkeysByScopeName` matches aliases with no rank
 * condition at all and only uses rank as an ORDER BY tiebreaker; this
 * reproduces that.
 */
export const ALIAS_RANK = '\u0000alias';

export function scopeKey(rank: string, name: string): string {
  return `${rank.toLowerCase()}:${name}`;
}

export function buildScopeIndex<T extends IndexableKey>(keys: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const k of keys) {
    if (!k.scope_name) continue;
    const k1 = scopeKey(k.scope_rank, k.scope_name);
    const arr = m.get(k1) ?? [];
    arr.push(k);
    m.set(k1, arr);
    if (k.aliases) {
      try {
        const aliases = JSON.parse(k.aliases) as unknown;
        if (Array.isArray(aliases)) {
          for (const a of aliases) {
            if (typeof a !== 'string' || !a) continue;
            const k2 = scopeKey(ALIAS_RANK, a);
            const arr2 = m.get(k2) ?? [];
            arr2.push(k);
            m.set(k2, arr2);
          }
        }
      } catch {
        // ignore malformed aliases JSON
      }
    }
  }
  return m;
}

/**
 * Keys offered for a scope: exact-rank matches first, then alias matches.
 *
 * Both are returned rather than falling back, because they can be genuinely
 * different keys from different books — Selaginella has a genus key from one
 * flora and a family key from another. Exact rank leads because it is the more
 * specific claim. Deduped by id so one call never repeats a key.
 */
export function lookupScope<T extends IndexableKey>(
  index: Map<string, T[]> | null,
  rank: string,
  name: string,
): T[] {
  if (!index || !name) return [];
  const exact = index.get(scopeKey(rank, name)) ?? [];
  const byAlias = index.get(scopeKey(ALIAS_RANK, name)) ?? [];
  if (byAlias.length === 0) return exact;
  const seen = new Set(exact.map((k) => k.id));
  return [...exact, ...byAlias.filter((k) => !seen.has(k.id))];
}
