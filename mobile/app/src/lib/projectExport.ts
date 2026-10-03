/**
 * Project-level export: one zip carrying every record of a project (reusing
 * the per-record entry builders unchanged, under records/), plus the
 * cross-plot analysis tables (vegan matrices + wide env), JUICE import files,
 * a Darwin Core Archive (Event core + Occurrence + Humboldt extension), the
 * project's sites and a README documenting all of it.
 *
 * Analysis scope is deliberately plots-only (user decision); sessions and
 * collection trips still ship in records/ and in the DwC-A.
 */
import { errText } from '~/lib/errText';
import { listCensuses, type CensusListRow } from '~/survey/db/stemmap';
import { getUserDb } from '~/db/init';
import { resolveTaxa } from '~/db/taxonLookup';
import { buildSurveyDoc } from '~/survey/db/surveyDocCore';
import { projectSurveyMatrices } from '~/survey/export/surveyExportCore';
import { modularEventIds, surveyNames } from '~/survey/surveyBundle';
import yaml from 'js-yaml';
import { strToU8 } from 'fflate';
import {
  getProject,
  getPlotLayers,
  getSubplotLayers,
  listCollectionTrips,
  listPlotSpecies,
  listPlotSurveys,
  listSessionRecords,
  listSessions,
  listSitesByProject,
  listSpecimens,
  listSubplots,
  plotEventIds,
} from '~/db';
import {
  buildCensusBundleEntries,
  buildModularBundleEntries,
  buildCollectionEntries,
  buildPlotEntries,
  buildSessionEntries,
  checklistT,
  countPhotosPlotWithEnv,
  countPhotosSession,
  finalizeZip,
  orderLevels,
  plotSpeciesToMarkdownItem,
  recordToMarkdownItem,
  taxonToMarkdownItem,
  sanitizeFilename,
  specimenToMarkdownItem,
  type BuiltZipEntry,
  type BundleOptions,
  type ExportFile,
  checklistIdentity,
} from './bundleExport';
import { csvEscape, localIso } from './bundleYaml';
import { convertToDwc } from './dwcMapper';
import { buildRecordsDwca } from './dwcRows';
import { DOC_FORMATS } from './docFormat';
import { generateMarkdown, type MarkdownItem } from './markdown';
import {
  buildCoverScaleCsv,
  buildEnvWide,
  buildMatrix,
  buildMatrixByLayer,
  buildReleveIndex,
  buildReleves,
  buildSpeciesCols,
  buildSpeciesIndex,
  buildSpeciesLong,
  coverScaleRows,
  tableToCsv,
  TooManyRelevesError,
  type MatrixValueMode,
  type Releve,
  type RelevePlotInput,
  type SpeciesCol,
} from './vegMatrix';
import { buildJuiceHeader, buildJuiceSpeciesList, buildJuiceTable } from './juiceExport';
import { collectProjectReportInput } from './reportData';
import { buildProjectReport, type Translate } from './reportModel';
import { buildReportHtml } from './reportHtml';
import i18n from '~/i18n';
import { sitesToGeoJSON, sitesToGPX, sitesToKML } from './geoExporters';
import type { AnalysisFormat, ReportFormat } from '~/stores/settings';

export type ProjectExportOptions = BundleOptions & {
  matrixValue: MatrixValueMode;
  analysisFormats: AnalysisFormat[];
  /** Also emit the per-layer matrix (species_matrix_by_layer.csv). */
  matrixByLayer: boolean;
  /** Also emit the research report under report/. */
  includeReport: boolean;
  reportFormat: ReportFormat;
};

export async function bundleProject(
  projectId: number,
  opts: ProjectExportOptions,
): Promise<ExportFile> {
  const project = getProject(projectId);
  if (!project) throw new Error(i18n.t('export.err.projectNotFound', { id: projectId }));

  const sessions = listSessions().filter((s) => s.project_id === projectId);
  const plots = listPlotSurveys().filter((p) => p.project_id === projectId);
  const trips = listCollectionTrips().filter((c) => c.project_id === projectId);
  // Tree censuses: one file per series, its latest census here (the file carries the earlier ones, §9 1D).
  const latestCensus = new Map<number, CensusListRow>();
  for (const c of listCensuses().filter((x) => x.project_id === projectId)) {
    const cur = latestCensus.get(c.series_id);
    if (!cur || c.census_no > cur.census_no) latestCensus.set(c.series_id, c);
  }
  const censuses = [...latestCensus.values()];
  // Checklist / plot-style surveys (Phase 2E-a): each its own file (it carries the one before it).
  const modulars = (getUserDb().executeSync(`SELECT id, uuid FROM fw_surveys WHERE style <> 'individual' AND project_id = ? ORDER BY start_ts, id`, [projectId]).rows ?? []) as {
    id: number;
    uuid: string;
  }[];
  const sites = listSitesByProject(projectId);
  if (sessions.length + plots.length + trips.length + censuses.length + modulars.length + sites.length === 0) {
    throw new Error(i18n.t('export.err.projectEmpty', { name: project.name }));
  }

  // Whole-bundle photo total so the progress bar covers the full batch.
  let totalPhotos = 0;
  if (opts.includePhotos) {
    for (const s of sessions) totalPhotos += countPhotosSession(listSessionRecords(s.id));
    for (const p of plots) totalPhotos += countPhotosPlotWithEnv(p.id);
    for (const c of trips) totalPhotos += countPhotosSession(listSpecimens(c.id));
  }
  const ctx = { done: 0, total: totalPhotos, onProgress: opts.onProgress };
  opts.onProgress?.({ label: i18n.t('export.preparing') });

  const entries: BuiltZipEntry[] = [];
  const recordMeta: Array<Record<string, unknown>> = [];
  const totalRecords = sessions.length + plots.length + trips.length + censuses.length + modulars.length;
  let recordIdx = 0;

  const addRecord = async (
    kind: 'session' | 'plot' | 'collection' | 'survey' | 'modular',
    id: number,
    uuid: string | undefined,
    build: () => Promise<{ entries: BuiltZipEntry[]; folderName: string }>,
  ) => {
    recordIdx += 1;
    opts.onProgress?.({ label: i18n.t('export.stage.records', { current: recordIdx, total: totalRecords }), done: recordIdx - 1, total: totalRecords });
    try {
      const { entries: built, folderName } = await build();
      entries.push(...built.map((e) => ({ ...e, name: `records/${e.name}` })));
      recordMeta.push({ kind, id, uuid, folder: `records/${folderName}` });
    } catch (e) {
      // A record that fails (e.g. empty session) is noted, not fatal.
      recordMeta.push({ kind, id, uuid, error: errText(e) });
    }
  };

  // 逐筆記錄不再各自產一份 DwC-A：整包最後會有一份涵蓋所有記錄的
  // `dwca/`（同一組 row builder），每個 records/ 子資料夾再放一份只是重複。
  const recordOpts = { ...opts, includeDwca: false };
  for (const p of plots) await addRecord('plot', p.id, p.uuid, () => buildPlotEntries(p.id, recordOpts, ctx));
  for (const s of sessions) await addRecord('session', s.id, s.uuid, () => buildSessionEntries(s.id, recordOpts, ctx));
  for (const c of trips) await addRecord('collection', c.id, c.uuid, () => buildCollectionEntries(c.id, recordOpts, ctx));
  for (const c of censuses) await addRecord('survey', c.id, c.uuid, () => buildCensusBundleEntries(c.id, recordOpts));
  for (const m of modulars) await addRecord('modular', m.id, m.uuid, () => buildModularBundleEntries(m.id, recordOpts));

  // ── Merged checklist across every record in the project ─────────────────
  // records/ already carries one checklist per record; this is their union,
  // which is what "what did this project find" actually asks. Scope is all
  // three record kinds — unlike analysis/ and juice/ above, which are
  // plots-only — because a project checklist that silently dropped the
  // sessions and collections would be answering a different question.
  //
  // Per-record abundance and remarks are dropped on purpose: one species can
  // appear in several plots with different values, so carrying any one of them
  // would be picking a winner. This is a species list, not an observation table.
  opts.onProgress?.({ label: i18n.t('export.stage.mergeChecklist') });
  const checklistItems: MarkdownItem[] = [];
  const seenSpecies = new Set<string>();
  const addSpecies = (
    r: {
      taxon_id: string;
      used_scientific_name: string | null;
      verbatim_identification?: string | null;
    },
    toItem: () => MarkdownItem,
  ) => {
    // Same identity the rest of the export chain uses — including the verbatim
    // field determination (v39), without which `Orchidaceae sp1` and `sp2`
    // collapse into one line here while staying two everywhere else.
    const key = checklistIdentity(r);
    if (opts.mergeDuplicateTaxa && seenSpecies.has(key)) return;
    seenSpecies.add(key);
    checklistItems.push({ ...toItem(), abundance: null, notes: null });
  };
  for (const p of plots) {
    for (const r of listPlotSpecies(p.id)) addSpecies(r, () => plotSpeciesToMarkdownItem(r));
  }
  for (const sess of sessions) {
    for (const r of listSessionRecords(sess.id)) addSpecies(r, () => recordToMarkdownItem(r));
  }
  for (const c of trips) {
    for (const sp of listSpecimens(c.id)) addSpecies(sp, () => specimenToMarkdownItem(sp));
  }
  // Checklist / plot-style surveys: their occurrences, by the taxon as the checklists have it.
  const modularDocs = modulars.map((m) => buildSurveyDoc({ db: getUserDb() }, m.id));
  const modularTaxa = resolveTaxa([...new Set(modularDocs.flatMap((d) => d.occurrences.map((o) => String(o.taxon_id))))]);
  for (const d of modularDocs) {
    for (const o of d.occurrences) {
      const id = String(o.taxon_id);
      const f = modularTaxa.get(id);
      if (!f) continue;
      const r = { taxon_id: id, used_scientific_name: (o.used_scientific_name as string | null) ?? null, verbatim_identification: (o.verbatim_identification as string | null) ?? null };
      addSpecies(r, () => taxonToMarkdownItem(id, f));
    }
  }

  if (checklistItems.length > 0) {
    const checklistMd = generateMarkdown(
      checklistItems,
      checklistT(opts.lang),
      { project: project.name },
      {
        levelsOverride: opts.levels.length ? orderLevels(opts.levels) : undefined,
        conservationFields: opts.conservationFields,
        hideLowConcern: opts.conservationHideLowConcern,
      },
    );
    entries.push({ name: 'checklist/checklist.md', bytes: strToU8(checklistMd) });
    if (opts.includeDocx) {
      const doc = DOC_FORMATS[opts.docFormat];
      entries.push({ name: `checklist/checklist.${doc.ext}`, bytes: doc.fromMarkdown(checklistMd) });
    }
    entries.push({
      name: 'checklist/checklist.csv',
      bytes: strToU8(buildChecklistCsv(checklistItems)),
    });
  }

  // ── Analysis tables (plots only) ─────────────────────────────────────────
  const readmeNotes: string[] = [];
  let releves: Releve[] = [];
  let cols: SpeciesCol[] = [];
  let lossyTaxa: string[] = [];
  const wantVegan = opts.analysisFormats.includes('vegan');
  const wantJuice = opts.analysisFormats.includes('juice');
  const wantDwca = opts.analysisFormats.includes('dwca');
  const safeName = sanitizeFilename(project.name);

  if (plots.length > 0 && (wantVegan || wantJuice)) {
    opts.onProgress?.({ label: i18n.t('export.stage.analysis') });
    const inputs: RelevePlotInput[] = plots.map((plot) => ({
      plot,
      projectName: project.name,
      layers: plot.plot_type === 'fixed' ? getPlotLayers(plot.id) : [],
      subplots: listSubplots(plot.id).map((sp) => ({ ...sp, layers: getSubplotLayers(sp.id) })),
      species: listPlotSpecies(plot.id),
    }));
    let built: ReturnType<typeof buildReleves>;
    try {
      built = buildReleves(inputs, plotEventIds(plots.map((p) => p.plotid)));
    } catch (e) {
      // vegMatrix stays free of ~/i18n (check:vegmatrix runs it in Node).
      if (e instanceof TooManyRelevesError) throw new Error(i18n.t('export.err.tooManyReleves', { n: e.releves, max: e.max }));
      throw e;
    }
    releves = built.releves;
    readmeNotes.push(...built.warnings);
    cols = buildSpeciesCols(releves);

    const empty = releves.filter((r) => r.records.length === 0);
    if (empty.length > 0) {
      readmeNotes.push(
        `空樣區（矩陣中為全 0 列，vegan::vegdist 會產生 NaN）：${empty.map((r) => r.id).join('、')}`,
      );
    }

    if (wantVegan) {
      const mode = opts.matrixValue;
      const put = (name: string, text: string) =>
        entries.push({ name: `analysis/${name}`, bytes: strToU8(text) });
      put('releve_index.csv', tableToCsv(buildReleveIndex(releves)));
      put('species_index.csv', tableToCsv(buildSpeciesIndex(cols)));
      put('species_long.csv', tableToCsv(buildSpeciesLong(releves, cols, mode)));
      put('species_matrix.csv', tableToCsv(buildMatrix(releves, cols, mode)));
      if (opts.matrixByLayer) {
        put('species_matrix_by_layer.csv', tableToCsv(buildMatrixByLayer(releves, cols, mode)));
      }
      put('env.csv', tableToCsv(buildEnvWide(releves)));
      put('cover_scale.csv', buildCoverScaleCsv());
    }

    if (wantJuice) {
      const table = buildJuiceTable(releves, cols, `${project.name} (mitalivana)`);
      lossyTaxa = table.lossyTaxa;
      entries.push({ name: `juice/${safeName}_table.csv`, bytes: strToU8(table.text) });
      entries.push({ name: `juice/${safeName}_header.csv`, bytes: strToU8(buildJuiceHeader(releves)) });
      entries.push({ name: `juice/${safeName}_species.csv`, bytes: strToU8(buildJuiceSpeciesList(cols)) });
    }
  }

  // ── Plot-style surveys' matrices (decided 2026-10-03: per template, per scale) ──
  if (wantVegan && modularDocs.some((d) => d.survey.style === 'plot')) {
    const ids = modularEventIds();
    const items = modularDocs.map((doc, i) => ({ doc, eventId: ids.get(modulars[i].id) ?? String(doc.survey.uuid) }));
    const built = projectSurveyMatrices(items, surveyNames(modularDocs.flatMap((d) => d.occurrences.map((o) => String(o.taxon_id)))));
    for (const tb of built.tables) entries.push({ name: `analysis/surveys/${tb.name}.csv`, bytes: strToU8(tableToCsv(tb.table)) });
    if (built.left.length) readmeNotes.push(`樣區型調查用了多種或自訂豐度尺度，只在有無矩陣中（不進尺度矩陣）：${built.left.join('、')}`);
  }

  // ── Darwin Core Archive (all three record kinds) ─────────────────────────
  if (wantDwca && totalRecords > 0) {
    opts.onProgress?.({ label: i18n.t('export.stage.dwca') });
    const dwca = buildRecordsDwca({
      title: project.name,
      abstract: project.abstract ?? '',
      packageId: `mitalivana-${safeName}-${new Date().toISOString().slice(0, 10)}`,
      plots,
      sessions,
      trips,
    });
    entries.push({
      name: `dwca/${safeName}_dwca.zip`,
      bytes: dwca.records,
      // Already a deflate stream — store, don't re-compress.
      zipOpts: { level: 0 },
    });
    // Taxon core: conservation status is a property of the taxon, and one
    // archive can only have one core. Absent when nothing has a status.
    if (dwca.taxa) {
      entries.push({
        name: `dwca/${safeName}_taxon_dwca.zip`,
        bytes: dwca.taxa,
        zipOpts: { level: 0 },
      });
    }
  }

  // ── Sites ────────────────────────────────────────────────────────────────
  if (sites.length > 0) {
    for (const fmt of opts.geoFormats) {
      const text =
        fmt === 'geojson' ? sitesToGeoJSON(sites) : fmt === 'kml' ? sitesToKML(sites) : sitesToGPX(sites);
      entries.push({ name: `sites/sites.${fmt}`, bytes: strToU8(text) });
    }
  }

  // ── project.yml / README.md / manifest.json ──────────────────────────────
  const now = new Date();
  const stats = {
    sessions: sessions.length,
    plots: plots.length,
    collections: trips.length,
    surveys: modulars.length,
    sites: sites.length,
    releves: releves.length,
    taxa: cols.length,
  };
  const projectYml = {
    app: 'mitalivana',
    type: 'project',
    schema_version: 1,
    created_at: localIso(now.getTime()),
    project: {
      name: project.name,
      abstract: project.abstract ?? '',
      location_description: project.location_description ?? '',
      notes: project.notes ?? '',
    },
    stats,
    records: recordMeta,
  };
  entries.push({ name: 'project.yml', bytes: strToU8(yaml.dump(projectYml, { lineWidth: -1, noRefs: true })) });

  // ── research report ──────────────────────────────────────────────────────
  // Prose and statistics commentary, so it follows the export language like the
  // checklist does — a French user handed a Chinese narrative has nothing.
  // Still fixed regardless of language: DwC terms, scientific and vernacular
  // names, and the analysis tables, which are controlled vocabularies and data.
  if (opts.includeReport) {
    opts.onProgress?.({ label: i18n.t('export.stage.report') });
    try {
      const input = collectProjectReportInput(projectId);
      if (input) {
        const lang = i18n.language;
        const report = buildProjectReport(input, i18n.getFixedT(lang) as unknown as Translate);
        if (opts.reportFormat === 'html' || opts.reportFormat === 'both') {
          entries.push({ name: 'report/report.html', bytes: strToU8(buildReportHtml(report, lang)) });
        }
        // 'docx' is the stored value for "the formatted document", in whichever
        // format is chosen.
        if (opts.reportFormat === 'docx' || opts.reportFormat === 'both') {
          const doc = DOC_FORMATS[opts.docFormat];
          entries.push({ name: `report/report.${doc.ext}`, bytes: doc.report(report) });
        }
        readmeNotes.push(`研究報表語言：${lang}（報表以目前介面語言產生，其餘匯出內容維持既有慣例）`);
      }
    } catch (e) {
      // A report that fails must not cost the user the rest of the bundle.
      readmeNotes.push(`研究報表產生失敗：${errText(e)}`);
    }
  }

  entries.push({
    name: 'README.md',
    bytes: strToU8(buildReadme(project.name, stats, opts, readmeNotes, lossyTaxa)),
  });
  entries.push({
    name: 'manifest.json',
    bytes: strToU8(
      JSON.stringify(
        {
          app: 'mitalivana',
          schema_version: 1,
          type: 'project',
          created_at: now.toISOString(),
          project_name: project.name,
          stats,
          matrix_value: opts.matrixValue,
          analysis_formats: opts.analysisFormats,
          include_report: opts.includeReport,
          report_format: opts.includeReport ? opts.reportFormat : null,
          doc_format: opts.docFormat,
          geoFormats: opts.geoFormats,
          includePhotos: opts.includePhotos,
          records: recordMeta,
        },
        null,
        2,
      ),
    ),
  });

  const ymdStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return await finalizeZip(entries, `${safeName}_${ymdStr}`, opts.onProgress);
}

// ── README ──────────────────────────────────────────────────────────────────

function buildReadme(
  projectName: string,
  stats: Record<string, number>,
  opts: ProjectExportOptions,
  notes: string[],
  lossyTaxa: string[],
): string {
  const checklistFormats = ['md', ...(opts.includeDocx ? [DOC_FORMATS[opts.docFormat].ext] : []), 'csv'].join(' / ');
  const scale = coverScaleRows()
    .map((r) => `| ${r.bbCode} | ${r.coverPct} | ${r.ordinal} | ${r.coverProvenance} |`)
    .join('\n');
  const modeLabel =
    opts.matrixValue === 'bb'
      ? 'Braun-Blanquet 原始碼（矩陣含非數值儲存格，需自行轉換）'
      : opts.matrixValue === 'ordinal'
        ? 'ordinal transform（1–9）'
        : '覆蓋度整數百分比（JUICE/Turboveg 慣例）';
  const lines = [
    `# ${projectName} — 專案匯出`,
    '',
    `統計：名錄 ${stats.sessions}、樣區 ${stats.plots}（樣方 ${stats.releves}）、採集 ${stats.collections}、名錄型／樣區型調查 ${stats.surveys}、地理樣區 ${stats.sites}、物種欄 ${stats.taxa}`,
    '',
    '## 內容結構',
    '',
    '- `records/` — 逐筆記錄的完整匯出（yml / csv / md / geo / 照片），與單筆匯出格式相同，可個別重新匯入 app'
      + '；DwC-A 只在本包最外層的 `dwca/` 出一份（涵蓋全部記錄），逐筆資料夾內不重複產生',
    `- \`checklist/\` — **全專案合併物種名錄**（${checklistFormats}）：`
      + '樣區、名錄、採集與名錄型／樣區型調查的物種聯集去重，'
      + '不含各筆記錄的豐度與備註（同一種可能在多個樣區有不同值）',
    '- `analysis/` — 跨樣區分析資料表（樣方 × 物種矩陣、環境表；**只涵蓋樣區**，名錄與採集不進矩陣）',
    '- `analysis/surveys/` — 樣區型調查（模板組成的調查表）的單位 × 物種矩陣：每個模板一個有無矩陣，每種豐度尺度一個矩陣，只收全部記錄都用該尺度的調查（列名為單位的 eventID，同 records/ 內的 `_units.csv`）',
    '- `juice/` — JUICE 匯入檔（分號分隔）',
    '- `dwca/` — Darwin Core Archive（Event core + Occurrence + Humboldt extension，GBIF 發布用）',
    '- `sites/` — 專案的地理樣區幾何',
    '',
    '## analysis/（R vegan）',
    '',
    '樣方（relevé）定義：有小區的樣區以小區為一列（`plotid-S1`），未分小區以樣區為一列；',
    '切分後仍未歸屬小區的記錄另立母樣區列。同 plotid 重複調查時列名加日期後綴。',
    `矩陣數值表示法：${modeLabel}。`,
    '',
    '```r',
    'comm <- read.csv("analysis/species_matrix.csv", row.names = 1, check.names = FALSE)',
    'env  <- read.csv("analysis/env.csv", row.names = 1, check.names = FALSE)',
    'stopifnot(identical(rownames(comm), rownames(env)))',
    'library(vegan)',
    'vegdist(comm)          # Bray-Curtis 距離',
    'decostand(comm, "hellinger")',
    '```',
    '',
    '- `species_matrix.csv` — 合併版：同一物種跨層取最大值。**注意**：同一樣區不同層使用不同計量（如喬木層 DBH、草本層 BB）時，合併值單位混雜，請改用 `species_long.csv` 自訂合併規則',
    ...(opts.matrixByLayer ? ['- `species_matrix_by_layer.csv` — 分層版：欄名 `物種@E4`'] : []),
    '- `species_long.csv` — 無損長表（每筆記錄一列，含原值 quantity/quantityType 與轉換值 value）',
    '- `env.csv` — 環境表（列＝樣方、欄＝變數），與矩陣同列序',
    '- `releve_index.csv` — 樣方整數編號 ↔ 樣方 ID ↔ 樣區 UUID 對照',
    '- `species_index.csv` — 物種欄名 ↔ taxonID ↔ 學名/俗名/科；未鑑定到種的形態種（同屬 sp1、sp2）各自一欄，暫定名在 `verbatimIdentification`',
    '- `cover_scale.csv` — 本次匯出使用的 Braun-Blanquet 換算表（含出處）',
    '- 檔案為 UTF-8 **無 BOM**（R 友善）；Excel 開啟請用「資料 → 從文字/CSV」並選 UTF-8',
    '- DBH 記錄之數值化 = 斷面積合計（cm²，多莖加總）；個體數跨層/跨筆合併採加總，覆蓋度採最大值',
    '',
    '## Braun-Blanquet 換算表',
    '',
    '| BB 碼 | 覆蓋度 % | ordinal | 出處 |',
    '|---|---|---|---|',
    scale,
    '',
    'ordinal 出處：van der Maarel (2007) J Veg Sci 18:767 摘要（extended BB scale r,+,1,2m,2a,2b,3,4,5 → OTV 1–9）；',
    '本 app 尺度無 2m/2a/2b，plain 2 → 5 為本軟體之文件化約定。',
    '',
    '## juice/（JUICE 匯入步驟）',
    '',
    `1. \`File → Import → Table → from Spreadsheet file\`，選 \`juice/*_table.csv\`，分隔符 **Semicolon**，第 2 欄為層次（層次 = 樣區分層 E1–E6 → 1–6）`,
    '2. `File → Import → Header Data`，套用 `juice/*_header.csv`（首欄 Relevé number 與表格對應；date 為 YYYYMMDD）',
    '3. 表中 `.` = 未出現；Braun-Blanquet 碼與百分比 JUICE 皆可讀',
    ...(lossyTaxa.length > 0
      ? [
          '',
          `**注意**：下列物種含非覆蓋度資料（個體數/胸徑/自訂計量），JUICE 表中一律以最小正值 \`1\`（=1%）標記為出現，數量請查 \`analysis/species_long.csv\`：${lossyTaxa.join('、')}`,
        ]
      : []),
    '',
    '## dwca/',
    '',
    '`*_dwca.zip` 為完整 Darwin Core Archive（TAB 分隔 + meta.xml + eml.xml），可直接上傳 GBIF IPT 或以',
    'GBIF data validator 檢驗。Event 階層：樣區為母事件、小區為子事件（parentEventID）；名錄與採集各自成事件。',
    '葉候（leafPhenology）與偵測方式等非標準 DwC 欄位不在 archive 內，完整欄位見 `records/`。',
    '每木調查與名錄型／樣區型調查尚未納入 archive，資料見 `records/`。',
    '',
    ...(notes.length > 0 ? ['## 匯出注意事項', '', ...notes.map((n) => `- ${n}`), ''] : []),
  ];
  return lines.join('\n');
}

/**
 * The merged checklist as DwC CSV, one row per species.
 *
 * Columns are the union of every row's keys, so a list where only some species
 * carry a CITES appendix still gets that column. UTF-8 BOM because Excel on
 * Windows reads a BOM-less UTF-8 CSV as the local codepage and mangles every
 * CJK name. Rows are ordered taxonomically, matching the per-record
 * `_occurrence_dwc.csv`.
 *
 * Unlike the Markdown twin this is never localized: DwC terms are a controlled
 * vocabulary and a translated header would not be readable by GBIF or R.
 */
function buildChecklistCsv(items: MarkdownItem[]): string {
  const order: (keyof MarkdownItem)[] = [
    'kingdom', 'phylum', 'class_name', 'order', 'family', 'genus', 'name',
  ];
  const rows = [...items]
    .sort((a, b) => {
      for (const f of order) {
        const c = String(a[f] ?? '').localeCompare(String(b[f] ?? ''));
        if (c !== 0) return c;
      }
      return 0;
    })
    .map((it) => convertToDwc(it as unknown as Record<string, unknown>));

  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
  return (
    '\ufeff' +
    [keys.join(','), ...rows.map((r) => keys.map((k) => csvEscape(r[k])).join(','))].join('\n')
  );
}
