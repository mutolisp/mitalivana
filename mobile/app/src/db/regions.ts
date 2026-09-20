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
 * 使用者「想要」哪些區域 —— 直接讀 settings 表，讓 DB 層不必依賴 React store。
 * 可能是 []（只用 pack）或 ['JP']；TW 是預設值而不是常數（store 的 parser 也
 * 同樣處理，兩邊要保持一致）。讀不到／壞掉 → ['TW']。
 *
 * 這是**意圖**，不是可用集合：名錄模組可以下載、刪除，所以「開了 JP 但還沒
 * 下載日本名錄」是正常狀態。區域設定畫面顯示這個；查詢要用
 * `getEnabledRegions()`。
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
 * 實際可以查詢的區域 = 想要 ∩ 已安裝。
 *
 * 交集只存在這一個函式裡：把一份寫著 ['TW','JP'] 的備份還原到只裝了臺灣名錄的
 * 裝置時，查詢安全（只會查 TW），而使用者的意圖仍然保留在 settings 裡，區域頁
 * 才能顯示「日本名錄已啟用但尚未下載」。
 */
export function getEnabledRegions(): RegionCode[] {
  const requested = getRequestedRegions();
  const installed = installedRegions();
  return requested.filter((r) => installed.includes(r));
}

/** 檢索表可用（模組已安裝、臺灣名錄也在、且 TW 已啟用）。所有 檢索表 UI 的
 *  單一守門。 */
export function keysAvailable(): boolean {
  return isAvailable('tw-keys');
}

// registry 需要知道某個 region 是否被使用者要求，但它不能反過來 import 本檔
// （會形成 cycle），所以在這裡註冊。
configureRegionReader((region) => getRequestedRegions().includes(region));

/** Where a taxon_id's data lives. The first character is the whole
 *  discriminator: TaiCOL 't…', Japan 'y…', external (GBIF) 'g…'. */
export type TaxonSource = 'taicol' | 'jp' | 'external';

/** taxon_id belongs to the Japan (YList / wamei) dataset. */
export function isJpTaxonId(taxonId: string | null | undefined): boolean {
  return !!taxonId && taxonId.charAt(0) === 'y';
}

/** taxon_id was minted for a species absent from both bundled checklists; its
 *  row lives in user.db's `external_taxa`, not in twnamelist.db. */
export function isExternalTaxonId(taxonId: string | null | undefined): boolean {
  return !!taxonId && taxonId.charAt(0) === 'g';
}

export function sourceOfTaxonId(taxonId: string | null | undefined): TaxonSource {
  if (isExternalTaxonId(taxonId)) return 'external';
  // registry 是前綴 → 模組的唯一權威；未知前綴保留舊行為（當成 TaiCOL），
  // 呼叫端拿到的仍是一個它處理得了的值。
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
 *  taxon must not borrow Taiwan's wording. TaiCOL keeps its existing "特有種". */
export function endemicTagLabel(taxonId: string | null | undefined): string {
  return isJpTaxonId(taxonId) ? i18n.t('species.japanEndemic') : i18n.t('species.endemic');
}

/** Normalize a scientific name into the cross-region match key — must mirror
 *  `sci_norm()` in backend/services/ylist_import.py exactly. */
export function normalizeSci(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/×/g, 'x');
}

/** SQLite 的變數上限預設 999；`getSpeciesUnder` 之類的呼叫端可能丟上千個 id。 */
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
 * 名錄拆成獨立檔之後，原本的 `species_xref` 同檔自我 JOIN 不可能成立了（不同
 * 模組 = 不同 SQLite 檔，這個 app 從不 ATTACH）。改成兩段：
 *   ① 在**擁有該 id 的模組**裡查 taxon_id → sci_norm（PK 查詢）
 *   ② 拿 sci_norm 去**每個可用模組**查俗名（吃 idx_xref_sci_norm）
 * 兩段都是索引查詢，最多各 2 次。
 *
 * `AND region = ?` 不是贅字：過渡期（步驟 1–5）三個模組共用同一個合併檔，那個
 * 檔的 `species_xref` 兩區的列都在，少了這個條件就會從「臺灣模組」讀出日本
 * 俗名 —— 而且只在最難測到的過渡窗口出錯。
 *
 * 只有兩個以上名錄模組可用時才有意義；只有臺灣（預設）時直接早退，成本為零，
 * 維持「與 region 功能出現前 byte-identical」的不變式。
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
    // ① id → sci_norm，依擁有的模組分組
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
