/**
 * Checklist and plot-style surveys and the template store on the database
 * (v83, src/survey/db/surveyCore.ts, templatesCore.ts; Modular_survey.md §5.2,
 * §5.5, §7.1), on the real migrated schema with foreign keys ON.
 *
 * What must hold:
 *   - the v83 CHECKs: a census needs a frame, series and number; frame,
 *     series and number come together; style is one of three;
 *   - the census code sees censuses only: a checklist survey is not a census,
 *     and a plot-style survey on a frame is not listed with its censuses;
 *   - saving a template gives the next version, equal content adds nothing,
 *     required components are put in, built-ins and invalid ones are refused;
 *   - a survey upgrades only on an additive change to a newer version;
 *   - a checklist has no frame; a plot-style survey on a frame joins the
 *     frame's series and is numbered in it;
 *   - single-active: a new or reopened survey ends every other open record
 *     except tree censuses; a new session or plot ends an open survey;
 *   - units: levels from the snapshot, parents on a higher level of the same
 *     survey, codes unique per level; on a frame they mirror the frame's
 *     layout (copied at start without retired units, added units join the
 *     frame); a used frame unit keeps code, parent and geometry and cannot be
 *     deleted, only retired;
 *   - occurrences: their unit is in the same survey; a recheck is blind until
 *     the blind phase is closed, the earlier list is refused until then; a
 *     first survey and a checklist have no phase;
 *   - values: set, change in place, clear (row gone), per index;
 *   - components (2B): every component a plot can hold writes and reads back
 *     on its owner (columns, values tables per layer, media), two Traits
 *     components stay apart, writing stamps the owner; values that cannot be
 *     stored, components of another level or unit level, unknown fields and
 *     media outside addMedia are refused;
 *   - morphospecies: listed / new / none, no duplicates;
 *   - deleting a unit moves its occurrences and sub-units up; deleting a
 *     survey takes its units, occurrences, values and photos, never the
 *     frame's layout or labels, nor any census row;
 *   - nothing is left for the integrity sweep; an empty fw_units does not make
 *     the fw_media rule sweep census photos.
 *
 * Run: npm run check:survey-core
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { closeActiveRecords } from '../src/db/activeRecords.ts';
import { CASCADE_ORPHANS } from '../src/db/integrityRules.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as tp from '../src/survey/db/templatesCore.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { withRequired } from '../src/survey/template/validate.ts';
import { childLevel, unitPath, unitRows } from '../src/survey/form/units.ts';
import { recheckCandidates, recheckKey, recheckOpen } from '../src/survey/form/recheck.ts';
import { blankOccurrenceHasErrors, formComponents } from '../src/survey/form/occurrenceForm.ts';
import { SAMPLE_TEMPLATES, SAMPLE_TEMPLATES_OFFERED } from '../src/survey/templates/samples.ts';
import { validateTemplate } from '../src/survey/template/validate.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const throwsCode = (fn, code, msg) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof s.SurveyError && e.code === code, `${msg} (threw ${e.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};

const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
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
const all = (sql, ...a) => sqlite.prepare(sql).all(...a);
const count = (table, where = '1', ...a) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).n;
const rejects = (sql, msg) => {
  try {
    sqlite.prepare(sql).run();
  } catch {
    return;
  }
  ok(false, `${msg} (was accepted)`);
};
let clock = 1000;
let n = 0;
const ctx = { db, now: () => ++clock, uuid: () => `u-${++n}` };
const statusOf = (table, id) => one(`SELECT status FROM ${table} WHERE id = ?`, id).status;
const sweepCount = (table) => count(table, CASCADE_ORPHANS.find(([t]) => t === table)[1]);

// ── a census first: everything below must leave it alone ─────────────────
const F = s.createFrame(ctx, { code: 'P1', sizeXM: 40, sizeYM: 40 });
const C1 = s.startCensus(ctx, { frameId: F, template: STEMMAP_TEMPLATE });
const tree = s.addIndividual(ctx, { surveyId: C1, taxon: { taxonId: 't1' }, location: { method: 'grid', quadrat: '0000', localX: 1, localY: 1 } });
s.addTreeMedia(ctx, C1, tree.id, 'file:///photos/tree.jpg');
// The bug v83 nearly shipped: with fw_units empty, `unit_id NOT IN (…)` is true for NULL.
ok(count('fw_units') === 0 && sweepCount('fw_media') === 0, 'sweep: an empty fw_units does not make a census photo an orphan');
const censusRows = () => ['fw_surveys', 'fw_individuals', 'fw_stems', 'fw_stem_measures', 'fw_media'].map((t) => count(t, t === 'fw_surveys' ? `style = 'individual'` : '1'));
const censusBefore = censusRows();

// ── v83 CHECKs ───────────────────────────────────────────────────────────
const S0 = one(`SELECT series_id FROM fw_surveys WHERE id = ?`, C1).series_id;
const ins = (cols) =>
  `INSERT INTO fw_surveys (uuid, style, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at)
   VALUES ('${cols.uuid}', '${cols.style}', ${cols.frame}, ${cols.series}, ${cols.no}, 'x', 1, '{}', 'h', 1, 1, 1)`;
rejects(ins({ uuid: 'k1', style: 'individual', frame: 'NULL', series: 'NULL', no: 'NULL' }), 'schema: a census needs a frame');
rejects(ins({ uuid: 'k2', style: 'plot', frame: F, series: 'NULL', no: 'NULL' }), 'schema: a frame comes with a series');
rejects(ins({ uuid: 'k3', style: 'plot', frame: F, series: S0, no: 'NULL' }), 'schema: a series comes with a number');
rejects(ins({ uuid: 'k4', style: 'plot', frame: 'NULL', series: 'NULL', no: 2 }), 'schema: no number without a series');
rejects(ins({ uuid: 'k5', style: 'transect', frame: 'NULL', series: 'NULL', no: 'NULL' }), 'schema: style is one of three');
sqlite.prepare(ins({ uuid: 'k6', style: 'checklist', frame: 'NULL', series: 'NULL', no: 'NULL' })).run();
ok(count('fw_surveys', `uuid = 'k6'`) === 1, 'schema: a checklist without a frame goes in (the refusals above are the CHECKs)');
sqlite.prepare(`DELETE FROM fw_surveys WHERE uuid = 'k6'`).run();

// ── templates ────────────────────────────────────────────────────────────
const bare = (style, over = {}) => ({ schema: 1, id: `user:${style}`, version: 1, origin: 'user', name: { text: style }, style, components: [], codelists: [], quick_add: true, ...over });
const UNITS = [
  { key: 'subplot', label: { text: '小區' } },
  { key: 'quadrat', label: { text: '小樣方' } },
];
const CL1 = tp.saveTemplate(ctx, bare('checklist'));
ok(CL1.version === 1 && CL1.components.some((x) => x.type === 'taxon' && x.level === 'occurrence'), 'template: first save is version 1, required components put in');
ok(tp.saveTemplate(ctx, { ...CL1, version: 7 }).version === 1 && count('survey_templates', `template_id = 'user:checklist'`) === 1, 'template: equal content adds no version');
const CL2 = tp.saveTemplate(ctx, { ...CL1, name: { text: '快速名錄' } });
ok(CL2.version === 2 && tp.getTemplate(ctx, 'user:checklist').name.text === '快速名錄', 'template: a change is the next version, and the latest is read');
ok(tp.getTemplate(ctx, 'user:checklist', 1).name.text === 'checklist', 'template: an older version stays readable');
ok(tp.getTemplate(ctx, 'builtin:stemmap') === STEMMAP_TEMPLATE && tp.getTemplate(ctx, 'builtin:stemmap', 99) == null, 'template: built-ins come from code');
throwsCode(() => tp.saveTemplate(ctx, { ...STEMMAP_TEMPLATE, origin: 'user' }), 'builtin_template', 'template: a built-in id cannot be saved over');
throwsCode(() => tp.saveTemplate(ctx, bare('plot')), 'template_invalid', 'template: an invalid one is refused (plot without unit levels)');
const PL = tp.saveTemplate(ctx, bare('plot', { units: UNITS }));
ok(
  JSON.stringify(tp.listTemplates(ctx).map((t) => `${t.id}@${t.version}`)) === JSON.stringify(['builtin:stemmap@1', 'user:checklist@2', 'user:plot@1']),
  `template: list is built-ins, then the latest of each (${tp.listTemplates(ctx).map((t) => `${t.id}@${t.version}`)})`,
);

// ── checklist surveys and single-active ──────────────────────────────────
sqlite.prepare(`INSERT INTO sessions (id, uuid, name, type, project_id, started_at, status) VALUES (1, 's1', 'S', 'checklist', 0, 1, 'active')`).run();
sqlite.prepare(`INSERT INTO plot_surveys (id, uuid, plotid, project_id, status, created_at, updated_at) VALUES (1, 'p1', 'P', 0, 'active', 1, 1)`).run();
throwsCode(() => c.createSurvey(ctx, { template: STEMMAP_TEMPLATE }), 'wrong_style', 'survey: a census is started with startCensus');
throwsCode(() => c.createSurvey(ctx, { template: CL2, frameId: F }), 'frame_not_allowed', 'survey: a checklist has no frame');
const K1 = c.createSurvey(ctx, { template: CL2, investigators: 'A' });
const k1 = c.getFwSurvey(ctx, K1);
ok(k1.style === 'checklist' && k1.frame_id == null && k1.series_id == null && k1.census_no == null && k1.status === 'active', 'survey: checklist without frame, series or number');
ok(k1.template_snapshot === JSON.stringify(CL2), 'survey: keeps the template snapshot');
ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(k1.name ?? ''), `name (v84): without a frame, the start time as a session is named (${k1.name})`);
ok(c.getActiveSurvey(ctx)?.id === K1, 'active: the open checklist survey');
ok(statusOf('sessions', 1) === 'done' && statusOf('plot_surveys', 1) === 'done', 'single-active: starting a survey ends the open session and plot');
ok(statusOf('fw_surveys', C1) === 'active', 'single-active: the tree census stays open');
const K2 = c.createSurvey(ctx, { template: CL2 });
ok(statusOf('fw_surveys', K1) === 'done' && statusOf('fw_surveys', K2) === 'active', 'single-active: a second survey ends the first');
c.reopenSurvey(ctx, K1);
ok(statusOf('fw_surveys', K1) === 'active' && statusOf('fw_surveys', K2) === 'done' && statusOf('fw_surveys', C1) === 'active', 'single-active: reopening ends the other survey, not the census');
closeActiveRecords(db, ctx.now());
ok(statusOf('fw_surveys', K1) === 'done' && statusOf('fw_surveys', C1) === 'active', 'single-active: a new session or plot ends an open survey, not the census');
ok(c.getActiveSurvey(ctx) == null, 'active: an open census is not the open survey');
// The end time a finish records (chooseEndTime): none given, now unless one exists; null, as it is; a time, that time.
c.reopenSurvey(ctx, K2);
c.finishSurvey(ctx, K2, null);
ok(statusOf('fw_surveys', K2) === 'done' && c.getFwSurvey(ctx, K2).stop_ts == null, 'finish: null leaves the end time blank');
c.reopenSurvey(ctx, K2);
c.finishSurvey(ctx, K2, 4242);
ok(c.getFwSurvey(ctx, K2).stop_ts === 4242, 'finish: a chosen time is recorded');
c.reopenSurvey(ctx, K2);
const beforeFinish = clock;
c.finishSurvey(ctx, K2);
ok(c.getFwSurvey(ctx, K2).stop_ts > beforeFinish, 'finish: none given records now (reopening cleared the old one)');
ok(s.getSurvey(ctx, K1) == null, 'census code: a checklist survey is not a census');
throwsCode(() => c.updateSurvey(ctx, C1, { notes: 'x' }), 'wrong_style', 'survey code: a census is not its business');
c.updateSurvey(ctx, K1, { notes: '晴', lat: 24.1 });
ok(c.getFwSurvey(ctx, K1).notes === '晴' && c.getFwSurvey(ctx, K1).lat === 24.1, 'survey: notes and position update');
c.updateSurvey(ctx, K1, { name: ' 晨間名錄 ' });
ok(c.getFwSurvey(ctx, K1).name === '晨間名錄', 'name: renamed, trimmed');
throwsCode(() => c.updateSurvey(ctx, K1, { name: '  ' }), 'bad_value', 'name: never empty');

// ── checklist occurrences ────────────────────────────────────────────────
throwsCode(() => c.addUnit(ctx, K1, { levelKey: 'subplot', code: '1' }), 'wrong_style', 'units: a checklist has none');
const o1 = c.addOccurrence(ctx, K1, { taxon_id: 't5', organism_quantity: '3', organism_quantity_type: 'individuals', recorded_by: 'A' });
const occ1 = c.getOccurrence(ctx, o1);
ok(occ1.phase == null && occ1.unit_id == null && occ1.organism_quantity === '3' && occ1.observed_at > 0, 'occurrence: checklist, no phase, stamped');
throwsCode(() => c.addOccurrence(ctx, K1, { taxon_id: ' ' }), 'not_found', 'occurrence: needs a taxon');
c.updateOccurrence(ctx, o1, { notes: '幼苗', organism_quantity: '4' });
ok(c.getOccurrence(ctx, o1).notes === '幼苗' && c.getOccurrence(ctx, o1).organism_quantity === '4', 'occurrence: updates');
throwsCode(() => c.updateOccurrence(ctx, o1, { taxon_id: '' }), 'not_found', 'occurrence: the taxon cannot be emptied');

// ── values ───────────────────────────────────────────────────────────────
const occOwner = { kind: 'occurrence', id: o1 };
c.setValue(ctx, occOwner, 'traits', 'leaf_len', { num: 3.5, unit: 'cm' });
const v1 = c.listValues(ctx, occOwner);
c.setValue(ctx, occOwner, 'traits', 'leaf_len', { num: 4, unit: 'cm' });
const v2 = c.listValues(ctx, occOwner);
ok(v1.length === 1 && v2.length === 1 && v2[0].value_num === 4 && v2[0].uuid === v1[0].uuid, 'values: set, then changed in place (same uuid)');
c.setValue(ctx, occOwner, 'traits', 'leaf_len', { num: 5 }, 1);
ok(c.listValues(ctx, occOwner).length === 2, 'values: a second index is a second row');
c.setValue(ctx, occOwner, 'traits', 'leaf_len', null);
c.setValue(ctx, occOwner, 'traits', 'leaf_len', { text: '' }, 1);
ok(c.listValues(ctx, occOwner).length === 0, 'values: cleared values leave no row');
c.setValue(ctx, { kind: 'survey', id: K1 }, 'environment', 'weather', { text: 'sunny' });
ok(count('fw_survey_values', 'survey_id = ?', K1) === 1, 'values: on the survey');
throwsCode(() => c.setValue(ctx, { kind: 'occurrence', id: 9999 }, 'a', 'b', { num: 1 }), 'not_found', 'values: the owner must exist');
throwsCode(() => c.setValue(ctx, { kind: 'survey', id: C1 }, 'a', 'b', { num: 1 }), 'wrong_style', 'values: not on a census through this path');

// ── plot style on a frame ────────────────────────────────────────────────
const fu = (code, levelKey, parentId = null, more = {}) => c.addFrameUnit(ctx, F, { levelKey, code, parentId, ...more });
const FS1 = fu('S1', 'subplot', null, { shape: 'rect', widthM: 10, lengthM: 10 });
const FS2 = fu('S2', 'subplot');
const FQ1 = fu('Q1', 'quadrat', FS1);
const FQ9 = fu('Q9', 'quadrat', FS1);
const FX = fu('X1', 'transect');
c.setFrameUnitRetired(ctx, FQ9, true);
throwsCode(() => fu('S1', 'subplot'), 'unit_taken', 'frame units: code unique per level');
ok(fu('S1', 'quadrat') > 0, 'frame units: the same code on another level is fine');
throwsCode(() => c.addFrameUnit(ctx, F, { levelKey: 'quadrat', code: 'Q7', parentId: 9999 }), 'bad_unit', 'frame units: the parent is in the same frame');
throwsCode(() => c.createSurvey(ctx, { template: PL, frameId: F }), 'series_code_required', 'plot survey: a second series on a frame needs a code');
ok(c.seriesCodeNeeded(ctx, F, PL.id) && !c.seriesCodeNeeded(ctx, F, STEMMAP_TEMPLATE.id), 'series: a new template on a used frame needs a code, the census series does not');
const P1 = c.createSurvey(ctx, { template: PL, frameId: F, seriesCode: 'veg' });
const p1 = c.getFwSurvey(ctx, P1);
ok(!c.seriesCodeNeeded(ctx, F, PL.id), 'series: once it exists, no code is asked');
ok(p1.name === 'P1' && c.getActiveSurvey(ctx)?.id === P1, 'name: on a frame, the frame code; the open survey is it');
ok(p1.style === 'plot' && p1.frame_id === F && p1.series_id !== S0 && p1.census_no === 1, 'plot survey: own series on the frame, number 1');
ok(statusOf('fw_surveys', C1) === 'active' && statusOf('fw_surveys', K2) === 'done', 'plot survey: single-active spares the census');
ok(s.listCensuses(ctx, F).every((x) => x.style === 'individual') && s.listCensuses(ctx, F).length === 1, 'census code: a plot survey on the frame is not listed as a census');
ok(s.frameHasSurveys(ctx, F), 'frame: has surveys');
const u1 = c.listUnits(ctx, P1);
const unitBy = (code, list = u1) => list.find((u) => u.code === code);
ok(
  JSON.stringify(u1.map((u) => `${u.level_key}:${u.code}`)) === JSON.stringify(['subplot:S1', 'subplot:S2', 'quadrat:Q1', 'quadrat:S1']),
  `plot survey: copies the frame layout on its levels, top first, without retired ones (${u1.map((u) => `${u.level_key}:${u.code}`)})`,
);
ok(unitBy('Q1').parent_id === unitBy('S1').id && unitBy('Q1').frame_unit_id === FQ1, 'plot survey: copied units keep their parent and frame unit');
ok(c.frameUnitUsed(ctx, FS1) && !c.frameUnitUsed(ctx, FX), 'frame units: used once a survey has them');
throwsCode(() => c.updateFrameUnit(ctx, FS1, { code: 'S1b' }), 'frame_unit_locked', 'frame units: a used one keeps its code');
throwsCode(() => c.updateFrameUnit(ctx, FS1, { widthM: 20 }), 'frame_unit_locked', 'frame units: a used one keeps its geometry');
throwsCode(() => c.deleteFrameUnit(ctx, FS1), 'frame_unit_locked', 'frame units: a used one cannot be deleted');
c.updateFrameUnit(ctx, FS1, { label: '東北角' });
ok(c.getFrameUnit(ctx, FS1).label === '東北角', 'frame units: the label stays editable');
const FY = fu('Y1', 'transect');
const FY2 = fu('Y2', 'transect', FY);
c.updateFrameUnit(ctx, FY, { code: 'Y0', widthM: 2 });
ok(c.getFrameUnit(ctx, FY).code === 'Y0', 'frame units: an unused one can change');
c.deleteFrameUnit(ctx, FY);
ok(c.getFrameUnit(ctx, FY) == null && c.getFrameUnit(ctx, FY2).parent_id == null, 'frame units: an unused one is deleted, its children move up');

// Units added during the survey join the frame.
const Q2 = c.addUnit(ctx, P1, { levelKey: 'quadrat', code: 'Q2', parentId: unitBy('S2').id, frameUnit: { shape: 'circle', radiusM: 1 } });
const fq2 = one(`SELECT * FROM fw_frame_units WHERE frame_id = ? AND code = 'Q2'`, F);
ok(fq2 && fq2.parent_id === FS2 && fq2.shape === 'circle' && c.getUnit(ctx, Q2).frame_unit_id === fq2.id, 'units: a unit added on a frame joins its layout');
throwsCode(() => c.addUnit(ctx, P1, { levelKey: 'quadrat', code: 'Q2' }), 'unit_taken', 'units: code unique per level in a survey');
throwsCode(() => c.addUnit(ctx, P1, { levelKey: 'quadrat', code: 'Q9' }), 'unit_taken', 'units: a retired frame code is not reused');
throwsCode(() => c.addUnit(ctx, P1, { levelKey: 'transect', code: 'T1' }), 'bad_unit', 'units: only the template levels');
throwsCode(() => c.addUnit(ctx, P1, { levelKey: 'subplot', code: 'S3', parentId: unitBy('Q1').id }), 'bad_unit', 'units: a parent sits on a higher level');
throwsCode(() => c.addUnit(ctx, P1, { levelKey: 'quadrat', code: 'Q3', parentId: unitBy('Q1').id }), 'bad_unit', 'units: not on the same level');
throwsCode(() => c.updateUnit(ctx, unitBy('Q1').id, { code: 'Q1b' }), 'frame_unit_locked', 'units: on a frame the code is the frame unit’s');
c.updateUnit(ctx, unitBy('Q1').id, { notes: '石塊多', lat: 24.2 });
ok(c.getUnit(ctx, unitBy('Q1').id).notes === '石塊多', 'units: notes and position update');

// Occurrences in a first survey on a frame: no phase.
const oA = c.addOccurrence(ctx, P1, { taxon_id: 't7', unit_id: unitBy('Q1').id, layer: 'E1' });
const oB = c.addOccurrence(ctx, P1, { taxon_id: 't8', verbatim_identification: 'sp1', unit_id: unitBy('S2').id });
ok(c.getOccurrence(ctx, oA).phase == null && !c.hasBlindPhase(ctx, P1), 'phase: a first survey has none');
throwsCode(() => c.closeBlindPhase(ctx, P1), 'no_blind_phase', 'phase: nothing to close in a first survey');
throwsCode(() => c.closeBlindPhase(ctx, K1), 'no_blind_phase', 'phase: nothing to close in a checklist');
throwsCode(() => c.addOccurrence(ctx, K1, { taxon_id: 't7', unit_id: unitBy('Q1').id }), 'bad_unit', 'occurrence: the unit is in the same survey');
ok(c.previousOccurrences(ctx, P1).length === 0, 'phase: a first survey has no earlier list');
c.setValue(ctx, { kind: 'unit', id: unitBy('S2').id }, 'cover', 'rock_pct', { num: 20 });
sqlite.prepare(`INSERT INTO fw_media (uuid, survey_id, occurrence_id, component, kind, uri, created_at) VALUES ('m-o', ?, ?, 'photos', 'photo', 'file:///photos/o.jpg', 1)`).run(P1, oB);
sqlite.prepare(`INSERT INTO fw_media (uuid, survey_id, unit_id, component, kind, uri, created_at) VALUES ('m-u', ?, ?, 'photos', 'photo', 'file:///photos/u.jpg', 1)`).run(P1, unitBy('S2').id);

// Morphospecies.
const L1 = c.addFrameLabel(ctx, F, { taxonId: 't8', verbatim: ' sp1 ', firstSurveyId: P1 });
ok(c.frameLabelStatus(ctx, P1, 't8', 'sp1') === 'listed' && c.frameLabelStatus(ctx, P1, 't8', 'sp2') === 'new', 'labels: listed / new');
ok(c.frameLabelStatus(ctx, K1, 't8', 'sp1') === 'none' && c.frameLabelStatus(ctx, P1, 't8', null) === 'none', 'labels: none without a frame or a label');
throwsCode(() => c.addFrameLabel(ctx, F, { taxonId: 't8', verbatim: 'sp1' }), 'label_taken', 'labels: no duplicates');
c.updateFrameLabel(ctx, L1, { note: '葉背有毛', photoUri: 'file:///photos/sp1.jpg' });
ok(c.listFrameLabels(ctx, F)[0].note === '葉背有毛', 'labels: note and photo update');

const oX = c.addOccurrence(ctx, P1, { taxon_id: 't9' });
c.addOccurrence(ctx, P1, { taxon_id: 't10', unit_id: unitBy('S1').id });
const listed = c.listSurveys(ctx, { frameId: F });
ok(listed.length === 1 && listed[0].id === P1 && listed[0].species_count === 4 && listed[0].occurrence_count === 4 && listed[0].frame_code === 'P1', 'list: a frame’s plot-style surveys with counts, no census');
ok(c.listSurveys(ctx).every((x) => x.style !== 'individual') && c.listSurveys(ctx).length === 3, 'list: every checklist / plot-style survey');
ok(c.findOccurrence(ctx, P1, unitBy('S2').id, 't8', ' sp1 ')?.id === oB && c.findOccurrence(ctx, P1, null, 't8', 'sp1') == null, 'find: same taxon and label in the same unit only');

// ── a recheck: blind, then recheck ───────────────────────────────────────
c.finishSurvey(ctx, P1);
c.setFrameUnitRetired(ctx, FS1, true);
const P2 = c.createSurvey(ctx, { template: PL, frameId: F });
const u2 = c.listUnits(ctx, P2);
ok(c.getFwSurvey(ctx, P2).census_no === 2 && c.getFwSurvey(ctx, P2).series_id === p1.series_id, 'recheck: number 2 in the same series');
ok(
  JSON.stringify(u2.map((u) => u.code)) === JSON.stringify(['S2', 'Q1', 'Q2', 'S1']) && unitBy('Q1', u2).parent_id == null && unitBy('Q2', u2).parent_id === unitBy('S2', u2).id,
  `recheck: the layout as it is now — S1 retired, Q2 added, Q1 without its retired parent (${u2.map((u) => `${u.code}<${u.parent_id}`)})`,
);
ok(c.hasBlindPhase(ctx, P2), 'recheck: starts blind');
throwsCode(() => c.previousOccurrences(ctx, P2), 'blind_open', 'recheck: the earlier list is refused while blind');
const oC = c.addOccurrence(ctx, P2, { taxon_id: 't7', unit_id: unitBy('Q1', u2).id });
c.updateOccurrence(ctx, oC, { notes: 'x' });
ok(c.getOccurrence(ctx, oC).phase === 'blind', 'recheck: an edit keeps the phase');
ok(c.recheckState(ctx, P2) == null, 'recheck state: none while blind');
throwsCode(() => c.answerRecheck(ctx, P2, { frameUnitId: null, taxonId: 't9', verbatim: null }, 'not_found'), 'blind_open', 'recheck answers: refused while blind');
c.closeBlindPhase(ctx, P2);
const closedAt = c.getFwSurvey(ctx, P2).blind_closed_at;
c.closeBlindPhase(ctx, P2);
ok(closedAt != null && c.getFwSurvey(ctx, P2).blind_closed_at === closedAt, 'recheck: closing twice keeps the first time');
// Sealed (v84, as MIREN): a blind occurrence after the close takes no change at all.
throwsCode(() => c.updateOccurrence(ctx, oC, { notes: 'y' }), 'blind_sealed', 'sealed: no edit');
throwsCode(() => c.deleteOccurrence(ctx, oC), 'blind_sealed', 'sealed: no removal');
throwsCode(() => c.setValue(ctx, { kind: 'occurrence', id: oC }, 'traits', 'h', { num: 1 }), 'blind_sealed', 'sealed: no values');
throwsCode(() => c.writeComponent(ctx, { kind: 'occurrence', id: oC }, 'taxon', { verbatim_identification: 'z' }), 'blind_sealed', 'sealed: no component writes');
ok(c.occurrenceSealed(ctx, c.getOccurrence(ctx, oC)) && !c.occurrenceSealed(ctx, c.getOccurrence(ctx, oA)), 'sealed: only blind ones after the close');
// A mistaken close can be undone until recheck work exists.
c.reopenBlindPhase(ctx, P2);
ok(c.getFwSurvey(ctx, P2).blind_closed_at == null && c.getOccurrence(ctx, oC).phase === 'blind', 'blind: reopened before any recheck work');
c.closeBlindPhase(ctx, P2);
const oD = c.addOccurrence(ctx, P2, { taxon_id: 't8', verbatim_identification: 'sp1', unit_id: unitBy('S2', u2).id });
ok(c.getOccurrence(ctx, oC).phase === 'blind' && c.getOccurrence(ctx, oD).phase === 'recheck', 'recheck: blind before closing, recheck after');
c.updateOccurrence(ctx, oD, { notes: '補記' });
ok(c.getOccurrence(ctx, oD).notes === '補記', 'sealed: a recheck occurrence stays editable');
throwsCode(() => c.reopenBlindPhase(ctx, P2), 'recheck_begun', 'blind: not reopened once a recheck occurrence exists');
const prev = c.previousOccurrences(ctx, P2);
ok(
  prev.length === 4 && prev.find((p) => p.taxon_id === 't7').unit_code === 'Q1' && prev.find((p) => p.taxon_id === 't7').frame_unit_id === FQ1,
  'recheck: after closing, the earlier list with its units (matched by frame unit)',
);
// Answers (v84 fw_rechecks): every earlier taxon missing from the blind list of its unit.
const st0 = c.recheckState(ctx, P2);
const keys0 = st0.candidates.map((x) => `${x.taxon_id}@${x.frame_unit_id ?? '-'}`).sort();
ok(
  st0.previousId === P1 && JSON.stringify(keys0) === JSON.stringify([`t8@${FS2}`, 't9@-']) && st0.open === 2,
  `recheck state: t7 was recorded blind, t10's unit is retired; t8 (S2) and t9 (no unit) need answers (${keys0})`,
);
ok(st0.candidates.find((x) => x.taxon_id === 't8').unitId === unitBy('S2', u2).id, 'recheck state: a candidate knows this survey’s unit at its place');
const T8 = { frameUnitId: FS2, taxonId: 't8', verbatim: 'sp1' };
const T9 = { frameUnitId: null, taxonId: 't9', verbatim: null };
ok(c.answerRecheck(ctx, P2, T8, 'found') === oD, 'answer found: the recheck occurrence already there is the find');
const oF = c.answerRecheck(ctx, P2, T9, 'found');
ok(c.getOccurrence(ctx, oF).phase === 'recheck' && c.getOccurrence(ctx, oF).unit_id == null && c.recheckState(ctx, P2).open === 0, 'answer found: adds a recheck occurrence at the same place');
ok(c.answerRecheck(ctx, P2, T9, 'found') === oF && count('fw_rechecks', 'survey_id = ?', P2) === 2, 'answer found again: same occurrence, one answer');
c.answerRecheck(ctx, P2, T9, 'not_found');
ok(c.getOccurrence(ctx, oF) == null && c.recheckState(ctx, P2).open === 0, 'answer changed: the found occurrence goes, not found still answers');
throwsCode(() => c.answerRecheck(ctx, P2, T9, 'reidentified'), 'not_found', 'answer reidentified: needs an occurrence of this survey');
throwsCode(() => c.answerRecheck(ctx, P2, T9, 'reidentified', o1), 'not_found', 'answer reidentified: not one of another survey');
throwsCode(() => c.answerRecheck(ctx, P2, { frameUnitId: FQ1, taxonId: 't7', verbatim: null }, 'not_found'), 'not_found', 'answer: only candidates');
const oG = c.addOccurrence(ctx, P2, { taxon_id: 't11', unit_id: unitBy('Q1', u2).id });
c.answerRecheck(ctx, P2, T9, 'reidentified', oG);
ok(c.recheckState(ctx, P2).open === 0 && c.listRechecks(ctx, P2).find((r) => r.prev_taxon_id === 't9').occurrence_id === oG, 'answer reidentified: names the occurrence');
c.deleteOccurrence(ctx, oG);
ok(c.recheckState(ctx, P2).open === 1 && c.listRechecks(ctx, P2).find((r) => r.prev_taxon_id === 't9').occurrence_id == null, 'answer reidentified: its occurrence deleted, it needs answering again');
const oF2 = c.answerRecheck(ctx, P2, T9, 'found');
c.deleteOccurrence(ctx, oF2);
ok(c.listRechecks(ctx, P2).every((r) => r.prev_taxon_id !== 't9') && c.recheckState(ctx, P2).open === 1, 'answer found: deleting its occurrence removes the answer');
c.answerRecheck(ctx, P2, T9, 'reidentified', oC);
ok(c.recheckState(ctx, P2).open === 0, 'answer reidentified: a sealed blind occurrence may be the one');
rejects(`INSERT INTO fw_rechecks (uuid, survey_id, frame_unit_id, prev_taxon_id, prev_verbatim_identification, outcome, checked_at, updated_at) VALUES ('dup', ${P2}, ${FS2}, 't8', 'sp1', 'found', 1, 1)`, 'schema: one answer per place, taxon and label');
rejects(`INSERT INTO fw_rechecks (uuid, survey_id, prev_taxon_id, outcome, checked_at, updated_at) VALUES ('dup2', ${P2}, 't9', 'not_found', 1, 1)`, 'schema: one answer per place, taxon and label (no unit)');
rejects(`INSERT INTO fw_rechecks (uuid, survey_id, prev_taxon_id, outcome, checked_at, updated_at) VALUES ('bad', ${P2}, 't99', 'maybe', 1, 1)`, 'schema: outcome is one of three');
ok(c.previousSurveyId(ctx, P2) === P1 && c.previousSurveyId(ctx, K1) == null, 'recheck: previous survey in the series only');

// ── deletes ──────────────────────────────────────────────────────────────
const s2 = unitBy('S2', u2).id;
c.setValue(ctx, { kind: 'unit', id: s2 }, 'cover', 'rock_pct', { num: 5 });
c.deleteUnit(ctx, s2);
ok(c.getUnit(ctx, s2) == null && c.getUnit(ctx, unitBy('Q2', u2).id).parent_id == null, 'delete unit: sub-units move up');
ok(c.getOccurrence(ctx, oD).unit_id == null && count('fw_unit_values', 'unit_id = ?', s2) === 0, 'delete unit: occurrences move up, its values go');
ok(c.getFrameUnit(ctx, FS2) != null, 'delete unit: the frame layout keeps it');
c.deleteOccurrence(ctx, oB);
ok(c.getOccurrence(ctx, oB) == null && count('fw_media', `uuid = 'm-o'`) === 0, 'delete occurrence: its photo goes');
c.deleteUnit(ctx, unitBy('S2').id);
ok(count('fw_media', `uuid = 'm-u'`) === 0, 'delete unit: its photo goes');
// A quadrat inside a subplot: its occurrences move to the subplot, not out of every unit.
const q2 = unitBy('Q2', u2).id;
const sub = c.addUnit(ctx, P2, { levelKey: 'subplot', code: 'S4' });
c.deleteUnit(ctx, q2);
const q5 = c.addUnit(ctx, P2, { levelKey: 'quadrat', code: 'Q5', parentId: sub });
const oE = c.addOccurrence(ctx, P2, { taxon_id: 't9', unit_id: q5 });
c.deleteUnit(ctx, q5);
ok(c.getOccurrence(ctx, oE).unit_id === sub, 'delete unit: occurrences move to its parent unit');

const labelsBefore = count('fw_frame_labels');
const frameUnitsBefore = count('fw_frame_units');
// Deletes remove children by hand (foreign keys are off in migrations and the startup sweep).
c.setValue(ctx, { kind: 'unit', id: unitBy('Q1').id }, 'cover', 'rock_pct', { num: 30 });
c.setValue(ctx, { kind: 'occurrence', id: oA }, 'traits', 'height_cm', { num: 12 });
sqlite.prepare(`INSERT INTO fw_media (uuid, survey_id, component, kind, uri, created_at) VALUES ('m-s', ?, 'photos', 'photo', 'file:///photos/s.jpg', 1)`).run(P1);
sqlite.exec('PRAGMA foreign_keys = OFF;');
c.deleteSurvey(ctx, P1);
ok(count('fw_media', 'survey_id = ?', P1) === 0 && count('fw_unit_values', 'unit_id NOT IN (SELECT id FROM fw_units)') === 0, 'delete survey: its photos and unit values go');
ok(c.getFwSurvey(ctx, P1) == null && count('fw_units', 'survey_id = ?', P1) === 0 && count('fw_occurrences', 'survey_id = ?', P1) === 0, 'delete survey: its units and occurrences go');
ok(count('fw_frame_labels') === labelsBefore && one(`SELECT first_survey_id AS f FROM fw_frame_labels WHERE id = ?`, L1).f == null, 'delete survey: labels stay, unlinked');
ok(count('fw_frame_units') === frameUnitsBefore, 'delete survey: the frame layout stays');
ok(c.previousSurveyId(ctx, P2) == null && !c.hasBlindPhase(ctx, P2), 'delete survey: the recheck has no earlier survey now');
c.deleteSurvey(ctx, K1);
ok(count('fw_survey_values', 'survey_id = ?', K1) === 0 && count('fw_occurrence_values') === 0, 'delete survey: its values go');
for (const [table, where] of CASCADE_ORPHANS) if (table.startsWith('fw_')) ok(count(table, where) === 0, `delete survey (foreign keys off): no ${table} orphans`);
sqlite.exec('PRAGMA foreign_keys = ON;');
throwsCode(() => c.deleteSurvey(ctx, C1), 'wrong_style', 'delete survey: never a census');
throwsCode(() => s.deleteFrame(ctx, F), 'frame_has_surveys', 'frame: not deleted while a plot survey uses it');

// ── template upgrade ─────────────────────────────────────────────────────
const relabelled = { ...PL, version: 2, name: { text: '樣區 v2' } };
ok(tp.upgradeSurvey(ctx, P2, relabelled) && c.getFwSurvey(ctx, P2).template_version === 2 && c.snapshotOf(c.getFwSurvey(ctx, P2)).name.text === '樣區 v2', 'upgrade: additive change moves the survey');
ok(tp.upgradeSurvey(ctx, P2, { ...relabelled, version: 3 }) === false, 'upgrade: same content, nothing to do');
throwsCode(() => tp.upgradeSurvey(ctx, P2, { ...relabelled, version: 3, units: [UNITS[0]] }), 'template_breaking', 'upgrade: a breaking change is refused');
throwsCode(() => tp.upgradeSurvey(ctx, P2, { ...relabelled, version: 1, name: { text: 'old' } }), 'template_invalid', 'upgrade: only to a newer version');

// ── component values (2B) ────────────────────────────────────────────────
// A plot template with every component a plot can hold, written and read back.
const FULL = tp.saveTemplate(ctx, {
  ...bare('plot', { id: 'user:full', units: UNITS }),
  components: [
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'percent', 'count', 'DBH', 'custom'], default: 'BB' } },
    { key: 'freq', type: 'frequency', level: 'occurrence', required: false, params: { mode: 'cells', n: 3, top_edge: 'N' } },
    { key: 'layers', type: 'structure', level: 'survey', required: false, params: { layers: 4, methods: ['BB', 'percent'] } },
    { key: 'layer', type: 'structure', level: 'occurrence', required: false, params: { layers: 4, methods: ['BB'] } },
    { key: 'sublayers', type: 'structure', level: 'unit', unit: 'subplot', required: false, params: { layers: 4, methods: ['BB'] } },
    { key: 'pheno', type: 'phenology', level: 'occurrence', required: false, params: { fields: ['sex', 'reproductive_condition', 'leaf_phenology'] } },
    { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'length_cm', label: { text: '葉長' }, unit: 'cm', min: 0, max: 50 }, { id: 'count', label: { text: '葉數' }, integer: true }] } },
    { key: 'seed', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'length_cm', label: { text: '種子長' }, unit: 'cm' }] } },
    { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['elevation_m', 'slope_deg', 'terrain_position', 'rock_cover_pct', 'litter_cover_pct'] } },
    { key: 'qenv', type: 'environment', level: 'unit', unit: 'quadrat', required: false, params: { fields: ['slope_deg'] } },
    { key: 'audio', type: 'audio', level: 'occurrence', required: false, params: { max: 2 } },
    { key: 'photos', type: 'photos', level: 'occurrence', required: false, params: { max: 6 } },
    { key: 'qphotos', type: 'photos', level: 'unit', unit: 'quadrat', required: false, params: { max: 6 } },
    { key: 'workers', type: 'workers', level: 'occurrence', required: false, params: { roles: ['recorder', 'identifier'] } },
    { key: 'subworkers', type: 'workers', level: 'unit', unit: 'subplot', required: false, params: { roles: ['recorder'] } },
    { key: 'where', type: 'location', level: 'occurrence', required: false, params: { methods: ['gps'] } },
    { key: 'qwhere', type: 'location', level: 'unit', unit: 'quadrat', required: false, params: { methods: ['gps'] } },
    { key: 'height', type: 'height', level: 'occurrence', required: false, params: {} },
  ],
});
const V = c.createSurvey(ctx, { template: FULL });
const vSub = c.addUnit(ctx, V, { levelKey: 'subplot', code: 'A' });
const quad = c.addUnit(ctx, V, { levelKey: 'quadrat', code: 'A1', parentId: vSub });
const occ = c.addOccurrence(ctx, V, { taxon_id: 't20', unit_id: quad });
const O = { kind: 'occurrence', id: occ };
const S = { kind: 'survey', id: V };
const U = { kind: 'unit', id: vSub };
const Q = { kind: 'unit', id: quad };
const roundTrip = (owner, key, patch, label) => {
  c.writeComponent(ctx, owner, key, patch);
  const got = c.readComponent(ctx, owner, key);
  for (const [f, v] of Object.entries(patch)) ok(JSON.stringify(got[f]) === JSON.stringify(v), `values ${label}: ${key}.${f} round-trips (${JSON.stringify(got[f])} vs ${JSON.stringify(v)})`);
};
roundTrip(O, 'abundance', { organism_quantity: '3', organism_quantity_type: 'Braun-Blanquet Scale' }, 'abundance BB');
roundTrip(O, 'abundance', { organism_quantity: '[12.5,8]', organism_quantity_type: 'DBH (cm)' }, 'abundance DBH');
ok(c.getOccurrence(ctx, occ).organism_quantity === '[12.5,8]', 'values: abundance lands on the occurrence columns');
roundTrip(O, 'freq', { freq_cells: '010010001' }, 'frequency');
roundTrip(S, 'layers', { layer_count: 3, cover_pct: { 1: 80, 2: 30, 3: 5 }, height_cm: { 1: 1500 }, height_unit: { 1: 'm' }, method: { 1: 'BB', 2: 'percent' } }, 'structure (survey)');
ok(count('fw_survey_values', `survey_id = ? AND component = 'layers' AND field = 'cover_pct'`, V) === 3, 'values: one row per layer');
c.writeComponent(ctx, S, 'layers', { cover_pct: { 2: null } });
ok(JSON.stringify(c.readComponent(ctx, S, 'layers').cover_pct) === JSON.stringify({ 1: 80, 3: 5 }), 'values: a layer cleared on its own');
c.writeComponent(ctx, S, 'layers', { cover_pct: null });
ok(c.readComponent(ctx, S, 'layers').cover_pct == null, 'values: every layer cleared at once');
roundTrip(O, 'layer', { layer: 'E2' }, 'structure (occurrence)');
roundTrip(U, 'sublayers', { cover_pct: { 1: 60, 2: 20 }, height_cm: { 1: 300 } }, 'structure (unit)');
roundTrip(O, 'pheno', { sex: 'female', reproductive_condition: ['flowering', 'fruiting'], leaf_phenology: ['green'] }, 'phenology');
ok(c.getOccurrence(ctx, occ).reproductive_condition === '["flowering","fruiting"]', 'values: multi-value columns are JSON arrays');
roundTrip(O, 'leaf', { length_cm: 12.5, count: 7 }, 'traits');
roundTrip(O, 'seed', { length_cm: 0.4 }, 'second traits component');
ok(c.readComponent(ctx, O, 'leaf').length_cm === 12.5, 'values: two traits components with the same trait id stay apart');
roundTrip(S, 'env', { elevation_m: 1520, slope_deg: 25, terrain_position: 'ridge', rock_cover_pct: 10 }, 'environment (survey)');
roundTrip(Q, 'qenv', { slope_deg: 31 }, 'environment (unit)');
roundTrip(O, 'workers', { recorded_by: 'A', identified_by: 'B' }, 'workers (occurrence)');
roundTrip(U, 'subworkers', { recorded_by: 'C' }, 'workers (unit)');
roundTrip(O, 'where', { lat: 24.12, lng: 121.3, accuracy: 4, elevation_m: 1501, elevation_source: 'gnss' }, 'location (occurrence)');
roundTrip(Q, 'qwhere', { lat: 24.13, lng: 121.31, accuracy: 3 }, 'location (unit)');
roundTrip(O, 'height', { height_m: 0.35 }, 'height');
const before = c.getOccurrence(ctx, occ).updated_at;
c.writeComponent(ctx, O, 'leaf', { count: 8 });
ok(c.getOccurrence(ctx, occ).updated_at > before, 'values: writing stamps the owner');
// Refusals: what cannot be stored, components that sit elsewhere, media through their own path.
throwsCode(() => c.writeComponent(ctx, O, 'leaf', { length_cm: 80 }), 'bad_value', 'values: above a trait maximum is refused');
throwsCode(() => c.writeComponent(ctx, O, 'leaf', { count: 7.5 }), 'bad_value', 'values: a non-integer count is refused');
throwsCode(() => c.writeComponent(ctx, O, 'layer', { layer: 'E9' }), 'bad_value', 'values: an unknown layer is refused');
throwsCode(() => c.writeComponent(ctx, S, 'env', { slope_deg: 'steep' }), 'bad_value', 'values: text in a number is refused');
throwsCode(() => c.writeComponent(ctx, O, 'pheno', { reproductive_condition: 'flowering' }), 'bad_value', 'values: a multi-value field needs a list');
throwsCode(() => c.writeComponent(ctx, O, 'leaf', { width_cm: 1 }), 'bad_value', 'values: a field the component does not have is refused');
throwsCode(() => c.writeComponent(ctx, O, 'env', { slope_deg: 3 }), 'bad_component', 'values: a survey-level component is not written on an occurrence');
throwsCode(() => c.writeComponent(ctx, Q, 'sublayers', { cover_pct: { 1: 5 } }), 'bad_component', 'values: a subplot component is not written on a quadrat');
throwsCode(() => c.writeComponent(ctx, O, 'nope', { x: 1 }), 'bad_component', 'values: an unknown component key is refused');
throwsCode(() => c.writeComponent(ctx, O, 'photos', { photos: ['x'] }), 'bad_value', 'values: media go through addMedia');
c.writeComponent(ctx, O, 'abundance', { organism_quantity: '60', organism_quantity_type: '% cover' });
ok(c.readComponent(ctx, O, 'abundance').organism_quantity === '60', 'values: abundance switches scale (the form checks the value against it)');
// Media.
c.addMedia(ctx, O, 'photos', 'file:///photos/o1.jpg');
c.addMedia(ctx, O, 'audio', 'file:///audio/a1.m4a');
c.addMedia(ctx, O, 'audio', 'file:///audio/a2.m4a');
throwsCode(() => c.addMedia(ctx, O, 'audio', 'file:///audio/a3.m4a'), 'bad_value', 'media: at most the component maximum');
throwsCode(() => c.addMedia(ctx, O, 'leaf', 'file:///photos/x.jpg'), 'bad_value', 'media: only on a media component');
c.addMedia(ctx, Q, 'qphotos', 'file:///photos/q1.jpg');
const read = c.readComponent(ctx, O, 'audio');
ok(JSON.stringify(read.audio) === JSON.stringify(['file:///audio/a1.m4a', 'file:///audio/a2.m4a']), 'media: read back in order');
ok(one(`SELECT kind FROM fw_media WHERE uri = 'file:///audio/a1.m4a'`).kind === 'audio' && one(`SELECT occurrence_id AS o FROM fw_media WHERE uri = 'file:///photos/q1.jpg'`).o == null, 'media: kind and owner columns');
ok(JSON.stringify(c.readComponent(ctx, O, 'photos').photos) === JSON.stringify(['file:///photos/o1.jpg']), 'media: per component');
c.removeMedia(ctx, O, 'audio', 'file:///audio/a1.m4a');
ok(c.listMedia(ctx, O, 'audio').length === 1, 'media: removed');
c.deleteSurvey(ctx, V);
ok(count('fw_occurrence_values', 'occurrence_id = ?', occ) === 0 && count('fw_media', 'survey_id = ?', V) === 0 && count('fw_unit_values', 'unit_id IN (?, ?)', vSub, quad) === 0, 'values: a deleted survey takes its component values and media');

ok(count('fw_rechecks', 'survey_id = ?', P2) > 0, 'recheck answers exist before the delete');
// Foreign keys off, as in migrations and the startup sweep: the delete must not rely on the cascade.
sqlite.exec('PRAGMA foreign_keys = OFF;');
c.deleteSurvey(ctx, P2);
sqlite.exec('PRAGMA foreign_keys = ON;');
ok(count('fw_rechecks', 'survey_id = ?', P2) === 0, 'delete survey: its recheck answers go');

// ── pure modules of the screens (2C-a) ───────────────────────────────────
const mkU = (id, parent_id, level_key, code, sort = 0) => ({ id, parent_id, level_key, code, sort });
const rowsU = unitRows(['subplot', 'quadrat'], [mkU(4, 1, 'quadrat', 'A10'), mkU(3, 1, 'quadrat', 'A2'), mkU(1, null, 'subplot', 'A'), mkU(2, null, 'subplot', 'B'), mkU(5, 99, 'quadrat', 'Z1'), mkU(6, 6, 'quadrat', 'S')]);
ok(
  JSON.stringify(rowsU.map((r) => `${r.path}:${r.depth}`)) === JSON.stringify(['A:0', 'A / A2:1', 'A / A10:1', 'B:0', 'S:0', 'Z1:0']),
  `units: walking order, numeric codes, an orphan and a self-parent at the top (${rowsU.map((r) => `${r.path}:${r.depth}`)})`,
);
ok(unitPath([mkU(1, null, 's', 'A'), mkU(3, 1, 'q', 'A2')], 3) === 'A / A2' && unitPath([], null) === '', 'units: path of codes');
ok(childLevel(['subplot', 'quadrat'], 'subplot') === 'quadrat' && childLevel(['subplot', 'quadrat'], 'quadrat') == null, 'units: the level below');
const prevS = [
  { frameUnitId: 1, taxonId: 'a', verbatim: null },
  { frameUnitId: 1, taxonId: 'a', verbatim: null },
  { frameUnitId: 1, taxonId: 'b', verbatim: 'sp1' },
  { frameUnitId: 2, taxonId: 'a', verbatim: null },
  { frameUnitId: 9, taxonId: 'c', verbatim: null },
  { frameUnitId: null, taxonId: 'd', verbatim: ' ' },
];
const cand = recheckCandidates(prevS, [{ frameUnitId: 1, taxonId: 'a', verbatim: '' }, { frameUnitId: 1, taxonId: 'b', verbatim: 'sp2' }], new Set([1, 2, null]));
ok(
  JSON.stringify(cand.map(recheckKey)) === JSON.stringify([recheckKey(prevS[2]), recheckKey(prevS[3]), recheckKey(prevS[5])]),
  'recheck model: per place, taxon and label; once each; places this survey lacks are skipped',
);
ok(recheckOpen(cand, [{ key: recheckKey(prevS[2]), outcome: 'not_found', occurrenceId: null }, { key: recheckKey(prevS[3]), outcome: 'reidentified', occurrenceId: null }]) === 2, 'recheck model: a re-identification without its occurrence is still open');
ok(SAMPLE_TEMPLATES_OFFERED === false, 'samples: not offered outside a development build');
for (const t of SAMPLE_TEMPLATES) {
  ok(validateTemplate(t).length === 0, `samples: ${t.id} is valid (${validateTemplate(t)})`);
  ok(!blankOccurrenceHasErrors(t), `samples: ${t.id} quick adds without opening the form`);
  ok(formComponents(t, 'occurrence').every((x) => x.type !== 'taxon') && formComponents(t, 'survey').some((x) => x.type === 'timestamp'), `samples: ${t.id} form components per level`);
}
ok(SAMPLE_TEMPLATES.some((t) => t.quick_add) && SAMPLE_TEMPLATES.some((t) => !t.quick_add), 'samples: one of each quick-add rule');

// ── the census and the integrity sweep ───────────────────────────────────
ok(JSON.stringify(censusRows()) === JSON.stringify(censusBefore), `census: untouched (${censusRows()} vs ${censusBefore})`);
for (const [table, where] of CASCADE_ORPHANS) {
  if (!table.startsWith('fw_')) continue;
  ok(count(table, where) === 0, `integrity: no ${table} orphans`);
}
ok(all('PRAGMA foreign_key_check').length === 0, 'integrity: foreign_key_check clean');

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-core: templates, checklist and plot surveys, units, phases, values and deletes hold on the real schema');
