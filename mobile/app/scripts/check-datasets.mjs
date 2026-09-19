#!/usr/bin/env node
/**
 * 名錄模組化的跨模組合併邏輯檢查。
 *
 * 名錄拆成獨立檔之後，「一個答案」常常是兩個模組各查一次再併起來。SQL 那半由
 * `backend/scripts/datasets/verify_datasets.py` 對真實資料驗證（結構／列數／
 * 查詢等價）；**併起來那半**是純 JS，就在這裡驗。
 *
 * 之所以能在 Node 跑，是因為 `src/db/mergeScope.ts` 刻意不相依任何原生模組
 * （`taxonomy.ts` / `regions.ts` 會連帶載入 op-sqlite 與 expo-file-system，在
 * Node 載不起來）。要加新的合併規則，就把它放進那個檔，然後在這裡補測試。
 *
 * Usage: npm run check:datasets   (exit 1 on violation)
 */
import { mergeScopeNodes, stitchCrossRegion } from '../src/db/mergeScope.ts';
import {
  datasetNeedsUpdate,
  parseDatasetManifest,
  spaceNeededFor,
  unmetRequirements,
} from '../src/lib/datasetManifest.ts';

let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const node = (name, stats, name_c = '') => ({
  name,
  name_c,
  rank: 'phylum',
  rank_key: 'phylum',
  child_rank: 'class',
  stats: { ...stats },
  ancestors: {},
});

console.log('\n[mergeScopeNodes] 兩個名錄模組的同一層節點');
{
  const tw = [node('Tracheophyta', { class: 5, species: 100 }, '維管束植物')];
  const jp = [node('Tracheophyta', { class: 4, species: 80 }), node('Bryophyta', { class: 2, species: 30 })];
  const merged = mergeScopeNodes(tw, jp);

  ok(merged.length === 2, '同名合併成一筆、模組專有的另成一筆', `得到 ${merged.length} 筆`);
  const t = merged.find((n) => n.name === 'Tracheophyta');
  ok(t.stats.class === 9 && t.stats.species === 180, '統計相加', JSON.stringify(t.stats));
  ok(t.name_c === '維管束植物', '中文名以先進來的（TaiCOL）為準', t.name_c);
  ok(
    merged.map((n) => n.name).join(',') === 'Bryophyta,Tracheophyta',
    '合併後仍依 name 排序（與 SQL ORDER BY 一致）',
    merged.map((n) => n.name).join(','),
  );
}
{
  const only = [node('Tracheophyta', { species: 1 })];
  ok(mergeScopeNodes([], only) === only, '累積端為空時原樣回傳（不必複製）');
  ok(mergeScopeNodes(only, []) === only, '新進端為空時原樣回傳');
  // 單一模組（預設只開臺灣）永遠走不到合併，數字必須與拆檔前一致
  const single = mergeScopeNodes([], [node('Animalia', { species: 42 })]);
  ok(single[0].stats.species === 42, '只有一個模組時統計不受任何加工');
}
{
  // 第二個模組帶了第一個沒有的統計欄位（例如它有種下階層而對方沒有）
  const a = [node('X', { species: 3 })];
  const b = [node('X', { species: 2, infraspecific: 7 })];
  const m = mergeScopeNodes(a, b);
  ok(m[0].stats.infraspecific === 7, '對方獨有的統計欄位會被帶進來', JSON.stringify(m[0].stats));
}

console.log('\n[stitchCrossRegion] 跨區俗名的縫合');
{
  const idToNorm = new Map([
    ['t001', 'abies kawakamii'], // 兩區都有
    ['t002', 'quercus glauca'], // 只有臺灣
    ['y900', 'abies kawakamii'], // 日本側同一個學名
    ['t003', 'nothing here'], // 兩區都沒有俗名
  ]);
  const cnames = new Map([
    ['TW', new Map([['abies kawakamii', '臺灣冷杉'], ['quercus glauca', '青剛櫟']])],
    ['JP', new Map([['abies kawakamii', 'タイワンモミ']])],
  ]);
  const out = stitchCrossRegion(idToNorm, cnames);

  ok(out.get('t001').tw === '臺灣冷杉' && out.get('t001').jp === 'タイワンモミ', '共有種兩區俗名都拿到');
  ok(
    out.get('y900').tw === '臺灣冷杉' && out.get('y900').jp === 'タイワンモミ',
    '日本側的 id 走同一個 sci_norm，結果相同',
  );
  const tw2 = out.get('t002');
  ok(tw2.tw === '青剛櫟' && tw2.jp === undefined, '只有一區有俗名時不捏造另一區');
  ok(!out.has('t003'), '兩區都沒俗名的 id 不進結果（等同原本 JOIN 沒有列）');
}
{
  // 只裝一個模組：另一區的 map 根本不存在，不能因此爆掉
  const out = stitchCrossRegion(
    new Map([['t001', 'abies kawakamii']]),
    new Map([['TW', new Map([['abies kawakamii', '臺灣冷杉']])]]),
  );
  ok(out.get('t001').tw === '臺灣冷杉' && out.get('t001').jp === undefined, '缺少另一個模組時安全降級');
  ok(stitchCrossRegion(new Map(), new Map()).size === 0, '空輸入回空 map');
}

console.log('\n[parseDatasetManifest] 向前相容規則');
{
  const KNOWN = ['tw-taicol', 'jp-ylist', 'tw-keys'];
  const entry = (over = {}) => ({
    id: 'tw-taicol',
    region: 'TW',
    version: '2026-08-26',
    title: { 'zh-TW': '臺灣物種名錄 TaiCOL' },
    url: 'https://data.mitalivana.org/checklists/tw-taicol/2026-08-26/tw-taicol.db.zip',
    bytes: 34_000_000,
    uncompressedBytes: 142_000_000,
    md5: 'abc',
    rows: { taicol_names: 269824 },
    requires: [],
    minAppSchema: 1,
    attribution: 'TaiCOL',
    license: 'CC BY 4.0',
    ...over,
  });

  const r1 = parseDatasetManifest(
    { datasets: [entry(), entry({ id: 'xx-future', region: null })] },
    { knownIds: KNOWN, appSchema: 1 },
  );
  ok(r1.entries.length === 1, '不認識的 id 直接略過（manifest 可以先列下一版的模組）');
  ok(r1.needsAppUpdate === false, '不認識的 id 不算「要更新 app」');

  const r2 = parseDatasetManifest(
    { datasets: [entry({ minAppSchema: 2 })] },
    { knownIds: KNOWN, appSchema: 1 },
  );
  ok(r2.entries.length === 0 && r2.needsAppUpdate === true, 'minAppSchema 太新 → 略過並提示更新 app');

  const r3 = parseDatasetManifest(
    { datasets: [entry({ md5: '' }), entry({ id: 'tw-keys', url: '' }), entry({ id: 'jp-ylist', version: '' })] },
    { knownIds: KNOWN, appSchema: 1 },
  );
  ok(r3.entries.length === 0, '缺 md5 / url / version 的條目視為壞資料而略過（驗不了就別下載）');

  ok(parseDatasetManifest(null, { knownIds: KNOWN, appSchema: 1 }).entries.length === 0, 'null 輸入不爆');
  ok(
    parseDatasetManifest({ datasets: 'nope' }, { knownIds: KNOWN, appSchema: 1 }).entries.length === 0,
    'datasets 不是陣列時不爆',
  );
  const r4 = parseDatasetManifest(
    { datasets: [entry({ requires: undefined })] },
    { knownIds: KNOWN, appSchema: 1 },
  );
  ok(Array.isArray(r4.entries[0].requires), '缺 requires 時補成空陣列');
}

console.log('\n[版本 / 相依 / 空間]');
{
  ok(datasetNeedsUpdate(null, '2026-08-26') === false, '沒安裝過不算「要更新」（那是下載）');
  ok(datasetNeedsUpdate('2026-08-26', '2026-08-26') === false, '版本相同不需更新');
  ok(datasetNeedsUpdate('2026-02-24', '2026-08-26') === true, '版本不同就要更新');
  // 版本字串沒有共通排序語意，只比相等；回退版本也該被視為「要換」
  ok(datasetNeedsUpdate('2026-08-26', '2026-02-24') === true, '上游回退版本時也會提示更新');

  const keys = { requires: ['tw-taicol'] };
  ok(unmetRequirements(keys, []).length === 1, '檢索表在名錄沒裝時相依未滿足');
  ok(unmetRequirements(keys, ['tw-taicol']).length === 0, '名錄裝好後相依滿足');
  ok(unmetRequirements({ requires: [] }, []).length === 0, '沒有相依的模組永遠可裝');

  // zip 與解壓後的檔在換檔前會同時存在，兩份都要算
  ok(
    spaceNeededFor({ bytes: 34_000_000, uncompressedBytes: 142_000_000 }, 200_000_000) ===
      376_000_000,
    '空間需求 = 壓縮檔 + 解壓後 + 緩衝',
  );
}

console.log(failed === 0 ? '\n✓ datasets: 跨模組合併與 manifest 規則正確' : `\n✗ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
