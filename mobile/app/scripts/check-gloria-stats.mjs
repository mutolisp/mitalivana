/**
 * GLORIA statistics (src/modules/gloria/model/stats.ts) against hand-worked
 * numbers:
 *   - 1×1 m cover summed per species over the quadrats kept, direction filter;
 *   - SAS class → BB → % (d 63, c 38, s 15, r 3, r! 1 — user convention);
 *   - 10×10 m hits → cover (hits / 4);
 *   - Shannon / Simpson / Pielou from diversity.ts on those vectors;
 *   - summit richness = SAS union; gained / lost by taxon_id;
 *   - cover and frequency changes (frequency from cells or from a count);
 *   - no comparison while the survey is active (blind resurvey).
 */
import {
  abundanceVector,
  compareSurveys,
  comparisonAllowed,
  sasPercent,
  summitSpecies,
  typeStats,
} from '../src/modules/gloria/model/stats.ts';
import { buildGloriaReport, buildGloriaProjectReport } from '../src/lib/reportGloria.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};
const near = (msg, got, want) => {
  if (got == null || Math.abs(got - want) > 1e-9) {
    failed++;
    console.error(`✗ ${msg}: got ${got}, want ${want}`);
  }
};

const cells = (n) => '1'.repeat(n) + '0'.repeat(100 - n);
const row = (unit_code, unit_type, taxon_id, v = {}) => ({
  unit_code, unit_type, taxon_id, name: taxon_id,
  cover_pct: null, freq_cells: null, freq_count: null, point_hits: null, legacy_hits: null, abundance: null, ...v,
});

const cur = [
  row('N11', 'quadrat', 'A', { cover_pct: 30, freq_cells: cells(40) }),
  row('N31', 'quadrat', 'A', { cover_pct: 10, freq_cells: cells(20) }),
  row('N11', 'quadrat', 'B', { cover_pct: 20, freq_cells: cells(30) }),
  row('E11', 'quadrat', 'C', { cover_pct: 40, freq_count: 50 }),
  row('E11', 'quadrat', 'D', {}), // listed, no cover yet
  row('N05', 'sas', 'A', { abundance: 'd' }),
  row('N05', 'sas', 'B', { abundance: 'c' }),
  row('N10', 'sas', 'E', { abundance: 's' }),
  row('E05', 'sas', 'C', { abundance: 'r!' }),
  row('N', 'square', 'A', { legacy_hits: 100 }),
  row('N', 'square', 'B', { point_hits: '1'.repeat(40) + '0'.repeat(360) }),
];

// ── conversions ──
eq('SAS class → %', ['d', 'c', 's', 'r', 'r!', null].map(sasPercent), [63, 38, 15, 3, 1, null]);

// ── vectors ──
const vAll = abundanceVector(cur, 'quadrat', { dirs: [] });
eq('1×1 cover summed per species', [...vAll].map(([k, v]) => [k, v.value]), [['A', 40], ['B', 20], ['C', 40], ['D', null]]);
const vN = abundanceVector(cur, 'quadrat', { dirs: ['N'] });
eq('direction filter keeps N only', [...vN.keys()], ['A', 'B']);
eq('SAS vector', [...abundanceVector(cur, 'sas', { dirs: [] })].map(([k, v]) => [k, v.value]), [['A', 63], ['B', 38], ['E', 15], ['C', 1]]);
eq('10×10 hits → cover %', [...abundanceVector(cur, 'square', { dirs: [] })].map(([k, v]) => [k, v.value]), [['A', 25], ['B', 10]]);

// ── indices (N quadrats: A 40, B 20 → p = 2/3, 1/3) ──
const sN = typeStats(cur, 'quadrat', { dirs: ['N'] });
const p = [2 / 3, 1 / 3];
near('Shannon H′', sN.shannonH, -p.reduce((a, x) => a + x * Math.log(x), 0));
near('Simpson 1−D', sN.simpson1mD, 1 - p.reduce((a, x) => a + x * x, 0));
near('Pielou J′', sN.pielouJ, -p.reduce((a, x) => a + x * Math.log(x), 0) / Math.log(2));
near('Berger–Parker', sN.bergerParker, 2 / 3);
eq('richness / units', [sN.richness, sN.units], [2, 2]);
const sAll = typeStats(cur, 'quadrat', { dirs: [] });
eq('unquantified species still counted in richness', [sAll.richness, sAll.unquantified], [4, 1]);

// ── summit richness and comparison ──
eq('summit species = SAS union', [...summitSpecies(cur, { dirs: [] })].sort(), ['A', 'B', 'C', 'E']);
const prev = [
  row('N11', 'quadrat', 'A', { cover_pct: 50, freq_count: 70 }),
  row('N11', 'quadrat', 'F', { cover_pct: 5, freq_cells: cells(10) }),
  row('N05', 'sas', 'A', { abundance: 'd' }),
  row('N05', 'sas', 'F', { abundance: 'r' }),
];
const cmp = compareSurveys(cur, prev, ['sas'], { dirs: [] });
eq('gained (SAS)', cmp.gained.map((x) => x.taxon_id), ['B', 'C', 'E']);
eq('lost (SAS)', cmp.lost.map((x) => x.taxon_id), ['F']);
eq('cover change A 50→40, largest first', cmp.cover.map((c) => [c.taxon_id, c.before, c.after, c.delta]),
  [['C', null, 40, 40], ['B', null, 20, 20], ['A', 50, 40, -10], ['F', 5, null, -5]]);
eq('frequency: count 70 → cells 60', cmp.frequency.find((c) => c.taxon_id === 'A'), { taxon_id: 'A', name: 'A', before: 70, after: 60, delta: -10 });
const cmpN = compareSurveys(cur, prev, ['quadrat'], { dirs: ['E'] });
eq('direction filter applies to gained / lost', [cmpN.gained.map((x) => x.taxon_id), cmpN.lost.map((x) => x.taxon_id)], [['C', 'D'], []]);

// ── blind resurvey ──
eq('comparison only for a finished survey', [comparisonAllowed('done'), comparisonAllowed('active')], [true, false]);

// ── reports ──
const t = (k, v) => (v ? `${k}${JSON.stringify(v)}` : k);
const summit = { id: 1, full_code: 'TW-DAS-SUN', name: null, target_region: 'DAS', country: 'TW' };
const cycle = (mocy, status, rows) => ({ id: mocy, mocy, year: 2000 + mocy, status, start_ts: 0, stop_ts: null, recorded_by: null, rows });
const noFilter = { dirs: [], types: [], summitIds: [] };
const ids = (r) => r.sections.map((x) => x.id);
const done = buildGloriaReport({ summit, survey: cycle(2, 'done', cur), prev: cycle(1, 'done', prev) }, noFilter, t);
eq('finished survey: comparison sections present', ['compare', 'turnover', 'coverChange', 'freqChange', 'directionsChange'].every((x) => ids(done).includes(x)), true);
const active = buildGloriaReport({ summit, survey: cycle(2, 'active', cur), prev: cycle(1, 'done', prev) }, noFilter, t);
eq('active survey: no previous data at all (blind)', [ids(active).includes('turnover'), ids(active).includes('coverChange'), active.sections.find((x) => x.id === 'compare').paras], [false, false, ['report.gloria.compareBlind']]);
eq('active survey: previous values never leak into any table', JSON.stringify(active.sections.filter((x) => x.id !== 'basics')).includes('F'), false);
const onlySas = buildGloriaReport({ summit, survey: cycle(2, 'done', cur), prev: cycle(1, 'done', prev) }, { dirs: [], types: ['sas'], summitIds: [] }, t);
eq('type filter: one index row, no 1×1 change tables', [onlySas.sections.find((x) => x.id === 'indices').table.rows.length, ids(onlySas).includes('coverChange')], [1, false]);
const proj = buildGloriaProjectReport(
  { projectName: 'P', summits: [{ summit, cycles: [cycle(1, 'done', prev), cycle(2, 'done', cur), cycle(3, 'active', cur)] }, { summit: { ...summit, id: 2, full_code: 'TW-DAS-XYZ', target_region: 'DAS' }, cycles: [cycle(1, 'done', cur)] }] },
  noFilter, t);
const ov = Object.fromEntries(proj.sections.find((x) => x.id === 'overview').meta.map((m) => [m.key, m.value]));
eq('project overview: regions, summits, surveys, resurveys', [ov['report.gloria.targetRegions'].startsWith('1'), ov['report.gloria.summitCount'], ov['report.gloria.surveyCount'], ov['report.gloria.resurveyCount']], [true, '2', '4', '2']);
eq('project latest uses the last FINISHED cycle (mocy 2, not active 3)', proj.sections.find((x) => x.id === 'latest').table.rows.some((r) => r[0].includes('m3')), false);

if (failed) {
  console.error(`check:gloria-stats — ${failed} failed`);
  process.exit(1);
}
console.log('✓ gloria-stats: vectors, SAS conversion, indices, direction filter, comparison and blind rule');
