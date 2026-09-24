import {
  availableNameDatasets,
  configureRegionReader,
  datasetForTaxonId,
  getDatasetDb,
  installedRegions,
  isAvailable,
} from './datasets';
import { getUserDb } from './init';
import { stitchCrossRegion } from './mergeScope';
import i18n from '~/i18n';
import type { RegionCode } from '~/stores/settings';

/**
 * Regional checklist helpers. Taiwan (TaiCOL) and Japan (YList → `jp_names`)
 * are both toggleable — since the unified region page, TW is a default, not a
 * constant. With exactly ['TW'] enabled the whole app still behaves as it did
 * before regions existed — every region-aware code path early-returns to its
 * original TaiCOL-only branch. The "at least one region/pack stays enabled"
 * rule is enforced by the region management UI, not here.
 *
 * Backend-built crosswalk (bundled in twnamelist.db, see
 * backend/services/ylist_import.py) powers the overlay:
 *   - species_xref(taxon_id, region, sci_norm, common_name_c) — same sci_norm
 *     across regions = shared species. Carries common_name_c so cross-region
 *     vernacular lookup is a pure self-join (no big-table / view join).
 *
 * taxon_id namespaces never collide: TaiCOL = 't…', YList = 'y…' — so any
 * taxon_id resolves by querying taicol_names or jp_names directly.
 */

/**
 * Which regions the user *wants* — read straight from the settings table so the
 * DB layer needs no React store. May be [] (packs only) or ['JP']; TW is a
 * default rather than a constant (the store's parser does the same, and the two
 * must agree). Unreadable or corrupt → ['TW'].
 *
 * This is **intent**, not the usable set: checklist modules can be downloaded
 * and deleted, so "JP enabled but the Japan checklist not downloaded yet" is a
 * normal state. The region settings screen shows this; queries must use
 * `getEnabledRegions()`.
 */
export function getRequestedRegions(): RegionCode[] {
  try {
    const res = getUserDb().executeSync(
      `SELECT value FROM settings WHERE key='enabled_regions' LIMIT 1`,
    );
    const raw = ((res.rows ?? [])[0] as { value?: string } | undefined)?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is RegionCode => v === 'TW' || v === 'JP');
      }
    }
  } catch {
    // settings unavailable — fall through to default
  }
  return ['TW'];
}

/**
 * The regions actually queryable = wanted ∩ installed.
 *
 * The intersection lives in this one function: restoring a backup that says
 * ['TW','JP'] onto a device with only the Taiwan checklist keeps queries safe
 * (TW only) while the user's intent survives in settings, so the region screen
 * can still show "Japan checklist enabled but not downloaded".
 */
export function getEnabledRegions(): RegionCode[] {
  const requested = getRequestedRegions();
  const installed = installedRegions();
  return requested.filter((r) => installed.includes(r));
}

/** Identification keys are usable (module installed, Taiwan checklist present,
 *  and TW enabled). The single gate for all key UI. */
export function keysAvailable(): boolean {
  return isAvailable('tw-keys');
}

// The registry needs to know whether a region was requested, but it cannot
// import this file back (that would be a cycle), so it is registered here.
configureRegionReader((region) => getRequestedRegions().includes(region));

/** Where a taxon_id's data lives. The first character is the whole
 *  discriminator: TaiCOL 't…', Japan 'y…', external (GBIF) 'g…'. */
export type TaxonSource = 'taicol' | 'jp' | 'external';

/** taxon_id belongs to the Japan (YList / wamei) dataset. */
export function isJpTaxonId(taxonId: string | null | undefined): boolean {
  return !!taxonId && taxonId.charAt(0) === 'y';
}

/** taxon_id was minted for a species absent from both bundled checklists; its
 *  row lives in user.db's `external_taxa`, not in twnamelist.db.
 *  Defined in `~/lib/taxonId` (pure, so a check script can exercise it) and
 *  re-exported here because this is where callers look for it. */
export { isExternalTaxonId } from '~/lib/taxonId';
import { isExternalTaxonId } from '~/lib/taxonId';

export function sourceOfTaxonId(taxonId: string | null | undefined): TaxonSource {
  if (isExternalTaxonId(taxonId)) return 'external';
  // The registry is the sole authority for prefix → module; an unknown prefix
  // keeps the old behaviour (treated as TaiCOL) so the caller still gets a value
  // it can handle.
  const spec = datasetForTaxonId(taxonId ?? '');
  if (spec?.id === 'jp-ylist') return 'jp';
  return 'taicol';
}

/**
 * Region for cross-region vernacular composition.
 *
 * NOTE this is a REGION, not a source: external taxa have no region of their
 * own and deliberately report 'TW' so they simply take the no-cross-vernacular
 * path. Use `sourceOfTaxonId` to decide which table to query — asking this
 * function is what would silently send a 'g…' id to taicol_names.
 */
export function regionOfTaxonId(taxonId: string | null | undefined): RegionCode {
  return isJpTaxonId(taxonId) ? 'JP' : 'TW';
}

/** Endemic-status tag text. YList `is_endemic` means *Japan*-endemic, so a 'y…'
 *  taxon must not borrow Taiwan's wording. TaiCOL keeps its existing
 *  Taiwan-endemic label (`species.endemic`). */
export function endemicTagLabel(taxonId: string | null | undefined): string {
  return isJpTaxonId(taxonId) ? i18n.t('species.japanEndemic') : i18n.t('species.endemic');
}

/** Normalize a scientific name into the cross-region match key — must mirror
 *  `sci_norm()` in backend/services/ylist_import.py exactly. */
export function normalizeSci(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/×/g, 'x');
}

/** SQLite's variable limit defaults to 999, and callers like `getSpeciesUnder`
 *  can pass a thousand ids. */
const IN_CHUNK = 500;

function chunked<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * For a set of taxon_ids, look up the accepted vernacular name in each enabled
 * region via the scientific-name crosswalk. Returns taxon_id → { tw?, jp? }.
 *
 * Once the checklists became separate files the original self-JOIN on
 * `species_xref` could not work any more (different modules = different SQLite
 * files, and this app never ATTACHes). It is now two stages:
 *   1. look up taxon_id → sci_norm **in the module that owns the id** (a PK
 *      lookup)
 *   2. take that sci_norm to **every available module** for the vernacular name
 *      (hits idx_xref_sci_norm)
 * Both stages are index lookups, at most two each.
 *
 * `AND region = ?` is not redundant: during the transition (steps 1-5) all three
 * modules shared one merged file whose `species_xref` holds rows for both
 * regions, and without the condition the "Taiwan module" would return Japanese
 * vernacular names — failing only inside the hardest window to test.
 *
 * Only meaningful with two or more checklist modules available; with Taiwan
 * alone (the default) it returns early at zero cost, preserving the invariant
 * that this is byte-identical to the behaviour before regions existed.
 */
export function crossRegionVernacular(
  taxonIds: string[],
  regions: RegionCode[],
): Map<string, { tw?: string; jp?: string }> {
  const out = new Map<string, { tw?: string; jp?: string }>();
  const ids = [...new Set(taxonIds.filter(Boolean))];
  if (ids.length === 0 || regions.length === 0) return out;

  const datasets = availableNameDatasets().filter(
    (spec) => spec.region && regions.includes(spec.region),
  );
  if (datasets.length < 2) return out;

  try {
    // 1. id → sci_norm, grouped by the owning module
    const norms = new Map<string, string>();
    const byDataset = new Map<string, string[]>();
    for (const id of ids) {
      const spec = datasetForTaxonId(id);
      if (!spec) continue;
      const bucket = byDataset.get(spec.id);
      if (bucket) bucket.push(id);
      else byDataset.set(spec.id, [id]);
    }
    for (const [datasetId, subset] of byDataset) {
      const spec = datasets.find((d) => d.id === datasetId);
      if (!spec || spec.tables.kind !== 'names' || !spec.tables.xref) continue;
      const db = getDatasetDb(spec.id);
      if (!db) continue;
      for (const chunk of chunked(subset)) {
        const res = db.executeSync(
          `SELECT taxon_id, sci_norm FROM ${spec.tables.xref}
            WHERE taxon_id IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        );
        for (const row of (res.rows ?? []) as { taxon_id: string; sci_norm: string }[]) {
          if (row.sci_norm) norms.set(row.taxon_id, row.sci_norm);
        }
      }
    }
    if (norms.size === 0) return out;

    // ② sci_norm → 各區俗名
    const distinct = [...new Set(norms.values())];
    const cnamesByRegion = new Map<RegionCode, Map<string, string>>();
    for (const spec of datasets) {
      if (spec.tables.kind !== 'names' || !spec.tables.xref || !spec.region) continue;
      const db = getDatasetDb(spec.id);
      if (!db) continue;
      const byNorm = cnamesByRegion.get(spec.region) ?? new Map<string, string>();
      for (const chunk of chunked(distinct)) {
        const res = db.executeSync(
          `SELECT sci_norm, common_name_c FROM ${spec.tables.xref}
            WHERE sci_norm IN (${chunk.map(() => '?').join(',')})
              AND region = ? AND common_name_c IS NOT NULL`,
          [...chunk, spec.region],
        );
        for (const row of (res.rows ?? []) as { sci_norm: string; common_name_c: string }[]) {
          if (!row.common_name_c) continue;
          if (!byNorm.has(row.sci_norm)) byNorm.set(row.sci_norm, row.common_name_c);
        }
      }
      cnamesByRegion.set(spec.region, byNorm);
    }

    // ③ 縫合（純邏輯，另有 check-datasets.mjs 驗證）
    for (const [id, entry] of stitchCrossRegion(norms, cnamesByRegion)) out.set(id, entry);
  } catch {
    // crosswalk objects absent — degrade to no enrichment
  }
  return out;
}

/**
 * Compose the display vernacular for a row from its own name/region and the
 * cross-region lookup. Shared species → "臺灣俗名 / 和名"; single-region → that
 * region's name. Falls back to ownCname when the crosswalk had nothing.
 */
export function composeVernacular(
  ownCname: string,
  ownRegion: RegionCode,
  cross: { tw?: string; jp?: string } | undefined,
  regions: RegionCode[],
): string {
  const tw = cross?.tw ?? (ownRegion === 'TW' ? ownCname : undefined);
  const jp = cross?.jp ?? (ownRegion === 'JP' ? ownCname : undefined);
  const parts: string[] = [];
  if (regions.includes('TW') && tw) parts.push(tw);
  if (regions.includes('JP') && jp && jp !== tw) parts.push(jp);
  return parts.length > 0 ? parts.join(' / ') : ownCname;
}

// Pure, so it lives with the other cross-region logic (runs under Node).
export { pickVernacular } from './mergeScope';
