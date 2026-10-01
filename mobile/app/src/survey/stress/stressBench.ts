/**
 * The 1E stress test on a device (app/survey/stress.tsx, development builds
 * only): build the test plot of stressCore.ts through the app's own save path,
 * then time what a census of that size costs — loading, saving, versions,
 * checks, sync blocks, export, backup, start-up clean-up — so the numbers come
 * from real hardware (an emulator can be several times faster than a phone).
 */
import { File } from 'expo-file-system';
import yaml from 'js-yaml';
import { purgeOrphanRows } from '~/db/cleanup';
import { getUserDb, withTransaction } from '~/db/init';
import { saveVersion } from '~/db/recordVersions';
import { generateUuid } from '~/db/uuid';
import { createBackup } from '~/lib/backup';
import { buildCensusBundleEntries, bundleCensus, type BundleOptions } from '~/lib/bundleExport';
import { baseOf } from '~/lib/mergeEngine';
import { aadFor, b64u, NONCE_BYTES, sealRecord } from '~/lib/teamCrypto';
import { randomBytes } from '~/lib/teamSync';
import { mergeBlockQuietly } from '../censusSync';
import { planCensusImport, type CensusExportDoc } from '../db/censusExportCore';
import { quadratRowId } from '../db/censusVersions';
import * as cs from '../db/censusSyncCore';
import * as core from '../db/stemmapCore';
import { STEMMAP_TEMPLATE } from '../templates/stemmap';
import { checkpointQuadrats } from '../undo';
import { extremeWorklist, screening } from '../stemmap/review';
import { chooseSyncBlock } from '../stemmap/syncBlocks';
import { fgQuadratCounts } from '../stemmap/coords';
import { loadCensusData, loadQuadratRows } from '../useCensus';
import { buildStressPlan, createStressPlot, STRESS_SIZES, writeCensus1, writeCensus2, type StressSize } from './stressCore';

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

/** The stress plot here, if built: its frame and censuses. */
export function stressPlot(size: StressSize): { frameId: number; census1: number | null; census2: number | null } | null {
  const f = rows<{ id: number }>(`SELECT id FROM fw_frames WHERE code = ?`, [STRESS_SIZES[size].code])[0];
  if (!f) return null;
  const cs2 = rows<{ id: number; census_no: number }>(`SELECT id, census_no FROM fw_surveys WHERE frame_id = ? ORDER BY census_no`, [f.id]);
  return { frameId: f.id, census1: cs2.find((c) => c.census_no === 1)?.id ?? null, census2: cs2.find((c) => c.census_no === 2)?.id ?? null };
}

/** Build the test plot (≈ 1–5 minutes on a phone). */
export async function buildStressData(size: StressSize, progress: Progress): Promise<BenchLine[]> {
  const out: BenchLine[] = [];
  const plan = buildStressPlan(size);
  const c = ctx();
  const t0 = Date.now();
  const made = withTransaction(() => createStressPlot(c, size, STEMMAP_TEMPLATE));
  const ids = new Map<string, number>();
  const CHUNK = 250;
  for (let i = 0; i < plan.trees.length; i += CHUNK) {
    withTransaction(() => writeCensus1(c, made.census1, plan, i, Math.min(plan.trees.length, i + CHUNK), ids));
    progress('第 1 回合', Math.min(plan.trees.length, i + CHUNK), plan.trees.length);
    await yieldUi();
  }
  core.finishCensus(c, made.census1);
  const t1 = Date.now();
  out.push({ label: '建立第 1 回合', ms: t1 - t0, detail: `${plan.trees.length} 株，每株 ${((t1 - t0) / plan.trees.length).toFixed(2)} ms` });
  const census2 = core.startCensus(c, { frameId: made.frameId, template: STEMMAP_TEMPLATE });
  for (let i = 0; i < plan.trees.length; i += CHUNK) {
    const end = Math.min(plan.trees.length, i + CHUNK);
    withTransaction(() => writeCensus2(c, census2, plan, i, end, ids, end === plan.trees.length));
    progress('第 2 回合', end, plan.trees.length);
    await yieldUi();
  }
  out.push({ label: '建立第 2 回合（西半部）', ms: Date.now() - t1 });
  return out;
}

const time = async (label: string, fn: () => unknown | Promise<unknown>, detail?: (r: unknown) => string): Promise<BenchLine> => {
  const t = Date.now();
  const r = await fn();
  return { label, ms: Date.now() - t, ...(detail ? { detail: detail(r) } : {}) };
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
  const k = core.getSurvey(c, id)!.sync_block_quadrats ?? chooseSyncBlock({ quadratsX: cols, quadratsY: rr, quadratM: frame.quadrat_m, stemsPerHa: 2000, bytesPerStem: 130 }).edgeQuadrats;
  withTransaction(() => cs.setBlockSize(c, id, k));
  const key = randomBytes(32);
  let maxBytes = 0;
  let maxStems = 0;
  let total = 0;
  let worst = '';
  const blocks = cs.allBlocks(cols, rr, k);
  const tb = Date.now();
  for (const [i, b] of blocks.entries()) {
    const doc = cs.buildBlockDoc(c, id, b);
    // With a merge base as large as the rows: what a teammate's copy brings (the worst case).
    const text = JSON.stringify({ ...doc, sync: { exported_at: Date.now(), base: baseOf(cs.blockSide(doc.slice)) } });
    const sealed = b64u(sealRecord(key, randomBytes(NONCE_BYTES), text, aadFor('t'.repeat(32), 'r'.repeat(43), 'd'.repeat(43))));
    total += sealed.length;
    if (sealed.length > maxBytes) {
      maxBytes = sealed.length;
      maxStems = doc.slice.stems.length;
      worst = b;
    }
    if (i % 5 === 0) {
      progress('同步區塊', i + 1, blocks.length);
      await yieldUi();
    }
  }
  out.push({ label: `建立全部同步區塊（k = ${k}，${blocks.length} 塊）`, ms: Date.now() - tb, detail: `合計 ${mb(total)}；最大 ${mb(maxBytes)}（${worst}，${maxStems} 分支，每分支 ${maxStems ? Math.round(maxBytes / maxStems) : 0} B）` });
  const worstDoc = cs.buildBlockDoc(c, id, worst);
  out.push(await time(`合併一個區塊（${worst}，與自己相同）`, () => mergeBlockQuietly(id, { ...worstDoc, sync: { base: [] } }, null).kind, (r) => String(r)));

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
  const ymlEntry = built!.entries.find((e) => e.name.endsWith('.yml'))!;
  out.push(
    await time('匯入解析（yml → 文件 → 比對）', () => {
      const doc = yaml.load(new TextDecoder().decode(ymlEntry.bytes)) as CensusExportDoc;
      return planCensusImport(c, doc).censuses.length;
    }),
  );
  try {
    new File(zipUri).delete();
  } catch {
    // left in the cache: cleared with it
  }

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
  const pages = rows<{ n: number }>(`PRAGMA page_count`)[0]?.n ?? 0;
  const pageSize = rows<{ n: number }>(`PRAGMA page_size`)[0]?.n ?? 0;
  out.push({ label: '資料庫大小', ms: null, detail: mb(pages * pageSize) });
  return out;
}

/** Remove the test plot and what the test left (versions, sync state), without keeping it for 最近刪除. */
export async function deleteStressData(size: StressSize, progress: Progress): Promise<void> {
  const plot = stressPlot(size);
  if (!plot) return;
  const c = ctx();
  const censuses = rows<{ id: number; uuid: string }>(`SELECT id, uuid FROM fw_surveys WHERE frame_id = ? ORDER BY census_no DESC`, [plot.frameId]);
  const quadratUuids = rows<{ uuid: string }>(
    `SELECT q.uuid FROM fw_survey_quadrats q JOIN fw_surveys s ON s.id = q.survey_id WHERE s.frame_id = ?`,
    [plot.frameId],
  ).map((r) => r.uuid);
  for (const s of censuses) {
    progress('刪除回合');
    await yieldUi();
    withTransaction(() => core.deleteCensus(c, s.id));
  }
  withTransaction(() => {
    core.deleteFrame(c, plot.frameId);
    const db = getUserDb();
    for (const u of [...quadratUuids, ...censuses.map((s) => s.uuid)]) db.executeSync(`DELETE FROM record_versions WHERE record_uuid = ?`, [u]);
    for (const s of censuses) db.executeSync(`DELETE FROM sync_base WHERE record_kind = 'survey' AND record_uuid = ?`, [s.uuid]);
  });
}
