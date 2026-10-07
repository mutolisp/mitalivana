#!/usr/bin/env node
/**
 * Guard the split map's pure helpers.
 *
 *   1. alongTrackSegments (src/lib/alongTrack.ts): track length, stretch
 *      boundaries, which stretch a record falls on, records off the track or
 *      without a position, a pause in the middle of the walk, the default
 *      stretch length; a stored distance along the track (v93) winning over
 *      the nearest point on a trail walked out and back, and losing to it
 *      when it no longer fits the track (code review L47).
 *   2. splitMap (src/lib/splitMap.ts): ratio clamping, the divider's preset
 *      cycle, and reading a stored setting that is partial or corrupt.
 *
 * Usage: npm run check:along-track   (exit 1 on violation)
 */
const { alongTrackSegments, stretchLengthFor, trackLengthM } = await import('../src/lib/alongTrack.ts');
const { readFileSync } = await import('node:fs');
const { SPLIT_PRESETS, SPLIT_PRESETS_V, clampRatio, layoutFor, nextPreset, parseSplitMap } = await import(
  '../src/lib/splitMap.ts'
);
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
const ok = (cond, label) => {
  if (!cond) errors.push(label);
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

// The grid search gives what testing every edge gave (code review M37).
{
  const R = 6_371_008.8;
  const rad = (d) => (d * Math.PI) / 180;
  // Brute force, as alongTrackSegments was before the grid: nearest over every edge.
  const brute = (track, recs, maxOffM = 200) => {
    const segs = track.filter((s) => s.length > 0);
    let latSum = 0;
    let n = 0;
    for (const s of segs) for (const p of s) (latSum += p[1]), n++;
    const k = Math.cos(rad(latSum / n));
    const xy = (lng, lat) => [R * rad(lng) * k, R * rad(lat)];
    let total = 0;
    const pts = [];
    const cum = [];
    for (const s of segs) {
      const q = [];
      const c = [];
      for (let i = 0; i < s.length; i++) {
        const p = xy(s[i][0], s[i][1]);
        if (i > 0) total += Math.hypot(p[0] - q[i - 1][0], p[1] - q[i - 1][1]);
        q.push(p);
        c.push(total);
      }
      pts.push(q);
      cum.push(c);
    }
    const out = new Map();
    for (const r of recs) {
      if (r.lat == null || r.lng == null) continue;
      const [px, py] = xy(r.lng, r.lat);
      let best = Infinity;
      let bestAlong = 0;
      pts.forEach((q, si) => {
        const c = cum[si];
        if (q.length === 1) {
          const d = Math.hypot(px - q[0][0], py - q[0][1]);
          if (d < best) (best = d), (bestAlong = c[0]);
          return;
        }
        for (let i = 1; i < q.length; i++) {
          const [ax, ay] = q[i - 1];
          const [bx, by] = q[i];
          const dx = bx - ax;
          const dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
          if (d < best) (best = d), (bestAlong = c[i - 1] + t * (c[i] - c[i - 1]));
        }
      });
      if (best <= maxOffM) out.set(r.id, bestAlong);
    }
    return out;
  };
  // A seeded walk: out and back along a trail, a pause, a lone fix, then on.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // A trail: about 5 m a fix, the heading wandering slowly.
  const walk = (n, lng, lat) => {
    const s = [];
    let h = 0.6;
    for (let i = 0; i < n; i++) {
      h += (rnd() - 0.5) * 0.25;
      lng += Math.cos(h) * 0.00005;
      lat += Math.sin(h) * 0.000045;
      s.push([lng, lat]);
    }
    return s;
  };
  const outLeg = walk(1200, 121.5, 24.69);
  const track = [outLeg, [...outLeg].reverse().map(([x, y]) => [x + 0.00003, y]), [[121.6, 24.7]], walk(600, 121.52, 24.7)];
  const recs = [];
  for (let i = 0; i < 1000; i++) {
    const base = track[i % 4][Math.floor(rnd() * track[i % 4].length)];
    const far = i % 10 === 0 ? 0.03 : 0.0006; // one in ten well off the 200 m band
    recs.push({ id: i, lat: base[1] + (rnd() - 0.5) * far, lng: base[0] + (rnd() - 0.5) * far });
  }
  recs.push({ id: 5000, lat: null, lng: null });
  const t0 = performance.now();
  const got = alongTrackSegments(track, recs);
  const ms = performance.now() - t0;
  const want = brute(track, recs);
  let diff = 0;
  for (const r of recs) {
    const a = got.alongM.get(r.id);
    const b = want.get(r.id);
    if ((a == null) !== (b == null) || (a != null && Math.abs(a - b) > 1e-6)) diff++;
  }
  eq('grid: same placement as testing every edge (3000 vertices, 1000 records, out and back)', diff, 0);
  ok(want.size > 300 && want.size < recs.length - 50, `grid: the sample has records on and off the track (${want.size} on)`);
  const t1 = performance.now();
  brute(track, recs);
  const bruteMs = performance.now() - t1;
  ok(ms * 3 < bruteMs, `grid: well under testing every edge (${ms.toFixed(1)} ms vs ${bruteMs.toFixed(1)} ms)`);
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
  { vol: { axis: 'row', ratio: 0.67, ratioV: SPLIT_PRESETS_V[0], collapsed: false, open: { plot: true } } },
);
eq('layout default', layoutFor({}, 'pro'), {
  axis: 'row',
  ratio: SPLIT_PRESETS[0],
  ratioV: SPLIT_PRESETS_V[0],
  collapsed: false,
  open: {},
});
// Map above the list: its own bounds and presets, and its own remembered height.
eq('clamp column low', clampRatio(0.1, 'column'), 0.34);
eq('clamp column high', clampRatio(0.9, 'column'), 0.7);
eq('clamp column NaN', clampRatio(Number.NaN, 'column'), SPLIT_PRESETS_V[0]);
eq('column preset cycle', nextPreset(SPLIT_PRESETS_V[0], 'column'), SPLIT_PRESETS_V[1]);
eq('column preset cycle wraps', nextPreset(SPLIT_PRESETS_V[2], 'column'), SPLIT_PRESETS_V[0]);
eq(
  'parse column',
  parseSplitMap(JSON.stringify({ casual: { axis: 'column', ratio: 0.4, ratioV: 0.2, collapsed: true } })),
  { casual: { axis: 'column', ratio: 0.4, ratioV: 0.34, collapsed: true, open: {} } },
);
eq('parse unknown axis', parseSplitMap(JSON.stringify({ pro: { axis: 'diagonal' } })).pro.axis, 'row');
// A value saved before the column layout existed reads as side by side.
eq('layout from an older save', layoutFor({ pro: { ratio: 0.4, collapsed: true, open: {} } }, 'pro'), {
  axis: 'row',
  ratio: 0.4,
  ratioV: SPLIT_PRESETS_V[0],
  collapsed: true,
  open: {},
});

// Out and back on one trail (code review L47): 1 km north, then back south.
{
  const out = line(0, 1000);
  const back = out.slice(0, -1).reverse();
  const walk = [[...out, ...back]];
  near('out and back total', trackLengthM(walk), 2000, 1);
  near('trackLengthM is the stretches measure', trackLengthM(walk), alongTrackSegments(walk, []).totalM, 1e-6);
  const at300 = { lat: north(300), lng: LNG0 };
  const r = alongTrackSegments(
    walk,
    [
      { id: 1, ...at300 }, // not stamped: the nearest point, the way out
      { id: 2, ...at300, alongM: 1700 }, // stamped on the way back
      { id: 3, ...at300, alongM: 1200 }, // stamped where the track is 500 m away: a track since replaced
      { id: 4, lat: null, lng: null, alongM: 900 }, // no fix, but stamped
      { id: 5, lat: null, lng: null, alongM: 2500 }, // beyond the track
      { id: 6, lat: north(20), lng: LNG0, alongM: 2100 }, // a little past the end (back at the start): the end
    ],
    500,
  );
  near('unstamped: nearest point', r.alongM.get(1), 300, 0.5);
  eq('unstamped: the way out', r.stretchOf.get(1), 0);
  eq('stamped: the way back', [r.alongM.get(2), r.stretchOf.get(2)], [1700, 3]);
  near('stamped off the track: nearest point instead', r.alongM.get(3), 300, 0.5);
  eq('no fix, stamped: its stretch', [r.alongM.get(4), r.stretchOf.get(4)], [900, 1]);
  ok(!r.stretchOf.has(5), 'no fix, stamped beyond the track: no stretch');
  near('stamped just past the end: the end', r.alongM.get(6), r.totalM, 1e-6);
}

// Where the distance is stamped and carried (code review L47; source guards).
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const fix = src('src/lib/recordFix.ts');
  const stamp = fix.slice(fix.indexOf('export function stampNewRecord'));
  ok(
    /const track = tracking && kind !== 'modular' \? liveTrack\(\{ kind, id: parentId \}\) : null;/.test(stamp) &&
      stamp.indexOf('trackLengthM(track)') < stamp.indexOf('await takeFix'),
    'stamp: taken from the live track when the record is entered, before the fix is awaited',
  );
  ok(/WHERE id = \? AND along_m IS NULL/.test(src('src/db/records.ts')) && /WHERE id = \? AND along_m IS NULL/.test(src('src/db/plots.ts')), 'stamp: never over an existing distance');
  ok(/alongM: r\.along_m/.test(src('app/session/[id].tsx')) && /alongM: r\.along_m/.test(src('src/components/PlotSpeciesTab.tsx')), 'map: both split maps hand the stored distance over');
  ok(/delete row\.along_m;/.test(src('src/lib/bundleExport.ts')), 'export: the occurrence CSV leaves along_m out (yml only)');
  ok(/along_m, sex,/.test(src('src/db/records.ts')), 'read: listSessionRecords selects along_m');
}

if (errors.length) {
  console.error(`✗ along-track: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log('✓ along-track: stretches, record placement, pauses, defaults; split layout parsing (side by side, map above)');
