/**
 * The 1E stress test on a device (app/survey/stress.tsx; release builds too
 * while STRESS_TEST_OFFERED): build the test plot of stressCore.ts through the app's own save path,
 * then time what a census of that size costs — loading, saving, versions,
 * checks, sync blocks, export, backup, start-up clean-up — so the numbers come
 * from real hardware (an emulator can be several times faster than a phone).
 */
import { decodeUtf8 } from '~/lib/utf8';
import { zipInPieces } from '~/lib/zipWriter';
import { sha256 } from '@noble/hashes/sha2.js';
import { File } from 'expo-file-system';
import { deflateSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { purgeOrphanRows } from '~/db/cleanup';
import { getUserDb, withTransaction } from '~/db/init';
import { saveVersion } from '~/db/recordVersions';
import { generateUuid } from '~/db/uuid';
import { errText } from '~/lib/errText';
import { createBackup } from '~/lib/backup';
import { buildCensusBundleEntries, bundleCensus, type BundleOptions } from '~/lib/bundleExport';
import { readRecordImportFromBytes } from '~/lib/recordImportZip';
import { baseOf } from '~/lib/mergeEngine';
import { aadFor, b64u, NONCE_BYTES, sealRecord } from '~/lib/teamCrypto';
import { randomBytes } from '~/lib/teamSync';
import { blockSizeOptions, mergeBlockQuietly } from '../censusSync';
import { buildCensusExport, censusExportFromFile, censusExportText, importCensusDoc, planCensusImport, type CensusExportDoc } from '../db/censusExportCore';
import { quadratRowId } from '../db/censusVersions';
import * as cs from '../db/censusSyncCore';
import * as core from '../db/stemmapCore';
import { deleteCensuses } from '../db/stemmap';
import { STEMMAP_TEMPLATE } from '../templates/stemmap';
import { checkpointQuadrats } from '../undo';
import { extremeWorklist, screening } from '../stemmap/review';
import { fgQuadratCounts } from '../stemmap/coords';
import { loadCensusData, loadQuadratRows } from '../useCensus';
import { AMS_CODESET } from '../codesets/forestgeoAms2021';
import { buildStressPlan, createStressPlot, STRESS_AMS_TEMPLATE, STRESS_SIZES, writeCensus1, writeCensus2, type StressSize } from './stressCore';

const ctx = (): core.Ctx => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });
const rows = <T>(sql: string, args: (string | number)[] = []) => (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];
const yieldUi = () => new Promise((r) => setTimeout(r, 0));

export type BenchLine = { label: string; ms: number | null; detail?: string };
export type Progress = (label: string, done?: number, total?: number) => void;

type HermesStats = { js_heapSize?: number };
const heapMb = (): number | null => {
  const h = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => HermesStats } }).HermesInternal;
  const v = h?.getInstrumentedStats?.().js_heapSize;
  return v == null ? null : Math.round(v / 1024 / 1024);
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The code of the plot the import test makes: the test plot as a teammate's phone gets it. */
const copyCode = (size: StressSize) => `${STRESS_SIZES[size].code}-COPY`;

/** The stress plot here, if built: its frame and censuses. */
export function stressPlot(size: StressSize): { frameId: number; census1: number | null; census2: number | null } | null {
  return plotByCode(STRESS_SIZES[size].code);
}

function plotByCode(code: string): { frameId: number; census1: number | null; census2: number | null } | null {
  const f = rows<{ id: number }>(`SELECT id FROM fw_frames WHERE code = ?`, [code])[0];
  if (!f) return null;
  const cs2 = rows<{ id: number; census_no: number }>(`SELECT id, census_no FROM fw_surveys WHERE frame_id = ? ORDER BY census_no`, [f.id]);
  return { frameId: f.id, census1: cs2.find((c) => c.census_no === 1)?.id ?? null, census2: cs2.find((c) => c.census_no === 2)?.id ?? null };
}

/** Whether the test plot was built with every AMS variable (its census template records the AMS code set). */
export function stressPlotHasAms(size: StressSize): boolean {
  const census1 = stressPlot(size)?.census1;
  return census1 != null && core.censusCodesets(ctx(), census1).includes(AMS_CODESET);
}

/** Build the test plot (≈ 1–5 minutes on a phone); `ams`: every stem also gets every AMS variable. */
export async function buildStressData(size: StressSize, progress: Progress, ams = false): Promise<BenchLine[]> {
  const out: BenchLine[] = [];
  const plan = buildStressPlan(size);
  const c = ctx();
  const t0 = Date.now();
  const template = ams ? STRESS_AMS_TEMPLATE : STEMMAP_TEMPLATE;
  const made = withTransaction(() => createStressPlot(c, size, template));
  const ids = new Map<string, number>();
  const CHUNK = 250;
  for (let i = 0; i < plan.trees.length; i += CHUNK) {
    withTransaction(() => writeCensus1(c, made.census1, plan, i, Math.min(plan.trees.length, i + CHUNK), ids, ams));
    progress('第 1 回合', Math.min(plan.trees.length, i + CHUNK), plan.trees.length);
    await yieldUi();
  }
  core.finishCensus(c, made.census1);
  const t1 = Date.now();
  out.push({ label: '建立第 1 回合', ms: t1 - t0, detail: `${plan.trees.length} 株，每株 ${((t1 - t0) / plan.trees.length).toFixed(2)} ms` });
  const census2 = core.startCensus(c, { frameId: made.frameId, template });
  for (let i = 0; i < plan.trees.length; i += CHUNK) {
    const end = Math.min(plan.trees.length, i + CHUNK);
    withTransaction(() => writeCensus2(c, census2, plan, i, end, ids, end === plan.trees.length, ams));
    progress('第 2 回合', end, plan.trees.length);
    await yieldUi();
  }
  out.push({ label: '建立第 2 回合（西半部）', ms: Date.now() - t1 });
  return out;
}

/** One timed step. A step that fails is reported as such and the run goes on (1E: a backup ran out of memory at 50 000 trees). */
const time = async (label: string, fn: () => unknown | Promise<unknown>, detail?: (r: unknown) => string): Promise<BenchLine> => {
  const t = Date.now();
  try {
    const r = await fn();
    return { label, ms: Date.now() - t, ...(detail ? { detail: detail(r) } : {}) };
  } catch (e) {
    return { label, ms: Date.now() - t, detail: `失敗：${errText(e).slice(0, 200)}` };
  }
};

/** Time what a census of this size costs. Writes a little (one tree, versions) into the test plot only. */
export async function runBench(size: StressSize, progress: Progress): Promise<BenchLine[]> {
  const plot = stressPlot(size);
  if (!plot?.census2) throw new Error('先建立測試樣區');
  const id = plot.census2;
  const c = ctx();
  const out: BenchLine[] = [];
  const counts = rows<{ t: number; s: number; m: number }>(
    `SELECT (SELECT COUNT(*) FROM fw_individuals WHERE frame_id = ?) AS t, (SELECT COUNT(*) FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.frame_id = ?) AS s,
            (SELECT COUNT(*) FROM fw_stem_measures m JOIN fw_surveys sv ON sv.id = m.survey_id WHERE sv.frame_id = ?) AS m`,
    [plot.frameId, plot.frameId, plot.frameId],
  )[0];
  out.push({ label: '資料量', ms: null, detail: `${counts.t} 株、${counts.s} 分支、${counts.m} 筆量測` });
  // The same JS work on every device (Node 25 on the development Mac: 125–140 ms), to compare the lines below across devices.
  out.push(
    await time('JS 基準（測試計畫 JSON：deflate＋SHA-256＋解析）', () => {
      const text = JSON.stringify(buildStressPlan('20k').trees);
      const bytes = strToU8(text);
      deflateSync(bytes, { level: 6 });
      sha256(bytes);
      JSON.parse(text);
      return bytes.length;
    }, (n) => mb(n as number)),
  );

  progress('回合載入');
  await yieldUi();
  let data: ReturnType<typeof loadCensusData> = null;
  out.push(await time('回合載入（全回合總覽）', () => (data = loadCensusData(id))));
  const densest = rows<{ q: string; n: number }>(`SELECT quadrat_code AS q, COUNT(*) AS n FROM fw_individuals WHERE frame_id = ? AND x_m < ? GROUP BY quadrat_code ORDER BY n DESC LIMIT 1`, [
    plot.frameId,
    STRESS_SIZES[size].xM / 2,
  ])[0];
  out.push(await time(`換樣方（最密的 ${densest.q}，${densest.n} 株）`, () => loadQuadratRows(data!, densest.q)));

  progress('單株存檔');
  await yieldUi();
  const tree = rows<{ id: number }>(`SELECT id FROM fw_individuals WHERE frame_id = ? AND quadrat_code = ? LIMIT 1`, [plot.frameId, densest.q])[0];
  const view = core.loadTree(c, id, tree.id)!;
  out.push(await time('復原檢查點（一個樣方）', () => checkpointQuadrats(id, [densest.q])));
  out.push(
    await time('單株存檔', () =>
      withTransaction(() =>
        core.saveTreeDraft(c, id, {
          individualId: tree.id,
          tag: null,
          taxon: null,
          location: null,
          notes: 'stress',
          heightM: null,
          treeCodes: [],
          mainStemNo: view.stems[0].stem.stem_no,
          stems: view.stems.map((s) => ({ stemNo: s.stem.stem_no, dbhCm: (s.measure?.dbh_cm ?? 5) + 0.1, pomM: 1.3, stemDead: false, codes: [], notes: null })),
          recordedBy: 'stress',
        }),
      ),
    ),
  );
  const rowId = quadratRowId(id, densest.q);
  if (rowId != null) out.push(await time('樣方版本', () => saveVersion('survey_quadrat', rowId, 'manual')));

  progress('檢查清單');
  await yieldUi();
  out.push(
    await time('檢查清單（篩檢＋極端生長）', () => {
      const trees = core.loadCensus(c, id);
      const d = data!;
      return screening(trees, { surveyId: id, firstCensus: false, thresholdCm: d.frame.dbh_min_cm, geometry: d.geometry }).length + extremeWorklist(trees, { pct: 0.05, min: 3, geometry: d.geometry }).length;
    }, (n) => `${n} 項`),
  );

  progress('同步區塊');
  await yieldUi();
  const frame = core.getFrame(c, plot.frameId)!;
  const { cols, rows: rr } = fgQuadratCounts(core.frameGeometry(frame));
  const k = core.getSurvey(c, id)!.sync_block_quadrats ?? blockSizeOptions(id).find((o) => o.recommended)!.edge;
  withTransaction(() => cs.setBlockSize(c, id, k));
  const key = randomBytes(32);
  let maxBytes = 0;
  let maxStems = 0;
  let maxRaw = 0;
  let total = 0;
  let worst = '';
  const blocks = cs.allBlocks(cols, rr, k);
  const tb = Date.now();
  for (const [i, b] of blocks.entries()) {
    const doc = cs.buildBlockDoc(c, id, b);
    // With a merge base as large as the rows: what a teammate's copy brings (the worst case).
    const text = JSON.stringify({ ...doc, sync: { exported_at: Date.now(), base: baseOf(cs.blockSide(doc.slice)) } });
    const raw = sealRecord(key, randomBytes(NONCE_BYTES), text, aadFor('t'.repeat(32), 'r'.repeat(43), 'd'.repeat(43)));
    const sealed = b64u(raw);
    total += sealed.length;
    if (sealed.length > maxBytes) {
      maxBytes = sealed.length;
      maxRaw = raw.length;
      maxStems = doc.slice.stems.length;
      worst = b;
    }
    if (i % 5 === 0) {
      progress('同步區塊', i + 1, blocks.length);
      await yieldUi();
    }
  }
  out.push({ label: `建立全部同步區塊（k = ${k}，${blocks.length} 塊）`, ms: Date.now() - tb, detail: `合計 ${mb(total)}；最大 ${mb(maxBytes)}（${worst}，${maxStems} 分支，每分支 ${maxStems ? Math.round(maxRaw / maxStems) : 0} B 未計 base64）` });
  const worstDoc = cs.buildBlockDoc(c, id, worst);
  out.push(await time(`合併一個區塊（${worst}，與自己相同）`, () => mergeBlockQuietly(id, { ...worstDoc, sync: { base: [] } }, null).kind, (r) => String(r)));

  // In a function of its own: the export, the zip and the copy are freed before the backup is timed.
  out.push(...(await exportAndImport(size, id, progress)));

  progress('備份');
  await yieldUi();
  const before = heapMb();
  let backupUri = '';
  out.push(
    await time('完整備份（VACUUM INTO＋讀檔＋zip）', async () => (backupUri = (await createBackup()).uri), () => {
      let size = '';
      try {
        size = mb(new File(backupUri).size ?? 0);
      } catch {
        // gone
      }
      const after = heapMb();
      return `${size}；JS heap ${before ?? '?'} → ${after ?? '?'} MB`;
    }),
  );
  try {
    new File(backupUri).delete();
  } catch {
    // left in the cache
  }

  progress('啟動清孤兒列');
  await yieldUi();
  out.push(await time('啟動清孤兒列（purgeOrphanRows）', () => purgeOrphanRows()));
  const dbBytes = rows<{ n: number }>(`SELECT p.page_count * s.page_size AS n FROM pragma_page_count() p, pragma_page_size() s`)[0]?.n ?? 0;
  out.push({ label: '資料庫大小', ms: null, detail: mb(dbBytes) });
  return out;
}

/**
 * The export and import steps one by one on the census's document (a few
 * minutes): which part of a slow export or import is slow on this device.
 */
export async function runBreakdown(size: StressSize, progress: Progress): Promise<BenchLine[]> {
  const plot = stressPlot(size);
  if (!plot?.census2) throw new Error('先建立測試樣區');
  const c = ctx();
  const out: BenchLine[] = [
    { label: '文字編碼', ms: null, detail: `TextEncoder ${typeof TextEncoder === 'undefined' ? '無' : '有'}、TextDecoder ${typeof TextDecoder === 'undefined' ? '無' : '有'}` },
  ];
  const step = async <T>(label: string, fn: () => T, detail?: (r: T) => string): Promise<T> => {
    progress(label);
    await yieldUi();
    const t = Date.now();
    const r = fn();
    out.push({ label, ms: Date.now() - t, ...(detail ? { detail: detail(r) } : {}) });
    return r;
  };
  const doc = await step('文件（兩回合）', () => buildCensusExport(c, plot.census2!));
  const text = await step('文件 → JSON 文字', () => censusExportText(doc), (r) => mb(r.length));
  const bytes = await step('文字 → 位元組（strToU8）', () => strToU8(text));
  await step('SHA-256', () => sha256(bytes));
  const zip = await step('zip（deflate 6）', () => zipSync({ 'census.yml': bytes }, { level: 6 }), (r) => mb(r.length));
  {
    progress('zip 分段');
    await yieldUi();
    const t = Date.now();
    const pieces = await zipInPieces([{ name: 'census.yml', bytes }], { level: 6 });
    out.push({ label: 'zip 分段（zipInPieces，匯出用）', ms: Date.now() - t, detail: mb(pieces.length) });
  }
  const files = await step('解壓（unzipSync）', () => unzipSync(zip));
  const back = await step('位元組 → 文字（strFromU8）', () => strFromU8(files['census.yml']));
  if (typeof TextDecoder !== 'undefined') await step('位元組 → 文字（TextDecoder）', () => new TextDecoder().decode(files['census.yml']));
  await step('位元組 → 文字（decodeUtf8，匯入用）', () => decodeUtf8(files['census.yml']), (r) => (r === back ? '與 strFromU8 相同' : '與 strFromU8 不同'));
  const parsed = await step('JSON.parse', () => JSON.parse(back) as unknown);
  await step('列表還原（censusExportFromFile）', () => censusExportFromFile(parsed));
  return out;
}

/** Export the census, read it back, import it as another plot, delete that plot (the app's paths). */
async function exportAndImport(size: StressSize, id: number, progress: Progress): Promise<BenchLine[]> {
  const c = ctx();
  const out: BenchLine[] = [];
  progress('匯出');
  await yieldUi();
  const opts = { includePhotos: false, onProgress: () => {} } as unknown as BundleOptions;
  let built: Awaited<ReturnType<typeof buildCensusBundleEntries>> | null = null;
  out.push(
    await time('匯出檔內容（yml＋CSV）', async () => (built = await buildCensusBundleEntries(id, opts)), () => mb(built!.entries.reduce((a, e) => a + e.bytes.length, 0))),
  );
  let zipUri = '';
  out.push(
    await time('匯出 zip（含簽章）', async () => (zipUri = (await bundleCensus(id, opts)).uri), () => {
      try {
        return mb(new File(zipUri).size ?? 0);
      } catch {
        return '';
      }
    }),
  );
  const zipBytes = await new File(zipUri).bytes();
  try {
    new File(zipUri).delete();
  } catch {
    // left in the cache: cleared with it
  }

  progress('匯入');
  await yieldUi();
  let doc: CensusExportDoc | null = null;
  out.push(
    await time('匯入：讀檔（zip → 文件 → 比對）', () => {
      const read = readRecordImportFromBytes(zipBytes);
      if (read.kind !== 'survey') throw new Error(`not a census: ${read.kind}`);
      doc = read.census;
      return planCensusImport(c, doc).censuses.length;
    }),
  );
  // As a teammate's phone gets it: the same plot under other uuids (first 8 hex digits flipped — never
  // the original) and another code.
  const copy = JSON.parse(
    JSON.stringify(doc).replace(/\b[0-9a-f]{8}(?=-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/g, (h) =>
      [...h].map((d) => (15 - parseInt(d, 16)).toString(16)).join(''),
    ),
  ) as CensusExportDoc;
  copy.frame.code = copyCode(size);
  out.push(
    await time('匯入：建立新樣區（全部回合）', () => withTransaction(() => importCensusDoc(c, copy, 'skip').created.length), (n) => `${String(n)} 回合`),
  );
  const copied = plotByCode(copyCode(size));
  if (copied) keepUuids(copied.frameId);
  progress('刪除');
  await yieldUi();
  out.push(
    await time('刪除：兩回合（含「最近刪除」版本）', () => deleteCensuses([copied?.census2, copied?.census1].filter((x): x is number => x != null))),
  );
  removeLeftovers(copyCode(size));
  return out;
}

/** Remove the test plot and what the test left (versions, sync state, the import copy), without keeping it for 最近刪除. */
export async function deleteStressData(size: StressSize, progress: Progress): Promise<void> {
  for (const code of [copyCode(size), STRESS_SIZES[size].code]) {
    const plot = plotByCode(code);
    if (!plot) continue;
    const c = ctx();
    for (const s of rows<{ id: number }>(`SELECT id FROM fw_surveys WHERE frame_id = ? ORDER BY census_no DESC`, [plot.frameId])) {
      progress('刪除回合');
      await yieldUi();
      withTransaction(() => {
        keepUuids(plot.frameId);
        core.deleteCensus(c, s.id);
      });
    }
    removeLeftovers(code);
  }
}

/** Uuids of a plot's censuses and quadrats, kept until removeLeftovers (their rows are gone by then). */
const leftUuids = new Map<number, string[]>();
function keepUuids(frameId: number): void {
  const now = rows<{ uuid: string }>(
    `SELECT uuid FROM fw_surveys WHERE frame_id = ? UNION ALL SELECT q.uuid FROM fw_survey_quadrats q JOIN fw_surveys s ON s.id = q.survey_id WHERE s.frame_id = ?`,
    [frameId, frameId],
  ).map((r) => r.uuid);
  leftUuids.set(frameId, [...new Set([...(leftUuids.get(frameId) ?? []), ...now])]);
}

/** A test plot whose censuses are gone: its frame, and the versions and sync state its censuses left. */
function removeLeftovers(code: string): void {
  const plot = plotByCode(code);
  if (!plot) return;
  const uuids = leftUuids.get(plot.frameId) ?? [];
  withTransaction(() => {
    const db = getUserDb();
    for (const u of uuids) {
      db.executeSync(`DELETE FROM record_versions WHERE record_uuid = ?`, [u]);
      db.executeSync(`DELETE FROM sync_base WHERE record_kind = 'survey' AND record_uuid = ?`, [u]);
    }
    core.deleteFrame(ctx(), plot.frameId);
  });
  leftUuids.delete(plot.frameId);
}
