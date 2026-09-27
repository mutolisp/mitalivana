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
 *   - morphospecies labels (sp1, sp2): next label, relabel plan, sheet comments
 *   - survey dates ↔ unit dates: span, clock times kept, fill only empty units
 *   - temperature loggers: cycle by date, carry-forward, letters, codes, positions
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
  H00_PLOT_COORDINATES, H02_POINTS, H12_13_1X1_SP_FREQ, H14_1X1_DISTURBANCE, H22_SAS_SP, H32_10X10_SP, SAS_ABUNDANCE_CODE,
} from '../src/modules/gloria/export/sheetHeaders.ts';
import { buildSheetTables, buildPointHitRows, summitRow, pointRows, toCsv, SHRUB_NOTE } from '../src/modules/gloria/export/sheetRows.ts';
import { parseCsv, tableToSummits, diffSummits } from '../src/modules/gloria/model/summitImport.ts';
import { readXlsxFirstSheet } from '../src/lib/xlsxRead.ts';
import { photoItems, checklistState } from '../src/modules/gloria/model/photoChecks.ts';
import { pointKeyOf, tableToPoints, rowsBySummitCycle, diffPoints } from '../src/modules/gloria/model/pointImport.ts';
import { strToU8, zipSync } from 'fflate';
import { element8, parseOverviewPhotos } from '../src/modules/gloria/model/overview.ts';
import { bySpeciesOrder } from '../src/modules/gloria/model/speciesOrder.ts';
import { followCoverTimes, nextMinute } from '../src/modules/gloria/model/quadratTimes.ts';
import { nextMorphoLabel, planNewMorpho } from '../src/modules/gloria/model/morpho.ts';
import { unitTimeSpan, surveyDatesFromUnits, planUnitDates, takesRealStart } from '../src/modules/gloria/model/surveyDates.ts';
import { cycleOf, carryForward, missingCarry, nextLoggerLabel, loggerCode, loggerPhotoItem, validQuadrat, utcDiffHours, form4Id } from '../src/modules/gloria/model/loggers.ts';
import { loggerRows, planLoggerFiles, temperatureLoggersId, H04_TEMPERATURE_LOGGERS } from '../src/modules/gloria/export/loggerRows.ts';
import { speciesComments } from '../src/modules/gloria/export/sheetRows.ts';

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
  // 「無」 ticks record 0: a zero is an estimate, not a blank, so the one field
  // left blank is still the one completed.
  eq('ticked-none zeros leave the last blank to fill', autoFillLast({ a: 60, b: 0, c: null }, K, 'b'), { key: 'c', value: 40 });
  eq('all estimated (zeros included): nothing to fill', autoFillLast({ a: 100, b: 0, c: 0 }, K, 'c'), null);
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
eq('mocy: 1 and 99 ok, 0 / 100 / 2.5 refused', [1, 99, 0, 100, 2.5].map((v) => checkRange(v, RANGES.mocy)), ['ok', 'ok', 'reject', 'reject', 'reject']);
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
  // Shrub quadrat (freq_skipped): frequency times left in the app are not exported.
  const at = (h) => new Date(2012, 7, 14, h, 0).getTime();
  const t11 = buildSheetTables({
    summit: { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN' },
    survey: { uuid: 's', mocy: 2, year: 2012, start_ts: 0, stop_ts: null, recorded_by: null, notes: null },
    points: [],
    units: [
      unit('N13', { start_ts: at(9), cov_vascular: 50, freq_start_ts: at(10), freq_stop_ts: at(11), freq_skipped: 1 }),
      unit('N33', { start_ts: at(9), cov_vascular: 50, freq_start_ts: at(10), freq_stop_ts: at(11) }),
    ],
    species: [],
  }).find((x) => x.name.startsWith('11'));
  const fcol = (r) => [r[t11.header.indexOf('freqEstStartTime')], r[t11.header.indexOf('freqEstStopTime')]];
  eq('11 shrub quadrat: no frequency times', fcol(byUnit(t11.rows, 'N13')), ['', '']);
  eq('11 other quadrat: frequency times kept', fcol(byUnit(t11.rows, 'N33')), ['10:00', '11:00']);
  // Shrub quadrat data recorded before the tick: exported as 0, with the note.
  const shrubData = {
    summit: { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN' },
    survey: { uuid: 's', mocy: 2, year: 2012, start_ts: 0, stop_ts: null, recorded_by: null, notes: null },
    points: [],
    units: [unit('N13', {
      start_ts: at(9), cov_vascular: 50, freq_skipped: 1, comments: '箭竹密生',
      freq_mode: 'cells', dist_hi1: setBits(emptyMask(100), [0], true), point_surface: '-R' + '.'.repeat(98),
    })],
    species: [sp('N13', 1, { freq_cells: setBits(emptyMask(100), [0, 5], true), point_hits: '10' + '0'.repeat(98), morpho_label: 'sp1' })],
  };
  const st = buildSheetTables(shrubData);
  const s11 = st.find((x) => x.name.startsWith('11'));
  const r11 = s11.rows[0];
  eq('11 shrub: surface point totals are 0', ['tphSolidRock', 'tphScree', 'tphLitter'].map((c) => r11[s11.header.indexOf(c)]), ['0', '0', '0']);
  eq('11 shrub: note (bilingual) before the user comment', r11[s11.header.indexOf('comments')], `${SHRUB_NOTE}; 箭竹密生`);
  const s12 = st.find((x) => x.name.startsWith('12'));
  const r12 = s12.rows[0];
  eq('12/13 shrub: hits, freq and every cell 0',
    [r12[s12.header.indexOf('totalPointsHitCalc')], r12[s12.header.indexOf('freq')], F_COLUMNS.every((c) => r12[s12.header.indexOf(c)] === '0')],
    ['0', '0', true]);
  eq('12/13 shrub: note, then label', r12[s12.header.indexOf('comments')], `${SHRUB_NOTE}; sp1`);
  const s14 = st.find((x) => x.name.startsWith('14'));
  const fi14 = s14.header.indexOf('freq');
  eq('14 shrub: three disturbance rows, all 0', s14.rows.map((r) => [r[fi14], r.slice(fi14 + 1).every((v) => v === '0')]), [['0', true], ['0', true], ['0', true]]);
  eq('point hits: none for a shrub quadrat', buildPointHitRows(shrubData).length, 0);
  eq('the note carries the English in brackets', /^[^()]+\([A-Za-z ,.-]+\)$/.test(SHRUB_NOTE), true);

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

// ── summit import (CSV / xlsx, sheet 00_ columns) ───────────────────────
{
  eq('csv: quotes, doubled quotes, CRLF, BOM',
    parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  eq('csv: tab separated', parseCsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  // Sheet 00_ exactly as downloaded: an empty degree-minute "Longitude" after decimalLongitude.
  const sheet = [
    ['fullSummitCode', 'targetRegion', 'summit', 'decimalLongitude', 'Longitude', 'decimalLatitude', 'Latitude', 'twd97x', 'twd97y', 'elevation', 'Vegetation Zone'],
    ['TW-DAS-SUN', 'DAS', 'SUN', '121.058113728349', '', '23.459855882054', '', '255937', '2595207', '3255', 'lower alpine'],
    ['TW-DAS-YAT', 'DAS', 'YAT', '121.052963202229', '', '23.455270369605', '', '', '', '3363', 'Upper Alpine'],
    ['TW-DAS-XX', 'DAS', 'XX', '', '', '', '', '', '', '', ''],
    ['TW-DAS-SEN', 'DAS', 'SEN', '', '', '95', '', '', '', '', ''],
    ['TW-DAS-SUN', 'DAS', 'SUN', '', '', '', '', '', '', '', ''],
    ['TW-HQM-QSS', 'HQM', 'QSS', '', '', '', '', '', '', '3300', 'alpine meadow'],
  ];
  const parsed = tableToSummits(sheet);
  eq('00_: codes, full-precision coordinates, zone normalised',
    parsed.items.map((i) => [i.full_code, i.decimal_longitude, i.decimal_latitude, i.elevation_m, i.veg_zone]),
    [['TW-DAS-SUN', 121.058113728349, 23.459855882054, 3255, 'lower alpine'],
      ['TW-DAS-YAT', 121.052963202229, 23.455270369605, 3363, 'upper alpine'],
      ['TW-HQM-QSS', null, null, 3300, null]]);
  eq('00_: bad code, bad latitude, duplicate and unknown zone reported with their line',
    parsed.problems.map((p) => [p.line, p.message]),
    [[4, 'badCode'], [5, 'bad_lat'], [6, 'duplicate'], [7, 'unknownZone']]);
  eq('title row above the header is skipped',
    tableToSummits([['Taiwan GLORIA'], ['code', 'name'], ['tw-nah-lin', 'Nanhu']]).items.map((i) => [i.full_code, i.name]),
    [['TW-NAH-LIN', 'Nanhu']]);
  const diff = diffSummits(
    [{ id: 1, full_code: 'TW-DAS-SUN', name: null, decimal_latitude: 23.459855882054, decimal_longitude: 121.058113728349, elevation_m: 3250, veg_zone: 'lower alpine' },
      { id: 2, full_code: 'TW-DAS-YAT', name: 'x', decimal_latitude: 23.455270369605, decimal_longitude: 121.052963202229, elevation_m: 3363, veg_zone: 'upper alpine' }],
    parsed.items,
  );
  eq('diff: changed field listed, blank import cells never a change, unseen code is new',
    diff.map((d) => [d.item.full_code, d.kind, d.kind === 'changed' ? d.changes.map((c) => `${c.field}:${c.from}→${c.to}`) : null]),
    [['TW-DAS-SUN', 'changed', ['elevation_m:3250→3255']], ['TW-DAS-YAT', 'same', null], ['TW-HQM-QSS', 'new', null]]);

  // A real .xlsx: shared strings (one rich), an inline string, a number, a skipped column.
  const X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const xlsx = zipSync({
    'xl/workbook.xml': strToU8(`<workbook xmlns="${X}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="00_" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst xmlns="${X}"><si><t>fullSummitCode</t></si><si><t>elevation</t></si><si><r><t>TW-DAS-</t></r><r><t>SUN</t></r></si></sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="${X}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>note</t></is></c><c r="C2"><v>3255</v></c></row></sheetData></worksheet>`),
  });
  const rows = readXlsxFirstSheet(xlsx);
  eq('xlsx: shared, rich and inline strings, numbers, gaps kept in place', rows, [['fullSummitCode', '', 'elevation'], ['TW-DAS-SUN', 'note', '3255']]);
  eq('xlsx → summits', tableToSummits(rows).items.map((i) => [i.full_code, i.elevation_m]), [['TW-DAS-SUN', 3255]]);
}

// ── measurement point import (sheet 02_ or just the needed columns) ─────
{
  eq('point spellings → key',
    ['N11', 'p-N11', 'p5m-N31', 'N10m', 'p10m-N', 'NE5', 'pNE-5', 'ne-10', 'X11'].map((s) => pointKeyOf(s)?.key ?? null),
    ['N11', 'N11', 'N31', 'N10m', 'N10m', 'NE5', 'NE5', 'NE10', null]);
  eq('direction column + bare point', [pointKeyOf('11', 'W')?.key, pointKeyOf('10m', 'S')?.key, pointKeyOf('5', 'SW')?.key], ['W11', 'S10m', 'SW5']);
  eq('p5m- prefix marks the p5m corner', [pointKeyOf('p5m-E11').p5m, pointKeyOf('p-E31').p5m], [true, false]);

  // Minimal file: no code, no mocy, p5m as a column.
  const min = tableToPoints([
    ['direction', 'point', 'distance', 'compass', 'p5m'],
    ['N', '11', '26.35', '25', ''],
    ['N', '31', '27.3', '19', 'TRUE'],
    ['N', '10m', 'NA', '19', ''],
    ['E', '99', '1', '1', ''],
    ['S', '11', '29.4', '400', ''],
  ]);
  eq('minimal: rows read, NA is blank', min.rows.map((r) => [r.key, r.distance_m, r.compass_deg, r.p5m]),
    [['N11', 26.35, 25, null], ['N31', 27.3, 19, true], ['N10m', null, 19, null]]);
  eq('minimal: bad point and compass > 360 reported', min.problems.map((p) => [p.line, p.message]), [[5, 'badPoint'], [6, 'badCompass']]);

  // Sheet 02_ columns: several summits and cycles in one file.
  const H = ['id', 'quadratCode', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCluster', 'pointNumber', 'p5m', 'quadrat1x1', 'distance', 'compassDirection', 'mocy', 'comments'];
  const sheet = tableToPoints([
    H,
    ['TW-DAS-SUN-N-p-N11', '', 'TW', 'DAS', 'SUN', 'N', 'main line', 'p-N11', 'FALSE', 'N11', '26.35', '25', '4', ''],
    ['TW-DAS-SUN-N-p5m-N31', '', 'TW', 'DAS', 'SUN', 'N', 'main line', 'p5m-N31', 'TRUE', 'N31', '27.30', '19', '4', ''],
    ['TW-DAS-SUN-N-p10m-N', '', 'TW', 'DAS', 'SUN', 'N', 'main line', 'p10m-N', 'FALSE', 'NA', '40.60', '19', '4', 'new pole'],
    ['TW-DAS-SUN-N-p-N11', '', 'TW', 'DAS', 'SUN', 'N', 'main line', 'p-N11', 'FALSE', 'N11', '26.00', '24', '3', ''],
    ['TW-DAS-YAT-N-p-N11', '', 'TW', 'DAS', 'YAT', 'N', 'main line', 'p-N11', 'FALSE', 'N11', '10', '10', '4', ''],
  ]);
  const sun = rowsBySummitCycle(sheet.rows, 'TW-DAS-SUN');
  eq('02_: this summit only, cycles newest first, other summits counted', [sun.cycles, sun.other], [[4, 3], 1]);
  eq('02_: one cycle picked', sun.of(4).map((r) => [r.key, r.distance_m, r.p5m, r.comments]),
    [['N11', 26.35, false, null], ['N31', 27.3, true, null], ['N10m', 40.6, false, 'new pole']]);

  const stored = [
    { id: 1, point_key: 'N11', is_p5m: 1, distance_m: 26.35, compass_deg: 26, comments: 'keep me' },
    { id: 2, point_key: 'N31', is_p5m: 0, distance_m: null, compass_deg: null, comments: null },
    { id: 3, point_key: 'N10m', is_p5m: 0, distance_m: 40.6, compass_deg: 19, comments: 'old' },
  ];
  const d = diffPoints(stored, sun.of(4));
  eq('diff: fill vs overwrite, blank never clears',
    d.points.map((p) => [p.key, p.fill, p.changes.map((c) => `${c.field}:${c.from}→${c.to}`)]),
    [['N11', false, ['compass_deg:26→25']], ['N31', true, ['distance_m:null→27.3', 'compass_deg:null→19']], ['N10m', false, ['comments:old→new pole']]]);
  eq('diff: p5m corner moves 11 → 31', d.p5m, [{ direction: 'N', from: '11', to: '31' }]);
  eq('diff: both corners marked p5m is a problem',
    diffPoints(stored, [{ ...sun.of(4)[0], p5m: true }, sun.of(4)[1]]).problems.map((p) => p.message), ['twoP5m']);
}

// ── summit / point CSV export reads back through the importers ───────────
{
  const sm = { full_code: 'TW-DAS-SUN', country: 'TW', target_region: 'DAS', summit: 'SUN', decimal_latitude: 23.459855882054,
    decimal_longitude: 121.058113728349, twd97x: null, twd97y: null, elevation_m: 3255, veg_zone: 'lower alpine' };
  const back = tableToSummits(parseCsv(toCsv(H00_PLOT_COORDINATES, [summitRow(sm)]))).items[0];
  eq('00_ export → import', [back.full_code, back.decimal_latitude, back.decimal_longitude, back.elevation_m, back.veg_zone],
    ['TW-DAS-SUN', 23.459855882054, 121.058113728349, 3255, 'lower alpine']);
  const pts = [
    { point_key: 'N11', is_p5m: 0, distance_m: 26.35, compass_deg: 25, comments: null, uuid: 'a' },
    { point_key: 'N31', is_p5m: 1, distance_m: 27.3, compass_deg: 19, comments: 'new pole, "tilted"', uuid: 'b' },
    { point_key: 'NE5', is_p5m: 0, distance_m: 24.8, compass_deg: 48, comments: null, uuid: 'c' },
  ];
  const rows = tableToPoints(parseCsv(toCsv(H02_POINTS, pointRows(sm, 5, pts)))).rows.filter((r) => r.distance_m != null);
  eq('02_ export → import: keys, values, p5m, cycle, quoted comment',
    rows.map((r) => [r.full_code, r.mocy, r.key, r.distance_m, r.compass_deg, r.p5m, r.comments]),
    [['TW-DAS-SUN', 5, 'N11', 26.35, 25, false, null], ['TW-DAS-SUN', 5, 'N31', 27.3, 19, true, 'new pole, "tilted"'],
      ['TW-DAS-SUN', 5, 'NE5', 24.8, 48, false, null]]);
}

// ── photo checklist (Form 1 photo checkboxes; manual §4.4) ──────────────
{
  const items = photoItems();
  eq('checklist: 54 obligatory, 64 optional quarters',
    [items.filter((i) => i.required).length, items.filter((i) => !i.required).length], [54, 64]);
  eq('checklist: item keys unique', new Set(items.map((i) => i.item)).size, items.length);
  const pts = [
    { point_key: 'N11', is_p5m: 0, photo_m2: 'ph://a', photo_m2f: null, photo_point: null },
    { point_key: 'N31', is_p5m: 1, photo_m2: null, photo_m2f: null, photo_point: 'ph://pole' },
    { point_key: 'NE5', is_p5m: 0, photo_m2: null, photo_m2f: null, photo_point: 'ph://ne5' },
  ];
  const st = checklistState({
    checks: [{ item: 'CL-N', checked: 1, photo_uri: null }, { item: 'N11:UL', checked: 0, photo_uri: 'ph://q' }, { item: 'N11:hp', checked: 0, photo_uri: null }],
    points: pts,
    overviewCount: 1,
  });
  const done = (k) => st.items.find((i) => i.item.item === k).done;
  eq('done: ticked / point photo / p5m corner pole / intersection pole / own photo / overview',
    ['CL-N', 'N11:bare', 'P5M-N', 'pNE-5', 'N11:UL', 'SU-OV', 'N11:hp', 'P5M-E', 'HSP'].map(done),
    [true, true, true, true, true, true, false, false, false]);
  eq('counts', [st.required.done, st.optional.done], [5, 1]);
  const names = planPhotoNames({ mocy: 5, country: 'TW', region: 'DAS', summit: 'SUN', date: '20260814', p5m: {}, points: [], units: [],
    checks: [{ item: 'CL-N', uri: 'ph://c' }, { item: 'N11:UL', uri: 'ph://q' }, { item: 'HSP', uri: 'ph://h' }] });
  eq('export names: cluster item N, quarter as element 8 of its quadrat, HSP',
    names.map((n) => n.name),
    ['05_TW_DAS_SUN_N________20260814_00001.jpg', '05_TW_DAS_SUN_N11______20260814_00002_UL.jpg', '05_TW_DAS_SUN_HSP______20260814_00003.jpg']);
}

// ── species order (v55): dragged order first, never-reordered rows after by serial ──
{
  const rows = [
    { id: 'a', serial: 1, sort_order: 2 },
    { id: 'b', serial: 2, sort_order: 0 },
    { id: 'c', serial: 3, sort_order: null },
    { id: 'd', serial: 4, sort_order: 1 },
    { id: 'e', serial: 0 },
  ];
  eq('species order: sort_order, then serial for the rest', [...rows].sort(bySpeciesOrder).map((r) => r.id), ['b', 'd', 'a', 'e', 'c']);
  eq('species order: nothing reordered = serial order',
    [{ serial: 3 }, { serial: 1 }, { serial: 2 }].sort(bySpeciesOrder).map((r) => r.serial), [1, 2, 3]);
}

// ── 1×1 m frequency follows the cover estimate: same day, next minute ──
{
  const at = (y, mo, d, h, mi, se = 0) => new Date(y, mo - 1, d, h, mi, se).getTime();
  eq('nextMinute rounds up to the next whole minute', [nextMinute(at(2019, 8, 14, 10, 5, 51)), nextMinute(at(2019, 8, 14, 10, 5, 0))],
    [at(2019, 8, 14, 10, 6), at(2019, 8, 14, 10, 6)]);
  const blank = { start_ts: at(2019, 8, 14, 9, 42), stop_ts: null, freq_start_ts: null, freq_stop_ts: null };
  eq('cover end set, no frequency start → next minute', followCoverTimes(blank, 'stop_ts', at(2019, 8, 14, 10, 5, 51)),
    { freq_start_ts: at(2019, 8, 14, 10, 6) });
  const derived = { ...blank, stop_ts: at(2019, 8, 14, 10, 5, 51), freq_start_ts: at(2019, 8, 14, 10, 6) };
  eq('derived start follows a corrected cover end', followCoverTimes(derived, 'stop_ts', at(2019, 8, 14, 10, 20)),
    { freq_start_ts: at(2019, 8, 14, 10, 21) });
  const own = { ...derived, freq_start_ts: at(2019, 8, 14, 10, 30), freq_stop_ts: at(2019, 8, 14, 11, 0) };
  eq('a start the user set is kept; frequency moves to the cover day',
    followCoverTimes(own, 'start_ts', at(2019, 8, 13, 9, 42)),
    { freq_start_ts: at(2019, 8, 13, 10, 30), freq_stop_ts: at(2019, 8, 13, 11, 0) });
  eq('cover end at 23:59 → frequency 00:00 next day (not moved back)',
    followCoverTimes(blank, 'stop_ts', at(2019, 8, 14, 23, 59, 10)), { freq_start_ts: at(2019, 8, 15, 0, 0) });
  eq('clearing a cover time touches nothing', followCoverTimes(own, 'stop_ts', null), {});
}

// ── Morphospecies labels: one genus as sp1, sp2 on the survey roster ──
{
  eq('nextMorphoLabel: none → sp1', nextMorphoLabel([]), 'sp1');
  eq('nextMorphoLabel: one past the highest spN, other labels ignored', nextMorphoLabel(['sp1', 'SP3', 'A', null, ' sp2 ']), 'sp4');
  eq('planNewMorpho: an unlabelled entry is labelled first', planNewMorpho([null]), { relabel: 'sp1', label: 'sp2' });
  eq('planNewMorpho: all labelled → only the new label', planNewMorpho(['sp1', 'sp2']), { relabel: null, label: 'sp3' });
  eq('planNewMorpho: blank counts as unlabelled', planNewMorpho(['sp1', '  ']), { relabel: 'sp2', label: 'sp3' });
  eq('sheet comments: label first, then the notes', speciesComments({ morpho_label: 'sp2', comments: 'leaves hairy' }), 'sp2; leaves hairy');
  eq('sheet comments: no label → notes as they are', speciesComments({ morpho_label: null, comments: 'x' }), 'x');
  eq('sheet comments: label only', speciesComments({ morpho_label: 'sp1', comments: null }), 'sp1');
}

// ── Survey dates ↔ unit dates ──
{
  const at = (mo, d, h, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
  const units = [
    { code: 'N11', start_ts: at(8, 14, 9, 42), stop_ts: at(8, 14, 10, 5), freq_start_ts: at(8, 14, 10, 6), freq_stop_ts: null },
    { code: 'N05', start_ts: at(8, 15, 11, 20), stop_ts: null, pf_stop_ts: at(8, 15, 16, 30) },
    { code: 'N', start_ts: null, stop_ts: null },
  ];
  eq('span: earliest and latest time over every unit column', unitTimeSpan(units), { first: at(8, 14, 9, 42), last: at(8, 15, 16, 30) });
  eq('span: a shrub quadrat’s leftover frequency / point-frame times do not count',
    unitTimeSpan([{ code: 'N11', start_ts: at(8, 14, 9, 42), stop_ts: at(8, 14, 10, 5), freq_stop_ts: at(8, 20, 9, 0), pf_start_ts: at(8, 1, 9, 0), freq_skipped: 1 }]),
    { first: at(8, 14, 9, 42), last: at(8, 14, 10, 5) });
  eq('span: no times → null', unitTimeSpan([{ code: 'N', start_ts: null, stop_ts: null }]), null);
  eq('units → survey: dates move, the survey clock times stay',
    surveyDatesFromUnits({ start_ts: at(9, 1, 8, 0), stop_ts: at(9, 2, 17, 0) }, unitTimeSpan(units)),
    { start_ts: at(8, 14, 8, 0), stop_ts: at(8, 15, 17, 0) });
  eq('units → survey: an empty end takes the last unit time',
    surveyDatesFromUnits({ start_ts: at(9, 1, 8, 0), stop_ts: null }, unitTimeSpan(units)).stop_ts, at(8, 15, 16, 30));
  eq('survey → units: only empty units, at local midnight; a start on another day is reported',
    planUnitDates(units, at(8, 14, 8, 0)),
    { fill: ['N'], value: at(8, 14, 0, 0), otherDay: [{ code: 'N05', start_ts: at(8, 15, 11, 20) }] });
  eq('date-only start takes the real time only on that day',
    [takesRealStart(at(8, 14, 0), at(8, 14, 9, 30)), takesRealStart(at(8, 14, 0), at(9, 20, 9, 30))], [true, false]);
}

// ── Temperature loggers (manual §4.3, Box 6.1, Form 4) ──
{
  const d = (y, m, dd, h = 12) => new Date(y, m - 1, dd, h).getTime();
  const surveys = [{ mocy: 4, start_ts: d(2026, 8, 4, 9) }, { mocy: 5, start_ts: d(2030, 7, 10, 9) }, { mocy: 3, start_ts: d(2022, 7, 27) }];
  eq('cycle: a 2028 visit belongs to mocy 4', cycleOf(d(2028, 7, 12), surveys), 4);
  eq('cycle: a visit on the day mocy 5 starts (earlier hour) is mocy 5', cycleOf(d(2030, 7, 10, 7), surveys), 5);
  eq('cycle: before the first survey → the first one', cycleOf(d(2020, 1, 1), surveys), 3);
  eq('cycle: no survey → null', cycleOf(d(2028, 1, 1), []), null);
  const L = (uuid, role, quadrat, label, flags, extra = {}) => ({ uuid, role, direction: quadrat[0], quadrat, label, serial: `s-${label}`, logger_type: 'Hobo MX2203', start_ts: 1, dist11_m: 1.5, dist31_m: 2.25, flags: flags ? JSON.stringify(flags) : null, ...extra });
  const visit1 = [L('ra', 'readout', 'E22', 'a', ['LC']), L('rb', 'readout', 'E22', 'b', null), L('ic', 'install', 'E22', 'c', null), L('id', 'install', 'E22', 'd', null), L('wn', 'readout', 'W22', 'a', ['BC'])];
  eq('carry: installs and loggers still in the ground; a changed one (LC) is not', carryForward(visit1).map((x) => x.prev_uuid), ['rb', 'ic', 'id', 'wn']);
  eq('carry: seeds keep serial, type, place and distances', carryForward([visit1[2]])[0], { direction: 'E', quadrat: 'E22', label: 'c', serial: 's-c', logger_type: 'Hobo MX2203', start_ts: 1, dist11_m: 1.5, dist31_m: 2.25, prev_uuid: 'ic' });
  {
    const seeds = carryForward(visit1);
    const have = [{ role: 'readout', quadrat: 'E22', label: 'B', prev_uuid: null }, { role: 'readout', quadrat: 'W22', label: 'a', prev_uuid: 'wn' }, { role: 'install', quadrat: 'E22', label: 'c', prev_uuid: null }];
    eq('refill: skips rows already carried and read-outs typed in at the same place and letter', missingCarry(seeds, have).map((x) => x.prev_uuid), ['ic', 'id']);
    eq('refill: nothing there yet → everything', missingCarry(seeds, []).length, 4);
  }
  eq('letter: next after every one used at the position', [nextLoggerLabel([]), nextLoggerLabel(['a', 'b']), nextLoggerLabel(['a', 'C', null, 'x1'])], ['a', 'c', 'd']);
  eq('full-length code with the letter (Box 6.1)', loggerCode({ country: 'TW', target_region: 'SAC', summit: 'JIA' }, 'E22', 'c', 2026), 'TW_SAC_JIA_E22c_2026');
  eq('photo item LOG-E22c fits 8 characters', [loggerPhotoItem('E22', 'c'), loggerPhotoItem('E22', 'c').length], ['LOG-E22c', 8]);
  eq('position: centre and the four sides allowed, corners refused', ['N22', 'N12', 'N21', 'N23', 'N32', 'N11', 'N13', 'N31', 'N33', 'X22'].map(validQuadrat), [true, true, true, true, true, false, false, false, false, false]);
  eq('UTC difference is minus the zone offset, as Form 4 note 5 (Taiwan −8)', utcDiffHours({ getTimezoneOffset: () => -480 }), -8);
  eq('Form 4 identifier, as the sheet writes it', form4Id(4, 'TW-SAC-JIA', 1, d(2026, 8, 4)), 'mocy4_TW-SAC-JIA_1_temperature-logger_20260804');
  // Export: 04_ rows, the 01_ identifier, file names.
  const sm = { full_code: 'TW-SAC-JIA', country: 'TW', target_region: 'SAC', summit: 'JIA' };
  const lg = (o) => ({ uuid: 'u', role: 'install', quadrat: 'E22', label: 'c', serial: '22237134', logger_type: 'Hobo MX2203', start_ts: d(2026, 8, 5, 12), stop_ts: null, utc_diff_h: -8, dist11_m: 1.234, dist31_m: 2, photo_open: 1, photo_closed: null, photo_open_uri: null, photo_closed_uri: 'file:///x/photos/p.jpg', flags: null, researcher: null, comments: null, data_files: null, ...o });
  const v2 = { uuid: 'v2', visit_ts: d(2028, 7, 12), researchers: '乙', comments: null, form4_files: null, loggers: [lg({ uuid: 'r1', role: 'readout', stop_ts: d(2028, 7, 12, 10), flags: '["DR"]', data_files: JSON.stringify([{ uri: 'file:///x/files/a.csv', name: 'E22c 2028.csv', size: 10 }]) })] };
  const v1 = { uuid: 'v1', visit_ts: d(2026, 8, 5), researchers: '陳', comments: null, form4_files: JSON.stringify([{ uri: 'ph://1', name: 'scan.pdf', size: null }, { uri: 'ph://2', name: 'p2.jpg', size: null }]), loggers: [lg({})] };
  const rows = loggerRows(4, sm, [v2, v1]);
  const col = (r, h) => r[H04_TEMPERATURE_LOGGERS.indexOf(h)];
  eq('04_: visits in date order, one row per logger', rows.map((r) => [col(r, 'visitDate'), col(r, 'role')]), [['2026-08-05', 'installation'], ['2028-07-12', 'read-out']]);
  const sameDay = loggerRows(4, sm, [v1, { ...v1, uuid: 'v1b', form4_files: null }]).map((r) => col(r, 'id'));
  eq('04_: ids stay unique with two visits on one day (numbered by visit)', [new Set(sameDay).size, sameDay[1]], [2, 'TW-SAC-JIA-mocy_4-logger_2-E22c-install']);
  eq('04_: code, times, UTC, distances to 2 decimals, photo checks (tick or photo)',
    ['loggerCode', 'startDate', 'startTime', 'utcDiff', 'dist11', 'photoCheckOpen', 'photoCheckClosed', 'researcher', 'form4'].map((h) => col(rows[0], h)),
    ['TW_SAC_JIA_E22c_2026', '2026-08-05', '12:00', '-8', '1.23', 'TRUE', 'TRUE', '陳', 'mocy4_TW-SAC-JIA_1_temperature-logger_20260805']);
  eq('04_: read-out row keeps the install year in its code, flags and file names',
    ['loggerCode', 'stopTime', 'flags', 'dataFiles', 'form4'].map((h) => col(rows[1], h)),
    ['TW_SAC_JIA_E22c_2026', '10:00', 'DR', 'TW_SAC_JIA_E22c_2026_22237134_E22c_2028.csv', 'mocy4_TW-SAC-JIA_2_temperature-logger_20280712']);
  eq('01_ temperature_loggers: the cycle\'s first visit', [temperatureLoggersId(4, sm, [v2, v1]), temperatureLoggersId(4, sm, [])], ['mocy4_TW-SAC-JIA_1_temperature-logger_20260805', '']);
  eq('zip files: Form 4 scans under the form identifier (numbered), data under code_serial_name',
    planLoggerFiles(4, sm, [v2, v1]).map((f) => [f.kind, f.name]),
    [['form4', 'mocy4_TW-SAC-JIA_1_temperature-logger_20260805.pdf'], ['form4', 'mocy4_TW-SAC-JIA_1_temperature-logger_20260805-2.jpg'], ['data', 'TW_SAC_JIA_E22c_2026_22237134_E22c_2028.csv']]);
  const named = planPhotoNames({ mocy: 4, country: 'TW', region: 'SAC', summit: 'JIA', date: '20260804', p5m: {}, points: [], units: [], loggers: [{ uri: 'u1', item: 'LOG-E22c', note: 'open', date: '20280712' }] });
  eq('logger photo: Annex III name with LOG- item, visit date and open/closed', named[0].name, '04_TW_SAC_JIA_LOG-E22c_20280712_00001_open.jpg');
}

if (failures) {
  console.error(`check:gloria — ${failures} failure(s)`);
  process.exit(1);
}
console.log('check:gloria — all rules hold');
