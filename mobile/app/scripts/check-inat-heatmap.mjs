/**
 * Fixture check for src/lib/inatHeatmap.ts — the iNaturalist observation-grid
 * overlay's pure half. No network, no Expo; same contract as
 * check-inat-payload.mjs. Run: npm run check:inat-heatmap
 *
 * Two things are worth pinning down with a test:
 *  1. "zero wild but a non-zero total means draw everything" — a deliberate
 *     product decision (a species with only cultivated records would give a
 *     completely empty map under captive=false, which looks like a broken
 *     feature), not a coincidence.
 *  2. `{z}/{x}/{y}` must stay verbatim in the string. It is a template for
 *     UrlTile / RasterSource, and any one "tidying" substitution pins the layer
 *     to a single tile without raising an error.
 */
import {
  INAT_CACHE_TTL_MS,
  gridPrecisionOffset,
  gridTileUrl,
  isInatCacheStale,
  pickHeatmapMode,
  tileZoomForRegion,
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

// ── grid cell size ─────────────────────────────────────────────────────────
{
  // Web mercator by definition: the whole world across a 256 pt viewport is z0,
  // and every halving of the visible span is one level.
  eq('whole world on a 256 pt canvas', tileZoomForRegion(360, 256), 0);
  eq('half the world', tileZoomForRegion(180, 256), 1);
  // A 390 pt phone screen spanning 4.5° (the app's default map view) — the
  // whole of Taiwan, just under z7.
  ok('default view is just under z7', Math.abs(tileZoomForRegion(4.5, 390) - 6.93) < 0.02);
  // A 184 px mini-map showing the same span is a LOWER zoom than a full screen.
  ok(
    'the mini-map reads lower than the full screen',
    tileZoomForRegion(0.02, 184) < tileZoomForRegion(0.02, 390),
  );
  eq('a collapsed region cannot divide by zero', tileZoomForRegion(0, 390), 0);

  // Two buckets only: the offset is part of the tile URL, so every change
  // throws the loaded tiles away.
  eq('island-wide stays fine', gridPrecisionOffset(6), 0);
  eq('just below the threshold', gridPrecisionOffset(10.9), 0);
  eq('one valley coarsens', gridPrecisionOffset(11), 1);
  eq('and stays coarsened', gridPrecisionOffset(16), 1);

  const coarse = gridTileUrl(120846, 'wild', 1);
  ok('coarse tiles carry the offset', coarse.includes('precision_offset=1'));
  ok('coarse tiles keep the template', coarse.includes('/{z}/{x}/{y}.png'));
  // Offset 0 must not appear at all: an extra query parameter is a different
  // CDN cache key for identical tiles.
  ok('offset 0 is left out', !gridTileUrl(120846, 'wild', 0).includes('precision_offset'));
  ok('a fractional offset is ignored', !gridTileUrl(120846, 'wild', 0.5).includes('precision_offset'));
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
