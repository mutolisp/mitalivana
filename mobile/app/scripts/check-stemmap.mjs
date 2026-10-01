/**
 * Tree-census (stem map) pure model — src/survey/stemmap and the two ForestGEO
 * code sets. Spec: docs/ForestGEO/Stem_mapping.md (驗證) and
 * docs/planned/Modular_survey.md §5.3–5.4, §7.9, §8.
 *
 * What each block protects:
 *   - code sets: every code Condit's Tables 2.2.1 / 2.5.1 list, nothing else;
 *     death codes on the tree, M derived; AMS variables kept apart
 *   - coordinates: quadrat codes, subquadrats, grid / polar (declination,
 *     slope) / GPS round trip, the plot's own edges
 *   - walking order read off Condit Fig. 2.2.2
 *   - tag blocks, stem tags, tag conflicts
 *   - status A/D/F/P, M, vitality, conflicts, state-dependent validation
 *   - growth, Condit's dbh classes, the 5 % / min-3 extreme list, entry hints
 *   - sync block sizing, and its limits equal to the sync server's defaults
 *
 * Run: npm run check:stemmap
 */
import { CENSUS_CODES, censusCode, enterableCensusCodes } from '../src/survey/codesets/forestgeoCensus1998.ts';
import { AMS_VARIABLES, amsModeConflict } from '../src/survey/codesets/forestgeoAms2021.ts';
import {
  formatQuadratCode, fromGps, fromGrid, fromPolar, horizontalDistance, locate, parseQuadratCode,
  stakeXY, subquadratOf, toLatLng, trueBearing, validateGeometry,
} from '../src/survey/stemmap/coords.ts';
import { sortByWalk, subquadratOrder } from '../src/survey/stemmap/walkOrder.ts';
import { formatStemTag, nextFreeTag, parseStemTag, tagBlockIndex, tagConflict, tagRange } from '../src/survey/stemmap/tags.ts';
import { conflicts, isMultiStem, treeStatus, validateStem, vitality } from '../src/survey/stemmap/status.ts';
import { entryHints, extremeList, growth, qaClass } from '../src/survey/stemmap/growth.ts';
import { chooseSyncBlock, SYNC_LIMITS } from '../src/survey/stemmap/syncBlocks.ts';
import { circleRadiusM, equivalentDbhCm, treeBasalAreaCm2 } from '../src/survey/stemmap/basal.ts';
import { DEFAULT_LIMITS } from '../../sync-worker/src/quota.js';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};
const ok = (label, cond) => {
  if (!cond) fail(label);
};
const near = (label, got, want, tol = 1e-6) => {
  if (!(Math.abs(got - want) <= tol)) fail(`${label}: got ${got}, expected ${want} ± ${tol}`);
};

console.log('check:stemmap');

// ── 1. code sets ────────────────────────────────────────────────────────────
eq('census codes = Tables 2.2.1 + 2.5.1',
  CENSUS_CODES.map((c) => c.code).sort(),
  ['A', 'B', 'C', 'DC', 'DN', 'DS', 'DT', 'I', 'L', 'M', 'P', 'Q', 'R', 'X', 'Y'].sort());
eq('recensus-only codes', CENSUS_CODES.filter((c) => c.recensusOnly).map((c) => c.code).sort(), ['C', 'DC', 'DN', 'DS', 'DT', 'R']);
eq('death codes sit on the tree', CENSUS_CODES.filter((c) => c.dead).map((c) => c.level), ['tree', 'tree', 'tree', 'tree']);
eq('POM height required by A and Y', CENSUS_CODES.filter((c) => c.needsPomHeight).map((c) => c.code), ['A', 'Y']);
ok('M is derived, never entered', !enterableCensusCodes('stem', false).some((c) => c.code === 'M'));
ok('first census offers no C / R', !enterableCensusCodes('stem', true).some((c) => c.code === 'C' || c.code === 'R'));
ok('every code cites its table', CENSUS_CODES.every((c) => /Table 2\.(2|5)\.1/.test(c.source)));
const amsFields = AMS_VARIABLES.map((v) => v.field);
eq('AMS fields are unique', amsFields.length, new Set(amsFields).size);
ok('AMS S means different things in different fields',
  AMS_VARIABLES.filter((v) => 'choices' in v && v.choices.some((c) => c.code === 'S')).length === 3);
ok('AMS mode: B + S is a conflict, B + U is not', amsModeConflict(['B', 'S']) && !amsModeConflict(['B', 'U']));
ok('every AMS variable cites its page', AMS_VARIABLES.every((v) => /^p\.\d+$/.test(v.page)));

// ── 2. coordinates ──────────────────────────────────────────────────────────
const plot = (over = {}) => ({
  sizeXM: 100, sizeYM: 100, quadratM: 20, subquadratM: 5,
  originLat: 23.5, originLng: 121.0, bearingDeg: 0, bearingRef: 'true', declinationDeg: 0,
  ...over,
});
const P = plot();
eq('valid geometry', validateGeometry(P), []);
eq('size not a multiple of the quadrat', validateGeometry(plot({ sizeXM: 90 })), ['size_not_multiple']);
eq('quadrat not a multiple of the subquadrat', validateGeometry(plot({ subquadratM: 6 })), ['quadrat_not_multiple']);
eq('quadrat code', formatQuadratCode(35, 13), '3513');
eq('parse quadrat code', parseQuadratCode('0102'), { col: 1, row: 2 });
eq('bad quadrat code', parseQuadratCode('102'), null);
const g1 = fromGrid('0001', 6, 7, P);
eq('quadrat 0001 (6, 7) → (6, 27)', [g1.x, g1.y], [6, 27]);
eq('… subquadrat 2,2', subquadratOf(6, 7, P), { i: 2, j: 2 });
const big = plot({ sizeXM: 1000, sizeYM: 500 });
const g2 = fromGrid('3513', 0, 0, big);
eq('quadrat 3513 (0, 0) → (700, 260)', [g2.x, g2.y], [700, 260]);
ok('local position outside the quadrat warns', fromGrid('0000', 21, 3, P).warnings.includes('local_outside_quadrat'));
const l = locate({ x: 25.2, y: 53.8 }, P);
eq('locate (25.2, 53.8)', [l.code, l.sub], ['0102', { i: 2, j: 3 }]);
eq('plot far edge stays in the last quadrat', locate({ x: 100, y: 100 }, P).code, '0404');
eq('NE stake of 0000', stakeXY('0000', 'NE', P), { x: 20, y: 20 });

const polar = (az, ref, slope, f) => fromPolar({ x: 0, y: 0 }, 10, az, ref, slope, f);
let q = polar(90, 'true', null, P);
near('bearing 0°, azimuth 90°, 10 m → x', q.x, 10);
near('… y', q.y, 0);
const B30 = plot({ bearingDeg: 30 });
q = polar(120, 'true', null, B30);
near('bearing 30°, azimuth 120° → x', q.x, 10);
near('… y', q.y, 0);
const B30m = plot({ bearingDeg: 30, declinationDeg: -4 });
q = polar(124, 'magnetic', null, B30m);
near('declination −4°, compass 124° → same point x', q.x, 10);
near('… y', q.y, 0);
eq('magnetic bearing + declination → true bearing', trueBearing(plot({ bearingDeg: 10, bearingRef: 'magnetic', declinationDeg: -4 })), 6);
near('slope 60°, 10 m along the ground → 5 m', horizontalDistance(10, 60), 5);

for (const f of [P, B30, B30m]) {
  for (const pt of [{ x: 0, y: 0 }, { x: 37.4, y: 81.9 }, { x: 99, y: 3 }]) {
    const ll = toLatLng(pt, f);
    const back = fromGps(ll.lat, ll.lng, f);
    ok(`GPS round trip < 0.1 m (bearing ${f.bearingDeg}, ${pt.x},${pt.y})`, Math.hypot(back.x - pt.x, back.y - pt.y) < 0.1);
  }
}
const north10 = fromGps(23.5 + 10 / 6371008.8 * 180 / Math.PI, 121.0, B30);
near('10 m due north on a 30° plot → x = −10 sin30', north10.x, -5, 1e-3);
near('… y = 10 cos30', north10.y, 10 * Math.cos(Math.PI / 6), 1e-3);
eq('no origin, no GPS position', fromGps(23.5, 121, plot({ originLat: null })), null);

// ── 3. walking order (Condit Fig. 2.2.2) ────────────────────────────────────
eq('4 × 4 subquadrats in Fig. 2.2.2 order',
  subquadratOrder(4).map((c) => `${c.i},${c.j}`),
  ['1,1', '1,2', '2,2', '2,1', '1,3', '1,4', '2,4', '2,3', '3,3', '3,4', '4,4', '4,3', '3,1', '3,2', '4,2', '4,1']);
eq('non power of two: serpentine', subquadratOrder(3).map((c) => `${c.i},${c.j}`),
  ['1,1', '1,2', '1,3', '2,3', '2,2', '2,1', '3,1', '3,2', '3,3']);
const walked = sortByWalk(
  [
    { id: 'in 4,1', localX: 17, localY: 2 },
    { id: 'in 1,2', localX: 2, localY: 7 },
    { id: 'in 1,1 lower-left', localX: 1, localY: 1 },
    { id: 'in 1,1 upper-right', localX: 4, localY: 4 },
    { id: 'in 2,1', localX: 7, localY: 2 },
  ],
  P,
);
eq('trees follow the walk', walked.map((w) => w.id), ['in 1,1 lower-left', 'in 1,1 upper-right', 'in 1,2', 'in 2,1', 'in 4,1']);

// ── 4. tags ─────────────────────────────────────────────────────────────────
eq('stem tag', formatStemTag('1027', 2), '1027-2');
eq('parse stem tag', parseStemTag('1027-2'), { tree: '1027', stem: 2 });
const fifty = plot({ sizeXM: 1000, sizeYM: 500 }); // 50 × 25 quadrats, blocks of 5 → 10 × 5 blocks
eq('tag block: first block', tagBlockIndex({ x: 10, y: 10 }, fifty, 5), 0);
eq('tag block: column-first (one block up)', tagBlockIndex({ x: 10, y: 110 }, fifty, 5), 1);
eq('tag block: next column', tagBlockIndex({ x: 110, y: 10 }, fifty, 5), 5);
eq('tag range of block 3', tagRange(3, 10000), { first: 30001, last: 40000 });
eq('first free tag in block 0', nextFreeTag(0, 10000, []), 1);
eq('next free tag skips used, ignores other blocks', nextFreeTag(3, 10000, ['30001', 30002, '7', 'A1']), 30003);
eq('full range', nextFreeTag(0, 2, [1, 2]), null);
ok('same tag 0.5 m apart, same species: same tree', !tagConflict({ x: 0, y: 0, taxonId: 't' }, { x: 0.5, y: 0, taxonId: 't' }));
ok('same tag 1.5 m apart: conflict', tagConflict({ x: 0, y: 0, taxonId: 't' }, { x: 1.5, y: 0, taxonId: 't' }));
ok('same tag, different species: conflict', tagConflict({ x: 0, y: 0, taxonId: 't' }, { x: 0, y: 0, taxonId: 'u' }));

// ── 5. status, vitality, validation ─────────────────────────────────────────
const stem = (over = {}) => ({ censusCodes: [], dbhCm: 12, ...over });
const tree = (stems, over = {}) => ({ treeCodes: [], stems, existed: true, thresholdCm: 1, ...over });
eq('all stems dead → D', treeStatus(tree([stem({ amsSurvival: 'X' }), stem({ stemDead: true })])), 'D');
eq('one dead, one alive → A', treeStatus(tree([stem({ amsSurvival: 'X' }), stem()])), 'A');
eq('alive, no stem at the threshold → F', treeStatus(tree([stem({ dbhCm: 0, censusCodes: ['R'] })])), 'F');
eq('not yet recruited → P', treeStatus(tree([stem()], { existed: false })), 'P');
eq('tree death code → D', treeStatus(tree([stem({ dbhCm: null })], { treeCodes: ['DS'] })), 'D');
eq('big tree awaiting the ladder counts as reaching', treeStatus(tree([stem({ dbhCm: null, pending: 'big_tree' })], { thresholdCm: 5 })), 'A');
ok('two live stems over the threshold → M', isMultiStem(tree([stem(), stem({ dbhCm: 3 })])));
ok('extra stem under the threshold is not M', !isMultiStem(tree([stem(), stem({ dbhCm: 3 })], { thresholdCm: 5 })));
eq('vitality alive', vitality(tree([stem()])), 'alive');
eq('vitality dead (DS)', vitality(tree([stem({ dbhCm: null })], { treeCodes: ['DS'] })), 'dead');
eq('vitality uncertain (DN)', vitality(tree([stem({ dbhCm: null })], { treeCodes: ['DN'] })), 'uncertain');
eq('vitality uncertain (AMS NF)', vitality(tree([stem({ dbhCm: null, amsSurvival: 'NF' })])), 'uncertain');
eq('vitality of P is none', vitality(tree([stem()], { existed: false })), null);
eq('AMS A + census DS conflict', conflicts(tree([stem({ amsSurvival: 'A', dbhCm: null })], { treeCodes: ['DS'] })), ['tree_dead_but_stem_alive']);
eq('dead tree still carrying a DBH', conflicts(tree([stem()], { treeCodes: ['DS'] })), ['dead_stem_with_dbh']);
eq('AMS D on one stem, A on another', conflicts(tree([stem({ amsSurvival: 'D', dbhCm: null }), stem({ amsSurvival: 'A' })])), ['ams_dead_individual_but_stem_alive']);

const v = (over, extra = {}) =>
  validateStem({ stem: stem(over), treeCodes: [], isNew: false, firstCensus: false, thresholdCm: 5, pomM: 1.3, ...extra }).map((i) => i.code);
eq('new stem below threshold: error', v({ dbhCm: 3 }, { isNew: true }), ['new_below_threshold']);
eq('tagged stem below threshold: warning only', v({ dbhCm: 3 }), ['tagged_below_threshold']);
eq('resprout may be 0', v({ dbhCm: 0, censusCodes: ['R'] }), []);
eq('0 without R: error', v({ dbhCm: 0 }), ['zero_needs_resprout']);
eq('big tree awaiting the ladder may be empty', v({ dbhCm: null, pending: 'big_tree' }), []);
eq('alive without DBH: error', v({ dbhCm: null }), ['dbh_required']);
eq('dead stem may be empty', v({ dbhCm: null, stemDead: true }), []);
eq('A needs a POM height', v({ censusCodes: ['A'] }, { pomM: null }), ['pom_required']);
eq('C in a first census: error', v({ censusCodes: ['C'] }, { firstCensus: true }), ['recensus_only']);
eq('tree code on a stem: error', v({ censusCodes: ['DS'] }), ['unknown_code']);

// ── 6. growth and the extreme list ──────────────────────────────────────────
const Y = 365.25 * 24 * 3600 * 1000;
const gr = growth({ dbhCm: 10, pomSeq: 1, measuredAt: 0 }, { dbhCm: 11, pomSeq: 1, measuredAt: 2 * Y });
near('growth 1 cm over 2 years', gr.annualCm, 0.5);
eq('POM changed: no growth', growth({ dbhCm: 10, pomSeq: 1, measuredAt: 0 }, { dbhCm: 11, pomSeq: 2, measuredAt: Y }), { valid: false, reason: 'pom_changed' });
eq('dbh classes (mm 10–19, 20–39, …, ≥320)', [0.9, 1, 1.99, 2, 8, 16, 31.9, 32, 150].map(qaClass), [null, 0, 0, 1, 3, 4, 4, 5, 5]);
const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${String(i).padStart(3, '0')}`, dbhCm: 5, annualCm: i / 10 }));
const picks = extremeList(items);
eq('100 stems: 5 per end', [picks.filter((p) => p.end === 'low').length, picks.filter((p) => p.end === 'high').length], [5, 5]);
eq('lowest picked', picks.filter((p) => p.end === 'low').map((p) => p.id)[0], 's000');
eq('highest picked', picks.filter((p) => p.end === 'high').map((p) => p.id).at(-1), 's099');
eq('20 stems: minimum 3 per end', extremeList(items.slice(0, 20)).length, 6);
eq('5 stems: all listed', extremeList(items.slice(0, 5)).length, 5);
eq('hint: shrank', entryHints({ dbhCm: 10, pomSeq: 1, measuredAt: 0 }, { dbhCm: 9, pomSeq: 1, measuredAt: Y }), ['shrank']);
eq('hint: tenfold', entryHints({ dbhCm: 2, pomSeq: 1, measuredAt: 0 }, { dbhCm: 20, pomSeq: 1, measuredAt: Y }), ['tenfold']);
eq('hint: POM changed', entryHints({ dbhCm: 10, pomSeq: 1, measuredAt: 0 }, { dbhCm: 10.2, pomSeq: 2, measuredAt: Y }), ['pom_changed']);

// ── 7. basal area ───────────────────────────────────────────────────────────
near('BA of 12.4 + 6.1 cm stems', treeBasalAreaCm2([12.4, 6.1, null]), (Math.PI / 4) * (12.4 ** 2 + 6.1 ** 2));
near('equivalent DBH', equivalentDbhCm([3, 4]), 5);
ok('saplings stay visible on the map', circleRadiusM([1]) >= 0.15);

// ── 8. sync blocks ──────────────────────────────────────────────────────────
eq('limits equal the sync server defaults', SYNC_LIMITS,
  { maxObjectBytes: DEFAULT_LIMITS.maxObjectBytes, maxTeamObjects: DEFAULT_LIMITS.maxTeamObjects });
const fiftyHa = { quadratsX: 50, quadratsY: 25, quadratM: 20, stemsPerHa: 6240 };
const census = chooseSyncBlock({ ...fiftyHa, bytesPerStem: 150 });
eq('census codes only: 1 ha blocks', [census.edgeQuadrats, census.blocks], [5, 50]);
const ams = chooseSyncBlock({ ...fiftyHa, bytesPerStem: 600 });
eq('AMS: 3-quadrat blocks', [ams.edgeQuadrats, ams.blocks], [3, 153]);
ok('AMS: within the object budget', !ams.overObjectBudget);
const small = chooseSyncBlock({ quadratsX: 4, quadratsY: 5, quadratM: 20, stemsPerHa: 6240, bytesPerStem: 600 });
eq('0.8 ha: whole plot', [small.wholePlot, small.blocks], [true, 1]);
const dense = chooseSyncBlock({ ...fiftyHa, stemsPerHa: 6240, bytesPerStem: 1200 });
eq('denser data → smaller blocks', dense.edgeQuadrats, 2);
ok('2-quadrat blocks over 50 ha exceed the object budget', dense.overObjectBudget);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ stemmap: code sets, coordinates, walk, tags, status, growth, sync blocks');
