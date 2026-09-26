/**
 * How many times the user has recorded each taxon, across quick checklists,
 * plot surveys, collections and GLORIA units — for ranking search results
 * (src/lib/usageRank.ts, setting `search_usage_rank`).
 *
 * One GROUP BY over indexed taxon columns; kept for a few seconds so typing
 * doesn't re-run it per keystroke, and dropped after an add
 * (`invalidateUsageCounts`) so the species just recorded counts at once.
 * Names come from the name cache / external taxa, so a used taxon can be found
 * for a query even when the search's own cut-off dropped it.
 */
import { getUserDb } from './init';
import { USAGE_COUNTS_SQL, type UsedTaxon } from '~/lib/usageRank';

const TTL_MS = 15_000;
let cached: { at: number; used: UsedTaxon[]; counts: Map<string, number> } | null = null;

export function invalidateUsageCounts(): void {
  cached = null;
}

export function usageCounts(): { used: UsedTaxon[]; counts: Map<string, number> } {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached;
  const rows = (getUserDb().executeSync(
    USAGE_COUNTS_SQL,
  ).rows ?? []) as Array<{ taxon_id: string; n: number; sci: string; cname: string; alt: string }>;
  const used = rows.map((r) => ({
    taxon_id: r.taxon_id,
    n: r.n,
    names: [r.sci, r.cname, ...r.alt.split(/[,，;；、]/)].map((s) => s.trim()).filter(Boolean),
  }));
  cached = { at: now, used, counts: new Map(used.map((u) => [u.taxon_id, u.n])) };
  return cached;
}
