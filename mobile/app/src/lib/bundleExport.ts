/**
 * Bundle export: pack one or more records (session / plot / collection) into a single zip
 * containing YAML / CSV / Markdown checklist, GeoJSON / GPX / KML for points
 * + tracks + bound site, plus photos copied from the device library.
 *
 * Uses `fflate.zipSync` for the final pack — synchronous but memory-bounded
 * because we don't keep the source strings/bytes alive once they're in the
 * input map. Photo reads are async (asset → file URI → base64 → bytes) and
 * happen serially with a progress callback so the UI can update.
 */
import { errText } from '~/lib/errText';
import { File, Paths } from 'expo-file-system';
import { safeAppFileUri } from './appFiles';
import { syncBlockFor } from '~/db/syncBase';
import { readAsStringAsync } from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import yaml from 'js-yaml';
import { strFromU8, strToU8, zipSync, type Zippable, type ZipOptions } from 'fflate';
import {
  getActiveLayers,
  getPlotLayers,
  getSubplotLayers,
  listSubplots,
  getProject,
  getSession,
  getSite,
  getPlotSurvey,
  layerIndexOf,
  listSessionRecords,
  listPlotSpecies,
  parseEnvPhotos,
  getCollectionTrip,
  listSpecimens,
  type FixedLayer,
  type PlotType,
  type PlotSurvey,
  type RecordWithTaxon,
  type TaxonFields,
  type PlotSpeciesRecordWithTaxon,
  type SpecimenWithTaxon,
  type ImportedSite,
  type Site,
} from '~/db';
import type { DocFormat } from '~/stores/settings';
import { GEODETIC_DATUM, locationTerms } from './dwcLocation';
import { establishmentDwcValue } from './dwcAttributes';
import { AUDIO_EXT, parseAudioPaths } from './audioCapture';
import { checklistIdentity, uniqueByIdentity } from './checklistIdentity';
export { checklistIdentity, uniqueByIdentity };
import { convertToDwc } from './dwcMapper';
import {
  buildContext,
  buildContextFromPlotRecord,
  buildContextFromSpecimen,
  restampJpegBase64,
  type PhotoSpeciesContext,
} from './photoCapture';
import {
  buildCollectionYamlDoc,
  buildPlotEnvRows,
  buildPlotYamlDoc,
  buildSessionYamlDoc,
  csvEscape,
  localIso,
  multiToPipe,
  recordToYamlItem,
  specimenToYamlItem,
  type PhotoNames,
} from './bundleYaml';
import i18n from '~/i18n';
import { generateMarkdown, type ConservationField } from './markdown';
import type { Translate } from './reportTypes';
import { DOC_FORMATS } from './docFormat';
import { buildRecordsDwca, type DwcaInput } from './dwcRows';
import { geoJsonToGpx, geoJsonToKml } from './geoSerializers';
import { injectFileDigests, isManifestPath } from './manifestDigest';
import { injectSignatures } from './signing';
import { activeSigner } from './signingKey';
import {
  getGloriaSurvey,
  getSummit,
  listPhotoChecks,
  listPoints as listGloriaPoints,
  listUnits as listGloriaUnits,
  loadExportData,
  loadGloriaDoc,
  listSurveySpecies as listGloriaSpecies,
  p5mOf,
} from '~/modules/gloria/db';
import { planPhotoNames, yyyymmdd } from '~/modules/gloria/export/photoNames';
import { parseOverviewPhotos } from '~/modules/gloria/model/overview';
import { CHECKLIST_HEADER, checklistRows, checklistState } from '~/modules/gloria/model/photoChecks';
import { buildPointHitRows, buildSheetTables, POINT_HITS_HEADER, toCsv } from '~/modules/gloria/export/sheetRows';
import { H04_TEMPERATURE_LOGGERS, loggerRows, planLoggerFiles, type ExportVisit } from '~/modules/gloria/export/loggerRows';
import { planFormScans } from '~/modules/gloria/model/formScans';
import { listLoggers, listVisits, summitCycles } from '~/modules/gloria/loggerDb';
import { cycleOf, loggerPhotoItem } from '~/modules/gloria/model/loggers';


export type GeoFormat = 'geojson' | 'gpx' | 'kml';

/** Structured progress update for the export overlay. `done`/`total` (when
 *  present) drive a progress bar; `label` is the current stage caption. */
export type ExportProgress = { label: string; done?: number; total?: number };

/** Internal cumulative photo-progress context threaded through the builders. */
type ProgressCtx = { done: number; total: number; onProgress?: (p: ExportProgress) => void };

export type BundleOptions = {
  geoFormats: GeoFormat[];
  includePhotos: boolean;
  /** Collapse repeated species in the checklist DOCUMENTS (md / docx / odt).
   *  The occurrence CSV and the DwC-A always keep every record. */
  mergeDuplicateTaxa: boolean;
  /** Emit a formatted document version of the checklist alongside the .md. */
  includeDocx: boolean;
  /** Format of that document. */
  docFormat: DocFormat;
  /** Classification levels override for the checklist; empty = per-group defaults. */
  levels: string[];
  /** Conservation-status columns to include in the checklist. */
  conservationFields: ConservationField[];
  /** Hide least concern: species lines omit the safe categories (LC/NLC/NE/NA).
 *  The statistics are unaffected. */
  conservationHideLowConcern: boolean;
  /** Emit a Darwin Core Archive (dwca/…zip) for this record. Mirrors the
   *  project export's 'dwca' analysis-format checkbox. */
  includeDwca: boolean;
  /** Language for the checklist's prose and group headings. Omitted =
   *  current UI language. Species names, DwC terms and conservation codes
   *  are data and never follow it. */
  lang?: string;
  /** Reports export progress (stage + optional done/total). */
  onProgress?: (p: ExportProgress) => void;
};

/** Canonical ordering for checklist hierarchy levels (mirrors backend
 *  LEVEL_ORDER). The picker stores tap order; we reorder here so the grouping
 *  is always taxonomically sensible regardless of how the user clicked. */
const LEVEL_ORDER = ['kingdom', 'phylum', 'class_name', 'order', 'family', 'genus'];
export function orderLevels(sel: string[]): string[] {
  return LEVEL_ORDER.filter((l) => sel.includes(l));
}

/** Translator for the checklist document. Resolving it here rather than inside
 *  `markdown.ts` is what keeps that module pure and therefore able to render any
 *  language — same split the report renderers use. */
export function checklistT(lang?: string): Translate {
  return i18n.getFixedT(lang ?? i18n.language) as unknown as Translate;
}

export type ExportFile = {
  uri: string;
  filename: string;
  mimeType: string;
};

export type BundleItem =
  | { kind: 'session'; id: number }
  | { kind: 'plot'; id: number }
  | { kind: 'collection'; id: number }
  | { kind: 'gloria'; id: number };

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

/** DB site row → the `site:` block both ymls carry. Returns null when the
 *  stored geometry is unparseable (the sidecar files skip it too). */
export function siteToImported(site: Site): ImportedSite | null {
  const geom = parseGeoJsonSafe(site.geometry_geojson);
  if (!geom) return null;
  return { name: site.name, notes: site.notes, geometry: geom as ImportedSite['geometry'] };
}

function parseGeoJsonSafe(s: string | null): object | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as object;
  } catch {
    return null;
  }
}

// ---- DwC helpers (mirror exporters.ts shape) ------------------------------


/** Compare two taxon-bearing rows by full taxonomic hierarchy, then scientific
 *  name — kingdom → phylum → class → order → family → genus → species (all
 *  alphabetical). Used to order exported CSV rows. */
type TaxonSortable = {
  kingdom: string;
  phylum: string;
  class: string;
  order: string;
  family: string;
  genus: string;
  simple_name: string;
};
function taxonSortCompare(a: TaxonSortable, b: TaxonSortable): number {
  const fields: (keyof TaxonSortable)[] = [
    'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'simple_name',
  ];
  for (const f of fields) {
    const c = (a[f] ?? '').localeCompare(b[f] ?? '');
    if (c !== 0) return c;
  }
  return 0;
}


/** A specimen is a DwC occurrence with `basisOfRecord: PreservedSpecimen` and a
 *  collector number (`recordNumber`). Kept literal — a DwC controlled-vocabulary
 *  value, so it is never localized (same rule as `sampling_protocol`). */

export function specimenToMarkdownItem(
  sp: SpecimenWithTaxon,
): Parameters<typeof generateMarkdown>[0][number] {
  const fullname = sp.name_author ? `${sp.simple_name} ${sp.name_author}` : sp.simple_name;
  return {
    taxon_id: sp.taxon_id,
    name: sp.simple_name,
    fullname,
    name_author: sp.name_author,
    cname: sp.common_name_c,
    family: sp.family,
    family_c: sp.family_c,
    family_cname: sp.family_c,
    kingdom: sp.kingdom,
    kingdom_c: sp.kingdom_c,
    phylum: sp.phylum,
    phylum_c: sp.phylum_c,
    class_name: sp.class,
    class_c: sp.class_c,
    order: sp.order,
    order_c: sp.order_c,
    genus: sp.genus,
    genus_c: sp.genus_c,
    rank: sp.rank,
    endemic: sp.is_endemic === 'true' ? 1 : 0,
    source: mapAlienToSource(sp.alien_type, sp.kingdom),
    redlist: sp.redlist,
    iucn_category: sp.iucn,
    cites: sp.cites,
    protected: sp.protected,
    is_hybrid: sp.is_hybrid,
    nomenclature_name: '',
    notes: sp.notes,
  };
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

export function recordToMarkdownItem(r: RecordWithTaxon): Parameters<typeof generateMarkdown>[0][number] {
  return { ...taxonToMarkdownItem(r.taxon_id, r), notes: r.notes };
}


/** Map a plot species record to a checklist MarkdownItem (mirrors
 *  recordToMarkdownItem). Used for the deduped `_checklist.md` per plot. */
export function plotSpeciesToMarkdownItem(
  r: PlotSpeciesRecordWithTaxon,
): Parameters<typeof generateMarkdown>[0][number] {
  const fullname = r.name_author ? `${r.simple_name} ${r.name_author}` : r.simple_name;
  return {
    taxon_id: r.taxon_id,
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
 * DwC occurrence rows → CSV text.
 *
 * Header is the union of the rows' own keys, so a field only some records
 * carry (a determination note, an adopted name) still gets its column. It used
 * to be derived from the *yml* items while the values came from the DwC rows —
 * the two key sets happened to match, but nothing enforced it.
 *
 * UTF-8 BOM: Excel on Windows reads a BOM-less UTF-8 CSV as the local codepage
 * and mangles every Chinese name.
 */
/**
 * 單筆記錄 zip 的 README。
 *
 * 從實際產出的 entries 反推檔案清單，不是寫死的說明 —— 勾不勾照片、有沒有
 * 樣區小區、DwC-A 開不開，每次的檔案組合都不同，寫死的清單一定會跟產出漂移。
 * 內容固定用正體中文，與專案匯出的 README 一致（匯出文件的語言選擇只作用在
 * 名錄本身）。
 */
const README_RULES: Array<{ match: (name: string) => boolean; desc: string }> = [
  { match: (n) => n.endsWith('.yml'), desc: '本 app 的完整格式（可從「匯入記錄」原樣讀回，含照片檔名對應）' },
  {
    match: (n) => n.endsWith('_occurrence_dwc.csv'),
    desc: 'Darwin Core occurrence 表：一列一筆物種記錄，欄名為 DwC 詞彙（basisOfRecord / eventID / taxonID / scientificName…），可直接給 Excel、R、GBIF 對照',
  },
  { match: (n) => n.endsWith('_env.csv'), desc: '事件層（Event）中繼資料與環境值，tall 格式（term,value）' },
  { match: (n) => n.endsWith('_subplots.csv'), desc: '小區尺寸與各層覆蓋度／高度' },
  {
    match: (n) => n.includes('/dwca/'),
    desc: 'Darwin Core Archive：event.txt（Event core）+ occurrence.txt + humboldt.txt + meta.xml + eml.xml，可直接上傳 GBIF IPT',
  },
  { match: (n) => n.endsWith('_04_temperature_loggers.csv'), desc: '溫度計（Form 4）：每支溫度計每次巡查一列，讀取與新部署；非 GLORIA Sheet 原有分頁' },
  { match: (n) => n.includes('/loggers/'), desc: '溫度計資料檔（全長碼_序號_原檔名）與 Form 4 掃描檔（01_ 的表單識別碼）' },
  { match: (n) => n.includes('/forms/'), desc: 'GLORIA 紙本表單掃描檔（Form 1、2、3、6-S；檔名為 01_ 的表單識別碼，同一表單第二個檔案起加 -2、-3）' },
  { match: (n) => n.endsWith('.md'), desc: '物種名錄文件（Markdown）' },
  { match: (n) => n.endsWith('.docx'), desc: '物種名錄文件（DOCX 排版文書檔）' },
  { match: (n) => n.endsWith('.odt'), desc: '物種名錄文件（ODT 排版文書檔）' },
  { match: (n) => n.includes('/photos/'), desc: '記錄的照片（檔名對應 yml 的 photo_files）' },
  { match: (n) => n.includes('/audio/'), desc: '記錄的錄音（檔名對應 yml 的 audio_files）' },
  { match: (n) => /\/(points|track|site)\.(geojson|gpx|kml)$/.test(n), desc: '地理檔（GIS／GNSS 軟體用）' },
  { match: (n) => n.endsWith('manifest.json'), desc: '匯出中繼資料（記錄種類、筆數、產生時間）' },
];

function buildRecordReadme(title: string, entries: BuiltZipEntry[]): string {
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
  lines.push('', '由 Mitalivana 匯出。');
  return lines.join('\n');
}

function buildOccurrenceCsv(rows: Array<Record<string, unknown>>): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
  }
  const lines = [keys.join(',')];
  for (const row of rows) lines.push(keys.map((k) => csvEscape(row[k])).join(','));
  return '﻿' + lines.join('\n');
}

/** Build the species CSV body for a plot. Columns are DwC terms — only
 *  `verbatimVegetationLayer` is non-standard because there's no DwC term for
 *  a within-event vegetation stratum. */
function buildPlotSpeciesCsv(
  species: PlotSpeciesRecordWithTaxon[],
  plotType: PlotType,
  plotid: string,
  subplotLabelById: Map<number, string>,
  datasetName: string,
  recordedBy: string,
): string {
  // verbatimVegetationLayer only carries meaning for fixed plots (E1-E6).
  // Transect ('T') and point_count have no vegetation stratum, so the column
  // is omitted entirely for them.
  const includeLayer = plotType === 'fixed';
  // leafPhenology (落葉/常綠) only applies to vascular plants; drop the column
  // when the plot has no vascular taxa (e.g. an all-animal point count).
  const includeLeaf = species.some((s) => s.phylum === 'Tracheophyta');
  // DwC event hierarchy: subplot record → eventID=plotid-label, parentEventID=plotid.
  const hasSubplots = species.some((s) => s.subplot_id != null);
  const eventIdOf = (r: PlotSpeciesRecordWithTaxon) =>
    r.subplot_id != null ? `${plotid}-${subplotLabelById.get(r.subplot_id) ?? r.subplot_id}` : plotid;
  const cols: Array<{ h: string; v: (r: PlotSpeciesRecordWithTaxon) => unknown }> = [
    { h: 'occurrenceID', v: (r) => r.occurrence_id },
    // 這張表被拆出 zip 單獨開啟時也要能被當成 DwC occurrence 讀：basisOfRecord
    // 是 GBIF 的必填欄，datasetName / recordedBy 則是事件層的資訊，不補進來就
    // 只剩 env.csv 知道。
    { h: 'basisOfRecord', v: () => 'HumanObservation' },
    { h: 'datasetName', v: () => datasetName },
    { h: 'recordedBy', v: () => recordedBy },
    { h: 'eventID', v: eventIdOf },
    ...(hasSubplots
      ? [{ h: 'parentEventID', v: (r: PlotSpeciesRecordWithTaxon) => (r.subplot_id != null ? plotid : '') }]
      : []),
    { h: 'taxonID', v: (r) => r.taxon_id },
    { h: 'scientificName', v: (r) => r.simple_name },
    { h: 'scientificNameAuthorship', v: (r) => r.name_author },
    { h: 'vernacularName', v: (r) => r.common_name_c },
    { h: 'family', v: (r) => r.family },
    ...(includeLayer
      ? [{ h: 'verbatimVegetationLayer', v: (r: PlotSpeciesRecordWithTaxon) => r.layer }]
      : []),
    { h: 'organismQuantity', v: (r) => r.organism_quantity ?? '' },
    { h: 'organismQuantityType', v: (r) => r.organism_quantity_type ?? '' },
    { h: 'sex', v: (r) => r.sex ?? '' },
    { h: 'lifeStage', v: (r) => r.life_stage ?? '' },
    { h: 'reproductiveCondition', v: (r) => multiToPipe(r.reproductive_condition) },
    ...(includeLeaf
      ? [{ h: 'leafPhenology', v: (r: PlotSpeciesRecordWithTaxon) => multiToPipe(r.leaf_phenology) }]
      : []),
    // 'wild' has no term in the DwC vocabulary, so it exports blank here —
    // see the Establishment docblock in dwcAttributes.ts.
    { h: 'degreeOfEstablishment', v: (r) => establishmentDwcValue(r.degree_of_establishment) },
    { h: 'detectionType', v: (r) => r.detection_type ?? '' },
    // Name usage — blank for every record filed under the accepted name, so
    // existing exports keep their shape.
    { h: 'scientificNameID', v: (r) => (r.used_name_id != null ? String(r.used_name_id) : '') },
    { h: 'taxonomicStatus', v: (r) => r.used_status ?? '' },
    { h: 'acceptedNameUsage', v: (r) => r.used_accepted_name ?? '' },
    { h: 'acceptedNameUsageID', v: (r) => (r.used_status ? r.taxon_id : '') },
    { h: 'decimalLatitude', v: (r) => r.lat ?? '' },
    { h: 'decimalLongitude', v: (r) => r.lng ?? '' },
    { h: 'coordinateUncertaintyInMeters', v: (r) => r.accuracy ?? '' },
    { h: 'geodeticDatum', v: (r) => locationTerms(r.lat, r.elevation_m, r.elevation_source).geodeticDatum },
    { h: 'minimumElevationInMeters', v: (r) => r.elevation_m ?? '' },
    { h: 'maximumElevationInMeters', v: (r) => r.elevation_m ?? '' },
    { h: 'verticalDatum', v: (r) => locationTerms(r.lat, r.elevation_m, r.elevation_source).verticalDatum },
    { h: 'eventDate', v: (r) => (r.observed_at ? localIso(r.observed_at) : '') },
    // Per-occurrence remarks. Was eventRemarks, which is the EVENT's note —
    // every other occurrence export in the app uses occurrenceRemarks, and the
    // plot's own note already goes out as eventRemarks in env.csv / event.txt.
    { h: 'occurrenceRemarks', v: (r) => r.notes ?? '' },
  ];
  const lines = [cols.map((c) => c.h).join(',')];
  for (const r of species) {
    lines.push(cols.map((c) => csvEscape(c.v(r))).join(','));
  }
  return '﻿' + lines.join('\n');
}

// Build the points/track/site GeoJSON FeatureCollections from a record set.

type PointFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
  properties: Record<string, unknown>;
};

function buildSessionPoints(records: RecordWithTaxon[]): { type: 'FeatureCollection'; features: PointFeature[] } | null {
  const features: PointFeature[] = [];
  for (const r of records) {
    if (r.lat === null || r.lng === null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        name: r.common_name_c || r.simple_name,
        description: r.simple_name + (r.name_author ? ` ${r.name_author}` : ''),
        taxon_id: r.taxon_id,
        observed_at: localIso(r.observed_at),
      },
    });
  }
  if (features.length === 0) return null;
  return { type: 'FeatureCollection', features };
}

function buildCollectionPoints(
  specimens: SpecimenWithTaxon[],
): { type: 'FeatureCollection'; features: PointFeature[] } | null {
  const features: PointFeature[] = [];
  for (const sp of specimens) {
    if (sp.lat === null || sp.lng === null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sp.lng, sp.lat] },
      properties: {
        name: `${sp.record_number} ${sp.common_name_c || sp.simple_name}`.trim(),
        description: sp.simple_name + (sp.name_author ? ` ${sp.name_author}` : ''),
        taxon_id: sp.taxon_id,
        recordNumber: sp.record_number,
        collected_at: localIso(sp.collected_at),
      },
    });
  }
  if (features.length === 0) return null;
  return { type: 'FeatureCollection', features };
}

function buildPlotPoints(records: PlotSpeciesRecordWithTaxon[]): { type: 'FeatureCollection'; features: PointFeature[] } | null {
  // Per-record GNSS (v13): a species observation may carry its own coordinate
  // (most common for transect / point count). Emit a Point per such record.
  const features: PointFeature[] = [];
  for (const r of records) {
    if (r.lat === null || r.lng === null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        name: r.common_name_c || r.simple_name,
        description: r.simple_name + (r.name_author ? ` ${r.name_author}` : ''),
        taxon_id: r.taxon_id,
        organismQuantity: r.organism_quantity ?? '',
        organismQuantityType: r.organism_quantity_type ?? '',
        detectionType: r.detection_type ?? '',
        observed_at: localIso(r.observed_at),
      },
    });
  }
  if (features.length === 0) return null;
  return { type: 'FeatureCollection', features };
}

// ---- Public API -----------------------------------------------------------

export type BuiltZipEntry = { name: string; bytes: Uint8Array; zipOpts?: ZipOptions };

/**
 * 單筆記錄的 Darwin Core Archive。
 *
 * 與專案匯出走同一組 row builder（`buildRecordsDwca`），差別只在餵進去的是一筆
 * 記錄而不是整個專案 —— 這樣「快速名錄自己的 DwC-A」與「專案裡同一筆記錄的
 * DwC-A」不會變成兩份各自漂移的實作。DwC-A 本身已是 deflate 流，放進外層 zip
 * 時用 level 0 存放，不再壓一次。
 */
function addDwcaEntry(
  entries: BuiltZipEntry[],
  base: string,
  title: string,
  abstract: string,
  records: Pick<DwcaInput, 'plots' | 'sessions' | 'trips'>,
): void {
  const dwca = buildRecordsDwca({
    ...records,
    title,
    abstract,
    packageId: `mitalivana-${base}-${new Date().toISOString().slice(0, 10)}`,
  });
  entries.push({
    name: `${base}/dwca/${base}_dwca.zip`,
    bytes: dwca.records,
    zipOpts: { level: 0 },
  });
  // Conservation status belongs to the taxon, not the observation, and a DwC
  // archive has one core — so it ships as its own Taxon-core archive beside
  // the records one. Absent when nothing has a status to state.
  if (dwca.taxa) {
    entries.push({
      name: `${base}/dwca/${base}_taxon_dwca.zip`,
      bytes: dwca.taxa,
      zipOpts: { level: 0 },
    });
  }
}

export async function buildSessionEntries(
  sessionId: number,
  opts: BundleOptions,
  progressCtx: ProgressCtx,
): Promise<{ entries: BuiltZipEntry[]; folderName: string }> {
  const session = getSession(sessionId);
  if (!session) throw new Error(i18n.t('export.err.sessionNotFound', { id: sessionId }));
  const project = getProject(session.project_id);
  const records = listSessionRecords(sessionId);
  if (records.length === 0) throw new Error(i18n.t('export.err.sessionEmpty', { name: session.name }));

  const base = sanitizeFilename(`${session.name}_${project?.name ?? ''}`);
  const entries: BuiltZipEntry[] = [];

  // Session-level event metadata, used by both the yml header and the
  // tall-format env CSV. Shared between formats so they don't drift.
  const startIso = localIso(session.started_at);
  const endIso = session.ended_at !== null ? localIso(session.ended_at) : null;
  const eventDate = endIso ? `${startIso}/${endIso}` : startIso;
  const eventMeta = {
    eventID: session.name,
    eventDate,
    eventStartedAt: startIso,
    eventEndedAt: endIso,
    datasetName: project?.name ?? '',
  };

  // Photos first: the yml lists the filenames each record's photos landed
  // under, so the names have to exist before the document is built.
  const namer = createPhotoNamer(base);
  let photoNames: PhotoNames = new Map();
  if (opts.includePhotos) {
    const collected = await collectPhotos(records, namer, progressCtx, buildContext);
    entries.push(...collected.entries);
    photoNames = collected.names;
  }
  // Clips ride the same 「包含照片」 toggle: that is the media switch the
  // size warning tells users to turn off, so audio must not slip past it.
  let audioNames: PhotoNames = new Map();
  if (opts.includePhotos) {
    const collectedAudio = await collectAudio(records, createPhotoNamer(base, 'audio'));
    entries.push(...collectedAudio.entries);
    audioNames = collectedAudio.names;
  }

  // Bound site — carried in the yml (authoritative on import) as well as in
  // the site.* sidecars (for GIS tools).
  const site = session.site_id !== null ? getSite(session.site_id) : null;
  const siteForYaml = site ? siteToImported(site) : null;

  // YAML — event block + checklist array
  const yamlData = buildSessionYamlDoc({
    session,
    projectName: project?.name ?? '',
    records,
    site: siteForYaml,
    photoNames,
    audioNames,
  });
  // Team merge: this device's common ancestor for the record (mergeEngine.ts).
  yamlData.sync = syncBlockFor('session', session.uuid);
  entries.push({ name: `${base}/${base}.yml`, bytes: strToU8(yaml.dump(yamlData, { lineWidth: -1, noRefs: true })) });

  // ${session.name}_env.csv — tall (term,value) format, mirrors plot env.
  const envRows: Array<{ term: string; value: string }> = [];
  const pushEnv = (term: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v);
    if (!s) return;
    envRows.push({ term, value: s });
  };
  pushEnv('eventID', eventMeta.eventID);
  pushEnv('eventDate', eventMeta.eventDate);
  pushEnv('startedAt', eventMeta.eventStartedAt);
  pushEnv('endedAt', eventMeta.eventEndedAt);
  pushEnv('datasetName', eventMeta.datasetName);
  pushEnv('recordedBy', session.recorded_by);
  pushEnv('eventRemarks', session.notes);
  if (session.start_lat !== null) pushEnv('decimalLatitude', session.start_lat);
  if (session.start_lng !== null) pushEnv('decimalLongitude', session.start_lng);
  if (session.start_lat !== null) pushEnv('geodeticDatum', GEODETIC_DATUM);
  const envCsv = '﻿' + ['term,value', ...envRows.map((r) => `${csvEscape(r.term)},${csvEscape(r.value)}`)].join('\n');
  entries.push({
    name: `${base}/${sanitizeFilename(session.name)}_env.csv`,
    bytes: strToU8(envCsv),
  });

  // ${session.name}_occurrence_dwc.csv — DwC occurrence table (was `_sp.csv`).
  // Rows ordered taxonomically (kingdom→…→genus→species); the yml checklist
  // above stays in observation order.
  //
  // basisOfRecord / eventID / datasetName / recordedBy are added HERE and not
  // in the yml: the yml is the round-trip format and already carries them in
  // its `event:` block, while this CSV is a deliverable that has to stand on
  // its own once it is opened away from the bundle.
  const csvItems = [...records]
    .sort(taxonSortCompare)
    .map((r) => ({
      basisOfRecord: 'HumanObservation',
      eventID: eventMeta.eventID,
      datasetName: eventMeta.datasetName,
      recordedBy: session.recorded_by ?? '',
      ...toDwcCsvRow(recordToYamlItem(r, photoNames)),
    }));
  entries.push({
    name: `${base}/${sanitizeFilename(session.name)}_occurrence_dwc.csv`,
    bytes: strToU8(buildOccurrenceCsv(csvItems)),
  });

  // Markdown — deduped, like the plot and collection checklists. The species
  // list is a list of species; the occurrence CSV above keeps every record.
  const md = generateMarkdown(
    (opts.mergeDuplicateTaxa ? uniqueByIdentity(records) : records).map(recordToMarkdownItem),
    checklistT(opts.lang),
    { project: project?.id !== 0 ? project?.name : '', site: '' },
    {
      levelsOverride: opts.levels.length ? orderLevels(opts.levels) : undefined,
      conservationFields: opts.conservationFields,
      hideLowConcern: opts.conservationHideLowConcern,
    },
  );
  entries.push({ name: `${base}/${base}.md`, bytes: strToU8(md) });
  if (opts.includeDocx) {
    const doc = DOC_FORMATS[opts.docFormat];
    entries.push({ name: `${base}/${base}.${doc.ext}`, bytes: doc.fromMarkdown(md) });
  }

  // Geo: per-record GNSS points
  const points = buildSessionPoints(records);
  if (points) addGeoEntries(entries, base, 'points', points, opts.geoFormats);

  // Geo: session track (full_track mode). Old data is a bare LineString; tracks
  // recorded with the unified recorder are MultiLineString — both parse through
  // parseGeoJsonSafe and serialize via addGeoEntries, same as the plot path.
  if (session.track_geojson) {
    const track = parseGeoJsonSafe(session.track_geojson);
    if (track) addGeoEntries(entries, base, 'track', track as never, opts.geoFormats);
  }

  // Geo: bound site geometry (if any)
  if (site) {
    const geom = parseGeoJsonSafe(site.geometry_geojson);
    if (geom) {
      const feature = {
        type: 'Feature' as const,
        geometry: geom as never,
        properties: { name: site.name, description: site.notes ?? '' },
      };
      const fc = { type: 'FeatureCollection' as const, features: [feature] };
      addGeoEntries(entries, base, 'site', fc, opts.geoFormats);
    }
  }

  // Darwin Core Archive — GBIF-publishable packaging of this one session.
  if (opts.includeDwca) {
    addDwcaEntry(entries, base, session.name, project?.name ?? '', {
      plots: [],
      sessions: [session],
      trips: [],
    });
  }

  // Manifest
  const manifest = buildManifest({
    kind: 'session',
    id: sessionId,
    name: session.name,
    project_name: project?.name ?? '',
    record_count: records.length,
    photo_count: opts.includePhotos
      ? records.reduce((n, r) => n + parsePhotoUris(r.photo_paths).length, 0)
      : 0,
    geoFormats: opts.geoFormats,
  });
  entries.push({ name: `${base}/manifest.json`, bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  // README 排在最後：清單是從實際產出的 entries 反推的，manifest 也要算進去。
  entries.push({
    name: `${base}/README.md`,
    bytes: strToU8(buildRecordReadme(session.name, entries)),
  });

  return { entries, folderName: base };
}

export async function buildPlotEntries(
  plotId: number,
  opts: BundleOptions,
  progressCtx: ProgressCtx,
): Promise<{ entries: BuiltZipEntry[]; folderName: string }> {
  const plot = getPlotSurvey(plotId);
  if (!plot) throw new Error(i18n.t('export.err.plotNotFound', { id: plotId }));
  const project = plot.project_id !== null ? getProject(plot.project_id) : null;
  const species = listPlotSpecies(plotId);
  // Loaded once and reused by the yml round-trip block + sp.csv + subplots.csv.
  const subplots = listSubplots(plot.id);
  const subplotLabelById = new Map(subplots.map((s) => [s.id, s.label]));
  const plotLayers = plot.plot_type === 'fixed' ? getPlotLayers(plotId) : [];

  const base = sanitizeFilename(`${plot.plotid}_${project?.name ?? 'plot'}`);
  const entries: BuiltZipEntry[] = [];

  // Photos first — the yml lists the filenames they land under.
  const namer = createPhotoNamer(base);
  let photoNames: PhotoNames = new Map();
  let envPhotoNames: string[] = [];
  if (opts.includePhotos) {
    const collected = await collectPhotosPlot(species, namer, progressCtx, {
      lat: plot.decimal_latitude,
      lng: plot.decimal_longitude,
      accuracyM: plot.coord_uncertainty_m,
    });
    entries.push(...collected.entries);
    photoNames = collected.names;
    // Plot environment context photos. Filename: plotid_YYYYMMDD_env-N.jpg
    // where YYYYMMDD is the plot start date (fallback today). Sequence is the
    // order user added the photos (already stable in env_photos_json).
    const envUris = parseEnvPhotos(plot.env_photos_json);
    if (envUris.length > 0) {
      const envCollected = await collectEnvPhotos(
        envUris,
        base,
        plot.plotid,
        // `created_at`, not `start_ts ?? now`: a plot whose survey has not
        // started has no start_ts, so the old fallback stamped TODAY and the
        // same plot exported on two days produced two different filenames for
        // the same photos. created_at exists from the moment the row does.
        ymdString(plot.start_ts ?? plot.created_at),
        namer,
        progressCtx,
      );
      entries.push(...envCollected.entries);
      envPhotoNames = envCollected.names;
    }
  }
  // Clips ride the same 「包含照片」 toggle: that is the media switch the
  // size warning tells users to turn off, so audio must not slip past it.
  let audioNames: PhotoNames = new Map();
  if (opts.includePhotos) {
    const collectedAudio = await collectAudio(species, createPhotoNamer(base, 'audio'));
    entries.push(...collectedAudio.entries);
    audioNames = collectedAudio.names;
  }

  const site = plot.site_id !== null ? getSite(plot.site_id) : null;

  // YAML — per-plot shape. Carries the full set of user-entered fields (notes,
  // DwC attributes, detection method, per-record GNSS) so the YAML is symmetric
  // with the sp.csv.
  const yamlData = buildPlotYamlDoc({
    plot,
    projectName: project?.name ?? '',
    species,
    layers: plotLayers,
    subplots: subplots.map((sp) => ({ ...sp, layers: getSubplotLayers(sp.id) })),
    subplotLabelById,
    site: site ? siteToImported(site) : null,
    photoNames,
    envPhotoNames,
    audioNames,
  });
  // Team merge: this device's common ancestor for the record (mergeEngine.ts).
  yamlData.sync = syncBlockFor('plot', plot.uuid);
  entries.push({ name: `${base}/${base}.yml`, bytes: strToU8(yaml.dump(yamlData, { lineWidth: -1, noRefs: true })) });

  // ${plotid}_checklist.md — deduped (one row per taxon) human-readable 名錄,
  // mirrors the session .md. Same dedup feeds the optional document below.
  // Keyed by taxon AND the name it was filed under: a taxon deliberately
  // recorded under two different names is two checklist entries, and collapsing
  // them would silently drop one of the recorder's determinations.
  const uniqueSpecies = opts.mergeDuplicateTaxa ? uniqueByIdentity(species) : species;
  const checklistMd = generateMarkdown(
    uniqueSpecies.map(plotSpeciesToMarkdownItem),
    checklistT(opts.lang),
    { project: project && project.id !== 0 ? project.name : '', site: plot.plotid },
    {
      levelsOverride: opts.levels.length ? orderLevels(opts.levels) : undefined,
      conservationFields: opts.conservationFields,
      hideLowConcern: opts.conservationHideLowConcern,
    },
  );
  entries.push({ name: `${base}/${plot.plotid}_checklist.md`, bytes: strToU8(checklistMd) });
  if (opts.includeDocx) {
    const doc = DOC_FORMATS[opts.docFormat];
    entries.push({
      name: `${base}/${plot.plotid}_checklist.${doc.ext}`,
      bytes: doc.fromMarkdown(checklistMd),
    });
  }

  // ${plotid}_env.csv — environmental metadata. Tall format (term,value) so
  // we can emit only the fields that were actually filled in, without leaving
  // empty columns. Standard DwC location / event terms where they exist;
  // vegetation-survey columns (cover/height/method per layer) kept under
  // descriptive camelCase keys (no DwC equivalent exists).
  const envRows = buildPlotEnvRows(plot, project?.name ?? '', plotLayers);
  if (envRows.length > 0) {
    const envCsv = '﻿' + ['term,value', ...envRows.map((r) => `${csvEscape(r.term)},${csvEscape(r.value)}`)].join('\n');
    entries.push({ name: `${base}/${plot.plotid}_env.csv`, bytes: strToU8(envCsv) });
  }

  // ${plotid}_occurrence_dwc.csv — species records under DwC terms (scientificName,
  // vernacularName, organismQuantity, organismQuantityType, family, taxonID).
  // Layer kept as a non-standard column since there is no DwC term for a
  // vegetation stratum within an event.
  // CSV rows ordered taxonomically (kingdom→…→genus→species); the yml above
  // keeps observation/subplot order for round-trip fidelity.
  const spCsv = buildPlotSpeciesCsv(
    [...species].sort(taxonSortCompare),
    plot.plot_type,
    plot.plotid,
    subplotLabelById,
    project?.name ?? '',
    plot.recorded_by ?? '',
  );
  entries.push({ name: `${base}/${plot.plotid}_occurrence_dwc.csv`, bytes: strToU8(spCsv) });

  // ${plotid}_subplots.csv — per-subplot dimensions + per-layer cover/height
  // (only when the plot is split into subplots). Layer method/unit are shared.
  if (subplots.length > 0) {
    const aLayers = getActiveLayers(plot.layer_count);
    const pLayers = getPlotLayers(plot.id);
    const unitFor = (idx: number) =>
      pLayers.find((l) => l.layer_index === idx)?.height_unit === 'm' ? 'm' : 'cm';
    const header = [
      'subplotLabel',
      'eventID',
      'parentEventID',
      'widthM',
      'lengthM',
      ...aLayers.flatMap((l) => {
        const u = unitFor(layerIndexOf(l));
        return [`${l.toLowerCase()}CoverPct`, `${l.toLowerCase()}Height${u === 'm' ? 'M' : 'Cm'}`];
      }),
    ];
    const lines = [header.join(',')];
    for (const s of subplots) {
      const sl = getSubplotLayers(s.id);
      const cells: unknown[] = [
        s.label,
        `${plot.plotid}-${s.label}`,
        plot.plotid,
        s.width_m ?? '',
        s.length_m ?? '',
        ...aLayers.flatMap((l) => {
          const idx = layerIndexOf(l);
          const row = sl.find((r) => r.layer_index === idx);
          const inM = unitFor(idx) === 'm';
          const h = row?.height_cm == null ? '' : inM ? row.height_cm / 100 : row.height_cm;
          return [row?.cover_pct ?? '', h];
        }),
      ];
      lines.push(cells.map(csvEscape).join(','));
    }
    entries.push({ name: `${base}/${plot.plotid}_subplots.csv`, bytes: strToU8('﻿' + lines.join('\n')) });
  }

  // Geo: per-record species points (v13 — present when observations carry
  // their own GNSS; most common for transect / point count).
  const points = buildPlotPoints(species);
  if (points) addGeoEntries(entries, base, 'points', points, opts.geoFormats);

  // Geo: track (transect)
  if (plot.track_geojson) {
    const track = parseGeoJsonSafe(plot.track_geojson);
    if (track) addGeoEntries(entries, base, 'track', track as never, opts.geoFormats);
  }

  // Geo: bound site
  if (site) {
    const geom = parseGeoJsonSafe(site.geometry_geojson);
    if (geom) {
      const fc = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: geom as never,
            properties: { name: site.name, description: site.notes ?? '' },
          },
        ],
      };
      addGeoEntries(entries, base, 'site', fc, opts.geoFormats);
    }
  }

  // Darwin Core Archive — same builder as the project export, one plot in.
  if (opts.includeDwca) {
    addDwcaEntry(entries, base, plot.plotid, project?.name ?? '', {
      plots: [plot],
      sessions: [],
      trips: [],
    });
  }

  // Manifest
  const manifest = buildManifest({
    kind: 'plot',
    id: plotId,
    uuid: plot.uuid,
    name: plot.plotid,
    project_name: project?.name ?? '',
    record_count: species.length,
    photo_count: opts.includePhotos
      ? species.reduce((n, r) => n + parsePhotoUris(r.photo_paths).length, 0) +
        parseEnvPhotos(plot.env_photos_json).length
      : 0,
    geoFormats: opts.geoFormats,
  });
  entries.push({ name: `${base}/manifest.json`, bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  // README 排在最後：清單是從實際產出的 entries 反推的，manifest 也要算進去。
  entries.push({
    name: `${base}/README.md`,
    bytes: strToU8(buildRecordReadme(plot.plotid, entries)),
  });

  return { entries, folderName: base };
}

/**
 * A GLORIA survey: the round-trip yml, one CSV per tab of the Taiwan sheet
 * (12_ and 13_ merged), the per-point long table, and the survey's species
 * checklist (md, plus docx / odt per the export settings) like the other
 * records. Sheet CSVs are the deliverable; the yml restores the survey.
 */
export async function buildGloriaEntries(
  surveyId: number,
  opts?: Pick<BundleOptions, 'includePhotos' | 'onProgress'> &
    Partial<Pick<BundleOptions, 'includeDocx' | 'docFormat' | 'levels' | 'conservationFields' | 'conservationHideLowConcern' | 'lang'>>,
): Promise<{ entries: BuiltZipEntry[]; folderName: string }> {
  const data = loadExportData(surveyId);
  const doc = loadGloriaDoc(surveyId);
  if (!data || !doc) throw new Error(`GLORIA survey ${surveyId} not found`);
  const base = sanitizeFilename(`GLORIA_${data.summit.full_code}_mocy${data.survey.mocy}`);
  const entries: BuiltZipEntry[] = [];
  // Team merge: this device's common ancestor for the record (mergeEngine.ts).
  const withSync = { ...doc, sync: syncBlockFor('gloria', data.survey.uuid) };
  entries.push({
    name: `${base}/${base}.yml`,
    bytes: strToU8(yaml.dump(withSync, { lineWidth: -1, noRefs: true })),
  });
  for (const t of buildSheetTables(data)) {
    if (t.rows.length === 0) continue;
    entries.push({ name: `${base}/${base}_${t.name}.csv`, bytes: strToU8(toCsv(t.header, t.rows)) });
  }
  const pointRows = buildPointHitRows(data);
  if (pointRows.length) {
    entries.push({ name: `${base}/${base}_point_hits.csv`, bytes: strToU8(toCsv(POINT_HITS_HEADER, pointRows)) });
  }
  // Species checklist: one entry per roster entry (taxon + morphospecies
  // label) found in any unit — 1×1 m, SAS or 10×10 m. A label (sp1, sp2)
  // goes in the brackets after the name, as it goes in the sheet's comments;
  // per-unit notes stay in the sheet, they belong to one unit.
  const roster = new Map<number, ReturnType<typeof listGloriaSpecies>[number]>();
  for (const s of listGloriaSpecies(surveyId)) if (!roster.has(s.gloria_taxon_id)) roster.set(s.gloria_taxon_id, s);
  if (roster.size) {
    const checklistMd = generateMarkdown(
      [...roster.values()].map((s) => ({ ...taxonToMarkdownItem(s.taxon_id, s), notes: s.verbatim_identification })),
      checklistT(opts?.lang),
      { project: getGloriaSurvey(surveyId)?.project_id !== 0 ? (doc.survey.project_name ?? '') : '', site: `${data.summit.full_code} mocy ${data.survey.mocy}` },
      {
        levelsOverride: opts?.levels?.length ? orderLevels(opts.levels) : undefined,
        conservationFields: opts?.conservationFields,
        hideLowConcern: opts?.conservationHideLowConcern,
      },
    );
    entries.push({ name: `${base}/${base}_checklist.md`, bytes: strToU8(checklistMd) });
    if (opts?.includeDocx && opts.docFormat) {
      const fmt = DOC_FORMATS[opts.docFormat];
      entries.push({ name: `${base}/${base}_checklist.${fmt.ext}`, bytes: fmt.fromMarkdown(checklistMd) });
    }
  }
  // Form 1 photo checklist: what was ticked, what has a photo in the app.
  const checklist = checklistState({
    checks: listPhotoChecks(surveyId),
    points: listGloriaPoints(surveyId),
    overviewCount: parseOverviewPhotos(getGloriaSurvey(surveyId)?.overview_photos).length,
  });
  entries.push({
    name: `${base}/${base}_photo_checklist.csv`,
    bytes: strToU8(toCsv(CHECKLIST_HEADER, checklistRows(checklist.items))),
  });
  // Photos named per manual Annex III, in photos/ like the other exports.
  let photoCount = 0;
  if (opts?.includePhotos) {
    const points = listGloriaPoints(surveyId);
    const plan = planPhotoNames({
      mocy: data.survey.mocy,
      country: data.summit.country,
      region: data.summit.target_region,
      summit: data.summit.summit,
      date: yyyymmdd(data.survey.start_ts),
      p5m: p5mOf(points),
      points,
      units: listGloriaUnits(surveyId).map((u) => ({ code: u.code, photo_uris: parsePhotoUris(u.photo_paths) })),
      overview: parseOverviewPhotos(getGloriaSurvey(surveyId)?.overview_photos),
      checks: listPhotoChecks(surveyId).flatMap((c) => (c.photo_uri ? [{ item: c.item, uri: c.photo_uri }] : [])),
      loggers: (data.visits ?? []).flatMap((v) =>
        v.loggers.flatMap((l) =>
          (['open', 'closed'] as const).flatMap((w) => {
            const uri = w === 'open' ? l.photo_open_uri : l.photo_closed_uri;
            return uri ? [{ uri, item: loggerPhotoItem(l.quadrat, l.label), note: w, date: yyyymmdd(v.visit_ts) }] : [];
          }),
        ),
      ),
      extOf: (uri) => guessExt(uri),
    });
    if (plan.length) await ensurePhotosReadAccess();
    for (let i = 0; i < plan.length; i++) {
      opts.onProgress?.({ label: i18n.t('export.stage.photos'), done: i, total: plan.length });
      const fileUri = await resolveAssetUri(plan[i].uri);
      if (!fileUri) continue;
      try {
        const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
        entries.push({ name: `${base}/photos/${plan[i].name}`, bytes: base64ToBytes(b64) });
        photoCount += 1;
      } catch {
        // unreadable (deleted from the library): skip, the manifest count says how many made it
      }
    }
  }
  // Temperature loggers: the loggers' data exports and the Form 4 scans,
  // always (like the other form scans), under loggers/.
  const loggerFiles = planLoggerFiles(data.survey.mocy, data.summit, data.visits ?? []);
  // Form 4 camera shots are photo-library references.
  if (loggerFiles.some((f) => !f.uri.startsWith('file:'))) await ensurePhotosReadAccess();
  for (const f of loggerFiles) {
    const fileUri = await resolveAssetUri(f.uri);
    if (!fileUri) continue;
    try {
      const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
      entries.push({ name: `${base}/loggers/${f.name}`, bytes: base64ToBytes(b64) });
    } catch {
      // gone from the device: the 04_ table still names it
    }
  }
  // Scans of the paper forms 1, 2, 3, 6-S, named by their 01_ identifiers.
  // Always, whatever the photos switch: they are the survey's paper record,
  // and 01_ names them.
  const scans = planFormScans(data.summit.full_code, data.survey, data.units);
  // Camera shots are photo-library references; picked files are app files.
  if (scans.some((f) => !f.uri.startsWith('file:'))) await ensurePhotosReadAccess();
  for (const f of scans) {
    const fileUri = await resolveAssetUri(f.uri);
    if (!fileUri) continue;
    try {
      const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
      entries.push({ name: `${base}/forms/${f.name}`, bytes: base64ToBytes(b64) });
    } catch {
      // gone from the device: 01_ still names it
    }
  }
  const manifest = buildManifest({
    kind: 'gloria',
    id: surveyId,
    uuid: data.survey.uuid,
    name: `${data.summit.full_code} mocy ${data.survey.mocy}`,
    record_count: data.species.length,
    photo_count: photoCount,
  });
  entries.push({ name: `${base}/manifest.json`, bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  const photoNote = photoCount
    ? '\n\n## GLORIA 照片檔名\n\n' +
      '- 依 GLORIA Field Manual 5th ed. Annex III：監測週期_國碼_目標區_山峰_項目代碼(8 碼，補 _)_日期_流水號(5 碼)。\n' +
      '- 流水號只在這次調查內唯一。手冊要求在整個目標區內唯一，送交 GLORIA 中央資料庫前請在室內重新編號（例如用 GPDM）。\n' +
      '- 日期取調查開始日，不是各張照片的拍攝時間；照片本身的 EXIF 保留原拍攝時間。\n'
    : '';
  entries.push({ name: `${base}/README.md`, bytes: strToU8(buildRecordReadme(base, entries) + photoNote) });
  return { entries, folderName: base };
}

/**
 * The temperature loggers of one summit alone (the summit page): every visit,
 * each under the cycle its date falls in — for visits between two surveys,
 * without exporting a survey. 04_ table, loggers/ (data files and Form 4
 * scans, always) and photos/ (position photos, with the photos switch).
 */
export async function bundleLoggers(summitId: number, opts: Pick<BundleOptions, 'includePhotos' | 'onProgress'>): Promise<ExportFile> {
  const summit = getSummit(summitId);
  if (!summit) throw new Error(`GLORIA summit ${summitId} not found`);
  const cycles = summitCycles(summitId);
  const byCycle = new Map<number, ExportVisit[]>();
  for (const v of listVisits(summitId)) {
    const m = cycleOf(v.visit_ts, cycles) ?? 0;
    byCycle.set(m, [...(byCycle.get(m) ?? []), { ...v, loggers: listLoggers(v.id) }]);
  }
  const base = sanitizeFilename(`GLORIA_${summit.full_code}_temperature-loggers`);
  const entries: BuiltZipEntry[] = [];
  const rows = [...byCycle.entries()].sort((a, b) => a[0] - b[0]).flatMap(([m, vs]) => loggerRows(m, summit, vs));
  entries.push({ name: `${base}/${base}_04_temperature_loggers.csv`, bytes: strToU8(toCsv(H04_TEMPERATURE_LOGGERS, rows)) });
  const files = [...byCycle.entries()].flatMap(([m, vs]) => planLoggerFiles(m, summit, vs));
  const photos = opts.includePhotos
    ? [...byCycle.entries()].flatMap(([m, vs]) =>
        planPhotoNames({
          mocy: m,
          country: summit.country,
          region: summit.target_region,
          summit: summit.summit,
          date: '',
          p5m: {},
          points: [],
          units: [],
          loggers: vs.flatMap((v) =>
            v.loggers.flatMap((l) =>
              (['open', 'closed'] as const).flatMap((w) => {
                const uri = w === 'open' ? l.photo_open_uri : l.photo_closed_uri;
                return uri ? [{ uri, item: loggerPhotoItem(l.quadrat, l.label), note: w, date: yyyymmdd(v.visit_ts) }] : [];
              }),
            ),
          ),
          extOf: (uri) => guessExt(uri),
        }),
      )
    : [];
  if (photos.length || files.some((f) => !f.uri.startsWith('file:'))) await ensurePhotosReadAccess();
  const todo = [
    ...files.map((f) => ({ uri: f.uri, name: `${base}/loggers/${f.name}` })),
    ...photos.map((p) => ({ uri: p.uri, name: `${base}/photos/${p.name}` })),
  ];
  for (let i = 0; i < todo.length; i++) {
    opts.onProgress?.({ label: i18n.t('export.stage.files'), done: i, total: todo.length });
    const fileUri = await resolveAssetUri(todo[i].uri);
    if (!fileUri) continue;
    try {
      entries.push({ name: todo[i].name, bytes: base64ToBytes(await readAsStringAsync(fileUri, { encoding: 'base64' })) });
    } catch {
      // gone from the device: the 04_ table still names it
    }
  }
  entries.push({ name: `${base}/README.md`, bytes: strToU8(buildRecordReadme(base, entries)) });
  await reportZipStage(opts.onProgress);
  return await finalizeZip(entries, base);
}

export async function bundleGloria(surveyId: number, opts: BundleOptions): Promise<ExportFile> {
  opts.onProgress?.({ label: i18n.t('export.preparing') });
  const { entries, folderName } = await buildGloriaEntries(surveyId, opts);
  await reportZipStage(opts.onProgress);
  return await finalizeZip(entries, folderName);
}

export async function buildCollectionEntries(
  tripId: number,
  opts: BundleOptions,
  progressCtx: ProgressCtx,
): Promise<{ entries: BuiltZipEntry[]; folderName: string }> {
  const trip = getCollectionTrip(tripId);
  if (!trip) throw new Error(i18n.t('export.err.tripNotFound', { id: tripId }));
  const project = getProject(trip.project_id);
  const specimens = listSpecimens(tripId);
  if (specimens.length === 0) throw new Error(i18n.t('export.err.tripEmpty', { name: trip.name }));

  const base = sanitizeFilename(`${trip.name}_${project?.name ?? ''}`);
  const entries: BuiltZipEntry[] = [];

  const startIso = localIso(trip.started_at);
  const endIso = trip.ended_at !== null ? localIso(trip.ended_at) : null;
  const eventDate = endIso ? `${startIso}/${endIso}` : startIso;

  // Photos first: the yml lists the filenames each specimen's photos landed
  // under, so the names have to exist before the document is built.
  const namer = createPhotoNamer(base);
  let photoNames: PhotoNames = new Map();
  if (opts.includePhotos) {
    const collected = await collectPhotos(specimens, namer, progressCtx, buildContextFromSpecimen);
    entries.push(...collected.entries);
    photoNames = collected.names;
  }
  // Clips ride the same 「包含照片」 toggle: that is the media switch the
  // size warning tells users to turn off, so audio must not slip past it.
  let audioNames: PhotoNames = new Map();
  if (opts.includePhotos) {
    const collectedAudio = await collectAudio(specimens, createPhotoNamer(base, 'audio'));
    entries.push(...collectedAudio.entries);
    audioNames = collectedAudio.names;
  }

  // YAML — event block + specimens array (collection order). Raw
  // `convertToDwc`, not `toDwcCsvRow`: the yml is the round-trip format and
  // must keep every value the user entered (see toDwcCsvRow's docblock).
  const tripSite = trip.site_id != null ? getSite(trip.site_id) : null;
  const yamlData = buildCollectionYamlDoc({
    trip,
    projectName: project?.name ?? '',
    specimens,
    site: tripSite ? siteToImported(tripSite) : null,
    photoNames,
    audioNames,
  });
  entries.push({
    name: `${base}/${base}.yml`,
    bytes: strToU8(yaml.dump(yamlData, { lineWidth: -1, noRefs: true })),
  });

  // _env.csv — tall (term,value), mirrors the session/plot shape.
  const envRows: Array<{ term: string; value: string }> = [];
  const pushEnv = (term: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const str = String(v);
    if (!str) return;
    envRows.push({ term, value: str });
  };
  pushEnv('eventID', trip.name);
  pushEnv('eventType', 'Collection');
  pushEnv('eventDate', eventDate);
  pushEnv('startedAt', startIso);
  pushEnv('endedAt', endIso);
  pushEnv('datasetName', project?.name ?? '');
  pushEnv('recordedBy', trip.recorded_by);
  pushEnv('locality', trip.locality);
  pushEnv('eventRemarks', trip.notes);
  const envCsv =
    '﻿' +
    ['term,value', ...envRows.map((r) => `${csvEscape(r.term)},${csvEscape(r.value)}`)].join('\n');
  entries.push({ name: `${base}/${sanitizeFilename(trip.name)}_env.csv`, bytes: strToU8(envCsv) });

  // _occurrence_dwc.csv — DwC occurrence rows, ordered taxonomically (the yml
  // above keeps collection order, same split as sessions). Event-level columns
  // added here for the same reason as the session table.
  const csvItems = [...specimens].sort(taxonSortCompare).map((sp) => ({
    basisOfRecord: 'PreservedSpecimen',
    eventID: trip.name,
    datasetName: project?.name ?? '',
    recordedBy: trip.recorded_by ?? '',
    ...toDwcCsvRow(specimenToYamlItem(sp, photoNames)),
  }));
  entries.push({
    name: `${base}/${sanitizeFilename(trip.name)}_occurrence_dwc.csv`,
    bytes: strToU8(buildOccurrenceCsv(csvItems)),
  });

  // Markdown checklist — dedupe by taxon (a trip may hold several duplicates of
  // the same species, each its own specimen).
  // Was keyed on taxon_id alone, which merged two determinations of one taxon
  // and both morphospecies under a family.
  const mdItems = (opts.mergeDuplicateTaxa ? uniqueByIdentity(specimens) : specimens).map(
    specimenToMarkdownItem,
  );
  const md = generateMarkdown(
    mdItems,
    checklistT(opts.lang),
    { project: project?.id !== 0 ? project?.name : '', site: trip.locality ?? '' },
    {
      levelsOverride: opts.levels.length ? orderLevels(opts.levels) : undefined,
      conservationFields: opts.conservationFields,
      hideLowConcern: opts.conservationHideLowConcern,
    },
  );
  entries.push({ name: `${base}/${base}.md`, bytes: strToU8(md) });
  if (opts.includeDocx) {
    const doc = DOC_FORMATS[opts.docFormat];
    entries.push({ name: `${base}/${base}.${doc.ext}`, bytes: doc.fromMarkdown(md) });
  }

  // Geo: one point per georeferenced specimen.
  const points = buildCollectionPoints(specimens);
  if (points) addGeoEntries(entries, base, 'points', points, opts.geoFormats);

  // Darwin Core Archive — specimens land as basisOfRecord=PreservedSpecimen.
  if (opts.includeDwca) {
    addDwcaEntry(entries, base, trip.name, project?.name ?? '', {
      plots: [],
      sessions: [],
      trips: [trip],
    });
  }

  const manifest = buildManifest({
    kind: 'collection',
    id: tripId,
    uuid: trip.uuid,
    name: trip.name,
    project_name: project?.name ?? '',
    record_count: specimens.length,
    photo_count: opts.includePhotos ? countPhotosSession(specimens) : 0,
    geoFormats: opts.geoFormats,
  });
  entries.push({ name: `${base}/manifest.json`, bytes: strToU8(JSON.stringify(manifest, null, 2)) });
  // README 排在最後：清單是從實際產出的 entries 反推的，manifest 也要算進去。
  entries.push({
    name: `${base}/README.md`,
    bytes: strToU8(buildRecordReadme(trip.name, entries)),
  });

  return { entries, folderName: base };
}

function addGeoEntries(
  out: BuiltZipEntry[],
  folder: string,
  stem: 'points' | 'track' | 'site',
  geo: object,
  formats: GeoFormat[],
): void {
  if (formats.includes('geojson')) {
    out.push({ name: `${folder}/${stem}.geojson`, bytes: strToU8(JSON.stringify(geo)) });
  }
  if (formats.includes('gpx')) {
    try {
      out.push({ name: `${folder}/${stem}.gpx`, bytes: strToU8(geoJsonToGpx(geo as never)) });
    } catch {
      // skip silently if geometry is unsupported by GPX
    }
  }
  if (formats.includes('kml')) {
    try {
      out.push({ name: `${folder}/${stem}.kml`, bytes: strToU8(geoJsonToKml(geo as never)) });
    } catch {
      // skip silently
    }
  }
}

/**
 * Maps a stored photo/audio URI to the argument `MediaLibrary.getAssetInfoAsync`
 * actually accepts, plus a fallback URI for when no asset id can be derived.
 *
 * iOS `ph://<localIdentifier>`: the bare localIdentifier, NOT the prefixed URI
 *   — passing the full URI silently throws, which reads as "photo missing".
 *
 * Android `content://media/external/images/media/<id>`: the trailing numeric
 *   MediaStore _id. If it can't be extracted (custom provider URI), callers
 *   fall back to the URI itself, which the platform ContentResolver can
 *   usually open.
 *
 * Exported because both the exporter and the size estimator need it, and they
 * drifted once already (`exportSize.ts` passed the full URI, so every iOS photo
 * silently fell back to a 3 MB guess). See memory `feedback-media-library-ph-uri`.
 */
export function mediaAssetTarget(uri: string): { assetId: string | null; fallback: string | null } {
  if (uri.startsWith('ph://')) return { assetId: uri.slice(5), fallback: null };
  if (uri.startsWith('content://')) {
    const m = uri.match(/\/(\d+)(?:\?|$)/);
    return { assetId: m ? m[1] : null, fallback: uri };
  }
  return { assetId: uri, fallback: null };
}

export async function resolveAssetUri(uri: string): Promise<string | null> {
  // App-owned files: the stored absolute path may point at a previous iOS
  // container (see appFiles.ts) — re-anchor before anyone tries to read it.
  // Only the app's media folders (or shared storage): a record's text can
  // point anywhere, including user.db (security audit S1).
  if (uri.startsWith('file:')) return safeAppFileUri(uri);

  // PHAsset (iOS) and Android MediaStore URIs both need an extra hop to get
  // the underlying file path.
  const { assetId, fallback } = mediaAssetTarget(uri);

  if (assetId) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(assetId);
      const localUri = info?.localUri ?? info?.uri ?? null;
      if (localUri) return localUri;
      if (__DEV__) console.warn('[bundleExport] no localUri for asset', assetId);
    } catch (e) {
      if (__DEV__) console.warn('[bundleExport] getAssetInfoAsync failed', uri, e);
    }
  }
  return fallback;
}

/**
 * Names photo entries `{taxonID}_{cname or scientific}_{n}.{ext}`
 * e.g. `t0040215_蔓花生_2.heic`. cname is sanitised so it's filesystem-safe;
 * if absent, falls back to the binomial scientific name with spaces → '_'.
 *
 * `n` counts per taxon across the WHOLE export, not within one record: two
 * records of the same taxon used to produce the same name, and `finalizeZip`
 * builds a plain object keyed by name, so one of the two photos was silently
 * dropped. The used-name set is the belt-and-braces guard for anything the
 * counter can't foresee (a hand-set label collision).
 */
function createPhotoNamer(folder: string, dir: 'photos' | 'audio' = 'photos') {
  const countByTaxon = new Map<string, number>();
  const used = new Set<string>();
  return {
    next(taxonId: string, cname: string, simpleName: string, ext: string): string {
      const label = sanitizeFilename(cname || simpleName.replace(/\s+/g, '_') || 'unknown');
      const tid = taxonId || 'unknown';
      const n = (countByTaxon.get(tid) ?? 0) + 1;
      countByTaxon.set(tid, n);
      let name = `${folder}/${dir}/${tid}_${label}_${n}.${ext}`;
      for (let dup = 2; used.has(name); dup++) {
        name = `${folder}/${dir}/${tid}_${label}_${n}-${dup}.${ext}`;
      }
      used.add(name);
      return name;
    },
    /** Reserve a name produced elsewhere (environment photos) so the species
     *  namer can never hand out the same one. */
    claim(name: string): string {
      let out = name;
      for (let dup = 2; used.has(out); dup++) {
        out = name.replace(/(\.[^.]+)$/, `-${dup}$1`);
      }
      used.add(out);
      return out;
    },
  };
}

type PhotoNamer = ReturnType<typeof createPhotoNamer>;

/** Bare filename (no folder) — what the yml lists and the importer looks up. */
function photoBasename(entryName: string): string {
  return entryName.split('/').pop() ?? entryName;
}

/** Photos.app permission elevation, once per export run.
 *
 * The capture flow requested `MediaLibrary.requestPermissionsAsync(true)` —
 * `true` = **write-only**. That lets the app SAVE new photos but **denies
 * reading existing assets**, so `requestContentEditingInput` inside
 * `getAssetInfoAsync` resolves with `contentInput = nil` →
 * `info.localUri = null` → photo silently skipped at export.
 *
 * Before any photo read, ask for FULL access. The first time, the system
 * shows the upgrade prompt; subsequent runs no-op. If the user refuses,
 * `getAssetInfoAsync` will continue to return null and we'll just skip
 * photos (the rest of the bundle still ships). */
let photosFullAccessAttempted = false;
export async function ensurePhotosReadAccess(): Promise<void> {
  if (photosFullAccessAttempted) return;
  photosFullAccessAttempted = true;
  try {
    const current = await MediaLibrary.getPermissionsAsync(false);
    if (current.granted) return;
    if (!current.canAskAgain) {
      if (__DEV__) console.warn('[bundleExport] full Photos permission permanently denied; photos will be skipped');
      return;
    }
    await MediaLibrary.requestPermissionsAsync(false);
  } catch (e) {
    if (__DEV__) console.warn('[bundleExport] could not elevate Photos permission', e);
  }
}

/** The minimum shape `collectPhotos` needs — satisfied by session records,
 *  plot species records and specimens alike. */
type PhotoBearing = {
  photo_paths: string | null;
  taxon_id: string;
  common_name_c: string;
  simple_name: string;
  /** Keys the assigned filenames so the yml can list them per record. */
  occurrence_id: string | null;
};

/**
 * Stamp the record's current metadata onto the copy going into the zip.
 *
 * The file in the user's photo library keeps whatever it was given when it was
 * saved — `expo-media-library` cannot modify an asset after the fact — so a
 * coordinate entered after the shutter, an edited note, or an attribute filled
 * in later only reaches the delivered file here. The original is untouched,
 * which is also what makes this safe for album-picked photos.
 *
 * JPEG only, and failure is not fatal: the untouched bytes still ship.
 */
function restamped(b64: string, fileUri: string, ctx: PhotoSpeciesContext | null): string {
  if (!ctx) return b64;
  // guessExt returns a bare extension with no leading dot ('jpg', not '.jpg').
  const ext = guessExt(fileUri).toLowerCase();
  if (ext !== 'jpg' && ext !== 'jpeg') return b64;
  return restampJpegBase64(b64, ctx) ?? b64;
}

/**
 * A yml item reshaped for a DwC-named CSV.
 *
 * The `.yml` and the `_occurrence_dwc.csv` share one item builder, but they answer to
 * different masters: the yml is this app's own round-trip format (it also
 * carries eventUUID / gpsMode / startedAt, none of them DwC) and `sessionImport`
 * reads `degreeOfEstablishment` straight back, so it must keep every value the
 * user entered — including `wild`, which is ours, not TDWG's. The CSV is the
 * deliverable, so there the same field is sanitised to a value the vocabulary
 * actually defines.
 */
function toDwcCsvRow(item: Record<string, unknown>): Record<string, unknown> {
  const row = convertToDwc(item);
  // DwC has no sound-specific term (only `associatedMedia`), so the deliverable
  // merges the two lists while the yml keeps them apart for the round trip.
  if (row.audio_files) {
    row.associatedMedia = [row.associatedMedia, row.audio_files].filter(Boolean).join('|');
    delete row.audio_files;
  }
  if ('degreeOfEstablishment' in row) {
    row.degreeOfEstablishment = establishmentDwcValue(row.degreeOfEstablishment as string | null);
  }
  return row;
}

async function collectPhotos<T extends PhotoBearing>(
  records: T[],
  namer: PhotoNamer,
  ctx: ProgressCtx,
  toContext?: (r: T) => PhotoSpeciesContext,
): Promise<{ entries: BuiltZipEntry[]; names: PhotoNames }> {
  await ensurePhotosReadAccess();
  const out: BuiltZipEntry[] = [];
  const names: PhotoNames = new Map();
  for (const r of records) {
    const uris = parsePhotoUris(r.photo_paths);
    for (const uri of uris) {
      const fileUri = await resolveAssetUri(uri);
      ctx.done += 1;
      ctx.onProgress?.({ label: i18n.t('export.stage.photos'), done: ctx.done, total: ctx.total });
      if (!fileUri) continue;
      try {
        const raw = await readAsStringAsync(fileUri, { encoding: 'base64' });
        const b64 = restamped(raw, fileUri, toContext ? toContext(r) : null);
        const bytes = base64ToBytes(b64);
        const name = namer.next(r.taxon_id, r.common_name_c, r.simple_name, guessExt(fileUri));
        out.push({ name, bytes });
        // Only photos that actually made it into the zip are listed in the
        // yml — an unreadable one must not leave a dangling filename.
        if (r.occurrence_id) {
          names.set(r.occurrence_id, [...(names.get(r.occurrence_id) ?? []), photoBasename(name)]);
        }
      } catch {
        // skip unreadable photo
      }
    }
  }
  return { entries: out, names };
}

type AudioBearing = {
  audio_paths: string | null;
  taxon_id: string;
  common_name_c: string;
  simple_name: string;
  occurrence_id: string | null;
};

/**
 * Recorded clips (v29) into `<folder>/audio/`.
 *
 * Simpler than photos on every axis: these are app-owned files under
 * documentDirectory/audio/, so there is no photo-library asset to resolve, no
 * EXIF to restamp and no permission to elevate. `safeAppFileUri` is still
 * needed: the iOS container id changes between installs, and a record's text
 * must not point the export at another file.
 *
 * Until this existed a clip had no way off the device at all — it rode in
 * neither the export bundle nor either backup.
 */
async function collectAudio<T extends AudioBearing>(
  records: T[],
  namer: PhotoNamer,
): Promise<{ entries: BuiltZipEntry[]; names: PhotoNames }> {
  const out: BuiltZipEntry[] = [];
  const names: PhotoNames = new Map();
  for (const r of records) {
    for (const uri of parseAudioPaths(r.audio_paths)) {
      const fileUri = safeAppFileUri(uri);
      if (!fileUri) continue;
      try {
        const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
        const ext = /\.([A-Za-z0-9]+)$/.exec(fileUri)?.[1]?.toLowerCase() ?? AUDIO_EXT;
        const name = namer.next(r.taxon_id, r.common_name_c, r.simple_name, ext);
        out.push({ name, bytes: base64ToBytes(b64) });
        // Same rule as photos: only clips that actually made it into the zip
        // are listed, so the yml never carries a dangling filename.
        if (r.occurrence_id) {
          names.set(r.occurrence_id, [...(names.get(r.occurrence_id) ?? []), photoBasename(name)]);
        }
      } catch {
        // skip unreadable clip
      }
    }
  }
  return { entries: out, names };
}

/** Pack environment context photos into the zip with the user-requested
 *  naming convention `${plotid}_${YYYYMMDD}_env-${N}.jpg`. Index is 1-based
 *  and reflects the order the user added them (preserved in
 *  `env_photos_json`). Extension is detected from the source URI; the user's
 *  example used `.jpg` but HEIC / PNG are also passed through unchanged. */
async function collectEnvPhotos(
  uris: string[],
  folder: string,
  plotid: string,
  dateStr: string,
  namer: PhotoNamer,
  ctx: ProgressCtx,
): Promise<{ entries: BuiltZipEntry[]; names: string[] }> {
  await ensurePhotosReadAccess();
  const out: BuiltZipEntry[] = [];
  const names: string[] = [];
  const safePlotid = sanitizeFilename(plotid || 'plot');
  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const fileUri = await resolveAssetUri(uri);
    ctx.done += 1;
    ctx.onProgress?.({ label: i18n.t('export.stage.photos'), done: ctx.done, total: ctx.total });
    if (!fileUri) continue;
    try {
      const b64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
      const bytes = base64ToBytes(b64);
      const ext = guessExt(fileUri);
      const name = namer.claim(`${folder}/photos/${safePlotid}_${dateStr}_env-${i + 1}.${ext}`);
      out.push({ name, bytes });
      names.push(photoBasename(name));
    } catch {
      // skip unreadable
    }
  }
  return { entries: out, names };
}

/** Format a millisecond timestamp as YYYYMMDD using the device timezone. */
function ymdString(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

async function collectPhotosPlot(
  species: PlotSpeciesRecordWithTaxon[],
  namer: PhotoNamer,
  ctx: ProgressCtx,
  /** Plot centre, used for records that carry no coordinate of their own. */
  plotGeo?: { lat: number | null; lng: number | null; accuracyM?: number | null } | null,
): Promise<{ entries: BuiltZipEntry[]; names: PhotoNames }> {
  await ensurePhotosReadAccess();
  const out: BuiltZipEntry[] = [];
  const names: PhotoNames = new Map();
  for (const r of species) {
    const uris = parsePhotoUris(r.photo_paths);
    for (const uri of uris) {
      const fileUri = await resolveAssetUri(uri);
      ctx.done += 1;
      ctx.onProgress?.({ label: i18n.t('export.stage.photos'), done: ctx.done, total: ctx.total });
      if (!fileUri) continue;
      try {
        const raw = await readAsStringAsync(fileUri, { encoding: 'base64' });
        const b64 = restamped(raw, fileUri, buildContextFromPlotRecord(r, plotGeo));
        const bytes = base64ToBytes(b64);
        const name = namer.next(r.taxon_id, r.common_name_c, r.simple_name, guessExt(fileUri));
        out.push({ name, bytes });
        if (r.occurrence_id) {
          names.set(r.occurrence_id, [...(names.get(r.occurrence_id) ?? []), photoBasename(name)]);
        }
      } catch {
        // skip
      }
    }
  }
  return { entries: out, names };
}

export function guessExt(uri: string): string {
  const m = uri.toLowerCase().match(/\.(jpg|jpeg|png|heic|webp)(?:\?|$)/);
  return m ? m[1] : 'jpg';
}

export function base64ToBytes(b64: string): Uint8Array {
  // Hermes doesn't have atob in older builds; expo's runtime has it but to be
  // safe we decode manually. Strip data: prefix if present.
  const data = b64.includes(',') ? b64.split(',')[1] : b64;
  const cleaned = data.replace(/\s+/g, '');
  // global.atob is available in Hermes 0.72+ (RN 0.74+); RN 0.81 has it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(cleaned) as string;
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function buildManifest(meta: {
  kind: 'session' | 'plot' | 'collection' | 'gloria' | 'bundle';
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

// Count photos before reading so we can publish the total to the progress
// callback up front.
export function countPhotosSession(records: { photo_paths: string | null }[]): number {
  let n = 0;
  for (const r of records) n += parsePhotoUris(r.photo_paths).length;
  return n;
}
function countPhotosPlot(records: PlotSpeciesRecordWithTaxon[]): number {
  let n = 0;
  for (const r of records) n += parsePhotoUris(r.photo_paths).length;
  return n;
}

/** Total photo count for a plot including env photos. Used for progress bar. */
export function countPhotosPlotWithEnv(plotId: number): number {
  const species = listPlotSpecies(plotId);
  const plot = getPlotSurvey(plotId);
  return countPhotosPlot(species) + (plot ? parseEnvPhotos(plot.env_photos_json).length : 0);
}

/** Announce the (synchronous, UI-blocking) zip step and yield one frame so the
 *  overlay can paint "壓縮中…" before zipSync freezes the JS thread. */
async function reportZipStage(onProgress?: (p: ExportProgress) => void): Promise<void> {
  if (!onProgress) return;
  onProgress({ label: i18n.t('export.stage.compressing') });
  await new Promise((r) => setTimeout(r, 0));
}

export async function bundleSession(
  sessionId: number,
  opts: BundleOptions,
): Promise<ExportFile> {
  const records = listSessionRecords(sessionId);
  const total = opts.includePhotos ? countPhotosSession(records) : 0;
  const ctx = { done: 0, total, onProgress: opts.onProgress };
  opts.onProgress?.(total > 0 ? { label: i18n.t('export.stage.photos'), done: 0, total } : { label: i18n.t('export.preparing') });
  const { entries, folderName } = await buildSessionEntries(sessionId, opts, ctx);
  await reportZipStage(opts.onProgress);
  return await finalizeZip(entries, folderName);
}

export async function bundlePlot(
  plotId: number,
  opts: BundleOptions,
): Promise<ExportFile> {
  const total = opts.includePhotos ? countPhotosPlotWithEnv(plotId) : 0;
  const ctx = { done: 0, total, onProgress: opts.onProgress };
  opts.onProgress?.(total > 0 ? { label: i18n.t('export.stage.photos'), done: 0, total } : { label: i18n.t('export.preparing') });
  const { entries, folderName } = await buildPlotEntries(plotId, opts, ctx);
  await reportZipStage(opts.onProgress);
  return await finalizeZip(entries, folderName);
}

export async function bundleCollection(
  tripId: number,
  opts: BundleOptions,
): Promise<ExportFile> {
  const total = opts.includePhotos ? countPhotosSession(listSpecimens(tripId)) : 0;
  const ctx = { done: 0, total, onProgress: opts.onProgress };
  opts.onProgress?.(total > 0 ? { label: i18n.t('export.stage.photos'), done: 0, total } : { label: i18n.t('export.preparing') });
  const { entries, folderName } = await buildCollectionEntries(tripId, opts, ctx);
  await reportZipStage(opts.onProgress);
  return await finalizeZip(entries, folderName);
}

export async function bundleMany(items: BundleItem[], opts: BundleOptions): Promise<ExportFile> {
  if (items.length === 0) throw new Error(i18n.t('export.err.noneSelected'));

  // Compute total photos across all items first so progress reflects the
  // whole batch, not just the current item.
  let totalPhotos = 0;
  if (opts.includePhotos) {
    for (const it of items) {
      if (it.kind === 'session') totalPhotos += countPhotosSession(listSessionRecords(it.id));
      else if (it.kind === 'collection') totalPhotos += countPhotosSession(listSpecimens(it.id));
      else if (it.kind === 'plot') totalPhotos += countPhotosPlotWithEnv(it.id);
    }
  }
  const ctx = { done: 0, total: totalPhotos, onProgress: opts.onProgress };
  opts.onProgress?.({ label: i18n.t('export.preparing') });

  const allEntries: BuiltZipEntry[] = [];
  const itemMeta: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Per-record progress so the user sees movement across a multi-record batch
    // even before photo reads kick in (photos report their own 處理照片 x/y).
    opts.onProgress?.({ label: i18n.t('export.stage.records', { current: i + 1, total: items.length }), done: i, total: items.length });
    try {
      if (it.kind === 'session') {
        const { entries, folderName } = await buildSessionEntries(it.id, opts, ctx);
        allEntries.push(...entries);
        itemMeta.push({ kind: 'session', id: it.id, folder: folderName });
      } else if (it.kind === 'collection') {
        const { entries, folderName } = await buildCollectionEntries(it.id, opts, ctx);
        allEntries.push(...entries);
        itemMeta.push({
          kind: 'collection',
          id: it.id,
          uuid: getCollectionTrip(it.id)?.uuid,
          folder: folderName,
        });
      } else if (it.kind === 'gloria') {
        const { entries, folderName } = await buildGloriaEntries(it.id, opts);
        allEntries.push(...entries);
        itemMeta.push({ kind: 'gloria', id: it.id, folder: folderName });
      } else {
        const { entries, folderName } = await buildPlotEntries(it.id, opts, ctx);
        allEntries.push(...entries);
        itemMeta.push({ kind: 'plot', id: it.id, uuid: getPlotSurvey(it.id)?.uuid, folder: folderName });
      }
    } catch (e) {
      // Skip a record that fails (e.g. empty) but record it in the bundle manifest.
      itemMeta.push({
        kind: it.kind,
        id: it.id,
        error: errText(e),
      });
    }
  }

  const bundleManifest = {
    app: 'mitalivana',
    schema_version: 1,
    created_at: new Date().toISOString(),
    item_count: items.length,
    items: itemMeta,
    geoFormats: opts.geoFormats,
    includePhotos: opts.includePhotos,
  };
  allEntries.push({
    name: `bundle_manifest.json`,
    bytes: strToU8(JSON.stringify(bundleManifest, null, 2)),
  });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  await reportZipStage(opts.onProgress);
  return await finalizeZip(allEntries, `mitalivana_bundle_${ts}`);
}

/**
 * Tell the recipient, inside the zip, what `signature.json` is.
 *
 * Not written by `buildRecordReadme`, because that runs while the records are
 * still being walked — before anyone knows whether this export will be signed
 * at all, and a README describing a signature file that is not there would be
 * worse than one that stays quiet.
 */
function appendSignatureNote(entries: BuiltZipEntry[], orcid: string): void {
  // Folders that will get a signature = folders that hold a manifest. Derived
  // rather than passed in, because this now runs before the signing does.
  const signedFolders = new Set(
    entries
      .filter((e) => isManifestPath(e.name))
      .map((e) => (e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/') + 1) : '')),
  );
  for (const e of entries) {
    if (!e.name.endsWith('README.md')) continue;
    const folder = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/') + 1) : '';
    if (!signedFolders.has(folder)) continue;
    e.bytes = strToU8(
      `${strFromU8(e.bytes)}\n\n## 出處簽章\n\n` +
        '- `signature.json` — 這份資料的 Ed25519 簽章，簽的是 `manifest.json`。\n' +
        `- 署名 ORCID：${orcid}（https://orcid.org/${orcid}）\n` +
        '- `manifest.json` 的 `files` 列出同層每個檔案的 SHA-256，所以一把簽章\n' +
        '  同時涵蓋 yml、CSV、照片與錄音。\n' +
        '- 驗證工具（離線、不需伺服器）：\n' +
        '  https://github.com/mutolisp/mitalivana/tree/main/mobile/verify\n' +
        '- 通過驗證代表「檔案自匯出後未被更動、由持有該金鑰者簽署」，\n' +
        '  不保證資料內容正確，也不排除 ORCID 帳號遭盜用。\n',
    );
  }
}

export async function finalizeZip(
  entries: BuiltZipEntry[],
  folderName: string,
): Promise<ExportFile> {
  // Signing goes through the same choke point rather than being decided per
  // export type: every zip this app writes leaves by this function, so there
  // is no "which exports get signed" rule that a new export path could miss.
  // `activeSigner()` returns null unless signing is on AND a key exists AND an
  // ORCID is set, so an incomplete setup produces an unsigned zip rather than
  // a signature that attributes the data to nobody.
  const active = await activeSigner();

  // Order matters, and getting it wrong is silent. The README is itself listed
  // in the manifest, so its note has to be written BEFORE the digests are
  // taken; and the digests have to be in the manifest before it is signed.
  // Appending the note last made every export report its own README as
  // "changed".
  if (active) appendSignatureNote(entries, active.signer.orcid);
  // Manifests learn what they are describing only now, when every file's
  // bytes exist. Rule lives in a pure module so the verifiers can share it.
  injectFileDigests(entries, strFromU8, strToU8);
  if (active) injectSignatures(entries, active.signer, active.seed, strFromU8, strToU8);
  const zippable: Zippable = {};
  for (const e of entries) zippable[e.name] = e.zipOpts ? [e.bytes, e.zipOpts] : e.bytes;
  const zipped = zipSync(zippable, { level: 6 });

  const filename = `${folderName}.zip`;
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(zipped);

  return { uri: file.uri, filename, mimeType: 'application/zip' };
}
