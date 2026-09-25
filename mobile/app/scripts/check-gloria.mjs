/**
 * GLORIA module — pure model rules (src/modules/gloria/model, export/sheetHeaders).
 *
 * What each block protects:
 *   - unit and point code lists (16 quadrats, 8 SAS, 4 squares, 28 points)
 *   - cell numbering: storage idx ↔ Form 5-S / sheet f11…f00
 *   - walk orders: every option visits every point once, line by line
 *   - validation rules (manual p.40–42, p.52, p.58)
 *   - prefill carries plot positions only, never species or values
 *   - sheet headers: spCode dropped, 12_+13_ merged in the right order
 *
 * Run: npm run check:gloria
 */
import {
  ALL_UNITS, QUADRAT_CODES, SAS_CODES, SQUARE_CODES, POINTS, pointNumberOf, quadratsOf, upperSasOf,
} from '../src/modules/gloria/model/units.ts';
import {
  F_COLUMNS, fColumn, fColumnIndex, setBits, popcount, emptyMask, fillMask, rcLabel, getBit, surfaceHits,
} from '../src/modules/gloria/model/grid.ts';
import { walkOrder, lineHits, coverFromHits, WALK_OPTIONS } from '../src/modules/gloria/model/walk.ts';
import {
  checkQuadrat, checkSasContainsQuadrats, checkP5m, checkPoints, vascularCoverOk, autoFillLast,
} from '../src/modules/gloria/model/validate.ts';
import { planPrefill, nextSerial } from '../src/modules/gloria/model/prefill.ts';
import { photoFileName, planPhotoNames } from '../src/modules/gloria/export/photoNames.ts';
import { RANGES, checkRange } from '../src/modules/gloria/model/ranges.ts';
import {
  H12_13_1X1_SP_FREQ, H14_1X1_DISTURBANCE, H22_SAS_SP, H32_10X10_SP, SAS_ABUNDANCE_CODE,
} from '../src/modules/gloria/export/sheetHeaders.ts';
import { buildSheetTables } from '../src/modules/gloria/export/sheetRows.ts';
import { element8, parseOverviewPhotos } from '../src/modules/gloria/model/overview.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const ok = (label, cond) => eq(label, !!cond, true);
const kinds = (issues) => issues.map((i) => i.kind);

// ── units ──────────────────────────────────────────────────────────────
eq('16 quadrats', QUADRAT_CODES.length, 16);
eq('8 SAS', SAS_CODES.length, 8);
eq('4 squares', SQUARE_CODES.length, 4);
eq('28 units', ALL_UNITS.length, 28);
eq('28 points', POINTS.length, 28);
eq('point keys unique', new Set(POINTS.map((p) => p.key)).size, 28);
eq('N quadrats in sheet order', quadratsOf('N'), ['N11', 'N31', 'N33', 'N13']);
eq('upper SAS of W13', upperSasOf('W13'), 'W05');
eq('p5m label', pointNumberOf('N31', { N: '31' }), 'p5m-N31');
eq('non-p5m corner', pointNumberOf('N11', { N: '31' }), 'p-N11');
eq('upper corner never p5m', pointNumberOf('N33', { N: '31' }), 'p-N33');
eq('10-m point', pointNumberOf('E10m', {}), 'p10m-E');
eq('intersection point', pointNumberOf('SW10', {}), 'pSW-10');

// ── grid numbering (Form 5-S p.121 / sheet 13_) ───────────────────────
eq('idx 0 = f11 (R1 C1)', fColumn(0), 'f11');
eq('idx 9 = f10 (R1 C10)', fColumn(9), 'f10');
eq('idx 10 = f21', fColumn(10), 'f21');
eq('idx 90 = f01 (R10 C1)', fColumn(90), 'f01');
eq('idx 99 = f00 (R10 C10)', fColumn(99), 'f00');
eq('100 f-columns, unique', new Set(F_COLUMNS).size, 100);
ok('fColumnIndex inverts fColumn', F_COLUMNS.every((f, i) => fColumnIndex(f) === i));
eq('R/C label', rcLabel(99), 'R10 · C10');
{
  const m = setBits(emptyMask(100), [0, 9, 99], true);
  eq('set bits counted', popcount(m), 3);
  ok('bit 99 set', getBit(m, 99));
  eq('no-op set returns same string', setBits(m, [0], true) === m, true);
  eq('fill 100', popcount(fillMask(100, true)), 100);
  eq('null mask counts 0', popcount(null), 0);
}
eq('surface hits', surfaceHits('RRS-.T'), { R: 2, S: 1, L: 0, B: 0, G: 0, T: 1 });

// ── walks (manual p.57–58) ─────────────────────────────────────────────
for (const opt of WALK_OPTIONS) {
  const order = walkOrder(20, opt);
  eq(`option ${opt}: 400 points`, order.length, 400);
  eq(`option ${opt}: permutation`, new Set(order).size, 400);
  let jumps = 0;
  for (let k = 1; k < order.length; k++) {
    const [a0, b0] = [Math.floor(order[k - 1] / 20), order[k - 1] % 20];
    const [a1, b1] = [Math.floor(order[k] / 20), order[k] % 20];
    if (Math.abs(a1 - a0) + Math.abs(b1 - b0) !== 1) jumps += 1;
  }
  eq(`option ${opt}: each step moves to a neighbour (boustrophedon)`, jumps, 0);
  // The first line runs along a lower edge: a = 0 (lower-left) or b = 0 (lower-right).
  const first = order.slice(0, 20);
  ok(`option ${opt}: first line on a lower edge`,
    first.every((i) => Math.floor(i / 20) === 0) || first.every((i) => i % 20 === 0));
}
eq('options 1 and 2 start at opposite ends', [walkOrder(20, 1)[0], walkOrder(20, 2)[0]], [0, 19]);
eq('options 3 and 4 start at opposite ends', [walkOrder(20, 3)[0], walkOrder(20, 4)[0]], [0, 380]);
eq('1×1 frame is row-major', walkOrder(10, null).slice(0, 3), [0, 1, 2]);
{
  const order = walkOrder(20, 1);
  const m = setBits(emptyMask(400), order.slice(0, 25), true); // all of line 1, 5 of line 2
  eq('line hits', lineHits(m, order, 20).slice(0, 3), [20, 5, 0]);
}
eq('400-point cover = hits / 4', coverFromHits(213, 400), 53.25);
eq('100-point cover = hits', coverFromHits(17, 100), 17);

// ── validation ─────────────────────────────────────────────────────────
const top = (v, rest = [0, 0, 0, 0, 0, 100 - v]) => ({
  vascular: v, solidRock: rest[0], scree: rest[1], lichens: rest[2], bryophytes: rest[3], bareGround: rest[4], litter: rest[5],
});
const sp = (key, cover, freq) => ({ key, name: key, cover_pct: cover, freq_cells: freq, point_hits: null });
const cells = (n) => setBits(emptyMask(100), Array.from({ length: n }, (_, i) => i), true);
const quad = (over) => ({ code: 'N33', top: top(80), subtypes: [], species: [], freqDone: false, point_surface: null, ...over });

eq('99.999% is not 100%', kinds(checkQuadrat(quad({ top: top(80, [0, 0, 0, 0, 0, 19.999]), species: [sp('a', 90, null)] }))), ['top-cover-sum']);
eq('99.995% is not 100% (three decimals)', kinds(checkQuadrat(quad({ top: top(80, [0, 0, 0, 0, 0, 19.995]), species: [sp('a', 90, null)] }))), ['top-cover-sum']);
eq('clean quadrat', kinds(checkQuadrat(quad({ species: [sp('a', 50, null), sp('b', 40, null)] }))), []);
eq('top cover must sum to 100',
  kinds(checkQuadrat(quad({ top: top(80, [0, 0, 0, 0, 0, 10]), species: [sp('a', 90, null)] }))), ['top-cover-sum']);
eq('blank top cover is not checked', kinds(checkQuadrat(quad({
  top: { vascular: null, solidRock: null, scree: null, lichens: null, bryophytes: null, bareGround: null, litter: null },
}))), []);
eq('vascular 85 > species 84.4 warns',
  checkQuadrat(quad({ top: top(85), species: [sp('a', 45, null), sp('b', 25, null), sp('c', 13.9, null), sp('d', 0.5, null)] })),
  [{ unit: 'N33', kind: 'vascular-exceeds-species', vascular: 85, speciesSum: 84.4 }]);
eq('species 0.001 short of vascular still warns', vascularCoverOk(top(10.001), [sp('a', 10, null)]), false);
eq('vascular equal to species sum is fine', vascularCoverOk(top(50), [sp('a', 20, null), sp('b', 30, null)]), true);
eq('species above vascular (overlap) is fine', vascularCoverOk(top(50), [sp('a', 40, null), sp('b', 40, null)]), true);
eq('no species cover yet: not applicable', vascularCoverOk(top(50), []), null);
eq('subtype out of range', kinds(checkQuadrat(quad({ species: [sp('a', 80, null)], subtypes: [10, 120] }))), ['subtype-range']);

// Frequency × cover cross-check, only once frequency was done.
eq('count-only frequency joins the cross-check', checkQuadrat(quad({ freqDone: true, species: [{ ...sp('a', 80, null), freq_count: 60 }, { ...sp('b', 0.5, null), freq_count: 0 }] })),
  [{ unit: 'N33', kind: 'cover-no-freq', species: 'b', cover: 0.5 }]);
eq('cover without frequency cells',
  checkQuadrat(quad({ freqDone: true, species: [sp('a', 79.5, cells(60)), sp('b', 0.5, cells(0))] })),
  [{ unit: 'N33', kind: 'cover-no-freq', species: 'b', cover: 0.5 }]);
eq('frequency cells without cover',
  checkQuadrat(quad({ freqDone: true, species: [sp('a', 80, cells(60)), sp('new', null, cells(3))] })),
  [{ unit: 'N33', kind: 'freq-no-cover', species: 'new', cells: 3 }]);
eq('cross-check silent before frequency is done',
  kinds(checkQuadrat(quad({ freqDone: false, species: [sp('a', 80, null)] }))), []);

// SAS 05 ⊇ quadrats of its direction (p.42).
eq('upper SAS missing quadrat species',
  checkSasContainsQuadrats(
    { code: 'N05', top: top(80), species: [sp('a', null, null)] },
    [quad({ code: 'N11', species: [sp('a', 10, null), sp('b', 5, null)] }), quad({ code: 'E11', species: [sp('c', 5, null)] })],
  ),
  [{ unit: 'N05', kind: 'sas-missing', species: ['b'] }]);
eq('lower SAS is not checked',
  checkSasContainsQuadrats({ code: 'N10', top: top(80), species: [] }, [quad({ code: 'N11', species: [sp('a', 10, null)] })]), []);

// Point consistency: a surface only where no vascular plant was hit.
{
  const hitA = setBits(emptyMask(4), [0, 1], true);
  const spp = [{ ...sp('a', null, null), point_hits: hitA }];
  eq('consistent points', checkPoints('N', '--R.', spp), []);
  eq('surface recorded under a hit', checkPoints('N', '-RR.', spp)[0].points, [1]);
  eq('vascular mark without a species', checkPoints('N', '---.', spp)[0].points, [2]);
}

eq('p5m missing for W', checkP5m({ N: '31', E: '11', S: '11' }).map((i) => i.direction), ['W']);
eq('p5m complete', checkP5m({ N: '31', E: '11', S: '11', W: '31' }), []);

// ── prefill: plot re-establishment only — resurveys are blind (Box 4.5) ──
{
  const plan = planPrefill({
    mocy: 4,
    p5m: { N: '31' },
    points: [{ key: 'N31', distance_m: 27.3, compass_deg: 19, comments: null }],
    walkOptions: [{ code: 'N', walk_option: 2 }, { code: 'E', walk_option: null }],
  });
  eq('mocy + 1', plan.mocy, 5);
  eq('p5m carried', plan.p5m, { N: '31' });
  eq('points carried', plan.points[0].distance_m, 27.3);
  eq('walk option carried, blanks dropped', plan.walkOptions, [{ code: 'N', walk_option: 2 }]);
  eq('carries nothing but points, p5m, walk options', Object.keys(plan).sort(), ['mocy', 'p5m', 'points', 'walkOptions']);
  eq('first survey', planPrefill(null).mocy, 1);
  eq('next serial', nextSerial([{ serial: 3 }, { serial: 7 }]), 8);
}

// ── photo names (manual Annex III) ────────────────────────────────────
eq('annex III: quadrat photo', photoFileName({ mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', item: 'N33', date: '20260814', order: 12 }),
  '05_TW_DAS_SUN_N33______20260814_00012.jpg');
eq('annex III: 8-character item kept', photoFileName({ mocy: 1, country: 'AT', region: 'HSW', summit: 'GHK', item: 'p5m-N31', date: '20010817', order: 0 }),
  '01_AT_HSW_GHK_p5m-N31__20010817_00000.jpg');
{
  const plan = planPhotoNames({
    mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', date: '20260814', p5m: { N: '31' },
    points: [
      { point_key: 'N31', photo_m2: 'a', photo_m2f: 'b', photo_point: 'c' },
      { point_key: 'NE5', photo_m2: null, photo_m2f: null, photo_point: 'd' },
      { point_key: 'N11', photo_m2: 'e', photo_m2f: null, photo_point: null },
    ],
    units: [{ code: 'N05', photo_uris: ['f'] }],
  });
  eq('photo plan: sheet order, quadrat code on m² photos, point label on point photos', plan.map((p) => p.name.slice(14, -4)), [
    'N11______20260814_00001', 'N31______20260814_00002', 'N31______20260814_00003', 'p5m-N31__20260814_00004',
    'pNE-5____20260814_00005', 'N05______20260814_00006',
  ]);
  eq('photo plan: names unique', new Set(plan.map((p) => p.name)).size, plan.length);
}

// ── top cover: the last blank field completes 100% (manual p.40) ─────
{
  const K = ['a', 'b', 'c'];
  eq('fills the last blank', autoFillLast({ a: 60, b: 25, c: null }, K, 'b'), { key: 'c', value: 15 });
  eq('never fills the field just edited (clearing to retype)', autoFillLast({ a: 60, b: null, c: 25 }, K, 'b'), null);
  eq('no fill while two are blank', autoFillLast({ a: 60, b: null, c: null }, K, 'a'), null);
  eq('no negative fill when the rest is over 100', autoFillLast({ a: 80, b: 30, c: null }, K, 'b'), null);
  eq('rounds away float noise', autoFillLast({ a: 33.3, b: 33.3, c: null }, K, 'a'), { key: 'c', value: 33.4 });
  eq('0 is a real fill', autoFillLast({ a: 60, b: 40, c: null }, K, 'b'), { key: 'c', value: 0 });
  eq('three decimals kept', autoFillLast({ a: 99.9, b: 0.095, c: null }, K, 'b'), { key: 'c', value: 0.005 });
  eq('0.001 survives (no rounding)', autoFillLast({ a: 99.998, b: 0.001, c: null }, K, 'b'), { key: 'c', value: 0.001 });
  eq('float noise stripped', autoFillLast({ a: 0.1, b: 0.2, c: null }, K, 'b'), { key: 'c', value: 99.7 });
}

// ── input ranges ──────────────────────────────────────────────────────
eq('bearing 360 ok, 361 refused, -1 refused', [360, 361, -1].map((v) => checkRange(v, RANGES.bearing)), ['ok', 'reject', 'reject']);
eq('aspect 0 ok', checkRange(0, RANGES.aspect), 'ok');
eq('distance 10 and 150 ok (limits inclusive)', [10, 150].map((v) => checkRange(v, RANGES.distance)), ['ok', 'ok']);
eq('distance 9.9 / 150.1 warn but are kept', [9.9, 150.1].map((v) => checkRange(v, RANGES.distance)), ['warn', 'warn']);
eq('negative distance refused', checkRange(-2, RANGES.distance), 'reject');
eq('blank is ok', checkRange(null, RANGES.distance), 'ok');
eq('cover 100.5 refused', checkRange(100.5, RANGES.percent), 'reject');
eq('cell count: 37 ok, 37.5 refused, 101 refused', [37, 37.5, 101].map((v) => checkRange(v, RANGES.cells)), ['ok', 'reject', 'reject']);

// ── sheet headers ──────────────────────────────────────────────────────
for (const [name, h] of [['12+13', H12_13_1X1_SP_FREQ], ['22', H22_SAS_SP], ['32', H32_10X10_SP]]) {
  ok(`${name}: no spCode`, !h.some((c) => /^spcode$/i.test(c)));
}
{
  const fcols = H12_13_1X1_SP_FREQ.filter((c) => /^f\d\d$/.test(c));
  eq('12+13: f-columns in sheet order', fcols, [...F_COLUMNS]);
  eq('12+13: freq right before f11', H12_13_1X1_SP_FREQ[H12_13_1X1_SP_FREQ.indexOf('f11') - 1], 'freq');
  eq('12+13: cover and point hits kept', ['coverInPercentage', 'totalPointsHitCalc'].every((c) => H12_13_1X1_SP_FREQ.includes(c)), true);
  eq('14: freq then 100 cells', H14_1X1_DISTURBANCE.length, 9 + 100);
}
eq('SAS abundance codes (sheet 33_)', SAS_ABUNDANCE_CODE, { d: 1, c: 2, s: 3, r: 4, 'r!': 5 });

// ── count-only frequency export (resurveys that kept only totals) ───────
{
  const unit = (code, extra) => ({
    code, unit_type: 'quadrat', start_ts: null, stop_ts: null, freq_start_ts: null, freq_stop_ts: null, recorded_by: null,
    aspect_deg: null, slope_deg: null, cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null,
    cov_bryophytes: null, cov_bare_ground: null, cov_litter: null, sub_lich_below_vasc: null, sub_lich_on_rock: null,
    sub_lich_on_scree: null, sub_bry_below_vasc: null, sub_bry_on_rock: null, sub_bry_on_scree: null,
    dist_hi1: null, dist_hi2: null, dist_hi3: null, point_surface: null, walk_option: null, legacy_surface_hits: null,
    comments: null, uuid: `u-${code}`, ...extra,
  });
  const sp = (code, serial, extra) => ({
    unit_code: code, occurrence_id: `o-${code}-${serial}`, serial, cover_pct: 1, abundance: null, freq_cells: null,
    point_hits: null, legacy_hits: null, comments: null, scientific_name: `Sp ${serial}`, vernacular_name: '',
    taxon_rank: 'species', family: 'F', ...extra,
  });
  const tables = buildSheetTables({
    summit: { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN' },
    survey: { uuid: 's', mocy: 2, year: 2012, start_ts: 0, stop_ts: null, recorded_by: null, notes: null },
    points: [],
    units: [
      unit('N11', { freq_mode: 'count', dist_hi1_n: 3, dist_hi2_n: null, dist_hi3_n: 0 }),
      unit('N31', { freq_mode: 'cells', dist_hi1: setBits(emptyMask(100), [0, 99], true) }),
    ],
    species: [sp('N11', 1, { freq_count: 47 }), sp('N31', 1, { freq_cells: setBits(emptyMask(100), [0, 9, 90], true) })],
  });
  const tbl = (prefix) => tables.find((x) => x.name.startsWith(prefix));
  const t13 = tbl('12');
  const col = (name) => t13.header.indexOf(name);
  const byUnit = (rows, code) => rows.find((r) => r.includes(code));
  const n11 = byUnit(t13.rows, 'N11');
  eq('13 count: freq holds the count', n11[col('freq')], '47');
  eq('13 count: all 100 cells blank', F_COLUMNS.every((c) => n11[col(c)] === ''), true);
  const n31 = byUnit(t13.rows, 'N31');
  eq('13 cells: freq = popcount', n31[col('freq')], '3');
  eq('13 cells: f11 f10 f01 set', ['f11', 'f10', 'f01', 'f00'].map((c) => n31[col(c)]), ['1', '1', '1', '0']);
  const t14 = tbl('14');
  const fi = t14.header.indexOf('freq');
  const hi = t14.rows.filter((r) => r[0].includes('-N11-')).map((r) => [r[fi], r.slice(fi + 1).every((v) => v === '')]);
  eq('14 count: Hi1–3 totals, cells blank', hi, [['3', true], ['', true], ['0', true]]);
  const hc = t14.rows.filter((r) => r[0].includes('-N31-')).map((r) => r[fi]);
  eq('14 cells: Hi1–3 popcounts', hc, ['2', '0', '0']);

  // Each unit may name its own researchers; empty falls back to the survey's.
  const byTables = buildSheetTables({
    summit: { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN' },
    survey: { uuid: 's', mocy: 2, year: 2012, start_ts: 0, stop_ts: null, recorded_by: 'A, B', notes: null },
    points: [],
    units: [
      unit('N11', { recorded_by: 'C', cov_vascular: 10 }),
      unit('N31', { cov_vascular: 10 }),
      { ...unit('N05', { recorded_by: 'D' }), unit_type: 'sas' },
    ],
    species: [],
  });
  const by = (prefix, code) => {
    const tb = byTables.find((x) => x.name.startsWith(prefix));
    return tb.rows.find((r) => r.includes(code))[tb.header.indexOf('researcher')];
  };
  eq('11: unit researchers override the survey', [by('11', 'N11'), by('11', 'N31')], ['C', 'A|B']);
  eq('21: SAS researchers are its own', by('21', 'N05'), 'D');
}

// ── summit base data: SU-OV photo names, 00_ row ──────────────────────
{
  eq('element 8: spaces, underscores and dots become hyphens', element8(' from N  peak_cairn.2 '), 'from-N-peak-cairn-2');
  eq('element 8: at most 150 characters', element8('a'.repeat(200)).length, 150);
  eq('SU-OV photo name carries the viewpoint as element 8',
    photoFileName({ mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', item: 'SU-OV', date: '20260814', order: 12, note: 'from SEN' }),
    '05_TW_DAS_SUN_SU-OV____20260814_00012_from-SEN.jpg');
  eq('no viewpoint: no element 8',
    photoFileName({ mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', item: 'SU-OV', date: '20260814', order: 1, note: ' ' }),
    '05_TW_DAS_SUN_SU-OV____20260814_00001.jpg');
  const plan = planPhotoNames({ mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', date: '20260814', p5m: {}, points: [], units: [],
    overview: parseOverviewPhotos('[{"uri":"ph://a","viewpoint":"E ridge"},{"uri":"ph://b"},{"bad":1}]') });
  eq('overview photos numbered after the rest, bad entries dropped', plan.map((x) => x.name),
    ['05_TW_DAS_SUN_SU-OV____20260814_00001_E-ridge.jpg', '05_TW_DAS_SUN_SU-OV____20260814_00002.jpg']);
  const t00 = buildSheetTables({
    summit: { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN', decimal_latitude: 23.459855882054,
      decimal_longitude: 121.058113728349, twd97x: 255937, twd97y: 2595207, elevation_m: 3255, veg_zone: 'lower alpine' },
    survey: { uuid: 's', mocy: 1, year: 2008, start_ts: 0, stop_ts: null, recorded_by: null, notes: null },
    points: [], units: [], species: [],
  }).find((x) => x.name.startsWith('00'));
  eq('00_: one row in sheet column order, full coordinate precision', t00.rows,
    [['TW-DAS-SUN', 'DAS', 'SUN', '121.058113728349', '', '23.459855882054', '', '255937', '2595207', '3255', 'lower alpine']]);
}

if (failures) {
  console.error(`check:gloria — ${failures} failure(s)`);
  process.exit(1);
}
console.log('check:gloria — all rules hold');
