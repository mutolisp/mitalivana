#!/usr/bin/env node
/**
 * Guard the split map's pure helpers.
 *
 *   1. alongTrackSegments (src/lib/alongTrack.ts): track length, stretch
 *      boundaries, which stretch a record falls on, records off the track or
 *      without a position, a pause in the middle of the walk, the default
 *      stretch length.
 *   2. splitMap (src/lib/splitMap.ts): ratio clamping, the divider's preset
 *      cycle, and reading a stored setting that is partial or corrupt.
 *
 * Usage: npm run check:along-track   (exit 1 on violation)
 */
const { alongTrackSegments, stretchLengthFor } = await import('../src/lib/alongTrack.ts');
const { SPLIT_PRESETS, clampRatio, layoutFor, nextPreset, parseSplitMap } = await import('../src/lib/splitMap.ts');
const { withLiveSegment } = await import('../src/lib/track.ts');

const errors = [];
const near = (label, got, want, tol) => {
  if (!(Math.abs(got - want) <= tol)) errors.push(`${label}: got ${got}, want ${want} ± ${tol}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) errors.push(`${label}: got ${a}, want ${b}`);
};

// A straight walk due north along lng 121.5 from lat 25.0, `m` metres long.
const LAT0 = 25.0;
const LNG0 = 121.5;
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;
const north = (m) => LAT0 + m / M_PER_DEG_LAT;
const east = (m) => LNG0 + m / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180));
const line = (fromM, toM, step = 50) => {
  const pts = [];
  for (let m = fromM; m <= toM + 1e-9; m += step) pts.push([LNG0, north(m)]);
  return pts;
};

// 1 km, cut every 250 m.
{
  const r = alongTrackSegments([line(0, 1000)], [
    { id: 1, lat: north(100), lng: east(10) },
    { id: 2, lat: north(600), lng: LNG0 },
    { id: 3, lat: north(999), lng: LNG0 },
    { id: 4, lat: north(500), lng: east(500) },
    { id: 5, lat: null, lng: null },
  ], 250);
  near('1 km total', r.totalM, 1000, 0.5);
  eq('1 km stretches', r.stretches.map((s) => [s.index, Math.round(s.fromM), Math.round(s.toM)]), [
    [0, 0, 250],
    [1, 250, 500],
    [2, 500, 750],
    [3, 750, 1000],
  ]);
  eq('record 10 m off the track', r.stretchOf.get(1), 0);
  near('record 10 m off the track, along', r.alongM.get(1), 100, 0.5);
  eq('record at 600 m', r.stretchOf.get(2), 2);
  eq('record at the far end', r.stretchOf.get(3), 3);
  eq('record 500 m off the track', r.stretchOf.has(4), false);
  eq('record without a position', r.stretchOf.has(5), false);
  // Every stretch is drawable and starts where the previous one ended.
  for (const s of r.stretches) {
    if (s.parts.length !== 1 || s.parts[0].length < 2) errors.push(`stretch ${s.index}: ${s.parts.length} part(s)`);
  }
  near('stretch 1 starts at 250 m', r.stretches[1]?.parts[0]?.[0]?.[1] ?? NaN, north(250), 1e-7);
  near('stretch 0 ends at 250 m', r.stretches[0]?.parts[0]?.at(-1)?.[1] ?? NaN, north(250), 1e-7);
}

// Paused at 400 m, resumed 200 m further on: the jump is not walked.
{
  const r = alongTrackSegments([line(0, 400), line(600, 1000)], [{ id: 1, lat: north(800), lng: LNG0 }], 250);
  near('paused walk total', r.totalM, 800, 0.5);
  eq('paused walk stretch count', r.stretches.length, 4);
  near('record after the pause, along', r.alongM.get(1), 600, 0.5);
  eq('record after the pause, stretch', r.stretchOf.get(1), 2);
  eq('stretch across the pause has two parts', r.stretches[1]?.parts.length, 2);
  near('second part starts where the walk resumed', r.stretches[1]?.parts[1]?.[0]?.[1] ?? NaN, north(600), 1e-7);
}

// Defaults and edge cases.
eq('default stretch, 1 km', stretchLengthFor(1000), 200);
eq('default stretch, 1.62 km', stretchLengthFor(1620), 250);
eq('default stretch, 150 m', stretchLengthFor(150), 50);
eq('default used when none given', alongTrackSegments([line(0, 1000)], []).stretchM, 200);
eq('no track', alongTrackSegments([], [{ id: 1, lat: LAT0, lng: LNG0 }]).stretches.length, 0);
eq('one point only', alongTrackSegments([[[LNG0, LAT0]]], []).stretches.length, 0);

// Saved track + live points (the recorder saves the segment in progress every minute).
{
  const A = [[121.5, 25.0], [121.5, 25.001]];
  const B1 = [[121.6, 25.1], [121.6, 25.101]];
  const B = [...B1, [121.6, 25.102], [121.6, 25.103]];
  eq('live before any save', withLiveSegment([A], B), [A, B]);
  eq('live after a save replaces the saved copy', withLiveSegment([A, B1], B), [A, B]);
  eq('nothing live', withLiveSegment([A], []), [A]);
  eq('first segment, saved', withLiveSegment([B1], B), [B]);
  eq('a saved segment longer than the live one is another segment', withLiveSegment([B], B1), [B, B1]);
}

// Split layout.
eq('clamp low', clampRatio(0.1), 0.36);
eq('clamp high', clampRatio(0.9), 0.67);
eq('clamp NaN', clampRatio(Number.NaN), SPLIT_PRESETS[0]);
eq('preset cycle from 1st', nextPreset(SPLIT_PRESETS[0]), SPLIT_PRESETS[1]);
eq('preset cycle wraps', nextPreset(SPLIT_PRESETS[2]), SPLIT_PRESETS[0]);
eq('preset after a dragged width', nextPreset(0.4), SPLIT_PRESETS[2]);
eq('parse empty', parseSplitMap(null), {});
eq('parse corrupt', parseSplitMap('{oops'), {});
eq(
  'parse partial',
  parseSplitMap(JSON.stringify({ vol: { ratio: 0.9, open: { plot: true, map: true } }, pro: 'x' })),
  { vol: { ratio: 0.67, collapsed: false, open: { plot: true } } },
);
eq('layout default', layoutFor({}, 'pro'), { ratio: SPLIT_PRESETS[0], collapsed: false, open: {} });

if (errors.length) {
  console.error(`✗ along-track: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log('✓ along-track: stretches, record placement, pauses, defaults; split layout parsing');
