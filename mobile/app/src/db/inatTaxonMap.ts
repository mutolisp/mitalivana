/**
 * Persistent scientific name → iNaturalist taxon id cache (user.db
 * `inat_taxon_map`, v36).
 *
 * Reads and writes only, **no network** — that half lives in
 * `src/lib/useInatGrid.ts`, which keeps `src/db/` to storage alone and keeps
 * `inatApi.ts`'s `expo-file-system/legacy` dependency out of the DB layer.
 *
 * **Negative caching is the main reason this table exists**: of 30 sampled
 * TaiCOL accepted names, 5 are absent from iNat entirely (about 17%, and far
 * worse for obscure invertebrates). `inatTaxonId === null` means "asked, not
 * there", which is a different answer from "never asked" (no row at all); the
 * two must not be conflated.
 *
 * The existing upload flow (`taxonCache` in `inatUpload.ts`) does the same
 * resolution, but only in a per-batch `Map` that is thrown away when the batch
 * ends. Once this table proves itself on the overlay it could take that over;
 * not touched for now.
 */
import type { TaxonMatchVia } from '~/lib/inatPayload';
import { getUserDb } from './init';

export type InatTaxonInfo = {
  /** null = asked, and iNat does not have this name. */
  inatTaxonId: number | null;
  /** Observation count with `captive=false`. */
  obsWild: number;
  /** Unfiltered total; null = never asked (not needed while `obsWild > 0`). */
  obsTotal: number | null;
  /** The name iNaturalist files the taxon under. Differs from the looked-up
   *  name when `via === 'synonym'`; null on rows written before v37. */
  inatName?: string | null;
  /** 'name' = iNat holds the very name asked for, 'synonym' = the name is one
   *  of that taxon's other names. null on rows written before v37, which could
   *  only ever have been strict 'name' matches. */
  via?: TaxonMatchVia | null;
};

export type CachedInatTaxon = InatTaxonInfo & { checkedAt: number };

type Row = {
  inat_taxon_id?: number | null;
  obs_wild?: number | null;
  obs_total?: number | null;
  checked_at?: number | null;
  inat_name?: string | null;
  matched_via?: string | null;
};

/** Missing row returns null (= never asked), which is a different answer from
 *  "asked, not there". */
export function readInatTaxonCache(name: string, kingdom: string): CachedInatTaxon | null {
  const key = name.trim();
  if (!key) return null;
  try {
    const res = getUserDb().executeSync(
      `SELECT inat_taxon_id, obs_wild, obs_total, checked_at, inat_name, matched_via
         FROM inat_taxon_map WHERE name = ? AND kingdom = ? LIMIT 1`,
      [key, kingdom ?? ''],
    );
    const row = ((res.rows ?? [])[0] as Row | undefined) ?? null;
    if (!row) return null;
    return {
      inatTaxonId: row.inat_taxon_id == null ? null : Number(row.inat_taxon_id),
      obsWild: Number(row.obs_wild ?? 0),
      obsTotal: row.obs_total == null ? null : Number(row.obs_total),
      inatName: row.inat_name ?? null,
      // Anything other than the two known values is treated as unrecorded
      // rather than trusted — a caption that says "filed under another name"
      // must be backed by a row that really says so.
      via: row.matched_via === 'synonym' || row.matched_via === 'name' ? row.matched_via : null,
      checkedAt: Number(row.checked_at ?? 0),
    };
  } catch {
    // A cache miss must not break the map; treat it as never asked, at the cost of
    // one extra API call.
    return null;
  }
}

export function writeInatTaxonCache(name: string, kingdom: string, info: InatTaxonInfo): void {
  const key = name.trim();
  if (!key) return;
  try {
    getUserDb().executeSync(
      `INSERT OR REPLACE INTO inat_taxon_map
         (name, kingdom, inat_taxon_id, obs_wild, obs_total, inat_name, matched_via, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        kingdom ?? '',
        info.inatTaxonId,
        info.obsWild,
        info.obsTotal,
        info.inatName ?? null,
        info.via ?? null,
        Date.now(),
      ],
    );
  } catch {
    // Failing to write only means asking again next time, which is not worth
    // interrupting the user for.
  }
}
