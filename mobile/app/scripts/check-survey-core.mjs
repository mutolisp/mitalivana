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
 *     the fw_media rule sweep census photos;
 *   - interactions (v87, 2F): stored one way (A ← B as B → A, ↔ as mutual);
 *     a type's direction and the template's offer are kept; B picked as a
 *     species not recorded here is recorded as the interaction's other side
 *     (not a species of the survey, not in the next recheck), taken over
 *     when recorded for itself, gone with its last interaction when nothing
 *     else is on it; deleting an occurrence takes its interactions and their
 *     photos; a unit's go up a level; blind ones are sealed, and a sealed
 *     occurrence still takes new ones.
 *
 * Run: npm run check:survey-core
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, runUserMigrations } from '../src/db/migrations.ts';
import { closeActiveRecords } from '../src/db/activeRecords.ts';
import { CASCADE_ORPHANS } from '../src/db/integrityRules.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as tp from '../src/survey/db/templatesCore.ts';
import * as ix from '../src/survey/db/interactionCore.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { withRequired } from '../src/survey/template/validate.ts';
import { childLevel, unitPath, unitRows, unitSubtree } from '../src/survey/form/units.ts';
import { recheckCandidates, recheckKey, recheckOpen } from '../src/survey/form/recheck.ts';
import { blankOccurrenceHasErrors, formComponents, occurrenceErrorIds } from '../src/survey/form/occurrenceForm.ts';
import { instanceProblems, requiredByAuthor } from '../src/survey/componentRules.ts';
import { rangeText } from '../src/lib/numRangeText.ts';
import { isPreviewId, PREVIEW_ID_BASE, raisePreviewIds } from '../src/db/previewIds.ts';
import { isIndividuals, occurrenceModules, surveyModules } from '../src/survey/form/moduleMap.ts';
import { groupStatus, surveyDataStatus, surveyGroups } from '../src/survey/form/surveyGroups.ts';
import { layerRows, nextUnitCode } from '../src/survey/form/plotStyle.ts';
import { coverOf, herbLayer, quadratLike, quadratSetup, taxaNotInPlotList } from '../src/survey/form/quadratModel.ts';
import { SAMPLE_TEMPLATES } from '../src/survey/templates/samples.ts';
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
throwsCode(() => c.deleteUnit(ctx, unitBy('Q1', u2).id), 'blind_sealed', 'sealed: its unit is not deleted (the record would move)');
ok(c.getOccurrence(ctx, oC).unit_id === unitBy('Q1', u2).id, 'sealed: the refused unit delete moved nothing');
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
ok(c.previousSurveyId(ctx, P2) == null && c.hasBlindPhase(ctx, P2), 'delete survey: the recheck has no earlier survey now, but is still a recheck (by its number)');
ok(c.recheckState(ctx, P2)?.candidates.length === 0, 'delete survey: its recheck has nothing left to confirm');
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
// The survey's elevation is one value on the survey row (v88, as a fixed plot's), not an environment value.
ok(one(`SELECT elevation_m FROM fw_surveys WHERE id = ?`, V).elevation_m === 1520 && count('fw_survey_values', `survey_id = ? AND field = 'elevation_m'`, V) === 0, 'values: the environment\'s survey-level elevation is the survey\'s column');
// Typed in the environment card, it says so (the editor sends the source with it), as on a fixed plot.
c.writeComponent(ctx, S, 'env', { elevation_m: 1530, elevation_source: 'manual' });
ok(one(`SELECT elevation_m, elevation_source FROM fw_surveys WHERE id = ?`, V).elevation_source === 'manual', 'values: a typed survey elevation is marked manual');
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
{
  const om = c.occurrenceMediaOf(ctx, V);
  ok(
    om.size === 1 && JSON.stringify(om.get(O.id)) === JSON.stringify({ photo: ['file:///photos/o1.jpg'], audio: ['file:///audio/a2.m4a'] }),
    `media: every occurrence's own in one read, the quadrat's left out (${JSON.stringify([...om])})`,
  );
}
// Every occurrence's values in one read (2G-e, the list's 必填未填 markers): the same as reading each alone.
{
  const bare2 = c.addOccurrence(ctx, V, { taxon_id: 't21' });
  const batch = c.occurrenceValuesOf(ctx, V);
  const keys = FULL.components.filter((x) => x.level === 'occurrence' && x.type !== 'taxon').map((x) => x.key);
  ok(batch.size === 2 && keys.length > 10, `values in one read: every occurrence (${batch.size}, ${keys.length} components)`);
  for (const id of [occ, bare2])
    for (const k of keys) {
      const a = JSON.stringify(batch.get(id)?.[k]);
      const b = JSON.stringify(c.readComponent(ctx, { kind: 'occurrence', id }, k));
      ok(a === b, `values in one read: ${k} of occurrence ${id} as read alone (${a} vs ${b})`);
    }
  ok(occurrenceErrorIds(FULL, batch).size === 0, 'required: nothing missing when the author made nothing 必填');
  const req = { ...FULL, components: FULL.components.map((x) => (x.key === 'seed' || x.key === 'audio' ? { ...x, required: true } : x)) };
  ok(JSON.stringify([...occurrenceErrorIds(req, batch)]) === JSON.stringify([bare2]), `required: the occurrence with a 必填 component empty, not the one with it filled (${[...occurrenceErrorIds(req, batch)]})`);
  ok(occurrenceErrorIds(FULL, new Map([[7, { leaf: { length_cm: 80 } }]])).has(7), 'required: a value that does not fit is an error too');
}
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
for (const t of SAMPLE_TEMPLATES) {
  ok(validateTemplate(t).length === 0, `samples: ${t.id} is valid (${validateTemplate(t)})`);
  ok(!blankOccurrenceHasErrors(t), `samples: ${t.id} quick adds without opening the form`);
  ok(formComponents(t, 'occurrence').every((x) => x.type !== 'taxon') && formComponents(t, 'survey').some((x) => x.type === 'timestamp'), `samples: ${t.id} form components per level`);
}
ok(SAMPLE_TEMPLATES.some((t) => t.quick_add) && SAMPLE_TEMPLATES.some((t) => !t.quick_add), 'samples: one of each quick-add rule');
// Which existing screen block shows each component (2G-c, moduleMap.ts).
{
  const comp = (key, type, level, params = {}) => ({ key, type, level, params });
  const base = SAMPLE_TEMPLATES.find((t) => t.style === 'checklist');
  const mk = (abundanceKinds) => ({
    ...base,
    components: [
      comp('ts', 'timestamp', 'survey'),
      comp('inv', 'investigators', 'survey'),
      comp('env', 'environment', 'survey', { fields: ['slope_deg'] }),
      comp('sph', 'photos', 'survey', { max: 3 }),
      comp('tx', 'taxon', 'occurrence'),
      comp('ab', 'abundance', 'occurrence', { kinds: abundanceKinds, default: abundanceKinds[0] }),
      comp('ph', 'phenology', 'occurrence', { fields: ['leaf_phenology', 'sex'] }),
      comp('tr', 'traits', 'occurrence', { traits: [{ id: 'leaf_length', unit: 'cm' }] }),
      comp('it', 'interaction', 'occurrence', { builtin: ['feeding'] }),
      comp('ch', 'choice', 'occurrence', { list: 'l', multi: false }),
      comp('op', 'photos', 'occurrence', { max: 6 }),
    ],
  });
  const m = occurrenceModules(mk(['count']));
  ok(m.counts && m.countOnly, 'module map: individuals only is the sheet’s own count');
  ok(occurrenceModules(mk(['BB', 'count'])).counts && !occurrenceModules(mk(['BB', 'count'])).countOnly && !occurrenceModules(mk(['BB'])).counts, 'module map: other scales take the scale picker; − n ＋ only where individuals are one of them');
  ok(m.phenologyFields.join() === 'sex,leaf_phenology', `module map: the attributes asked, in the block's order (${m.phenologyFields})`);
  ok(m.photos?.key === 'op' && m.interaction?.key === 'it' && !m.location && !m.comments && !m.audio, 'module map: the sheet’s own fields, by type, on the occurrence only');
  ok(m.extras.map((x) => x.key).join() === 'tr,ch', `module map: the rest follow in template order (${m.extras.map((x) => x.key)})`);
  const sm = surveyModules(mk(['count']));
  ok(sm.timestamp?.key === 'ts' && sm.investigators?.key === 'inv' && sm.data.map((x) => x.key).join() === 'env,sph', `module map: time and investigators are chips, the rest 調查資料 (${sm.data.map((x) => x.key)})`);
  ok(isIndividuals(null) && isIndividuals('') && isIndividuals('individuals') && !isIndividuals('% cover'), 'module map: what the row’s − n ＋ steps');
  // 調查資料 in four groups (2G-f, surveyGroups.ts).
  const facts = { investigators: '甲', start_ts: 1, stop_ts: null, lat: 24, site_id: null, track_geojson: null };
  const withMore = (style) => ({
    ...mk(['count']),
    style,
    components: [
      ...mk(['count']).components,
      comp('lay', 'structure', 'survey', { layers: 4, methods: ['BB'] }),
      comp('met', 'method', 'survey', { methods: [], fixed: null, custom: true }),
      comp('cmt', 'comments', 'survey'),
      // 空間資料 modules (2026-10-04), out of order on purpose: the group shows centre, site, track.
      comp('trk', 'track', 'survey'),
      comp('ctr', 'centre', 'survey'),
      comp('ste', 'site', 'survey'),
    ],
  });
  const gp = surveyGroups(withMore('plot'));
  ok(gp.map((g) => `${g.key}:${g.components.map((x) => x.key).join('+')}`).join() === 'basic:env+sph+cmt,time:ts,space:ctr+ste+trk,method:lay+met', `groups: by type; the survey's layers in 調查法 with the method (2026-10-04); 空間資料 in its own order (${gp.map((g) => `${g.key}:${g.components.map((x) => x.key).join('+')}`)})`);
  const gc = surveyGroups(withMore('checklist'));
  ok(!gc[0].components.some((x) => x.key === 'lay') && gc.find((g) => g.key === 'method')?.components.some((x) => x.key === 'lay'), 'groups: a checklist survey’s layers are 調查法 too');
  // A plot's first unit level is its 小區, in 調查法 (moved from the environment tab, 2026-10-04).
  const units = [{ key: 'u1', label: { text: '小區' } }, { key: 'u2', label: { text: '小樣方' } }];
  const gu = surveyGroups({ ...withMore('plot'), units }).find((g) => g.key === 'method');
  ok(gu?.subplots === 'u1' && gu.components.map((x) => x.key).join() === 'lay,met', `groups: 調查法 on a plot holds its first unit level as 小區 (${gu?.subplots})`);
  const gst = (n) => groupStatus(gu, { lay: { layer_count: 4 }, met: { protocol: 'inventory' } }, { ...facts, subplot_count: n });
  ok(gst(0).total === 3 && gst(0).filled === 2 && gst(2).filled === 3, `groups: 調查法 counts the layers set and the 小區 made (${JSON.stringify([gst(0), gst(2)])})`);
  const onlyUnits = { ...mk(['count']), style: 'plot', units };
  ok(surveyGroups(onlyUnits).map((g) => g.key).join() === 'basic,time,method' && surveyGroups(onlyUnits)[2].components.length === 0, 'groups: a plot with 小區 has 調查法 even without a method or layers');
  ok(!surveyGroups({ ...withMore('checklist'), units }).find((g) => g.key === 'method')?.subplots, 'groups: only a plot shows 小區');
  ok(surveyGroups(mk(['count'])).map((g) => g.key).join() === 'basic,time', 'groups: no 空間資料 without its modules, no 調查法 without a Method');
  const onlyTrack = { ...withMore('plot'), components: withMore('plot').components.filter((x) => x.key !== 'ctr' && x.key !== 'ste') };
  const ot = surveyGroups(onlyTrack).find((g) => g.key === 'space');
  ok(ot?.components.map((x) => x.key).join() === 'trk' && groupStatus(ot, {}, { investigators: null, start_ts: 1, stop_ts: null, lat: 24, site_id: 3, track_geojson: null }).total === 1, 'groups: 空間資料 counts only the modules the template has');
  const reqSpace = { key: 'space', components: [{ ...comp('ctr', 'centre', 'survey'), required: true }, { ...comp('trk', 'track', 'survey'), required: true }] };
  const rs = groupStatus(reqSpace, {}, { investigators: null, start_ts: 1, stop_ts: null, lat: 24, site_id: null, track_geojson: null });
  ok(rs.filled === 1 && rs.total === 2 && rs.missing === 1, `groups: a 必填 spatial module without its value is missing (${JSON.stringify(rs)})`);
  const vals = { env: { slope_deg: 3, aspect_deg: null }, sph: { photos: [] }, cmt: { notes: '' }, met: {} };
  const status = Object.fromEntries(gp.map((g) => [g.key, groupStatus(g, vals, facts)]));
  ok(status.basic.filled === 2 && status.basic.total === 4, `groups: 基本資料 counts its components with something in them, and the surveyors (${JSON.stringify(status.basic)})`);
  ok(status.time.filled === 1 && status.time.total === 2 && status.space.filled === 1 && status.space.total === 3, `groups: time is start and end, space the point, place and track (${JSON.stringify([status.time, status.space])})`);
  ok(status.method.filled === 0 && groupStatus(gp[3], { met: { protocol: 'inventory' } }, facts).filled === 1, 'groups: 調查法 filled once a method is chosen');
  ok(groupStatus({ key: 'method', components: [comp('met', 'method', 'survey', { methods: [], fixed: 'point_count', custom: false })] }, {}, facts).filled === 1, 'groups: a method the template fixes counts as filled');
  ok(groupStatus(gp[0], { env: { cover_pct: {} } }, { ...facts, investigators: null }).filled === 0, 'groups: an empty per-layer value is not filled');
  const sum = surveyDataStatus(withMore('plot'), vals, facts);
  ok(sum.filled === 4 && sum.total === 11, `groups: the chip counts every group (${JSON.stringify(sum)})`);
  // 必填 (2G-e): the author's, on a component they may leave out; fixed ones are every survey's anyway.
  const r = (x) => ({ ...x, required: true });
  ok(requiredByAuthor(r(comp('e', 'environment', 'survey'))) && !requiredByAuthor(comp('e', 'environment', 'survey')) && !requiredByAuthor(r(comp('c', 'comments', 'survey'))) && !requiredByAuthor(r(comp('t', 'timestamp', 'survey'))), 'required: only the author’s, never a fixed component');
  const envR = r(comp('e', 'environment', 'survey', { fields: ['slope_deg', 'aspect_deg'] }));
  const missingOf = (x, v) => instanceProblems(x, v).filter((p) => p.code === 'required_missing').length;
  ok(missingOf(envR, {}) === 1 && missingOf(envR, { slope_deg: null, aspect_deg: '' }) === 1 && missingOf(envR, { slope_deg: 0 }) === 0, 'required: missing until one of its fields holds something (0 does)');
  ok(missingOf(comp('e', 'environment', 'survey', { fields: ['slope_deg'] }), {}) === 0 && missingOf(r(comp('c', 'comments', 'survey')), {}) === 0, 'required: nothing missing on an optional or a fixed component');
  const bad = instanceProblems(envR, { slope_deg: 120 });
  ok(bad.length > 0 && bad.every((p) => p.code !== 'required_missing'), `required: a value out of range is its own problem, not 必填未填 (${bad.map((p) => p.code)})`);
  const occT = (required) => ({ ...mk(['count']), components: [...mk(['count']).components, { ...comp('tr', 'traits', 'occurrence', { traits: [{ id: 'n', label: { text: 'n' } }] }), required }] });
  ok(blankOccurrenceHasErrors(occT(true)) && !blankOccurrenceHasErrors(occT(false)), 'required: quick add opens the form when a new occurrence starts with a 必填 component empty');
  const gReq = { ...withMore('plot'), components: withMore('plot').components.map((x) => (x.key === 'env' || x.key === 'met' || x.key === 'cmt' ? r(x) : x)) };
  const gq = surveyGroups(gReq);
  const miss = gq.map((g) => groupStatus(g, { env: {}, met: {} }, facts).missing).join();
  ok(miss === '1,0,0,1', `required: each group counts its 必填 components left empty, a fixed one not (${miss})`);
  ok(groupStatus(gq[0], { env: { slope_deg: 3 } }, facts).missing === 0 && groupStatus(gq[3], { met: { protocol: 'inventory' } }, facts).missing === 0, 'required: filled, nothing missing');
  ok(groupStatus({ key: 'method', components: [r(comp('met', 'method', 'survey', { methods: [], fixed: 'point_count', custom: false }))] }, {}, facts).missing === 0, 'required: a method the template fixes is never missing');
  ok(surveyDataStatus(gReq, {}, facts).missing === 2, 'required: the chip sums what is missing');
  // A number field's range text: both bounds, one, or one exclusive (numRangeText.ts).
  const tr = (k, o) => `${k}${JSON.stringify(o)}`;
  ok(
    rangeText(tr, 0, 100) === 'plot.numRange{"min":0,"max":100}' && rangeText(tr, 0, undefined) === 'plot.numMin{"min":0}' && rangeText(tr, undefined, 50) === 'plot.numMax{"max":50}' &&
      rangeText(tr, 0, undefined, true) === 'plot.numAbove{"min":0}' && rangeText(tr, 0, 100, true) === 'plot.numAboveMax{"min":0,"max":100}' && rangeText(tr, undefined, undefined) === null,
    'range text: which bounds a field has',
  );
  // The fixed plot's blocks from a Structure's values (2G-d, plotStyle.ts).
  const lr = layerRows({ layer_count: 3, cover_pct: { 1: 40, 3: 5 }, height_cm: { 1: 1200 }, height_unit: { 1: 'm', 2: 'ft' }, method: { 2: 'BB', 3: 'count' } }, 3);
  ok(
    JSON.stringify(lr) ===
      JSON.stringify([
        { layer_index: 1, cover_pct: 40, height_cm: 1200, height_unit: 'm', method: null },
        { layer_index: 2, cover_pct: null, height_cm: null, height_unit: null, method: 'BB' },
        { layer_index: 3, cover_pct: 5, height_cm: null, height_unit: null, method: null },
      ]),
    `plot style: a Structure's values as the fixed plot's layer rows, unknown units and methods left out (${JSON.stringify(lr)})`,
  );
  ok(layerRows({}, 2).length === 2 && layerRows({}, 2).every((r) => r.cover_pct == null), 'plot style: an empty Structure gives empty rows');
  ok(nextUnitCode([]) === 'S1' && nextUnitCode(['S1', 'S3', 'A']) === 'S2' && nextUnitCode(['S1', 'S2']) === 'S3', 'plot style: the next subplot code is the first free S<n>');
}

// ── the census and the integrity sweep ───────────────────────────────────
ok(JSON.stringify(censusRows()) === JSON.stringify(censusBefore), `census: untouched (${censusRows()} vs ${censusBefore})`);
for (const [table, where] of CASCADE_ORPHANS) {
  if (!table.startsWith('fw_')) continue;
  ok(count(table, where) === 0, `integrity: no ${table} orphans`);
}
ok(all('PRAGMA foreign_key_check').length === 0, 'integrity: foreign_key_check clean');

// ── template drafts and archive (v86, the builder) ───────────────────────
{
  const id = 'user:checklist';
  const latest = tp.getTemplate(ctx, id);
  tp.saveDraft(ctx, { ...latest, name: { text: '草稿' } }, latest.version);
  ok(tp.getDraft(ctx, id)?.baseVersion === latest.version && tp.getDraft(ctx, id).template.name.text === '草稿', 'draft: kept with the version it started from');
  tp.saveDraft(ctx, { ...latest, name: { text: '草稿 2' } }, latest.version);
  ok(count('survey_template_drafts') === 1 && tp.getDraft(ctx, id).template.name.text === '草稿 2' && tp.listDrafts(ctx).length === 1, 'draft: one per template, replaced');
  throwsCode(() => tp.saveDraft(ctx, STEMMAP_TEMPLATE, 1), 'builtin_template', 'draft: a built-in is copied, not edited');
  const KU = c.createSurvey(ctx, { template: latest });
  const next = tp.commitDraft(ctx, id);
  ok(next.version === latest.version + 1 && tp.getDraft(ctx, id) == null && tp.getTemplate(ctx, id).name.text === '草稿 2', 'draft: saved as the next version and dropped');
  ok(JSON.stringify(tp.upgradableSurveys(ctx, next).map((x) => x.id)) === JSON.stringify([KU]), 'upgrade: the open survey on the older version is offered the new one');
  tp.saveDraft(ctx, next, next.version);
  ok(tp.commitDraft(ctx, id).version === next.version && count('survey_template_drafts') === 0, 'draft: saving it unchanged adds no version and drops it');
  throwsCode(() => tp.commitDraft(ctx, id), 'not_found', 'draft: nothing to save');
  const breaking = { ...next, components: [...next.components, { key: 'abundance', type: 'abundance', level: 'occurrence', required: true, params: { kinds: ['count'], default: 'count' } }] };
  tp.saveDraft(ctx, breaking, next.version);
  const v4 = tp.commitDraft(ctx, id);
  ok(v4.version === next.version + 1 && tp.upgradableSurveys(ctx, v4).length === 0, 'upgrade: a breaking change is not offered');
  c.finishSurvey(ctx, KU);
  const additive = tp.saveTemplate(ctx, { ...v4, name: { text: 'v5' } });
  ok(tp.upgradableSurveys(ctx, additive).length === 0, 'upgrade: a finished survey is not offered');
  const uses = tp.templateUseCounts(ctx).get(id);
  ok(uses && uses.all === count('fw_surveys', 'template_id = ?', id) && uses.active === count('fw_surveys', "template_id = ? AND status = 'active'", id), `use counts: all and open (${JSON.stringify(uses)})`);
  const lastStart = ctx.db.executeSync('SELECT MAX(start_ts) AS m FROM fw_surveys WHERE template_id = ?', [id]).rows[0].m;
  ok(uses && lastStart != null && uses.last === lastStart, `use counts: the latest start, for the copy list's date (${uses?.last} vs ${lastStart})`);
  tp.setTemplateArchived(ctx, id, true);
  const ids = (o) => tp.listTemplates(ctx, o).map((t) => t.id);
  ok(!ids().includes(id) && JSON.stringify(ids({ archived: 'only' })) === JSON.stringify([id]) && ids({ archived: 'include' }).includes(id) && tp.isTemplateArchived(ctx, id), 'archive: hidden unless asked for');
  ok(tp.getTemplate(ctx, id)?.version === additive.version, 'archive: still readable (surveys and copies)');
  tp.setTemplateArchived(ctx, id, false);
  ok(ids().includes(id) && !tp.isTemplateArchived(ctx, id), 'archive: brought back');
}

// ── deleting a template no survey uses (asked 2026-10-04) ──────────────────
{
  const del = tp.saveTemplate(ctx, { ...tp.getTemplate(ctx, 'user:checklist'), id: 'user:to-delete', name: { text: '要刪的' } });
  tp.saveTemplate(ctx, { ...del, name: { text: '要刪的 v2' } });
  tp.saveDraft(ctx, { ...del, name: { text: '草稿' } }, 2);
  tp.setTemplateArchived(ctx, 'user:to-delete', true);
  ok(tp.templateDeleteBlocker(ctx, 'user:to-delete') === null, 'delete: an unused template may go');
  tp.deleteTemplate(ctx, 'user:to-delete');
  ok(count('survey_templates', 'template_id = ?', 'user:to-delete') === 0 && count('survey_template_drafts', 'template_id = ?', 'user:to-delete') === 0 && count('survey_template_archive', 'template_id = ?', 'user:to-delete') === 0, 'delete: every version, the draft and the archive mark go');
  ok(tp.getTemplate(ctx, 'user:to-delete') == null && !tp.listTemplates(ctx, { archived: 'include' }).some((x) => x.id === 'user:to-delete'), 'delete: gone from the lists');
  ok(tp.templateDeleteBlocker(ctx, 'user:checklist') === 'in_use', 'delete: not while a survey uses it');
  throwsCode(() => tp.deleteTemplate(ctx, 'user:checklist'), 'template_in_use', 'delete: refused while in use');
  ok(tp.getTemplate(ctx, 'user:checklist') != null, 'delete: a refused delete leaves it');
  // A permanent plot's series alone keeps it too.
  const onSeries = tp.saveTemplate(ctx, { ...del, id: 'user:series-only', name: { text: '系列' } });
  const frameId = one('SELECT id FROM fw_frames LIMIT 1')?.id;
  ok(frameId != null, 'delete: a frame for the series test');
  sqlite.prepare(`INSERT INTO fw_frame_series (uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES ('ser-del', ?, ?, 'ZZ', 1, 1)`).run(frameId, onSeries.id);
  ok(tp.templateDeleteBlocker(ctx, onSeries.id) === 'in_use', 'delete: not while a permanent plot\'s series names it');
  sqlite.prepare(`DELETE FROM fw_frame_series WHERE uuid = 'ser-del'`).run();
  ok(tp.templateDeleteBlocker(ctx, STEMMAP_TEMPLATE.id) === 'builtin' && tp.templateDeleteBlocker(ctx, 'sample:checklist') === 'builtin', 'delete: never a built-in or a sample');
  throwsCode(() => tp.deleteTemplate(ctx, STEMMAP_TEMPLATE.id), 'builtin_template', 'delete: a built-in is refused');
}

// ── a recheck starts with the previous environment values (2D-a) ─────────
{
  const FE = s.createFrame(ctx, { code: 'ENV1', sizeXM: 20, sizeYM: 20 });
  const ENV = tp.saveTemplate(
    ctx,
    bare('plot', {
      id: 'user:env',
      units: UNITS,
      components: [
        { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['slope_deg', 'aspect_deg'] } },
        { key: 'uenv', type: 'environment', level: 'unit', unit: 'subplot', required: false, params: { fields: ['rock_cover_pct'] } },
      ],
      quick_add: false,
    }),
  );
  const E1 = c.createSurvey(ctx, { template: ENV, frameId: FE });
  const s1 = c.addUnit(ctx, E1, { levelKey: 'subplot', code: 'S1' });
  c.writeComponent(ctx, { kind: 'survey', id: E1 }, 'env', { slope_deg: 20, aspect_deg: 180 });
  c.writeComponent(ctx, { kind: 'unit', id: s1 }, 'uenv', { rock_cover_pct: 30 });
  ok(Object.keys(c.environmentCarried(ctx, { kind: 'survey', id: E1 }).fields).length === 0, 'carry: nothing on a first survey');
  c.finishSurvey(ctx, E1);
  const E2 = c.createSurvey(ctx, { template: ENV, frameId: FE });
  const s2 = c.listUnits(ctx, E2).find((u) => u.code === 'S1').id;
  ok(c.readComponent(ctx, { kind: 'survey', id: E2 }, 'env').slope_deg === 20 && c.readComponent(ctx, { kind: 'unit', id: s2 }, 'uenv').rock_cover_pct === 30, 'carry: survey and unit environment values come with the recheck');
  const carried = c.environmentCarried(ctx, { kind: 'survey', id: E2 });
  ok(carried.census === 1 && JSON.stringify(carried.fields.env?.sort()) === JSON.stringify(['aspect_deg', 'slope_deg']), `carry: said as the previous survey's (${JSON.stringify(carried)})`);
  c.writeComponent(ctx, { kind: 'survey', id: E2 }, 'env', { slope_deg: 25 });
  ok(JSON.stringify(c.environmentCarried(ctx, { kind: 'survey', id: E2 }).fields.env) === JSON.stringify(['aspect_deg']), 'carry: a changed value is no longer the previous one');
  ok(JSON.stringify(c.environmentCarried(ctx, { kind: 'unit', id: s2 }).fields.uenv) === JSON.stringify(['rock_cover_pct']), 'carry: on a unit too');
  ok(c.readComponent(ctx, { kind: 'survey', id: E1 }, 'env').slope_deg === 20, 'carry: the previous survey keeps its own');
  ok(count('fw_occurrences', 'survey_id = ?', E2) === 0, 'carry: no species come with it (the blind phase)');
}

// ── 自訂選項欄 (choice, 2D-b): one code as text, several as a list ──────────
{
  const list = { id: 'list_1', label: { text: '微棲地' }, items: [{ code: 'rock', label: { text: '岩石' } }, { code: 'log', label: { text: '倒木' } }] };
  const CH = tp.saveTemplate(
    ctx,
    bare('checklist', {
      id: 'user:choice',
      codelists: [list],
      components: [
        { key: 'where', type: 'choice', level: 'survey', required: false, params: { list: 'list_1', multi: false } },
        { key: 'on', type: 'choice', level: 'occurrence', required: false, params: { list: 'list_1', multi: true } },
      ],
    }),
  );
  const K = c.createSurvey(ctx, { template: CH });
  const o = c.addOccurrence(ctx, K, { taxon_id: 't1' });
  c.writeComponent(ctx, { kind: 'survey', id: K }, 'where', { value: 'rock' });
  c.writeComponent(ctx, { kind: 'occurrence', id: o }, 'on', { value: ['rock', 'log'] });
  ok(c.readComponent(ctx, { kind: 'survey', id: K }, 'where').value === 'rock', 'choice: one code, read back');
  ok(JSON.stringify(c.readComponent(ctx, { kind: 'occurrence', id: o }, 'on').value) === JSON.stringify(['rock', 'log']), 'choice: several codes, read back as a list');
  c.writeComponent(ctx, { kind: 'survey', id: K }, 'where', { value: null });
  ok(c.readComponent(ctx, { kind: 'survey', id: K }, 'where').value == null, 'choice: cleared');
  c.finishSurvey(ctx, K);
}

// ── interactions (v87, 2F) ───────────────────────────────────────────────
{
  const IT = withRequired({
    schema: 1,
    id: 'user:inter',
    version: 1,
    origin: 'user',
    name: { text: '交互作用' },
    style: 'plot',
    units: [
      { key: 'u1', label: { text: '小區' } },
      { key: 'u2', label: { text: '小樣方' } },
    ],
    components: [
      { key: 'inter', type: 'interaction', level: 'occurrence', required: false, params: { builtin: ['feeding', 'flower_visit', 'mutualism'], list: 'list_1', count: true, photos: 1 } },
      { key: 'onote', type: 'comments', level: 'occurrence', required: true, params: {} },
    ],
    codelists: [
      {
        id: 'list_1',
        label: { text: '自訂' },
        items: [
          { code: '1', label: { text: '產卵於', tr: { en: 'lays eggs on' } }, inverse: { text: '被產卵' } },
          { code: '2', label: { text: '舊型' }, deprecated: true },
        ],
      },
    ],
    quick_add: false,
  });
  ok(validateTemplate(IT).length === 0, `interaction: the test template is valid (${validateTemplate(IT)})`);
  const types = ix.interactionTypes(IT);
  ok(
    JSON.stringify(types.filter((x) => x.offered).map((x) => x.code)) === JSON.stringify(['feeding', 'flower_visit', 'mutualism', '1']) &&
      types.find((x) => x.code === '1').en === 'lays eggs on' &&
      types.find((x) => x.code === 'flower_visit').iri.endsWith('RO_0002622'),
    `interaction: offered types, own English name, built-in IRI (${types.filter((x) => x.offered).map((x) => x.code)})`,
  );
  const FI = s.createFrame(ctx, { code: 'IX1', sizeXM: 20, sizeYM: 20 });
  const P1 = c.createSurvey(ctx, { template: IT, frameId: FI });
  const S0 = c.addUnit(ctx, P1, { levelKey: 'u1', code: 'S1' });
  const S1 = c.addUnit(ctx, P1, { levelKey: 'u2', code: 'Q1', parentId: S0 });
  const A = c.addOccurrence(ctx, P1, { taxon_id: 'butterfly', unit_id: S1 });
  const B = c.addOccurrence(ctx, P1, { taxon_id: 'bidens', unit_id: S1 });
  const C = c.addOccurrence(ctx, P1, { taxon_id: 'lantana' });
  const row = (id) => one('SELECT * FROM fw_interactions WHERE id = ?', id);
  const i1 = ix.addInteraction(ctx, { from: A, partner: { occurrenceId: B }, type: 'flower_visit', direction: 'forward', count: 3 });
  // 2G-d (v89): a quadrat marked done takes no new interaction from its occurrences, nor a change to one recorded there.
  c.setUnitDone(ctx, S1, true);
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'feeding', direction: 'forward' }), 'unit_done', 'interaction: none from an occurrence in a unit marked done (v89)');
  throwsCode(() => ix.deleteInteraction(ctx, i1), 'unit_done', 'interaction: one recorded in a unit marked done stays (v89)');
  c.setUnitDone(ctx, S1, false);
  ok(row(i1).subject_occurrence_id === A && row(i1).object_occurrence_id === B && row(i1).mutual === 0 && row(i1).count === 3 && row(i1).unit_id === S1 && row(i1).phase === null, 'interaction: A → B stored as recorded, in A’s unit');
  const i2 = ix.addInteraction(ctx, { from: B, partner: { occurrenceId: A }, type: 'flower_visit', direction: 'backward' });
  ok(row(i2).subject_occurrence_id === A && row(i2).object_occurrence_id === B, 'interaction: B ← A from B’s page is stored A → B (one way of writing it)');
  ok(JSON.stringify(ix.asSeenFrom(row(i2), B)) === JSON.stringify({ direction: 'backward', partner: A }) && ix.asSeenFrom(row(i2), A).direction === 'forward', 'interaction: read from either side');
  const i3 = ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'mutualism', direction: 'mutual' });
  ok(row(i3).mutual === 1 && ix.asSeenFrom(row(i3), C).direction === 'mutual', 'interaction: both ways is mutual from either side');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'mutualism', direction: 'forward' }), 'bad_value', 'interaction: a both-ways type only goes ↔');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'feeding', direction: 'mutual' }), 'bad_value', 'interaction: a one-way type never goes ↔');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'parasitism', direction: 'forward' }), 'bad_value', 'interaction: a built-in the template does not offer');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: '2', direction: 'forward' }), 'bad_value', 'interaction: a deprecated own type is not offered for new ones');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: C }, type: 'feeding', direction: 'forward', count: 0 }), 'bad_value', 'interaction: a count is at least 1');
  throwsCode(() => ix.addInteraction(ctx, { from: A, partner: { occurrenceId: A }, type: 'feeding', direction: 'forward' }), 'bad_value', 'interaction: not with itself');
  rejects(`UPDATE fw_interactions SET object_occurrence_id = subject_occurrence_id WHERE id = ${i1}`, 'interaction: the table refuses one occurrence on both sides');
  // B as a species not recorded here
  const before = c.listSurveys(ctx).find((x) => x.id === P1).species_count;
  const i4 = ix.addInteraction(ctx, { from: A, partner: { taxonId: 'bird' }, type: 'feeding', direction: 'backward' });
  const V = row(i4).subject_occurrence_id;
  const v = c.getOccurrence(ctx, V);
  ok(v.taxon_id === 'bird' && v.via_interaction === 1 && v.unit_id === S1 && row(i4).object_occurrence_id === A, 'interaction: a new species is recorded in A’s unit as the other side (bird eats butterfly)');
  ok(c.listSurveys(ctx).find((x) => x.id === P1).species_count === before && c.findOccurrence(ctx, P1, S1, 'bird', null) === null, 'interaction: not a species of the survey, not found as one');
  const i5 = ix.addInteraction(ctx, { from: A, partner: { taxonId: 'bird' }, type: 'feeding', direction: 'backward' });
  ok(row(i5).subject_occurrence_id === V && count('fw_occurrences', 'survey_id = ? AND taxon_id = ?', P1, 'bird') === 1, 'interaction: the same species again is the same occurrence');
  const i6 = ix.addInteraction(ctx, { from: C, partner: { taxonId: 'bidens' }, type: 'feeding', direction: 'forward' });
  ok(c.getOccurrence(ctx, row(i6).object_occurrence_id).via_interaction === 1 && row(i6).object_occurrence_id !== B, 'interaction: a species recorded in another unit is recorded again where A is');
  // taken over when recorded for itself
  ok(c.addOccurrence(ctx, P1, { taxon_id: 'bird', unit_id: S1, organism_quantity: '2', organism_quantity_type: 'individuals' }) === V && c.getOccurrence(ctx, V).via_interaction === 0 && c.getOccurrence(ctx, V).organism_quantity === '2', 'interaction: recording it for itself takes the occurrence over');
  ok(c.listSurveys(ctx).find((x) => x.id === P1).species_count === before + 1, 'interaction: then it counts');
  // the other side goes with its last interaction, unless something else is on it
  const i7 = ix.addInteraction(ctx, { from: B, partner: { taxonId: 'bee' }, type: 'flower_visit', direction: 'backward' });
  const bee = row(i7).subject_occurrence_id;
  ix.deleteInteraction(ctx, i7);
  ok(c.getOccurrence(ctx, bee) === null, 'interaction: an occurrence made only for it goes with it');
  // still held by another interaction: stays
  const iHold1 = ix.addInteraction(ctx, { from: B, partner: { taxonId: 'hoverfly' }, type: 'flower_visit', direction: 'backward' });
  const hover = row(iHold1).subject_occurrence_id;
  const iHold2 = ix.addInteraction(ctx, { from: A, partner: { occurrenceId: hover }, type: 'feeding', direction: 'backward' });
  ix.deleteInteraction(ctx, iHold1);
  ok(c.getOccurrence(ctx, hover) != null && row(iHold2) != null, 'interaction: a made-for-it occurrence another interaction holds stays');
  ix.deleteInteraction(ctx, iHold2);
  ok(c.getOccurrence(ctx, hover) === null, 'interaction: and goes with the last one');
  const i8 = ix.addInteraction(ctx, { from: B, partner: { taxonId: 'bee' }, type: 'flower_visit', direction: 'backward' });
  const bee2 = row(i8).subject_occurrence_id;
  c.updateOccurrence(ctx, bee2, { notes: '腳上有花粉' });
  ix.deleteInteraction(ctx, i8);
  ok(c.getOccurrence(ctx, bee2)?.via_interaction === 1, 'interaction: one with a note of its own stays');
  // changing B leaves a made-for-it occurrence behind only while something holds it
  const i9 = ix.addInteraction(ctx, { from: B, partner: { taxonId: 'moth' }, type: 'flower_visit', direction: 'backward' });
  const moth = row(i9).subject_occurrence_id;
  ix.updateInteraction(ctx, i9, { from: B, partner: { occurrenceId: A }, type: 'flower_visit', direction: 'backward', count: 2 });
  ok(row(i9).subject_occurrence_id === A && row(i9).count === 2 && c.getOccurrence(ctx, moth) === null, 'interaction: B changed; the one made for it goes');
  throwsCode(() => ix.updateInteraction(ctx, i9, { from: C, partner: { occurrenceId: A }, type: 'flower_visit', direction: 'forward' }), 'bad_value', 'interaction: changed only from one of its sides');
  // an own type no longer offered still holds where it was recorded
  const i10 = ix.addInteraction(ctx, { from: A, partner: { occurrenceId: B }, type: '1', direction: 'forward' });
  sqlite.prepare(`UPDATE fw_interactions SET type_code = '2' WHERE id = ?`).run(i10);
  ix.updateInteraction(ctx, i10, { from: A, partner: { occurrenceId: B }, type: '2', direction: 'forward', notes: '舊型' });
  ok(row(i10).notes === '舊型', 'interaction: a deprecated type stays on the one that has it');
  // photos
  ix.addInteractionPhoto(ctx, i1, 'file:///p/visit.jpg');
  throwsCode(() => ix.addInteractionPhoto(ctx, i1, 'file:///p/visit2.jpg'), 'bad_value', 'interaction: photos up to the template’s limit');
  ok(c.listMedia(ctx, { kind: 'survey', id: P1 }).length === 0 && JSON.stringify(ix.listInteractionPhotos(ctx, i1)) === JSON.stringify(['file:///p/visit.jpg']), 'interaction: its photo is not the survey’s');
  ok(ix.listInteractions(ctx, P1, { occurrenceId: B }).find((r) => r.id === i1)?.photos === 1, 'interaction: listed with its photo count');
  ok(c.interactionCountOf(ctx, A) === ix.listInteractions(ctx, P1, { occurrenceId: A }).length, 'interaction: counted per occurrence');
  // a unit's interactions go up with its occurrences
  c.deleteUnit(ctx, S1);
  ok(row(i1)?.unit_id === S0 && c.getOccurrence(ctx, A).unit_id === S0, 'interaction: deleting its unit moves it up a level, with its occurrences');
  // deleting an occurrence: a made-for-it other side goes too
  const iFly = ix.addInteraction(ctx, { from: C, partner: { taxonId: 'fly' }, type: 'feeding', direction: 'backward' });
  const fly = row(iFly).subject_occurrence_id;
  c.deleteOccurrence(ctx, C);
  ok(c.getOccurrence(ctx, fly) === null && row(iFly) === undefined, 'interaction: deleting an occurrence takes a made-for-it other side with it');
  // deleting an occurrence takes its interactions and their photos
  const n = c.interactionCountOf(ctx, A);
  c.deleteOccurrence(ctx, A);
  ok(n > 0 && count('fw_interactions', 'subject_occurrence_id = ? OR object_occurrence_id = ?', A, A) === 0 && count('fw_media', 'interaction_id = ?', i1) === 0, 'interaction: deleting an occurrence takes its interactions and photos');
  // the next survey: blind, sealed, and the made-for-it ones left out of the recheck
  const viaLeft = ix.addInteraction(ctx, { from: B, partner: { taxonId: 'wasp' }, type: 'flower_visit', direction: 'backward' });
  ok(row(viaLeft) != null, 'interaction: one more made-for-it occurrence on the first survey');
  c.finishSurvey(ctx, P1);
  const P2 = c.createSurvey(ctx, { template: IT, frameId: FI });
  const S2 = c.listUnits(ctx, P2).find((u) => u.code === 'S1').id;
  const D = c.addOccurrence(ctx, P2, { taxon_id: 'bidens', unit_id: S2 });
  const j1 = ix.addInteraction(ctx, { from: D, partner: { taxonId: 'beetle' }, type: 'feeding', direction: 'backward' });
  ok(row(j1).phase === 'blind' && c.getOccurrence(ctx, row(j1).subject_occurrence_id).phase === 'blind', 'interaction: recorded blind with its new occurrence');
  c.closeBlindPhase(ctx, P2);
  ok(ix.interactionSealed(ctx, row(j1)), 'interaction: sealed once the blind phase closes');
  throwsCode(() => ix.updateInteraction(ctx, j1, { from: D, partner: { taxonId: 'beetle' }, type: 'feeding', direction: 'backward', notes: 'x' }), 'blind_sealed', 'interaction: a sealed one is not changed');
  throwsCode(() => ix.deleteInteraction(ctx, j1), 'blind_sealed', 'interaction: nor deleted');
  throwsCode(() => ix.addInteractionPhoto(ctx, j1, 'file:///p/x.jpg'), 'blind_sealed', 'interaction: nor given photos');
  const beetle = row(j1).subject_occurrence_id;
  const j0 = ix.addInteraction(ctx, { from: D, partner: { occurrenceId: beetle }, type: 'flower_visit', direction: 'backward' });
  ok(row(j0).phase === 'recheck' && count('fw_occurrences', "survey_id = ? AND phase = 'recheck'", P2) === 0, 'interaction: two sealed occurrences still take a new one, after the blind phase');
  throwsCode(() => c.reopenBlindPhase(ctx, P2), 'recheck_begun', 'interaction: one recorded after the blind phase is recheck work');
  const j2 = ix.addInteraction(ctx, { from: D, partner: { taxonId: 'ant' }, type: 'flower_visit', direction: 'backward' });
  ok(row(j2).phase === 'recheck', 'interaction: and with a new species');
  const prev = c.previousOccurrences(ctx, P2).map((o) => o.taxon_id);
  ok(!prev.includes('wasp') && prev.includes('bidens'), `interaction: the next recheck leaves out the made-for-it occurrences (${prev})`);
  ok(!c.recheckState(ctx, P2).candidates.some((x) => x.taxonId === 'wasp'), 'interaction: so nobody is asked to look for them');
  // a 'found' answer's occurrence that has interactions stays, as their other side, when the answer changes
  const bird = c.recheckState(ctx, P2).candidates.find((x) => x.taxonId === 'bird');
  const found = c.answerRecheck(ctx, P2, bird, 'found');
  ix.addInteraction(ctx, { from: found, partner: { occurrenceId: D }, type: 'feeding', direction: 'forward' });
  c.answerRecheck(ctx, P2, bird, 'not_found');
  ok(c.getOccurrence(ctx, found)?.via_interaction === 1 && c.interactionCountOf(ctx, found) === 1, 'interaction: a found occurrence with an interaction stays as its other side when the answer changes');
  // deleting the surveys takes everything — by hand, as cleanup runs with foreign keys off
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  c.deleteSurvey(ctx, P2);
  c.deleteSurvey(ctx, P1);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  ok(count('fw_interactions', 'survey_id IN (?, ?)', P1, P2) === 0 && count('fw_occurrences', 'survey_id IN (?, ?)', P1, P2) === 0, 'interaction: deleting a survey takes its interactions');
  for (const [table, where] of CASCADE_ORPHANS) if (table.startsWith('fw_')) ok(count(table, where) === 0, `interaction: no ${table} orphans`);
  ok(all('PRAGMA foreign_key_check').length === 0, 'interaction: foreign_key_check clean');
}

// ── 2G-b: a track, a place and elevations, as 快速名錄 and the fixed plot have (v88) ──
{
  const G = c.createSurvey(ctx, { template: FULL });
  const GS = { kind: 'survey', id: G };
  const elev = () => one(`SELECT elevation_m, elevation_source, elevation_min_m, elevation_max_m FROM fw_surveys WHERE id = ?`, G);
  const site = Number(sqlite.prepare(`INSERT INTO sites (name, geometry_type, geometry_geojson, project_id, created_at, updated_at) VALUES ('s', 'Point', '{"type":"Point","coordinates":[121,24]}', 0, 1, 1)`).run().lastInsertRowid);
  c.updateSurvey(ctx, G, { siteId: site, trackGeojson: '{"type":"MultiLineString","coordinates":[[[121,24],[121.1,24.1]]]}', gpsMode: 'full_track' });
  const g = c.getFwSurvey(ctx, G);
  ok(g.site_id === site && g.gps_mode === 'full_track' && g.track_geojson.includes('MultiLineString'), '2G-b: a survey takes its place and its track');
  rejects(`UPDATE fw_surveys SET gps_mode = 'walk' WHERE id = ${G}`, '2G-b schema: gps_mode is single_point or full_track');
  rejects(`UPDATE fw_surveys SET elevation_source = 'guess' WHERE id = ${G}`, '2G-b schema: elevation_source is gnss or manual');
  // A track's fixes (asked 2026-10-04): the range widens; the survey's own elevation takes the first while empty.
  c.noteTrackAltitude(ctx, G, 1520.4);
  let r = elev();
  ok(r.elevation_m === 1520 && r.elevation_source === 'gnss' && r.elevation_min_m === 1520 && r.elevation_max_m === 1520, `2G-b track altitude: the first fills the elevation and the range (${JSON.stringify(r)})`);
  for (const a of [1490, 1601.6, 1550]) c.noteTrackAltitude(ctx, G, a);
  r = elev();
  ok(r.elevation_min_m === 1490 && r.elevation_max_m === 1602 && r.elevation_m === 1520, `2G-b track altitude: the range widens, the elevation stays (${JSON.stringify(r)})`);
  c.noteTrackAltitude(ctx, G, Number.NaN);
  ok(JSON.stringify(elev()) === JSON.stringify(r), '2G-b track altitude: a fix without a usable altitude changes nothing');
  // A typed elevation (through the environment component) is never overwritten by the track.
  c.writeComponent(ctx, GS, 'env', { elevation_m: 1555, elevation_source: 'manual' });
  c.noteTrackAltitude(ctx, G, 1400);
  r = elev();
  ok(r.elevation_m === 1555 && r.elevation_source === 'manual' && r.elevation_min_m === 1400, `2G-b track altitude: a typed elevation stays (${JSON.stringify(r)})`);
  ok(c.readComponent(ctx, GS, 'env').elevation_m === 1555, '2G-b: the environment component reads the survey\'s elevation');
  // A species' own fix (recordFix): only where it has none, never on a sealed one.
  const o1 = c.addOccurrence(ctx, G, { taxon_id: 'tA' });
  ok(c.stampOccurrenceFix(ctx, o1, { lat: 24, lng: 121, accuracy: 5, elevation_m: 1500 }) && c.getOccurrence(ctx, o1).elevation_source === 'gnss', '2G-b stamp: an unlocated species takes the fix');
  ok(!c.stampOccurrenceFix(ctx, o1, { lat: 25, lng: 122, accuracy: 1, elevation_m: null }) && c.getOccurrence(ctx, o1).lat === 24, '2G-b stamp: a located one keeps its position');
  const o2 = c.addOccurrence(ctx, G, { taxon_id: 'tB' });
  c.stampOccurrenceFix(ctx, o2, { lat: 24.5, lng: 121.5, accuracy: 8, elevation_m: null });
  ok(c.getOccurrence(ctx, o2).elevation_source == null, '2G-b stamp: no altitude, no elevation source');
  const unlocated = { template_snapshot: JSON.stringify({ components: [{ key: 'qwhere', type: 'location', level: 'unit' }] }) };
  ok(c.occurrencesLocated(g) && !c.occurrencesLocated(unlocated), '2G-b stamp: only a template with Location on its occurrences is stamped');
  // v88 moved an environment component's survey-level elevation onto the survey row.
  sqlite.prepare(`UPDATE fw_surveys SET elevation_m = NULL, elevation_source = NULL WHERE id = ?`).run(G);
  sqlite.prepare(`INSERT INTO fw_survey_values (uuid, survey_id, component, field, idx, value_num, updated_at) VALUES ('mv1', ?, 'env', 'elevation_m', 0, 1777, 1)`).run(G);
  sqlite.prepare(`INSERT INTO fw_survey_values (uuid, survey_id, component, field, idx, value_num, updated_at) VALUES ('mv2', ?, 'other', 'elevation_m', 0, 9, 1)`).run(G);
  MIGRATIONS.find((m) => m.version === 88).up(db);
  r = elev();
  ok(r.elevation_m === 1777 && r.elevation_source === 'manual' && count('fw_survey_values', `uuid = 'mv1'`) === 0, `2G-b v88: the environment's survey elevation moves to the survey row (${JSON.stringify(r)})`);
  ok(count('fw_survey_values', `uuid = 'mv2'`) === 1, '2G-b v88: a value of another component stays');
}

// ── 2G-d: a subplot's size and a quadrat marked done, as the fixed plot has them (v89) ──
{
  const D = c.createSurvey(ctx, { template: FULL });
  const sub = c.addUnit(ctx, D, { levelKey: 'subplot', code: 'A' });
  const q = c.addUnit(ctx, D, { levelKey: 'quadrat', code: 'A1', parentId: sub });
  const q2 = c.addUnit(ctx, D, { levelKey: 'quadrat', code: 'A2', parentId: sub });
  const inQ = c.addOccurrence(ctx, D, { taxon_id: 'tq' });
  c.updateOccurrence(ctx, inQ, { unit_id: q });
  const outside = c.addOccurrence(ctx, D, { taxon_id: 'tout' });
  rejects(`UPDATE fw_units SET width_m = 0 WHERE id = ${sub}`, '2G-d schema: a width is above 0');
  rejects(`UPDATE fw_units SET length_m = -1 WHERE id = ${sub}`, '2G-d schema: a length is above 0');
  c.updateUnit(ctx, sub, { widthM: 10, lengthM: 5 });
  ok(c.getUnit(ctx, sub).width_m === 10 && c.getUnit(ctx, sub).length_m === 5, '2G-d: a subplot keeps its size');
  c.setUnitDone(ctx, q, true);
  ok(c.getUnit(ctx, q).done_at != null, '2G-d: a quadrat is marked done');
  const QO = { kind: 'unit', id: q };
  throwsCode(() => c.addOccurrence(ctx, D, { taxon_id: 'tnew', unit_id: q }), 'unit_done', '2G-d done: no species added to it');
  throwsCode(() => c.updateOccurrence(ctx, inQ, { notes: 'x' }), 'unit_done', '2G-d done: its species do not change');
  throwsCode(() => c.updateOccurrence(ctx, outside, { unit_id: q }), 'unit_done', '2G-d done: nothing moves into it');
  throwsCode(() => c.deleteOccurrence(ctx, inQ), 'unit_done', '2G-d done: its species are not deleted');
  throwsCode(() => c.writeComponent(ctx, { kind: 'occurrence', id: inQ }, 'leaf', { count: 3 }), 'unit_done', '2G-d done: its species\' values do not change');
  throwsCode(() => c.writeComponent(ctx, QO, 'qenv', { slope_deg: 10 }), 'unit_done', '2G-d done: its own values do not change');
  throwsCode(() => c.addMedia(ctx, QO, 'qphotos', 'file:///q.jpg'), 'unit_done', '2G-d done: no photo added');
  throwsCode(() => c.updateUnit(ctx, q, { label: 'x' }), 'unit_done', '2G-d done: the unit itself does not change');
  throwsCode(() => c.deleteUnit(ctx, q), 'unit_done', '2G-d done: it is not deleted');
  ok(!c.stampOccurrenceFix(ctx, inQ, { lat: 24, lng: 121, accuracy: 3, elevation_m: null }) && c.getOccurrence(ctx, inQ).lat == null, '2G-d done: a late GNSS fix is not written into it');
  c.addOccurrence(ctx, D, { taxon_id: 'tq2', unit_id: q2 });
  c.updateOccurrence(ctx, outside, { notes: 'still open' });
  ok(c.listOccurrences(ctx, D, { unitId: q2 }).length === 1 && c.getOccurrence(ctx, outside).notes === 'still open', '2G-d done: the other quadrats and the rest of the survey stay open');
  c.setUnitDone(ctx, sub, true);
  throwsCode(() => c.addUnit(ctx, D, { levelKey: 'quadrat', code: 'A3', parentId: sub }), 'unit_done', '2G-d done: no sub-unit added under it');
  c.setUnitDone(ctx, sub, false);
  c.setUnitDone(ctx, q, false);
  c.updateOccurrence(ctx, inQ, { notes: 'reopened' });
  ok(c.getUnit(ctx, q).done_at == null && c.getOccurrence(ctx, inQ).notes === 'reopened', '2G-d done: opened again, it takes changes');
}

// ── 2G-d4: the second unit level as the fixed plot's quadrats (quadratModel.ts) ──
{
  const comp = (key, type, level, params, unit) => ({ key, type, level, ...(unit ? { unit } : {}), required: false, params });
  const QT = {
    units: [
      { key: 'sub', label: 'S' },
      { key: 'quad', label: 'Q' },
    ],
    components: [
      comp('ab', 'abundance', 'occurrence', { kinds: ['BB', 'percent'], default: 'BB' }),
      comp('fr', 'frequency', 'occurrence', { n: 5, mode: 'count', top_edge: 'upslope' }),
      comp('se', 'environment', 'unit', { fields: ['rock_cover_pct'] }, 'sub'),
      comp('qe', 'environment', 'unit', { fields: ['slope_deg', 'litter_cover_pct', 'vascular_cover_pct'] }, 'quad'),
      comp('qp', 'photos', 'unit', {}, 'quad'),
    ],
  };
  const q = quadratSetup(QT);
  ok(
    q?.level === 'quad' && q.recordCover && q.freq?.key === 'fr' && q.n === 5 && q.mode === 'count' && q.topEdge === 'upslope' && q.env?.key === 'qe' && q.photos?.key === 'qp',
    `quadrats: the second level, a cover when the abundance takes %, the frequency's grid and method, that level's environment and photos (${JSON.stringify(q && { ...q, abundance: q.abundance?.key, freq: q.freq?.key, env: q.env?.key, photos: q.photos?.key })})`,
  );
  ok(q?.surface.join() === 'vascular_cover_pct,litter_cover_pct', `quadrats: the ground covers that level's environment asks for, in the fixed plot's order (${q?.surface})`);
  ok(quadratSetup({ ...QT, units: [QT.units[0]] }) === null, 'quadrats: none without a second level');
  const noPct = quadratSetup({ ...QT, components: [comp('ab', 'abundance', 'occurrence', { kinds: ['BB'], default: 'BB' })] });
  ok(noPct && !noPct.recordCover && !noPct.freq && noPct.n === 10 && noPct.mode === 'cells' && noPct.topEdge === 'N' && noPct.surface.length === 0, 'quadrats: no cover without %, the defaults without a frequency');
  ok(coverOf({ organism_quantity: '12.5', organism_quantity_type: '% cover' }) === 12.5, 'quadrats: a % abundance is the cover');
  ok(coverOf({ organism_quantity: '3', organism_quantity_type: 'Braun-Blanquet' }) == null && coverOf({ organism_quantity: null, organism_quantity_type: '% cover' }) == null && coverOf({ organism_quantity: 'x', organism_quantity_type: '% cover' }) == null, 'quadrats: no cover from another scale, an empty or a broken value');
  const ql = quadratLike(true, 'count', { vascular_cover_pct: 30, litter_cover_pct: 'x' });
  ok(ql.locked === 1 && ql.freq_mode === 'count' && ql.cov_vascular === 30 && ql.cov_litter === null && ql.cov_scree === null, `quadrats: done, the method and the covers under GLORIA's keys (${JSON.stringify(ql)})`);
  ok(quadratLike(false, 'cells', {}).locked === 0, 'quadrats: not done');
  ok(herbLayer(1) === 'E1' && herbLayer(2) === 'E2' && herbLayer(6) === 'E2', 'quadrats: species go to the herb layer (the moss layer with one layer)');
  ok(nextUnitCode(['Q1', 'Q3', 'S2'], 'Q') === 'Q2' && nextUnitCode([], 'Q') === 'Q1' && nextUnitCode(['Q1']) === 'S1', 'quadrats: the next quadrat code is the first free Q<n>; subplots still S<n>');
  const units = [
    { id: 1, parent_id: null, level_key: 'sub' },
    { id: 2, parent_id: 1, level_key: 'quad' },
    { id: 3, parent_id: null, level_key: 'quad' },
    { id: 4, parent_id: 2, level_key: 'cell' },
  ];
  const occ = (taxon_id, unit_id, via_interaction = 0) => ({ taxon_id, unit_id, via_interaction });
  const miss = taxaNotInPlotList(
    units,
    [occ('a', 1), occ('a', 2), occ('b', 2), occ('c', 3), occ('d', 4), occ('e', null), occ('e', 2), occ('f', 2, 1), occ('b', 3)],
    ['sub', 'quad', 'cell'],
  );
  ok(
    JSON.stringify(miss) === JSON.stringify([{ taxon_id: 'b', parentId: 1 }, { taxon_id: 'c', parentId: null }, { taxon_id: 'd', parentId: 1 }]),
    `quadrats: species in a quadrat (or below) missing from the plot list, each with its subplot; an interaction's other side does not count (${JSON.stringify(miss)})`,
  );
  // A quadrat may stand without a subplot, as on the fixed plot.
  const D = c.createSurvey(ctx, { template: FULL });
  const lone = c.addUnit(ctx, D, { levelKey: 'quadrat', code: 'Q1' });
  ok(c.getUnit(ctx, lone).parent_id == null, 'quadrats: one without a subplot is allowed');
}

// ── 2G-d4: deleting a quadrat takes what is in it, as the fixed plot does (asked 2026-10-04) ──
{
  const QD = withRequired({
    schema: 1,
    id: 'user:qdel',
    version: 1,
    origin: 'user',
    name: { text: '刪除小樣方' },
    style: 'plot',
    units: [
      { key: 'u1', label: { text: '小區' } },
      { key: 'u2', label: { text: '小樣方' } },
      { key: 'u3', label: { text: '細格' } },
    ],
    components: [
      { key: 'inter', type: 'interaction', level: 'occurrence', required: false, params: { builtin: ['feeding'], count: false, photos: 1 } },
      { key: 'qenv', type: 'environment', level: 'unit', unit: 'u2', required: false, params: { fields: ['slope_deg'] } },
      { key: 'qph', type: 'photos', level: 'unit', unit: 'u2', required: false, params: { max: 4 } },
      { key: 'oph', type: 'photos', level: 'occurrence', required: false, params: { max: 4 } },
    ],
    codelists: [],
    quick_add: false,
  });
  ok(validateTemplate(QD).length === 0, `quadrat delete: the test template is valid (${validateTemplate(QD)})`);
  const D = c.createSurvey(ctx, { template: QD });
  const S = c.addUnit(ctx, D, { levelKey: 'u1', code: 'S1' });
  const Q = c.addUnit(ctx, D, { levelKey: 'u2', code: 'Q1', parentId: S });
  const Q2 = c.addUnit(ctx, D, { levelKey: 'u2', code: 'Q2', parentId: S });
  const cell = c.addUnit(ctx, D, { levelKey: 'u3', code: 'Q1a', parentId: Q });
  ok(JSON.stringify(unitSubtree(c.listUnits(ctx, D), Q)) === JSON.stringify([Q, cell]) && unitSubtree(c.listUnits(ctx, D), Q2).length === 1, 'quadrat delete: the unit and the units below it');
  const inQ = c.addOccurrence(ctx, D, { taxon_id: 'tq', unit_id: Q });
  const inCell = c.addOccurrence(ctx, D, { taxon_id: 'tc', unit_id: cell });
  const inQ2 = c.addOccurrence(ctx, D, { taxon_id: 'tq2', unit_id: Q2 });
  const inS = c.addOccurrence(ctx, D, { taxon_id: 'ts', unit_id: S });
  c.writeComponent(ctx, { kind: 'unit', id: Q }, 'qenv', { slope_deg: 12 });
  c.addMedia(ctx, { kind: 'unit', id: Q }, 'qph', 'file:///q1.jpg');
  c.addMedia(ctx, { kind: 'occurrence', id: inQ }, 'oph', 'file:///o1.jpg');
  // From the quadrat to a taxon not recorded: its other side is made there (via_interaction).
  const viaI = ix.addInteraction(ctx, { from: inQ, partner: { taxonId: 'tvia' }, type: 'feeding', direction: 'forward' });
  const via = c.getOccurrence(ctx, one('SELECT subject_occurrence_id AS a, object_occurrence_id AS b FROM fw_interactions WHERE id = ?', viaI).b);
  // From outside to one inside; and one recorded here between two outside (moved up when it goes).
  const crossI = ix.addInteraction(ctx, { from: inS, partner: { occurrenceId: inCell }, type: 'feeding', direction: 'forward' });
  const outI = ix.addInteraction(ctx, { from: inS, partner: { occurrenceId: inQ2 }, type: 'feeding', direction: 'forward' });
  sqlite.prepare('UPDATE fw_interactions SET unit_id = ? WHERE id = ?').run(Q, outI);
  c.setUnitDone(ctx, cell, true);
  throwsCode(() => c.deleteUnitWithContents(ctx, Q), 'unit_done', 'quadrat delete: refused while a unit below it is done');
  ok(c.getUnit(ctx, Q) != null && c.getOccurrence(ctx, inQ) != null, 'quadrat delete: refused before anything went');
  c.setUnitDone(ctx, cell, false);
  // Children removed by hand, as the app runs with foreign keys off (see the survey delete above).
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  c.deleteUnitWithContents(ctx, Q);
  ok(c.getUnit(ctx, Q) == null && c.getUnit(ctx, cell) == null, 'quadrat delete: the quadrat and the units below it go');
  ok(c.getOccurrence(ctx, inQ) == null && c.getOccurrence(ctx, inCell) == null && c.getOccurrence(ctx, via.id) == null, 'quadrat delete: its occurrences go (with an interaction partner made only for it)');
  ok(count('fw_unit_values', 'unit_id = ?', Q) === 0 && count('fw_media', 'unit_id = ? OR occurrence_id = ?', Q, inQ) === 0 && count('fw_occurrence_values', 'occurrence_id IN (?, ?)', inQ, inCell) === 0, 'quadrat delete: its values and photos, and its occurrences\', go');
  ok(count('fw_interactions', 'id IN (?, ?)', viaI, crossI) === 0, 'quadrat delete: interactions with its occurrences go');
  ok(one('SELECT unit_id AS u FROM fw_interactions WHERE id = ?', outI)?.u === S, 'quadrat delete: an interaction recorded there between occurrences elsewhere stays, one level up');
  ok(c.getUnit(ctx, S) != null && c.getUnit(ctx, Q2) != null && c.getOccurrence(ctx, inS)?.unit_id === S && c.getOccurrence(ctx, inQ2)?.unit_id === Q2, 'quadrat delete: the subplot, the other quadrat and their species stay');
  c.setUnitDone(ctx, Q2, true);
  throwsCode(() => c.deleteUnitWithContents(ctx, Q2), 'unit_done', 'quadrat delete: not a quadrat marked done');
  throwsCode(() => c.deleteUnitWithContents(ctx, 999999), 'not_found', 'quadrat delete: an unknown unit');
  for (const [table, where] of CASCADE_ORPHANS) if (table.startsWith('fw_')) ok(count(table, where) === 0, `quadrat delete: no ${table} orphans`);
  sqlite.exec('PRAGMA foreign_keys = ON;');
}

// ── 2G-e: a builder preview's scratch file: every id it hands out is a preview id (previewIds.ts) ──
{
  const sq = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const pdb = {
    executeSync(sql, params = []) {
      const stmt = sq.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
      const res = stmt.run(...params);
      return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
    },
  };
  await runUserMigrations(pdb);
  sq.exec('PRAGMA foreign_keys = ON;');
  raisePreviewIds(pdb);
  const pctx = { db: pdb, now: () => ++clock, uuid: () => `p-${++n}` };
  const PT = withRequired({
    schema: 1,
    id: 'user:preview',
    version: 1,
    origin: 'user',
    name: { text: '預覽' },
    style: 'plot',
    units: [{ key: 'sub', label: { text: '小區' } }],
    components: [
      { key: 'inter', type: 'interaction', level: 'occurrence', required: false, params: { builtin: ['feeding'], count: false, photos: 1 } },
      { key: 'oph', type: 'photos', level: 'occurrence', required: false, params: { max: 4 } },
    ],
    codelists: [],
    quick_add: false,
  });
  const sv = c.createSurvey(pctx, { template: PT });
  const su = c.addUnit(pctx, sv, { levelKey: 'sub', code: 'S1' });
  const o1 = c.addOccurrence(pctx, sv, { taxon_id: 'pa', unit_id: su });
  const o2 = c.addOccurrence(pctx, sv, { taxon_id: 'pb', unit_id: su });
  const pi = ix.addInteraction(pctx, { from: o1, partner: { occurrenceId: o2 }, type: 'feeding', direction: 'forward' });
  c.addMedia(pctx, { kind: 'occurrence', id: o1 }, 'oph', 'file:///p1.jpg');
  const pm = sq.prepare('SELECT id FROM fw_media').get().id;
  ok([sv, su, o1, o2, pi, pm].every(isPreviewId), `preview: survey, unit, occurrence, interaction and media ids are preview ids (${[sv, su, o1, o2, pi, pm]})`);
  ok(isPreviewId(PREVIEW_ID_BASE) && !isPreviewId(PREVIEW_ID_BASE - 1) && !isPreviewId(null) && !isPreviewId(undefined) && !isPreviewId(sv - PREVIEW_ID_BASE), 'preview: the id range');
  // A table the survey screens pass ids of, made without AUTOINCREMENT, would hand out user.db-sized ids.
  for (const tbl of ['fw_surveys', 'fw_units', 'fw_occurrences', 'fw_interactions', 'fw_media', 'fw_rechecks'])
    ok(/AUTOINCREMENT/i.test(sq.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(tbl)?.sql ?? ''), `preview: ${tbl} ids come from sqlite_sequence`);
  ok(c.listSurveys(ctx).every((x) => !isPreviewId(x.id)), 'preview: user.db ids are never preview ids');
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-core: templates, checklist and plot surveys, units, phases, values and deletes hold on the real schema');
