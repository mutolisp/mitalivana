/**
 * Pure building blocks of the per-record export zips, shared by
 * bundleExport.ts (mobile) and the GLORIA web app (web/gloria): file names,
 * the README of a record folder, manifest.json, and the taxon half of a
 * checklist item. No Expo, no DB, no i18n — keep it that way, the web build
 * imports this file directly.
 */
import type { ZipOptions } from 'fflate';
import type { TaxonFields } from '~/db/taxonLookup';
import type { generateMarkdown } from './markdown';
import type { BundleItem, GeoFormat } from './bundleExport';

export type BuiltZipEntry = {
  name: string;
  bytes: Uint8Array;
  zipOpts?: ZipOptions;
  /** Formula-like values inside this entry, counted when it was built: a
   *  nested DwC-A, which the tally of the outer tables cannot see (code review L50). */
  formulaRaw?: number;
};

export function sanitizeFilename(name: string): string {
  // Allow Unicode letters (incl. CJK), digits, underscore, hyphen, dot. Without
  // \p{L}/\p{N} a Chinese name like 「樹木學」 becomes 「___」 because \w only
  // matches ASCII. Drop separators (space, slash, etc.) → underscore.
  // Trim leading/trailing dots so the entry doesn't accidentally become hidden.
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return cleaned.replace(/^[._]+|[._]+$/g, '').slice(0, 80) || 'export';
}

export function parsePhotoUris(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    // ignore
  }
  return [];
}

export function mapAlienToSource(alienType: string, kingdom: string): string {
  if (alienType === 'cultured') return kingdom === 'Animalia' ? '圈養' : '栽培';
  if (alienType === 'native') return '原生';
  if (alienType === 'naturalized' || alienType === 'invasive') return '歸化';
  return '';
}

/**
 * The taxon-derived half of a checklist item, with nothing observation-specific
 * in it.
 *
 * Split out so a 常用名錄 — which has a taxon_id and resolved TaxonFields but no
 * observation at all — can be exported through exactly the same Markdown/DOCX
 * pipeline as a session, rather than growing a second mapping that would drift.
 */
export function taxonToMarkdownItem(
  taxonId: string,
  r: TaxonFields,
): Parameters<typeof generateMarkdown>[0][number] {
  const fullname = r.name_author ? `${r.simple_name} ${r.name_author}` : r.simple_name;
  return {
    taxon_id: taxonId,
    name: r.simple_name,
    fullname,
    name_author: r.name_author,
    cname: r.common_name_c,
    family: r.family,
    family_c: r.family_c,
    family_cname: r.family_c,
    kingdom: r.kingdom,
    kingdom_c: r.kingdom_c,
    phylum: r.phylum,
    phylum_c: r.phylum_c,
    class_name: r.class,
    class_c: r.class_c,
    order: r.order,
    order_c: r.order_c,
    genus: r.genus,
    genus_c: r.genus_c,
    rank: r.rank,
    endemic: r.is_endemic === 'true' ? 1 : 0,
    source: mapAlienToSource(r.alien_type, r.kingdom),
    redlist: r.redlist,
    iucn_category: r.iucn,
    cites: r.cites,
    protected: r.protected,
    is_hybrid: r.is_hybrid,
    nomenclature_name: '',
  };
}

/**
 * README of a single-record zip.
 *
 * The file list is worked out from the entries actually produced, not written
 * out by hand: photos on or off, subplots or not, DwC-A or not — every export
 * holds a different set, and a fixed list would drift from what is in the zip.
 * The text is always Traditional Chinese, like the project export's README
 * (the export language setting applies to the checklist itself only).
 */
const README_RULES: Array<{ match: (name: string) => boolean; desc: string }> = [
  { match: (n) => n.endsWith('.yml'), desc: '本 app 的完整格式（可從「匯入記錄」原樣讀回，含照片檔名對應）' },
  {
    match: (n) => n.endsWith('_occurrence_dwc.csv'),
    desc: 'Darwin Core occurrence 表：一列一筆物種記錄，欄名為 DwC 詞彙（basisOfRecord / eventID / taxonID / scientificName…），給 Excel 開啟：以 = + - @ 開頭的文字前加了單引號（避免被當成公式）；給 R 或 GBIF 請用 Darwin Core Archive（dwca/）',
  },
  { match: (n) => n.endsWith('_env.csv'), desc: '事件層（Event）中繼資料與環境值，tall 格式（term,value）' },
  { match: (n) => n.endsWith('_subplots.csv'), desc: '小區尺寸與各層覆蓋度／高度' },
  {
    match: (n) => n.endsWith('_quadrats.csv'),
    desc: '小樣方物種：一列一個小樣方中的一種物種，覆蓋度、頻度（格數與 %）與每一格是否出現（f{列}{欄}，1 起算）',
  },
  {
    match: (n) => n.endsWith('_frequency.csv'),
    desc: '樣區頻度：整個樣區一個網格，一列一筆物種記錄（物種＋層次），頻度（格數與 %）與每一格是否出現（f{列}{欄}）',
  },
  { match: (n) => n.endsWith('_quadrat_surface.csv'), desc: '小樣方：一列一個小樣方，地表覆蓋、位置、大小、格數與上邊方向' },
  {
    match: (n) => n.includes('/dwca/'),
    desc: 'Darwin Core Archive：event.txt（Event core）+ occurrence.txt + humboldt.txt + measurementorfact.txt（量測，每木的胸徑等在此）+ resourcerelationship.txt（交互作用）+ meta.xml + eml.xml，可直接上傳 GBIF IPT',
  },
  { match: (n) => n.endsWith('_04_temperature_loggers.csv'), desc: '溫度計（Form 4）：每支溫度計每次巡查一列，讀取與新部署；非 GLORIA Sheet 原有分頁' },
  { match: (n) => n.includes('/loggers/'), desc: '溫度計資料檔（全長碼_序號_原檔名）與 Form 4 掃描檔（01_ 的表單識別碼）' },
  { match: (n) => n.includes('/forms/'), desc: 'GLORIA 紙本表單掃描檔（Form 1、2、3、6-S；檔名為 01_ 的表單識別碼，同一表單第二個檔案起加 -2、-3）' },
  // Tree census (Modular_survey.md §7.4; columns per Condit 1998 Table 3.2.2, book p.139).
  { match: (n) => n.endsWith('_trees.csv'), desc: '每木調查個體表：一列一株，樹號、物種、樣方、子樣方、全區 x,y（Condit 1998 Table 3.2.2 A）' },
  {
    match: (n) => n.endsWith('_census.csv'),
    desc: '每木調查回合表：每回合一列一株，列出所有曾記錄的個體；DBH（mm，最大的活分支）、POM 序號、活分支數、狀態 A 存活／D 死亡／F 存活但未達門檻／P 尚未出現（空白＝這回合還沒記錄）、日期、代碼（Condit 1998 Table 3.2.2 B 與 p.166）',
  },
  { match: (n) => n.endsWith('_stems.csv'), desc: '每木調查分支表：每回合一列一個有量測的分支，DBH（cm 與 mm）、POM 高度與序號、主分支、分支死亡、代碼' },
  { match: (n) => /_vegan_basal_area_census\d+\.csv$/.test(n), desc: '每木調查 vegan 群落矩陣：一回合一個檔，列為樣方、欄為物種，值為活分支的胸高斷面積（cm²）' },
  // Checklist / plot-style surveys (Phase 2E-a, src/survey/export/surveyExportCore.ts).
  { match: (n) => n.endsWith('_survey.csv'), desc: '調查表：這次調查一列，eventID、模板與版本、永久樣區與系列代號、次數，加上調查層各元件的欄位' },
  { match: (n) => n.endsWith('_units.csv'), desc: '單位表（樣區型）：一列一個單位，eventID 與上層 parentEventID、層級、代碼，加上單位層各元件的欄位' },
  {
    match: (n) => n.endsWith('_occurrences.csv'),
    desc: '出現記錄表：一列一筆，所在單位、物種，加上出現記錄各元件的欄位（欄名「元件 key.欄位」，自訂選項另有 _name 欄）；interaction_partner 為 1 的是只因交互作用而記的物種，不在群落矩陣內',
  },
  {
    match: (n) => n.endsWith('_interactions.csv'),
    desc: '交互作用表：一列一筆，A（subject，做這件事的一方）與 B（object）的出現記錄與物種、類型、關係（OBO Relation Ontology 名稱與 IRI）、是否雙向、次數、時間、照片檔名',
  },
  { match: (n) => n.endsWith('_interaction_types.csv'), desc: '交互作用類型：內建與模板自訂的類型、關係名稱與 IRI、從 B 看的說法、是否雙向、是否仍提供' },
  { match: (n) => /_interactions_[^/]+\.csv$/.test(n), desc: '交互作用矩陣：每種類型一個檔，列為 A（做這件事的一方）、欄為 B，值為次數合計（沒記次數的一筆算 1）；無 BOM，供 R 直接讀取' },
  { match: (n) => n.endsWith('_fields.csv'), desc: '欄位說明：每個元件欄位的元件名稱、單位、對應的 DwC 詞彙或量測類型' },
  { match: (n) => n.endsWith('_codelists.csv'), desc: '代碼清單：模板自己的代碼、名稱與是否停用' },
  { match: (n) => n.endsWith('_rechecks.csv'), desc: '複查結果：前次有、這次盲測沒記的物種逐一的結果' },
  {
    match: (n) => /_vegan_(presence|bb_cover_pct|percent_cover|count|basal_area_cm2)\.csv$/.test(n),
    desc: 'vegan 群落矩陣（樣區型）：列為單位、欄為物種；presence 為有無，其餘一種豐度尺度一個檔，只含用該尺度的記錄（Braun-Blanquet 換算為覆蓋度 %：r=1、+=2、1=3、2=15、3=38、4=63、5=88，出處同專案匯出的 cover_scale.csv；同格多筆取最大；個體數相加；胸徑為胸高斷面積 cm²）；無 BOM，供 R 直接讀取',
  },
  { match: (n) => n.endsWith('.md'), desc: '物種名錄文件（Markdown）' },
  { match: (n) => n.endsWith('.docx'), desc: '物種名錄文件（DOCX 排版文書檔）' },
  { match: (n) => n.endsWith('.odt'), desc: '物種名錄文件（ODT 排版文書檔）' },
  { match: (n) => n.includes('/photos/'), desc: '記錄的照片（檔名對應 yml 的 photo_files）' },
  { match: (n) => n.includes('/audio/'), desc: '記錄的錄音（檔名對應 yml 的 audio_files）' },
  { match: (n) => /\/(points|track|site)\.(geojson|gpx|kml)$/.test(n), desc: '地理檔（GIS／GNSS 軟體用）' },
  { match: (n) => n.endsWith('manifest.json'), desc: '匯出中繼資料（記錄種類、筆數、產生時間）' },
];

export function buildRecordReadme(title: string, entries: BuiltZipEntry[]): string {
  const lines = [`# ${title}`, '', '本資料夾的檔案：', ''];
  const used = new Set<string>();
  for (const e of entries) {
    const rule = README_RULES.find((r) => r.match(e.name));
    if (!rule || used.has(rule.desc)) continue;
    used.add(rule.desc);
    const shown = e.name.includes('/photos/')
      ? 'photos/'
      : e.name.includes('/dwca/')
        ? 'dwca/*.zip'
        : e.name.slice(e.name.indexOf('/') + 1);
    lines.push(`- \`${shown}\` — ${rule.desc}`);
  }
  if (entries.some((e) => e.name.endsWith('.csv'))) {
    // Code review L17 (src/lib/csvFormula.ts).
    lines.push(
      '',
      '表格中以 = + - @ 等字元開頭、又不是數字的值：有 UTF-8 BOM、給 Excel 開的表格在前面加了單引號（\'），以免被試算表當成公式；給 R 與 GBIF 的檔案（無 BOM 的矩陣、DwC-A）保留原值。',
    );
  }
  lines.push('', '由 Mitalivana 匯出。');
  return lines.join('\n');
}

export function buildManifest(meta: {
  kind: 'session' | 'plot' | 'collection' | 'gloria' | 'survey' | 'modular' | 'bundle';
  id?: number;
  /** Plot survey uuid (plot_surveys.uuid) — the stable round-trip key. */
  uuid?: string;
  name?: string;
  project_name?: string;
  record_count?: number;
  photo_count?: number;
  geoFormats?: GeoFormat[];
  items?: BundleItem[];
}): object {
  return {
    app: 'mitalivana',
    schema_version: 2,
    created_at: new Date().toISOString(),
    ...meta,
  };
}
