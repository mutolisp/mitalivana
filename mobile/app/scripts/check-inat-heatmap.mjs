/**
 * Fixture check for src/lib/inatHeatmap.ts — the iNaturalist observation-grid
 * overlay's pure half. No network, no Expo; same contract as
 * check-inat-payload.mjs. Run: npm run check:inat-heatmap
 *
 * 兩件事值得用測試釘住：
 *  1. 「野外 0 筆但總數 > 0 就改畫全部」——這是刻意的產品決策（只有栽培紀錄的
 *     物種套 captive=false 會得到全空的圖，看起來像功能壞掉），不是巧合。
 *  2. `{z}/{x}/{y}` 必須原樣留在字串裡。那是給 UrlTile / RasterSource 的樣板，
 *     任何一次「順手」把它格式化掉，圖層就被寫死在一格上而且不會報錯。
 */
import {
  INAT_CACHE_TTL_MS,
  gridTileUrl,
  isInatCacheStale,
  pickHeatmapMode,
} from '../src/lib/inatHeatmap.ts';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};
const ok = (label, cond) => {
  if (!cond) fail(label);
};

// ── pickHeatmapMode ────────────────────────────────────────────────────────
{
  // 臺灣冷杉的實測數字：野外 1,062 / 全部 1,076
  eq('wild observations win', pickHeatmapMode(1062, 1076), 'wild');
  eq('single wild observation still wild', pickHeatmapMode(1, 9999), 'wild');
  // 使用者指定的退路：只有圈養／栽培時仍然要畫，而不是給一張空圖
  eq('captive-only falls back to all', pickHeatmapMode(0, 122), 'all');
  eq('nothing at all', pickHeatmapMode(0, 0), 'none');
  // obsTotal 在野外有資料時根本不會被問，呼叫端傳 0 進來不可以改變答案
  eq('unknown total is ignored when wild > 0', pickHeatmapMode(53, 0), 'wild');
}

// ── gridTileUrl ────────────────────────────────────────────────────────────
{
  const wild = gridTileUrl(120846, 'wild');
  const all = gridTileUrl(120846, 'all');

  ok('wild keeps the {z}/{x}/{y} template verbatim', wild.includes('/{z}/{x}/{y}.png'));
  ok('all keeps the {z}/{x}/{y} template verbatim', all.includes('/{z}/{x}/{y}.png'));
  ok('no placeholder was substituted', !/\/\d+\/\d+\/\d+\.png/.test(wild));

  ok('wild excludes captive', wild.includes('captive=false'));
  ok('all does not exclude captive', !all.includes('captive'));
  ok('taxon id is carried', wild.includes('taxon_id=120846'));
  ok('grid style, not heatmap', wild.includes('/v1/grid/') && !wild.includes('/heatmap/'));

  eq('none draws nothing', gridTileUrl(120846, 'none'), null);
  // 壞掉的 id 不可以變成一個會打到 iNat 的 URL
  eq('zero id', gridTileUrl(0, 'wild'), null);
  eq('negative id', gridTileUrl(-5, 'wild'), null);
  eq('non-integer id', gridTileUrl(1.5, 'wild'), null);
  eq('NaN id', gridTileUrl(Number.NaN, 'wild'), null);
}

// ── 快取新鮮度 ─────────────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 8, 20);
  ok('just checked is fresh', !isInatCacheStale(now - 1000, now));
  ok('one day old is fresh', !isInatCacheStale(now - 24 * 3600 * 1000, now));
  ok('past the TTL is stale', isInatCacheStale(now - INAT_CACHE_TTL_MS - 1, now));
  // 沒有 checked_at 的列（理論上不該存在）必須當成過期，而不是永遠新鮮
  ok('missing timestamp is stale', isInatCacheStale(Number.NaN, now));
}

if (failures > 0) {
  console.error(`\ncheck-inat-heatmap: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-inat-heatmap: ok');
