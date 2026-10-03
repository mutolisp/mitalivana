/**
 * Tree census on the database (v80, src/survey/db/stemmapCore.ts) on the real
 * migrated schema, foreign keys ON as the app runs them.
 *
 * What must hold:
 *   - the schema's CHECKs and UNIQUEs refuse a 3 cm threshold, a bad quadrat
 *     code, an unknown location method, a second census 1, a repeated tag;
 *   - a frame's code is unique and its geometry valid; its grid, threshold
 *     and tag blocks are fixed once it has a census; a frame with censuses
 *     cannot be deleted;
 *   - the first series of a frame needs no code, later ones do; census
 *     numbers run 1, 2…; the census keeps the template's snapshot and hash;
 *   - grid / x,y / polar (stake or tree) / GPS positions land on the right
 *     x,y and quadrat, with what was entered kept; positions outside the
 *     plot and unknown references are refused;
 *   - a new tree takes the lowest free tag of its tag block; a taken tag and
 *     a full range are refused; a number given up in a tag correction is
 *     never suggested or accepted for another tree, but its own tree may
 *     take it back;
 *   - species, position and tag corrections leave history rows;
 *   - the first stem is the main one; stem numbers run on; the main flag
 *     moves; a recensus carries POM, its number and the main flag over;
 *     code C raises the POM number by one and removing it puts it back;
 *   - codes are checked per level, recensus-only codes refused in a first
 *     census; height and codes read back; every write stamps the quadrat;
 *   - a census sees the trees recorded up to it, with the previous
 *     census's measurements; only the latest census can be deleted, and it
 *     takes the trees and stems it added, leaving earlier data intact;
 *   - nothing is left for the integrity sweep to find.
 *
 * Run: npm run check:survey-db
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { CASCADE_ORPHANS } from '../src/db/integrityRules.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import * as r from '../src/survey/stemmap/review.ts';
import * as tf from '../src/survey/stemmap/treeForm.ts';
import * as sl from '../src/survey/db/sliceCore.ts';
import { templateHash } from '../src/survey/template/validate.ts';
import { toLatLng } from '../src/survey/stemmap/coords.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const near = (a, b, msg) => ok(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, expected ${b})`);
const throwsCode = (fn, code, msg) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof s.SurveyError && e.code === code, `${msg} (threw ${e.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};
const throwsCodeOf = (fn, Cls, code, msg) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof Cls && e.code === code, `${msg} (threw ${e.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};
const rejects = (sql, params, msg) => {
  try {
    sqlite.prepare(sql).run(...params);
  } catch {
    return;
  }
  ok(false, `${msg} (was accepted)`);
};

const sqlite = new DatabaseSync(':memory:');
const db = {
  executeSync(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
    const res = stmt.run(...params);
    return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
  },
};
await runUserMigrations(db);
sqlite.exec('PRAGMA foreign_keys = ON;');
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const tx = (fn) => {
  sqlite.exec('BEGIN');
  try {
    fn();
    sqlite.exec('COMMIT');
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }
};
const count = (table, where = '1', ...a) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).n;
let clock = 1000;
let n = 0;
const ctx = { db, now: () => ++clock, uuid: () => `u-${++n}` };
const T = STEMMAP_TEMPLATE;

// ── frames ───────────────────────────────────────────────────────────────
const F = s.createFrame(ctx, { code: 'FS1', sizeXM: 100, sizeYM: 100 });
const frame = s.getFrame(ctx, F);
ok(frame.quadrat_m === 20 && frame.subquadrat_m === 5 && frame.dbh_min_cm === 1 && frame.tag_block_size === 10000, 'frame: defaults 20 m / 5 m / 1 cm / 10000');
ok(frame.extreme_pct === 0.05 && frame.extreme_min === 3, 'frame: extreme list defaults 5 % / 3');
s.updateFrame(ctx, F, { extremePct: 0.1, extremeMin: 2 });
ok(s.getFrame(ctx, F).extreme_pct === 0.1 && s.getFrame(ctx, F).extreme_min === 2, 'frame: extreme list settings editable');
s.updateFrame(ctx, F, { extremePct: 0.05, extremeMin: 3 });
throwsCode(() => s.createFrame(ctx, { code: 'FS1', sizeXM: 100, sizeYM: 100 }), 'frame_code_taken', 'frame: code is unique');
throwsCode(() => s.createFrame(ctx, { code: 'X', sizeXM: 90, sizeYM: 100 }), 'geometry_invalid', 'frame: size must be whole quadrats');
throwsCode(() => s.createFrame(ctx, { code: 'X', sizeXM: 100, sizeYM: 100, subquadratM: 6 }), 'geometry_invalid', 'frame: quadrat must be whole subquadrats');
rejects(`UPDATE fw_frames SET dbh_min_cm = 3 WHERE id = ?`, [F], 'schema: threshold is 1 or 5 cm');
s.updateFrame(ctx, F, { sizeXM: 200, dbhMinCm: 5 });
ok(s.getFrame(ctx, F).size_x_m === 200 && s.getFrame(ctx, F).dbh_min_cm === 5, 'frame: grid and threshold editable before any census');
s.updateFrame(ctx, F, { sizeXM: 100, dbhMinCm: 1 });

// ── series and censuses ──────────────────────────────────────────────────
const C1 = s.startCensus(ctx, { frameId: F, template: T, investigators: 'A; B' });
const c1 = s.getSurvey(ctx, C1);
ok(c1.census_no === 1 && c1.status === 'active' && c1.template_id === 'builtin:stemmap', 'census: first census is no. 1, active');
ok(c1.template_snapshot === JSON.stringify(T) && c1.template_hash === templateHash(T), 'census: keeps the template snapshot and hash');
ok(one(`SELECT series_code AS c FROM fw_frame_series WHERE id = ?`, c1.series_id).c === '', 'series: the first one needs no code');
ok(s.isFirstCensus(ctx, C1) && s.previousCensusId(ctx, C1) == null, 'census: no previous census');
throwsCode(() => s.updateFrame(ctx, F, { dbhMinCm: 5 }), 'frame_locked', 'frame: threshold fixed once a census exists');
throwsCode(() => s.updateFrame(ctx, F, { tagBlockSize: 100 }), 'frame_locked', 'frame: tag blocks fixed once a census exists');
s.updateFrame(ctx, F, { name: 'Fushan', declinationDeg: -4.5 });
ok(s.getFrame(ctx, F).name === 'Fushan', 'frame: name and declination stay editable');
s.updateFrame(ctx, F, { declinationDeg: 0 });
throwsCode(() => s.deleteFrame(ctx, F), 'frame_has_surveys', 'frame: cannot delete with censuses');
const other = { ...T, id: 'user:other' };
throwsCode(() => s.startCensus(ctx, { frameId: F, template: other }), 'series_code_required', 'series: a second series needs a code');
throwsCode(() => s.startCensus(ctx, { frameId: F, template: { ...T, components: [] } }), 'template_invalid', 'census: an invalid template is refused');
rejects(
  `INSERT INTO fw_surveys (uuid, style, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('dup', 'individual', ?, ?, 1, 'x', 1, '{}', 'h', 1, 1, 1)`,
  [F, c1.series_id],
  'schema: one census no. 1 per series',
);
// The same row with census no. 9 goes in: the refusal above is the UNIQUE, not a missing column.
sqlite.prepare(
  `INSERT INTO fw_surveys (uuid, style, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('dup', 'individual', ?, ?, 9, 'x', 1, '{}', 'h', 1, 1, 1)`,
).run(F, c1.series_id);
sqlite.prepare(`DELETE FROM fw_surveys WHERE uuid = 'dup'`).run();

// ── trees: positions and tags ────────────────────────────────────────────
const taxon = (id) => ({ taxonId: id, usedScientificName: `Sp ${id}` });
const t1 = s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t1'), location: { method: 'grid', quadrat: '0102', localX: 3, localY: 4 } });
let i1 = s.getIndividual(ctx, t1.id);
ok(t1.tag === '1' && i1.x_m === 23 && i1.y_m === 44 && i1.quadrat_code === '0102', `grid: 0102 (column 1, row 2) + (3,4) → x 23 y 44, tag 1 (got ${t1.tag} ${i1.x_m},${i1.y_m} ${i1.quadrat_code})`);
ok(i1.local_x_m === 3 && i1.local_y_m === 4 && i1.coord_method === 'grid' && i1.first_survey_id === C1, 'grid: entered values and first census kept');
const t2 = s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t2'), location: { method: 'xy', x: 47.5, y: 12 } });
ok(t2.tag === '2' && s.getIndividual(ctx, t2.id).quadrat_code === '0200', 'xy: next tag of the block, quadrat 0200');
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, tag: '1', taxon: taxon('t3'), location: { method: 'xy', x: 5, y: 5 } }), 'tag_taken', 'tag: unique in the frame');
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t3'), location: { method: 'xy', x: 120, y: 5 } }), 'outside_plot', 'xy: outside the plot refused');
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t3'), location: { method: 'grid', quadrat: '0500', localX: 1, localY: 1 } }), 'outside_plot', 'grid: quadrat past the edge refused');
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t3'), location: { method: 'grid', quadrat: '0000', localX: 21, localY: 1 } }), 'outside_plot', 'grid: local x past the quadrat refused');
const pStake = s.addIndividual(ctx, {
  surveyId: C1,
  tag: '500',
  taxon: taxon('t3'),
  location: { method: 'polar', ref: { kind: 'stake', quadrat: '0101', corner: 'NE' }, distanceM: 10, azimuthDeg: 180, azimuthRef: 'true' },
});
let ip = s.getIndividual(ctx, pStake.id);
near(ip.x_m, 40, 'polar: from stake 0101 NE (40,40) 10 m due S → x 40');
near(ip.y_m, 30, 'polar: … y 30');
ok(ip.ref_kind === 'stake' && ip.ref_code === '0101NE' && ip.distance_m === 10 && ip.azimuth_deg === 180 && ip.azimuth_ref === 'true' && ip.quadrat_code === '0201', 'polar: reading kept, quadrat 0201');
const pTree = s.addIndividual(ctx, {
  surveyId: C1,
  taxon: taxon('t4'),
  location: { method: 'polar', ref: { kind: 'tree', tag: '1' }, distanceM: 2, azimuthDeg: 0, azimuthRef: 'true', slopeDeg: 60 },
});
ip = s.getIndividual(ctx, pTree.id);
near(ip.x_m, 23, 'polar: from tree 1 (23,44), 2 m N on a 60° slope → x 23');
near(ip.y_m, 45, 'polar: … horizontal 1 m → y 45');
ok(ip.ref_kind === 'tree' && ip.ref_code === '1' && ip.slope_deg === 60, 'polar: tree reference kept');
throwsCode(
  () => s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t4'), location: { method: 'polar', ref: { kind: 'tree', tag: '999' }, distanceM: 2, azimuthDeg: 0, azimuthRef: 'true' } }),
  'bad_reference',
  'polar: unknown reference tree refused',
);
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, taxon: taxon('t4'), location: { method: 'gps', lat: 24.76, lng: 121.55, accuracy: 3 } }), 'bad_reference', 'gps: refused without a surveyed origin');
rejects(`UPDATE fw_individuals SET coord_method = 'laser' WHERE id = ?`, [t1.id], 'schema: location method is one of four');
rejects(`UPDATE fw_individuals SET quadrat_code = '12' WHERE id = ?`, [t1.id], 'schema: quadrat code is four characters');

// GPS on a frame with an origin; tag blocks on a larger frame.
const G = s.createFrame(ctx, { code: 'G1', sizeXM: 500, sizeYM: 200, originLat: 24.76, originLng: 121.55, bearingDeg: 30 });
throwsCode(() => s.updateFrame(ctx, F, { code: 'G1' }), 'frame_code_taken', 'frame: renaming onto a taken code refused');
const CG = s.startCensus(ctx, { frameId: G, template: T });
const at = toLatLng({ x: 30, y: 10 }, s.frameGeometry(s.getFrame(ctx, G)));
const g1 = s.addIndividual(ctx, { surveyId: CG, taxon: taxon('t1'), location: { method: 'gps', lat: at.lat, lng: at.lng, accuracy: 4 } });
const ig = s.getIndividual(ctx, g1.id);
near(ig.x_m, 30, 'gps: rotated frame, back to x 30');
near(ig.y_m, 10, 'gps: … y 10');
ok(ig.lat === at.lat && ig.accuracy === 4 && ig.coord_method === 'gps' && ig.quadrat_code === '0100', 'gps: fix kept, quadrat 0100');
ok(g1.tag === '1', 'tags: block 0 starts at 1');
ok(s.addIndividual(ctx, { surveyId: CG, taxon: taxon('t1'), location: { method: 'xy', x: 110, y: 10 } }).tag === '20001', 'tags: block 2 (second column, first row) starts at 20001');
ok(s.addIndividual(ctx, { surveyId: CG, taxon: taxon('t1'), location: { method: 'xy', x: 110, y: 150 } }).tag === '30001', 'tags: block 3 starts at 30001');
const H = s.createFrame(ctx, { code: 'H1', sizeXM: 20, sizeYM: 20, tagBlockSize: 2 });
const CH = s.startCensus(ctx, { frameId: H, template: T });
s.addIndividual(ctx, { surveyId: CH, taxon: taxon('t1'), location: { method: 'xy', x: 1, y: 1 } });
s.addIndividual(ctx, { surveyId: CH, taxon: taxon('t1'), location: { method: 'xy', x: 2, y: 1 } });
throwsCode(() => s.addIndividual(ctx, { surveyId: CH, taxon: taxon('t1'), location: { method: 'xy', x: 3, y: 1 } }), 'tag_range_full', 'tags: a full range is reported');
ok(s.addIndividual(ctx, { surveyId: CH, tag: 'X9', taxon: taxon('t1'), location: { method: 'xy', x: 3, y: 1 } }).tag === 'X9', 'tags: an entered tag still goes in');

// ── corrections ──────────────────────────────────────────────────────────
const meta = (surveyId) => ({ surveyId, reason: 'checked', by: 'A' });
s.correctIndividual(ctx, t2.id, { taxon: taxon('t2b') }, meta(C1));
s.correctIndividual(ctx, t2.id, { location: { method: 'xy', x: 61, y: 12 } }, meta(C1));
throwsCode(() => s.correctIndividual(ctx, pStake.id, { tag: '1' }, meta(C1)), 'tag_taken', 'correct: tag onto a taken one refused');
s.correctIndividual(ctx, pStake.id, { tag: '501' }, meta(C1));
const i2 = s.getIndividual(ctx, t2.id);
ok(i2.taxon_id === 't2b' && i2.x_m === 61 && i2.quadrat_code === '0300', 'correct: species and position changed, quadrat follows');
ok(s.getIndividual(ctx, pStake.id).tag === '501', 'correct: tag changed');
throwsCode(() => s.addIndividual(ctx, { surveyId: C1, tag: '500', taxon: taxon('t3'), location: { method: 'xy', x: 5, y: 5 } }), 'tag_retired', 'retired: a given-up number is refused for a new tree');
throwsCode(() => s.correctIndividual(ctx, t2.id, { tag: '500' }, meta(C1)), 'tag_retired', 'retired: … and for another tree');
s.correctIndividual(ctx, g1.id, { tag: '7' }, meta(CG));
ok(s.addIndividual(ctx, { surveyId: CG, taxon: taxon('t1'), location: { method: 'xy', x: 5, y: 5 } }).tag === '2', 'retired: never suggested (block 0 skips 1)');
s.correctIndividual(ctx, g1.id, { tag: '1' }, meta(CG));
ok(s.getIndividual(ctx, g1.id).tag === '1', 'retired: a tree may take its own number back');
throwsCode(() => s.addIndividual(ctx, { surveyId: CG, tag: '7', taxon: taxon('t1'), location: { method: 'xy', x: 5, y: 6 } }), 'tag_retired', 'retired: the number it left is retired now');
const hist = sqlite.prepare(`SELECT field, old_value, new_value, survey_id, by FROM fw_individual_history ORDER BY id`).all();
ok(hist.map((h) => h.field).join() === 'taxon,position,tag,tag,tag', `correct: one history row each (${hist.map((h) => h.field)})`);
ok(JSON.parse(hist[1].old_value).x === 47.5 && JSON.parse(hist[1].new_value).x === 61 && hist[0].survey_id === C1 && hist[0].by === 'A', 'correct: old and new values, census and person kept');

// ── stems and values in a first census ───────────────────────────────────
const mOf = (surveyId, stemId) => one(`SELECT * FROM fw_stem_measures WHERE survey_id = ? AND stem_id = ?`, surveyId, stemId);
const s11 = t1.stemId;
let m11 = mOf(C1, s11);
ok(m11 && m11.is_main === 1 && m11.pom_m === 1.3 && m11.pom_seq === 1 && m11.dbh_cm == null, 'stem: the first stem is main, POM 1.3 m, POM no. 1');
const s12 = s.addStem(ctx, t1.id, C1);
ok(one(`SELECT stem_no FROM fw_stems WHERE id = ?`, s12).stem_no === 2 && mOf(C1, s12).is_main === 0, 'stem: the next one is no. 2, not main');
s.setMainStem(ctx, C1, t1.id, s12);
ok(mOf(C1, s11).is_main === 0 && mOf(C1, s12).is_main === 1, 'stem: main flag moves, numbers stay');
throwsCode(() => s.setMainStem(ctx, C1, t1.id, t2.stemId), 'not_found', 'stem: main flag only among the tree\'s stems');
s.updateMeasure(ctx, m11.id, { dbhCm: 12.3 });
s.updateMeasure(ctx, mOf(C1, s12).id, { dbhCm: 3.1, pomM: 1.1 });
m11 = mOf(C1, s11);
ok(m11.dbh_cm === 12.3 && m11.measured_at != null && mOf(C1, s12).pom_m === 1.1, 'measure: DBH, time and POM written');
rejects(`UPDATE fw_stem_measures SET pending = 'later' WHERE id = ?`, [m11.id], 'schema: pending is big_tree or nothing');
throwsCode(() => s.setStemCodes(ctx, m11.id, ['C']), 'recensus_only', 'codes: C only in a recensus');
throwsCode(() => s.setStemCodes(ctx, m11.id, ['DS']), 'bad_code', 'codes: death codes are not stem codes');
throwsCode(() => s.setStemCodes(ctx, m11.id, ['M']), 'bad_code', 'codes: M is derived, never entered');
throwsCode(() => s.setStemCodes(ctx, m11.id, ['ZZ']), 'bad_code', 'codes: unknown code refused');
s.setStemCodes(ctx, m11.id, ['A', 'L', 'A']);
ok(JSON.stringify(s.stemCodes(ctx, m11.id)) === '["A","L"]', 'codes: stored once each');
throwsCode(() => s.setTreeCodes(ctx, C1, t1.id, ['DS']), 'recensus_only', 'codes: death codes only in a recensus');
throwsCode(() => s.setTreeCodes(ctx, C1, t1.id, ['A']), 'bad_code', 'codes: stem codes are not tree codes');
s.setHeight(ctx, C1, t1.id, 14.5);
ok(s.heightOf(ctx, C1, t1.id) === 14.5, 'height: reads back');
s.setHeight(ctx, C1, t1.id, null);
ok(s.heightOf(ctx, C1, t1.id) == null && count('fw_individual_values', 'individual_id = ?', t1.id) === 0, 'height: cleared removes the row');
s.setHeight(ctx, C1, t1.id, 15);
const q0102 = () => one(`SELECT * FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = '0102'`, C1);
const stamp = q0102().updated_at;
s.setHeight(ctx, C1, t1.id, 15.5);
ok(q0102().updated_at > stamp, 'stamp: a write stamps its quadrat');
const codes = sqlite.prepare(`SELECT quadrat_code AS c FROM fw_survey_quadrats WHERE survey_id = ? ORDER BY c`).all(C1).map((r) => r.c);
ok(codes.join() === '0102,0200,0201,0300', `stamp: every quadrat written to has a row (${codes})`);
s.setFgQuadratStatus(ctx, C1, '0102', 'done');
ok(q0102().status === 'done' && q0102().ended_at != null, 'quadrat: done with an end time');
s.setFgQuadratStatus(ctx, C1, '0102', 'open');
ok(q0102().status === 'open' && q0102().ended_at == null, 'quadrat: reopened');
s.setFgQuadratRecorder(ctx, C1, '0102', 'A, B');
ok(q0102().recorded_by === 'A, B', 'quadrat: recorder kept');
s.updateCensus(ctx, C1, { investigators: 'A; B; C', notes: 'rainy' });
ok(s.getSurvey(ctx, C1).investigators === 'A; B; C' && s.getSurvey(ctx, C1).notes === 'rainy', 'census: investigators and notes');
s.finishCensus(ctx, C1);
ok(s.getSurvey(ctx, C1).status === 'done' && s.getSurvey(ctx, C1).stop_ts != null, 'census: finished');
s.reopenCensus(ctx, C1);
ok(s.getSurvey(ctx, C1).status === 'active' && s.getSurvey(ctx, C1).stop_ts == null, 'census: reopened');
s.finishCensus(ctx, C1);

// ── recensus ─────────────────────────────────────────────────────────────
const C2 = s.startCensus(ctx, { frameId: F, template: T });
ok(s.getSurvey(ctx, C2).census_no === 2 && s.previousCensusId(ctx, C2) === C1 && !s.isFirstCensus(ctx, C2), 'recensus: no. 2, previous is no. 1');
let view = s.loadFgQuadrat(ctx, C2, '0102');
const v1 = view.find((t) => t.individual.id === t1.id);
ok(view.map((t) => t.individual.tag).join() === '1,3', `recensus: sees the quadrat's trees (${view.map((t) => t.individual.tag)})`);
ok(v1.stems.length === 2 && v1.stems[0].measure == null && v1.stems[0].previous.dbh_cm === 12.3, 'recensus: previous DBH shown, nothing measured yet');
ok(JSON.stringify(v1.stems[0].previousCodes) === '["A","L"]' && v1.heightM == null, 'recensus: previous codes shown, height is this census\'s');
const m21 = s.ensureMeasure(ctx, C2, s11);
const m22 = s.ensureMeasure(ctx, C2, s12);
ok(s.ensureMeasure(ctx, C2, s11) === m21, 'recensus: one measurement row per stem and census');
ok(mOf(C2, s11).is_main === 0 && mOf(C2, s12).is_main === 1 && mOf(C2, s12).pom_m === 1.1, 'recensus: main flag and POM carried over');
s.setStemCodes(ctx, m21, ['C']);
ok(mOf(C2, s11).pom_seq === 2, 'POM: code C raises the POM number');
s.setStemCodes(ctx, m21, ['C', 'R']);
ok(mOf(C2, s11).pom_seq === 2, 'POM: raised once, not per write');
s.setStemCodes(ctx, m21, []);
ok(mOf(C2, s11).pom_seq === 1 && s.stemCodes(ctx, m21).length === 0, 'POM: removing C puts it back');
s.setStemCodes(ctx, m21, ['C']);
s.updateMeasure(ctx, m22, { dbhCm: 3.4 });
s.setTreeCodes(ctx, C2, pTree.id, ['DS']);
ok(JSON.stringify(s.treeCodes(ctx, C2, pTree.id)) === '["DS"]', 'recensus: death codes allowed');
const recruit = s.addIndividual(ctx, { surveyId: C2, taxon: taxon('t5'), location: { method: 'xy', x: 28, y: 48 } });
ok(recruit.tag === '4', `recensus: a recruit takes the next free tag (${recruit.tag})`);
const s13 = s.addStem(ctx, t1.id, C2);
s.correctIndividual(ctx, t1.id, { taxon: taxon('t1b') }, meta(C2));
ok(s.loadFgQuadrat(ctx, C1, '0102').every((t) => t.individual.id !== recruit.id), 'view: census 1 does not see census 2 recruits');
view = s.loadFgQuadrat(ctx, C2, '0102');
ok(view.some((t) => t.individual.id === recruit.id) && view.find((t) => t.individual.id === t1.id).stems.length === 3, 'view: census 2 sees its recruit and new stem');
ok(view.find((t) => t.individual.id === pTree.id).treeCodes[0] === 'DS', 'view: tree codes of this census');
const listed = s.listCensuses(ctx, F);
ok(listed.map((c) => c.census_no).join() === '2,1' && listed[0].frame_code === 'FS1', 'list: newest census first, with the plot code');
ok(listed[0].tree_count === 5 && listed[1].tree_count === 4, `list: each census counts the trees it sees (${listed.map((c) => c.tree_count)})`);
ok(s.listCensuses(ctx).length === count('fw_surveys'), 'list: all plots without a filter');
ok(s.loadFgQuadrat(ctx, C1, '0102').find((t) => t.individual.id === t1.id).stems.length === 2, 'view: census 1 does not see stems added in census 2');
ok(s.loadTree(ctx, C1, t1.id).stems.length === 2 && s.loadTree(ctx, C1, recruit.id) == null, 'loadTree: same rules for one tree');
ok(s.loadTree(ctx, C2, t1.id).stems.map((v) => v.stem.stem_no).join() === '1,2,3', 'loadTree: census 2 sees all three stems');

// ── census overview ──────────────────────────────────────────────────────
const st2 = new Map(s.censusTreeStates(ctx, C2).map((t) => [t.id, t]));
const a1 = st2.get(t1.id);
ok(a1.stems === 3 && !a1.done && a1.prev === 'alive' && !a1.isNew, `states: tree 1 has 3 stems, not done, alive last time (${JSON.stringify(a1)})`);
near(a1.d2, 3.4 * 3.4, 'states: size from this census once anything is measured');
const aDead = st2.get(pTree.id);
ok(aDead.done && aDead.deadNow && aDead.prev === 'missing', `states: death code makes it done and dead; nothing recorded last time → missing (${JSON.stringify(aDead)})`);
ok(st2.get(recruit.id).isNew && st2.get(recruit.id).prev == null, 'states: a recruit is new, with no previous state');
ok(st2.size === count('fw_individuals', 'frame_id = ?', F), 'states: one row per tree the census sees');
const st1 = new Map(s.censusTreeStates(ctx, C1).map((t) => [t.id, t]));
ok(!st1.has(recruit.id) && st1.get(t1.id).stems === 2 && st1.get(t1.id).prev == null, 'states: census 1 sees neither the recruit nor the new stem, and has no previous');
near(st1.get(t1.id).d2, 12.3 * 12.3 + 3.1 * 3.1, 'states: census 1 size');
ok(st1.get(t1.id).done && !st1.get(t2.id).done, 'states: done needs every stem handled');
s.updateMeasure(ctx, m21, { stemDead: true });
s.updateMeasure(ctx, mOf(C2, s13).id, { pending: 'big_tree' });
const a1b = s.censusTreeStates(ctx, C2).find((t) => t.id === t1.id);
ok(a1b.done && a1b.pending && !a1b.deadNow, 'states: dead, measured and big-tree stems all count as handled');

// ── review: same flags as the SQL, issues, worklists ─────────────────────
const geom = s.frameGeometry(s.getFrame(ctx, F));
for (const [sid, hasPrev] of [[C1, false], [C2, true]]) {
  const sql = new Map(s.censusTreeStates(ctx, sid).map((t) => [t.id, t]));
  const views = s.loadCensus(ctx, sid);
  ok(views.length === sql.size, `review: loadCensus sees the same trees as the overview (census ${sid})`);
  for (const v of views) {
    const f = r.treeFlags(v, sid, hasPrev);
    const q = sql.get(v.individual.id);
    ok(
      f.isNew === q.isNew && f.done === q.done && f.deadNow === q.deadNow && f.pending === q.pending && f.prev === q.prev,
      `review: flags of tree ${v.individual.tag} agree with SQL (${JSON.stringify(f)} vs ${JSON.stringify(q)})`,
    );
  }
}
const opts2 = { surveyId: C2, firstCensus: false, thresholdCm: 1 };
const issuesOf = () => r.treeIssues(s.loadTree(ctx, C2, t1.id), opts2);
s.updateMeasure(ctx, m22, { dbhCm: 2.0 });
ok(issuesOf().some((i) => i.stemNo === 2 && i.code === 'shrank' && i.severity === 'hint'), 'review: a smaller DBH is a hint to confirm');
ok(r.treeChip(r.treeFlags(s.loadTree(ctx, C2, t1.id), C2, true), issuesOf()) === 'warn', 'review: … and makes the chip "to confirm"');
s.updateMeasure(ctx, m22, { dbhCm: 31 });
ok(issuesOf().some((i) => i.code === 'tenfold'), 'review: a tenfold DBH is flagged');
s.updateMeasure(ctx, m22, { dbhCm: 3.4, pomM: 1.3 });
s.setStemCodes(ctx, m22, ['A']);
ok(issuesOf().some((i) => i.stemNo === 2 && i.code === 'pom_required'), 'review: A at the default 1.3 m needs its POM');
s.updateMeasure(ctx, m22, { pomM: 1.0 });
ok(!issuesOf().some((i) => i.code === 'pom_required'), 'review: … and is fine once the POM is entered');
s.setStemCodes(ctx, m22, ['P']);
ok(issuesOf().some((i) => i.code === 'problem'), 'review: P opens a problem');
s.setStemCodes(ctx, m22, []);
s.updateMeasure(ctx, m22, { pomM: 1.1 });
ok(issuesOf().length === 0, `review: no issues left (${JSON.stringify(issuesOf())})`);
s.updateMeasure(ctx, mOf(C1, t2.stemId).id, { dbhCm: 20 });
const scr = r.screening(s.loadCensus(ctx, C2), { ...opts2, geometry: geom });
ok(scr.some((w) => w.individualId === t2.id && w.code === 'not_handled'), `review: a stem measured last time but not now is listed (${JSON.stringify(scr)})`);
ok(!scr.some((w) => w.individualId === pTree.id), 'review: a tree recorded dead is not asked for its stems');
const ext = r.extremeWorklist(s.loadCensus(ctx, C2), { pct: 0.05, min: 3, geometry: geom });
ok(ext.length === 1 && ext[0].individualId === t1.id && ext[0].stemNo === 2 && ext[0].code === 'extreme_few', `review: only stems with a valid growth enter the extreme list; a lone stem is too few to rank (${JSON.stringify(ext)})`);
ok(r.treeChip({ isNew: false, done: false, deadNow: false, pending: false, partial: false, prev: 'dead' }, []) === 'prevDead', 'review: dead last time is listed, not counted as work');
ok(!r.isOpenWork('prevDead') && !r.isOpenWork('prevMissing') && r.isOpenWork('todo') && r.isOpenWork('partial'), 'review: work counts todo and partial only');

// ── the tree form ────────────────────────────────────────────────────────
const K = s.createFrame(ctx, { code: 'K1', sizeXM: 40, sizeYM: 40 });
const K1 = s.startCensus(ctx, { frameId: K, template: T });
const sd = (over) => ({ stemNo: null, dbhCm: null, pomM: 1.3, stemDead: false, codes: [], notes: null, ...over });
const draft = (over) => ({
  individualId: null,
  tag: null,
  taxon: taxon('k1'),
  location: { method: 'xy', x: 5, y: 5 },
  notes: null,
  heightM: 8.5,
  treeCodes: [],
  mainStemNo: 2,
  stems: [sd({ dbhCm: 12, codes: ['L'] }), sd({ dbhCm: 15 }), sd({ codes: ['B'] })],
  recordedBy: 'A',
  ...over,
});
throwsCode(() => s.saveTreeDraft(ctx, K1, draft({ taxon: null })), 'bad_reference', 'form: a new tree needs its species');
const kid = s.saveTreeDraft(ctx, K1, draft({}));
let kv = s.loadTree(ctx, K1, kid);
ok(kv.individual.tag === '1' && kv.stems.length === 3 && kv.heightM === 8.5, 'form: new tree with three stems and its height');
ok(kv.stems[1].measure.is_main === 1 && kv.stems[0].measure.is_main === 0, 'form: main stem as chosen');
ok(JSON.stringify(kv.stems[0].codes) === '["L"]' && kv.stems[2].measure.pending === 'big_tree', 'form: codes kept; B without DBH waits for the big-tree team');
ok(kv.stems[0].measure.recorded_by === 'A', 'form: recorder kept');
const t0 = kv.stems[0].measure.measured_at;
const asDraft = (v, patch = {}) => ({
  ...draft({}),
  individualId: v.individual.id,
  taxon: null,
  location: null,
  mainStemNo: 2,
  stems: v.stems.map((x) => sd({ stemNo: x.stem.stem_no, dbhCm: x.measure?.dbh_cm ?? null, pomM: x.measure?.pom_m ?? x.previous?.pom_m ?? 1.3, codes: x.codes })),
  ...patch,
});
s.saveTreeDraft(ctx, K1, asDraft(kv, { tag: '9', taxon: taxon('k2'), stems: asDraft(kv).stems.map((x, i) => (i === 2 ? { ...x, dbhCm: 80 } : i === 0 ? { ...x, codes: ['L', 'I'] } : { ...x, pomM: 1.1 })) }));
kv = s.loadTree(ctx, K1, kid);
ok(kv.individual.tag === '9' && kv.individual.taxon_id === 'k2' && count('fw_individual_history', 'individual_id = ?', kid) === 0, 'form: a recruit is fixed without history');
ok(kv.stems[2].measure.pending == null && kv.stems[2].measure.dbh_cm === 80, 'form: a DBH ends the big-tree wait');
ok(kv.stems[0].measure.measured_at === t0 && kv.stems[0].codes.join() === 'L,I', 'form: an unchanged DBH keeps its date');
const k2 = s.saveTreeDraft(ctx, K1, draft({ location: { method: 'xy', x: 6, y: 5 }, mainStemNo: 1, stems: [sd({ dbhCm: 3 })] }));
ok(s.getIndividual(ctx, k2).tag === '1', 'form: a recruit\'s first tag is not retired');
const K2 = s.startCensus(ctx, { frameId: K, template: T });
kv = s.loadTree(ctx, K2, kid);
s.saveTreeDraft(ctx, K2, asDraft(kv, { stems: asDraft(kv).stems.map((x, i) => (i === 0 ? { ...x, dbhCm: 12.5 } : x)) }));
ok(
  count('fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id', 'm.survey_id = ? AND st.individual_id = ?', K2, kid) === 1,
  'form: in a recensus only the stems entered get a row',
);
throwsCode(() => s.saveTreeDraft(ctx, K2, asDraft(kv, { taxon: taxon('k3') })), 'not_recruit', 'form: an older tree is corrected, not edited');
ok(s.mainStemId(ctx, K2, kid) === kv.stems[1].stem.id, 'form: the main stem carries over');
// the form module round-trips through the core
const kg = s.frameGeometry(s.getFrame(ctx, K));
let form = tf.formFromView(s.loadTree(ctx, K2, kid), { quadrat: '0000', geometry: kg });
ok(form.stems.length === 3 && form.mainKey === '2' && form.stems[0].dbh === '12.5' && form.stems[1].pom === '1.1', 'form: opens with this census\'s values, carried POM and main stem');
ok(tf.formIssues(form, s.loadTree(ctx, K2, kid), { surveyId: K2, firstCensus: false, thresholdCm: 1 }).length === 0, 'form: nothing to fix as stored');
form = { ...form, stems: form.stems.map((x, i) => (i === 1 ? { ...x, dbh: '1,5' } : x)) };
ok(tf.formIssues(form, s.loadTree(ctx, K2, kid), { surveyId: K2, firstCensus: false, thresholdCm: 1 }).some((i) => i.stemNo === 2 && i.code === 'tenfold'), 'form: 15 → 1,5 is read with the comma and flagged tenfold');
form = { ...form, stems: [...form.stems.map((x, i) => (i === 1 ? { ...x, dbh: '15.3' } : x)), { ...form.stems[0], key: 'new-9', stemNo: null, firstSurveyId: null, dbh: '', codes: [], previous: null, previousCodes: [] }] };
ok(
  tf.formIssues(form, s.loadTree(ctx, K2, kid), { surveyId: K2, firstCensus: false, thresholdCm: 1 }).some((i) => i.stemNo === 4 && i.code === 'dbh_required'),
  'form: a stem added now needs a DBH (4th stem)',
);
form = { ...form, stems: form.stems.map((x) => (x.key === 'new-9' ? { ...x, dbh: '0.5' } : x)) };
ok(tf.formIssues(form, s.loadTree(ctx, K2, kid), { surveyId: K2, firstCensus: false, thresholdCm: 1 }).some((i) => i.code === 'new_below_threshold'), 'form: … at the threshold or more');
form = { ...form, stems: form.stems.map((x) => (x.key === 'new-9' ? { ...x, dbh: '2' } : x)), mainKey: 'new-9' };
s.saveTreeDraft(ctx, K2, tf.formToDraft(form, s.loadTree(ctx, K2, kid), { surveyId: K2, recordedBy: 'B' }));
kv = s.loadTree(ctx, K2, kid);
ok(kv.stems.length === 4 && kv.stems[3].measure.dbh_cm === 2 && kv.stems[3].measure.is_main === 1 && kv.stems[1].measure.dbh_cm === 15.3, 'form: saved — new stem 4 is main, stem 2 measured');
const nf = tf.formFromView(null, { quadrat: '0101', at: { x: 25, y: 31 }, geometry: kg });
ok(nf.loc.quadrat === '0101' && nf.loc.lx === '5' && nf.loc.ly === '11', 'form: a map point opens as quadrat + local x,y');
const pv = tf.previewLocation({ ...nf.loc, method: 'polar', refKind: 'tree', refTag: '9', dist: '2', az: '90', azRef: 'true' }, kg, (tag) => {
  const st = s.censusTreeStates(ctx, K2).find((x) => x.tag === tag);
  return st ? { x: st.x, y: st.y } : null;
});
ok(pv && Math.abs(pv.x - 7) < 1e-9 && pv.y === 5 && pv.quadrat === '0000', `form: polar from a tree previews where the save puts it (${JSON.stringify(pv)})`);
ok(tf.locationInput({ ...nf.loc, method: 'xy', x: '', y: '3' }) == null, 'form: an incomplete position is not sent');
const typo = { ...nf, height: '1O', stems: [{ ...nf.stems[0], dbh: '12.086.3' }], loc: { ...nf.loc, lx: '5,2' } };
ok(
  JSON.stringify(tf.unreadableFields(typo, '7')) === JSON.stringify([{ stemTag: '7-1', field: 'dbh' }, { stemTag: null, field: 'height' }]),
  `form: text that is not a number is caught, a decimal comma is not (${JSON.stringify(tf.unreadableFields(typo, '7'))})`,
);
s.addTreeMedia(ctx, K2, kid, 'file:///photos/a.jpg');
s.addTreeMedia(ctx, K2, kid, 'file:///photos/b.jpg');
ok(s.listTreeMedia(ctx, K2, kid).map((m) => m.uri).join() === 'file:///photos/a.jpg,file:///photos/b.jpg' && s.listTreeMedia(ctx, K1, kid).length === 0, 'photos: per tree and census');
s.removeTreeMedia(ctx, K2, kid, 'file:///photos/a.jpg');
ok(s.listTreeMedia(ctx, K2, kid).length === 1, 'photos: removed by uri');

// ── AMS on census stems (2B) ─────────────────────────────────────────────
const AMS_T = { ...T, id: 'test:stemmap-ams', components: T.components.map((c) => (c.type === 'health' ? { ...c, params: { codesets: ['forestgeo-census-1998', 'forestgeo-ams-2021'] } } : c)) };
const AF = s.createFrame(ctx, { code: 'AMS1', sizeXM: 40, sizeYM: 40 });
const A1 = s.startCensus(ctx, { frameId: AF, template: AMS_T });
ok(s.censusCodesets(ctx, A1).join() === 'forestgeo-census-1998,forestgeo-ams-2021' && s.censusCodesets(ctx, K1).join() === 'forestgeo-census-1998', 'ams: a census knows its code sets');
const ag = s.frameGeometry(s.getFrame(ctx, AF));
const amsForm = (stems, at = { x: 3, y: 3 }) => {
  const f = tf.formFromView(null, { quadrat: '0000', at, geometry: ag, amsOn: true });
  return { ...f, taxon: taxon('a1'), stems: stems.map((x, i) => ({ ...f.stems[0], key: `new-${i + 1}`, ...x })) };
};
const amsIssues = (f, v = null) => tf.formIssues(f, v, { surveyId: A1, firstCensus: true, thresholdCm: 1 });
const okAms = { survival_status: 'OK', mode: ['S'], remaining_crown_pct: '95', living_length_m: '<POM', crown_illumination: '4', fungi: 'N', comment_codes: ['G', 'H'] };
let af = amsForm([{ dbh: '20', ams: okAms }, { dbh: '', ams: { survival_status: 'X', mode: ['B'], living_length_m: '0' } }]);
ok(amsIssues(af).filter((i) => i.severity === 'error').length === 0, `ams: a complete form has no errors (${JSON.stringify(amsIssues(af))})`);
const aid = s.saveTreeDraft(ctx, A1, tf.formToDraft(af, null, { surveyId: A1, recordedBy: 'A' }));
let av = s.loadTree(ctx, A1, aid);
ok(
  JSON.stringify(av.stems[0].ams) ===
    JSON.stringify({ comment_codes: ['G', 'H'], crown_illumination: '4', fungi: 'N', living_length_m: '<POM', mode: ['S'], remaining_crown_pct: 95, survival_status: 'OK' }),
  `ams: codes, lists, a number and a marker read back (${JSON.stringify(av.stems[0].ams)})`,
);
ok(one(`SELECT value_num AS n, unit FROM fw_stem_values WHERE measure_id = ? AND field = 'ams_remaining_crown_pct'`, av.stems[0].measure.id).unit === '%', 'ams: a number keeps its unit');
ok(av.stems[1].measure.stem_dead === 1 && av.stems[0].measure.stem_dead === 0, 'ams: X makes the stem dead, OK keeps it alive (the form derives stem death)');
ok(tf.formFromView(av, { quadrat: '0000', geometry: ag, amsOn: true }).stems[0].ams.remaining_crown_pct === '95', 'ams: the form opens with the stored values');
// The protocol's rules (registry Health, pages in forestgeoAms2021.ts).
const codesOf = (stems) => amsIssues(amsForm(stems)).map((i) => i.code);
ok(codesOf([{ dbh: '5', ams: { survival_status: 'A', mode: ['S', 'B'] } }]).includes('ams_mode_b_and_s'), 'ams: B with S is an error (p.4)');
ok(codesOf([{ dbh: '5', ams: { survival_status: 'A', mode: ['U'] } }]).includes('ams_uprooted_needs_leaning'), 'ams: U needs a leaning (p.4)');
ok(!codesOf([{ dbh: '5', ams: { survival_status: 'A', mode: ['U', 'B'], leaning_deg: '?' } }]).includes('ams_uprooted_needs_leaning'), 'ams: … "?" counts as filled; U with B is fine');
ok(codesOf([{ dbh: '5', ams: { survival_status: 'OK', mode: ['B'], remaining_crown_pct: '60' } }]).filter((c) => c.startsWith('ams_ok')).length === 2, 'ams: OK with damage or a lost crown is to confirm (p.3)');
ok(codesOf([{ dbh: '', ams: { survival_status: 'X', living_length_m: '3' } }]).includes('ams_x_with_living_length'), 'ams: X with a living length is to confirm (p.3)');
ok(codesOf([{ dbh: '5', ams: { survival_status: 'A', leaves_pct: 'lots' } }]).includes('ams_not_a_number'), 'ams: text in a number is an error');
ok(codesOf([{ dbh: '5', ams: { survival_status: 'A', leaves_pct: '120' } }]).includes('ams_above_max'), 'ams: a percent above 100 is an error');
ok(codesOf([{ dbh: '5', ams: { survival_status: 'A', remaining_crown_pct: 'NA' } }]).length === 0, 'ams: NA is a valid remaining crown (no crown, p.6)');
const am = av.stems[0].measure.id;
throwsCode(() => s.setStemAms(ctx, am, { survival_status: 'Z' }), 'bad_code', 'ams: an unknown survival code is refused');
throwsCode(() => s.setStemAms(ctx, am, { crown_illumination: '6' }), 'bad_code', 'ams: an illumination outside 1–5 is refused');
throwsCode(() => s.setStemAms(ctx, am, { colour: 'red' }), 'bad_code', 'ams: an unknown variable is refused');
throwsCode(() => s.setStemAms(ctx, am, { leaves_pct: -5 }), 'bad_code', 'ams: a negative percent is refused');
// Overview and lists agree on an AMS census (stem death from AMS).
const a2 = s.saveTreeDraft(ctx, A1, tf.formToDraft(amsForm([{ dbh: '', ams: { survival_status: 'D', mode: ['S'] } }], { x: 7, y: 7 }), null, { surveyId: A1, recordedBy: 'A' }));
const aSql = new Map(s.censusTreeStates(ctx, A1).map((t) => [t.id, t]));
for (const v of s.loadCensus(ctx, A1)) {
  const f = r.treeFlags(v, A1, false);
  const q = aSql.get(v.individual.id);
  ok(f.done === q.done && f.deadNow === q.deadNow && f.isNew === q.isNew, `ams: flags of tree ${v.individual.tag} agree with SQL (${JSON.stringify(f)} vs ${JSON.stringify(q)})`);
}
ok(aSql.get(a2).deadNow && aSql.get(a2).done, 'ams: a tree whose only stem is AMS D is dead and done');
// Conflicts reach the screening: AMS D on one stem, A on another; the stem-death switch on an AMS-alive stem.
const conflictCodes = (id) => r.treeIssues(s.loadTree(ctx, A1, id), { surveyId: A1, firstCensus: true, thresholdCm: 1 }).map((i) => i.code);
const a3 = s.saveTreeDraft(ctx, A1, tf.formToDraft(amsForm([{ dbh: '', ams: { survival_status: 'D' } }, { dbh: '4', ams: { survival_status: 'A' } }], { x: 9, y: 9 }), null, { surveyId: A1, recordedBy: 'A' }));
ok(conflictCodes(a3).includes('ams_dead_individual_but_stem_alive'), 'ams: D on one stem and A on another is a conflict');
s.updateMeasure(ctx, s.loadTree(ctx, A1, a3).stems[1].measure.id, { stemDead: true });
ok(conflictCodes(a3).includes('stem_dead_but_ams_alive'), 'ams: the stem-death switch on a stem AMS calls alive is a conflict');
// Clearing, and a census without AMS leaving AMS rows alone.
af = tf.formFromView(s.loadTree(ctx, A1, aid), { quadrat: '0000', geometry: ag, amsOn: true });
s.saveTreeDraft(ctx, A1, tf.formToDraft({ ...af, stems: af.stems.map((x, i) => (i === 0 ? { ...x, ams: { survival_status: 'A' } } : x)) }, s.loadTree(ctx, A1, aid), { surveyId: A1, recordedBy: 'A' }));
ok(JSON.stringify(s.loadTree(ctx, A1, aid).stems[0].ams) === '{"survival_status":"A"}', 'ams: variables left out of the form are cleared');
const plain = tf.formToDraft(tf.formFromView(s.loadTree(ctx, A1, aid), { quadrat: '0000', geometry: ag }), s.loadTree(ctx, A1, aid), { surveyId: A1, recordedBy: 'A' });
ok(plain.stems.every((x) => !('ams' in x)), 'ams: a form without AMS sends no AMS (its rows stay)');

// ── slices: restore (quadrat versions, undo) ─────────────────────────────
const R = s.createFrame(ctx, { code: 'R1', sizeXM: 40, sizeYM: 20 });
const R1 = s.startCensus(ctx, { frameId: R, template: T });
const xy = (x, y) => ({ method: 'xy', x, y });
const ra = s.saveTreeDraft(ctx, R1, draft({ location: xy(2, 2), mainStemNo: 1, stems: [sd({ dbhCm: 10 })] }));
const rb = s.saveTreeDraft(ctx, R1, draft({ location: xy(5, 5), mainStemNo: 1, stems: [sd({ dbhCm: 20 }), sd({ dbhCm: 4 })] }));
const rc = s.saveTreeDraft(ctx, R1, draft({ location: xy(25, 5), mainStemNo: 1, stems: [sd({ dbhCm: 30 })] })); // quadrat 0100
s.finishCensus(ctx, R1);
const R2 = s.startCensus(ctx, { frameId: R, template: T });
const mOfTree = (sid, tid, no = 1) => one(`SELECT m.* FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE m.survey_id = ? AND st.individual_id = ? AND st.stem_no = ?`, sid, tid, no);
s.saveTreeDraft(ctx, R2, { ...asDraft(s.loadTree(ctx, R2, ra)), stems: [sd({ stemNo: 1, dbhCm: 10.5 })], mainStemNo: 1 });
const snap = sl.buildSlice(ctx, R2, ['0000']);
const side = sl.censusSide(snap);
ok(side.tree.length === 2 && side.measure.length === 1 && side.measure[0].key === snap.stems.find((st) => st.tree_uuid === s.getIndividual(ctx, ra).uuid).uuid, 'slice: quadrat 0000 holds its two trees; a measurement is keyed by its stem');
ok(side.fgquadrat[0].key === '0000' && side.tree.every((r) => r.dupKey?.startsWith('tag:')), 'slice: quadrats keyed by code, trees carry their tag for duplicates');
// edits after the snapshot
s.saveTreeDraft(ctx, R2, { ...asDraft(s.loadTree(ctx, R2, ra)), stems: [sd({ stemNo: 1, dbhCm: 11 }), sd({ dbhCm: 2 })], mainStemNo: 1 }); // DBH + new stem
s.setTreeCodes(ctx, R2, rb, ['DS']);
s.setHeight(ctx, R2, rb, 18);
s.correctIndividual(ctx, rb, { taxon: taxon('rb2') }, meta(R2));
const recruitR = s.saveTreeDraft(ctx, R2, draft({ location: xy(8, 8), mainStemNo: 1, stems: [sd({ dbhCm: 3 })] }));
s.correctIndividual(ctx, ra, { location: xy(30, 10) }, meta(R2)); // moved out to 0100
s.correctIndividual(ctx, rc, { location: xy(15, 15) }, meta(R2)); // an older tree moved in
tx(() => sl.restoreSlice(ctx, R2, snap));
ok(mOfTree(R2, ra).dbh_cm === 10.5, `restore: DBH back (${mOfTree(R2, ra)?.dbh_cm})`);
ok(count('fw_stems', 'individual_id = ?', ra) === 1, 'restore: the stem added after the snapshot is gone');
ok(s.treeCodes(ctx, R2, rb).length === 0 && s.heightOf(ctx, R2, rb) == null, 'restore: codes and height added after it are gone');
ok(s.getIndividual(ctx, rb).taxon_id === 'k1' && count('fw_individual_history', "individual_id = ? AND field = 'taxon'", rb) === 1, 'restore: species back; the correction stays in the history');
ok(s.getIndividual(ctx, recruitR) == null, 'restore: a tree added after the snapshot is gone');
ok(s.getIndividual(ctx, ra).quadrat_code === '0000' && s.getIndividual(ctx, ra).x_m === 2, 'restore: a tree that moved out comes back');
ok(s.getIndividual(ctx, rc) != null && s.getIndividual(ctx, rc).quadrat_code === '0000', 'restore: an older tree that moved in stays');
ok(mOfTree(R1, rb, 2).dbh_cm === 4, 'restore: other censuses untouched');
let again = 0;
tx(() => {
  again = sl.restoreSlice(ctx, R2, sl.buildSlice(ctx, R2, ['0000'], [s.getIndividual(ctx, rc).uuid]));
});
ok(again === 0, `restore: restoring the current state changes nothing (${again} ops)`);
ok(Object.values(sl.CENSUS_COMBINERS.fgquadrat).length === 3, 'slice: quadrat times and recorders combine');
const emptySnap = sl.buildSlice(ctx, K2, ['0001']);
const first = s.saveTreeDraft(ctx, K2, draft({ location: xy(4, 24), mainStemNo: 1, stems: [sd({ dbhCm: 5 })] }));
ok(s.getIndividual(ctx, first).quadrat_code === '0001', '(first tree of an empty quadrat)');
tx(() => sl.restoreSlice(ctx, K2, emptySnap));
ok(s.getIndividual(ctx, first) == null && count('fw_survey_quadrats', "survey_id = ? AND quadrat_code = '0001'", K2) === 0, 'restore: undoing the first tree of an empty quadrat removes it (the slice keeps its scope)');

// recovering a deleted census from its header and quadrat slices
s.setFgQuadratStatus(ctx, R2, '0100', 'done');
const recruitR2 = s.saveTreeDraft(ctx, R2, draft({ location: xy(28, 12), mainStemNo: 1, stems: [sd({ dbhCm: 6 })] }));
const recruitUuid = s.getIndividual(ctx, recruitR2).uuid;
const header = sl.censusHeaderDoc(ctx, R2);
const kept = header.quadrats.map((q) => sl.buildSlice(ctx, R2, [q.quadrat_code]));
const r2uuid = header.survey.uuid;
const before = { trees: count('fw_individuals', 'frame_id = ?', R), measures: count('fw_stem_measures', 'survey_id = ?', R2) };
ok(header.quadrats.map((q) => q.quadrat_code).join() === '0000,0100', `recover: the header lists the quadrats with data (${header.quadrats.map((q) => q.quadrat_code)})`);
s.deleteCensus(ctx, R2);
ok(s.getIndividual(ctx, recruitR2) == null, 'recover: (deleting took the recruit)');
const R2b = s.startCensus(ctx, { frameId: R, template: T });
throwsCodeOf(() => tx(() => sl.recoverCensus(ctx, header, kept)), sl.RecoverCensusError, 'census_no_taken', 'recover: refused while another census has its number');
s.deleteCensus(ctx, R2b);
let back = 0;
tx(() => {
  back = sl.recoverCensus(ctx, header, kept);
});
ok(s.getSurvey(ctx, back).uuid === r2uuid && s.getSurvey(ctx, back).census_no === 2, 'recover: same uuid and census number');
ok(header.survey.status === 'active' && s.getSurvey(ctx, back).status === 'done', 'recover: a census deleted while active comes back finished');
ok(count('fw_individuals', 'frame_id = ?', R) === before.trees && count('fw_stem_measures', 'survey_id = ?', back) === before.measures, 'recover: every tree and measurement is back');
ok(one('SELECT first_survey_id AS f FROM fw_individuals WHERE uuid = ?', recruitUuid)?.f === back, 'recover: the recruit is back (same uuid), first seen in this census');
ok(one(`SELECT status FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = '0100'`, back).status === 'done', 'recover: quadrat status kept');
ok(one(`SELECT uuid FROM fw_survey_quadrats WHERE survey_id = ? AND quadrat_code = '0000'`, back).uuid === header.quadrats[0].uuid, 'recover: quadrats keep their uuids (their versions match again)');

// ── deleting a census ────────────────────────────────────────────────────
throwsCode(() => s.deleteCensus(ctx, C1), 'not_latest_census', 'delete: only the latest census of a series');
const c1Measures = count('fw_stem_measures', 'survey_id = ?', C1);
s.deleteCensus(ctx, C2);
ok(s.getSurvey(ctx, C2) == null && count('fw_survey_quadrats', 'survey_id = ?', C2) === 0, 'delete: census and its quadrat rows gone');
ok(s.getIndividual(ctx, recruit.id) == null && count('fw_stems', 'id = ?', s13) === 0, 'delete: its recruits and new stems gone');
ok(count('fw_stem_measures', 'survey_id = ?', C1) === c1Measures && mOf(C1, s11).dbh_cm === 12.3, 'delete: census 1 untouched');
ok(count('fw_individual_values', 'survey_id = ?', C2) === 0, 'delete: its values gone');
ok(one(`SELECT survey_id FROM fw_individual_history WHERE new_value LIKE '%t1b%'`).survey_id == null, 'delete: corrections keep their history, census unlinked');
const C3 = s.startCensus(ctx, { frameId: F, template: T });
ok(s.getSurvey(ctx, C3).census_no === 2, 'delete: the number is free again');

// ── integrity ────────────────────────────────────────────────────────────
for (const [table, where] of CASCADE_ORPHANS) {
  if (!table.startsWith('fw_')) continue;
  ok(count(table, where) === 0, `integrity: no ${table} orphans`);
}
s.deleteCensus(ctx, C3);
s.deleteCensus(ctx, C1);
ok(
  count('fw_individuals', 'frame_id = ?', F) === 0 && count('fw_individual_history', 'individual_id NOT IN (SELECT id FROM fw_individuals)') === 0,
  'delete: the first census takes every tree it added, with their history',
);
s.deleteFrame(ctx, F);
ok(s.getFrame(ctx, F) == null && count('fw_frame_series', 'frame_id = ?', F) === 0, 'frame: deleted once it has no census');
ok(count('fw_individuals', 'frame_id = ?', G) === 4, 'frame: other frames untouched');
for (const [table, where] of CASCADE_ORPHANS) {
  if (!table.startsWith('fw_')) continue;
  ok(count(table, where) === 0, `integrity: no ${table} orphans after deletes`);
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-db: frames, censuses, trees, stems, codes and deletes hold on the real schema');
