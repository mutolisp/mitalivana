/**
 * Fixture check for the map clustering module (src/lib/mapCluster.ts).
 * No network, no Expo — same contract as check-gdrive.mjs.
 * Run: npm run check:cluster
 */
import {
  CLUSTER_CELL_PX,
  clusterPoints,
  clusterRegion,
  clusterSplits,
} from '../src/lib/mapCluster.ts';

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
const close = (label, got, want, tol = 1e-9) => {
  if (Math.abs(got - want) > tol) fail(`${label}: got ${got}, expected ~${want}`);
};

/** 400×800 pt map over a 1°×1° box centred on (24, 121). */
const VP = {
  latitude: 24,
  longitude: 121,
  latitudeDelta: 1,
  longitudeDelta: 1,
  width: 400,
  height: 800,
};

const p = (key, latitude, longitude) => ({ key, latitude, longitude });

// ── grouping ────────────────────────────────────────────────────────────────
{
  // 1° spans 400 px, so one 64 px cell is 0.16°. Two points 0.01° apart land in
  // the same cell; the same pair is separate once the span is small enough.
  const near = [p('a', 24.0, 121.0), p('b', 24.0, 121.01)];
  const merged = clusterPoints(near, VP);
  eq('close pair merges', merged.length, 1);
  eq('member keys sorted', merged[0].memberKeys, ['a', 'b']);
  close('centroid lng', merged[0].longitude, 121.005);
  close('centroid lat', merged[0].latitude, 24);

  const zoomed = clusterPoints(near, { ...VP, latitudeDelta: 0.01, longitudeDelta: 0.01 });
  eq('same pair separates when zoomed in', zoomed.length, 2);
  eq('each is a singleton', zoomed.map((c) => c.memberKeys.length), [1, 1]);
}

// ── every point comes back exactly once ─────────────────────────────────────
{
  const pts = [
    p('a', 24.0, 121.0),
    p('b', 24.0, 121.01),
    p('c', 23.0, 120.0),
    p('d', 25.5, 122.5), // outside the viewport
  ];
  const cs = clusterPoints(pts, VP);
  const seen = cs.flatMap((c) => c.memberKeys).sort();
  eq('no point lost or duplicated', seen, ['a', 'b', 'c', 'd']);
  // Off-screen points are kept: a transect whose centre is just outside still
  // has a line crossing the screen.
  ok(
    'off-screen point retained',
    cs.some((c) => c.memberKeys.includes('d')),
  );
}

// ── stability ───────────────────────────────────────────────────────────────
{
  const a = clusterPoints([p('a', 24, 121), p('b', 24, 121.01)], VP);
  const b = clusterPoints([p('b', 24, 121.01), p('a', 24, 121)], VP);
  eq('input order does not change the key', a[0].key, b[0].key);
  eq('input order does not change members', a[0].memberKeys, b[0].memberKeys);

  // The key is the cell alone. A key that also carried the count remounted the
  // marker whenever membership changed, which is half of why the map used to
  // blank and rebuild itself.
  const three = clusterPoints([p('a', 24, 121), p('b', 24, 121.01), p('c', 24, 121.02)], VP);
  eq('gaining a member keeps the key', three[0].key, a[0].key);
}

// ── panning must not regroup (this was the visible bug) ─────────────────────
{
  const pts = [p('a', 24.0, 121.0), p('b', 24.0, 121.01), p('c', 23.5, 120.4)];
  const before = clusterPoints(pts, VP);

  // Same zoom, camera moved. An earlier version measured cells from the
  // viewport edge, so every pan shifted the grid, rekeyed every bubble and made
  // the map visibly blank and rebuild at the end of each drag.
  const panned = clusterPoints(pts, { ...VP, latitude: 24.3, longitude: 121.3 });
  eq(
    'panning keeps the keys',
    panned.map((c) => c.key).sort(),
    before.map((c) => c.key).sort(),
  );
  eq(
    'panning keeps the grouping',
    panned.map((c) => c.memberKeys).sort(),
    before.map((c) => c.memberKeys).sort(),
  );

  // react-native-maps reports a slightly different span after each gesture;
  // the power-of-two ladder absorbs that instead of nudging points across cell
  // boundaries for no visible reason.
  const wobbled = clusterPoints(pts, { ...VP, latitudeDelta: 1.01, longitudeDelta: 1.02 });
  eq(
    'a small span change keeps the keys',
    wobbled.map((c) => c.key).sort(),
    before.map((c) => c.key).sort(),
  );
}

// ── degenerate viewports must not collapse the map ──────────────────────────
{
  const pts = [p('a', 24, 121), p('b', 24, 121.01)];
  for (const [label, vp] of [
    ['zero width', { ...VP, width: 0 }],
    ['zero height', { ...VP, height: 0 }],
    ['zero lat span', { ...VP, latitudeDelta: 0 }],
    ['zero lng span', { ...VP, longitudeDelta: 0 }],
  ]) {
    const cs = clusterPoints(pts, vp);
    eq(`${label} falls back to singletons`, cs.length, 2);
  }
  eq('zero cell size falls back to singletons', clusterPoints(pts, VP, 0).length, 2);
  eq('empty input', clusterPoints([], VP), []);
}

// ── junk coordinates are skipped, not crashed on ────────────────────────────
{
  const cs = clusterPoints([p('a', 24, 121), p('bad', NaN, 121)], VP);
  const seen = cs.flatMap((c) => c.memberKeys);
  eq('NaN point dropped', seen, ['a']);
}

// ── cluster zoom target ─────────────────────────────────────────────────────
{
  // Built by hand rather than via clusterPoints: this is about the framing
  // maths, and deriving the input from the grid would only re-test the grid.
  const spread = {
    key: 'c:0,0:2',
    latitude: 24.05,
    longitude: 121.05,
    memberKeys: ['a', 'b'],
    minLatitude: 24.0,
    maxLatitude: 24.1,
    minLongitude: 121.0,
    maxLongitude: 121.1,
  };
  const r = clusterRegion(spread);
  close('region centres on the members', r.latitude, 24.05, 1e-9);
  close('region centres on the members (lng)', r.longitude, 121.05, 1e-9);
  ok('region covers the span with margin', r.latitudeDelta > 0.1);

  // Members stacked on one spot still need a usable zoom level, otherwise
  // tapping the bubble would animate to a zero-sized region.
  const stacked = clusterPoints([p('a', 24, 121), p('b', 24, 121)], VP)[0];
  eq('identical coordinates do merge', stacked.memberKeys, ['a', 'b']);
  const rs = clusterRegion(stacked);
  ok('stacked members get the floor', rs.latitudeDelta >= 0.002 && rs.longitudeDelta >= 0.002);
}

// ── zooming in has to get somewhere ─────────────────────────────────────────
{
  // The bug this guards: tapping a bubble always zoomed to clusterRegion, so
  // records sharing a coordinate stayed bubbled at every zoom and could never
  // be opened. The caller now lists the members when zooming would not help.
  const vpAt = (r) => ({ ...r, width: VP.width, height: VP.height });

  const stacked = clusterPoints([p('a', 24, 121), p('b', 24, 121)], VP)[0];
  ok(
    'stacked members never split, however far you zoom',
    !clusterSplits(stacked, vpAt(clusterRegion(stacked))),
  );

  // A metre apart is still a dead end: clusterRegion's floor stops zooming
  // long before that distance crosses a cell edge.
  const nearly = clusterPoints([p('a', 24, 121), p('b', 24.00001, 121.00001)], VP)[0];
  eq('near-identical points merge', nearly.memberKeys, ['a', 'b']);
  ok('near-identical members do not split either', !clusterSplits(nearly, vpAt(clusterRegion(nearly))));

  // Genuinely separate records must still zoom rather than pop a list.
  const apart = clusterPoints([p('a', 24, 121), p('b', 24.02, 121.02)], VP)[0];
  eq('points a couple of km apart merge at this zoom', apart.memberKeys, ['a', 'b']);
  ok('but they do split once zoomed', clusterSplits(apart, vpAt(clusterRegion(apart))));

  ok('a lone point is never offered as a split', !clusterSplits({ ...stacked, memberKeys: ['a'] }, VP));
}

ok('cell size is exported', CLUSTER_CELL_PX > 0);

if (failures > 0) {
  console.error(`\ncheck-cluster: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-cluster: ok');
