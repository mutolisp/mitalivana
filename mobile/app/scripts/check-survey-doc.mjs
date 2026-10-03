/**
 * A checklist / plot-style survey as one document (src/survey/db/surveyDocCore.ts;
 * Phase 2C-b): the unit of its record versions, team merge and team sync. Two
 * phones are two databases on the real migrated schema, foreign keys ON.
 *
 * What must hold:
 *   - a survey copied to another phone (insertSurveyFromDoc) is the same
 *     survey there: its plot, series, layout, morphospecies, units,
 *     occurrences, values and recheck answers, every row by its key;
 *   - merging the two copies after each phone changed something brings both
 *     changes, with nothing asked where only one side changed; two phones
 *     that each added the same quadrat (level + code) meet in one unit, and
 *     the same taxon added in one unit on both is offered as a duplicate;
 *   - investigators are pooled, the earlier start and the later end kept;
 *   - restoring a version makes the survey equal to it again, but never
 *     reopens a closed blind phase, never removes from the plot's layout or
 *     morphospecies (another survey may use them), and leaves a closed blind
 *     phase's records — and the units holding them — as they are;
 *   - a teammate's copy carries neither this phone's project nor file paths,
 *     but does carry the survey before it, made on the teammate's phone when
 *     missing so the recheck has its list (never in a record version);
 *   - photo rows come back on restore only if their file is still here and
 *     their owner exists;
 *   - a plot's survey is found by plot + template + number (two phones that
 *     each started it meet), a survey without a plot by its uuid;
 *   - a plot code another plot holds and a number the series already has are refused.
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { baseOf, diffSides, planOps, defaultDecision } from '../src/lib/mergeEngine.ts';
import { restoreDecisions, takeVersion } from '../src/lib/recordVersionsCore.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as d from '../src/survey/db/surveyDocCore.ts';
import { withRequired } from '../src/survey/template/validate.ts';

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
    ok(e?.code === code, `${msg} (threw ${e?.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};

let clock = 1_000_000;
let n = 0;
async function phone(tag) {
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
  const ctx = { db, now: () => ++clock, uuid: () => `${tag}-${++n}` };
  const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
  const count = (table, where = '1', ...a) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).n;
  return { sqlite, db, ctx, one, count };
}

const PL = withRequired({
  schema: 1,
  id: 'user:plot',
  version: 1,
  origin: 'user',
  name: { text: 'plot' },
  style: 'plot',
  units: [
    { key: 'subplot', label: { text: '小區' } },
    { key: 'quadrat', label: { text: '小樣方' } },
  ],
  components: [
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'percent'], default: 'BB' } },
    { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'len', label: { text: '葉長' }, unit: 'cm' }] } },
    { key: 'q_photos', type: 'photos', level: 'unit', unit: 'quadrat', required: false, params: { max: 4 } },
    { key: 'cover', type: 'environment', level: 'unit', unit: 'subplot', required: false, params: { fields: ['rock_cover_pct'] } },
    { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['elevation_m'] } },
  ],
  codelists: [],
  quick_add: false,
});

const side = (p, id, opts) => d.surveyDocSide(d.buildSurveyDoc(p.ctx, id), opts);
const sameSide = (a, b) => JSON.stringify(baseOf(a).sort()) === JSON.stringify(baseOf(b).sort());
const mergeInto = (p, id, remoteSide, base) => {
  const local = side(p, id);
  const items = diffSides(local, remoteSide, base, d.SURVEY_DOC_COMBINERS);
  const decisions = new Map(items.map((it) => [it.id, defaultDecision(it)]));
  d.applySurveyDocOps(p.ctx, id, planOps(items, decisions));
  return items;
};

// ── phone A: a plot, its layout, a first survey and a recheck ────────────
const A = await phone('a');
const F = s.createFrame(A.ctx, { code: 'TP1', sizeXM: 20, sizeYM: 20 });
const P1 = c.createSurvey(A.ctx, { template: PL, frameId: F, investigators: '甲' });
const S1 = c.addUnit(A.ctx, P1, { levelKey: 'subplot', code: 'S1' });
const Q1 = c.addUnit(A.ctx, P1, { levelKey: 'quadrat', code: 'Q1', parentId: S1 });
c.addOccurrence(A.ctx, P1, { taxon_id: 't1', unit_id: Q1 });
c.addOccurrence(A.ctx, P1, { taxon_id: 't2', unit_id: S1, verbatim_identification: 'sp1' });
c.addFrameLabel(A.ctx, F, { taxonId: 't2', verbatim: 'sp1', note: '葉背有毛', firstSurveyId: P1 });
c.finishSurvey(A.ctx, P1);
const P2 = c.createSurvey(A.ctx, { template: PL, frameId: F, investigators: '甲' });
const u2 = Object.fromEntries(c.listUnits(A.ctx, P2).map((u) => [u.code, u.id]));
const o1 = c.addOccurrence(A.ctx, P2, { taxon_id: 't1', unit_id: u2.Q1, organism_quantity: '2', organism_quantity_type: 'Braun-Blanquet Scale' });
c.writeComponent(A.ctx, { kind: 'occurrence', id: o1 }, 'leaf', { len: 4.5 });
c.writeComponent(A.ctx, { kind: 'unit', id: u2.S1 }, 'cover', { rock_cover_pct: 20 });
c.writeComponent(A.ctx, { kind: 'survey', id: P2 }, 'env', { elevation_m: 1200 });
c.addMedia(A.ctx, { kind: 'unit', id: u2.Q1 }, 'q_photos', 'file:///photos/q1.jpg');
c.closeBlindPhase(A.ctx, P2);
// Blind occurrences are sealed now; the edits below go to one added in the recheck.
const oR = c.addOccurrence(A.ctx, P2, { taxon_id: 't4', unit_id: u2.Q1 });
c.writeComponent(A.ctx, { kind: 'occurrence', id: oR }, 'leaf', { len: 4.5 });
c.answerRecheck(A.ctx, P2, { frameUnitId: A.one(`SELECT id FROM fw_frame_units WHERE code = 'S1'`).id, taxonId: 't2', verbatim: 'sp1' }, 'not_found');

const docA = d.buildSurveyDoc(A.ctx, P2);
ok(d.isSurveyDoc(docA) && !d.isSurveyDoc({ ...docA, record_type: 'census_slice' }), 'doc: recognised');
ok(
  docA.units.map((u) => `${u.level_key}:${u.code}<${u.parent ?? '-'}`).join(',') === 'subplot:S1<-,quadrat:Q1<subplot:S1',
  `doc: units parents first, linked by key (${docA.units.map((u) => `${u.code}<${u.parent}`)})`,
);
ok(docA.occurrences[0].unit === 'quadrat:Q1' && docA.occurrence_values[0].occurrence === docA.occurrences[0].uuid, 'doc: occurrences and values linked by key');
ok(docA.rechecks[0].place === 'subplot:S1' && docA.frame_labels[0].first_survey === A.one(`SELECT uuid FROM fw_surveys WHERE id = ?`, P1).uuid, 'doc: recheck place and label first survey');
ok(docA.media.length === 1 && docA.media[0].unit === 'quadrat:Q1', 'doc: photo rows with their owner');
ok(!d.surveyDocSide(docA, { frame: false }).funit && d.surveyDocSide(docA).funit.length === 2, 'side: the plot tables only when asked for');

// ── phone B receives it ──────────────────────────────────────────────────
const B = await phone('b');
const P2b = d.insertSurveyFromDoc(B.ctx, docA, { status: 'active', projectId: 0 });
ok(sameSide(side(A, P2), side(B, P2b)), 'copy: the same survey on the other phone (every row)');
ok(B.one(`SELECT uuid FROM fw_surveys WHERE id = ?`, P2b).uuid === docA.survey.uuid && B.count('fw_frames') === 1 && B.count('fw_frame_series') === 1, 'copy: own uuid, plot and series created');
ok(d.surveyByIdent(B.ctx, docA) === P2b && d.surveyIdent(docA) === `${docA.frame.uuid}|user:plot|2`, 'ident: plot + template + number');
ok(B.count('fw_media') === 0, 'copy: photo rows not copied (file sync brings them)');
ok(B.one(`SELECT blind_closed_at AS b FROM fw_surveys WHERE id = ?`, P2b).b != null, 'copy: the blind phase stays closed');
// B has survey 2 without survey 1: still a recheck (its number says so), with nothing to compare here.
ok(c.hasBlindPhase(B.ctx, P2b) && c.recheckState(B.ctx, P2b)?.previousId === null, 'copy: a recheck without its earlier survey here is still a recheck');
const base0 = baseOf(side(A, P2));

// ── both phones change it ────────────────────────────────────────────────
c.writeComponent(A.ctx, { kind: 'occurrence', id: oR }, 'leaf', { len: 5 });
c.updateSurvey(A.ctx, P2, { investigators: '甲' });
const ub = Object.fromEntries(c.listUnits(B.ctx, P2b).map((u) => [u.code, u.id]));
const q2a = c.addUnit(A.ctx, P2, { levelKey: 'quadrat', code: 'Q2', parentId: u2.S1 });
const q2b = c.addUnit(B.ctx, P2b, { levelKey: 'quadrat', code: 'Q2', parentId: ub.S1, label: '東' });
c.addOccurrence(A.ctx, P2, { taxon_id: 't9', unit_id: q2a });
const oB = c.addOccurrence(B.ctx, P2b, { taxon_id: 't9', unit_id: q2b });
ok(c.getOccurrence(B.ctx, oB).phase === 'recheck', 'copy: a teammate adding after the close adds to the recheck');
c.addOccurrence(B.ctx, P2b, { taxon_id: 't3', unit_id: ub.Q1 });
c.updateSurvey(B.ctx, P2b, { investigators: '乙', notes: '霧' });
const items = mergeInto(A, P2, side(B, P2b), base0);
const kinds = items.map((it) => `${it.tbl}:${it.kind}`).sort();
ok(kinds.includes('occ:duplicate') && !kinds.some((k) => k.endsWith(':conflict')), `merge: the same taxon added in one quadrat on both is a duplicate, nothing else asked (${kinds})`);
ok(A.count('fw_units', 'survey_id = ? AND code = ?', P2, 'Q2') === 1 && A.one(`SELECT label FROM fw_units WHERE survey_id = ? AND code = 'Q2'`, P2).label === '東', 'merge: a quadrat added on both is one unit, with their label');
ok(A.count('fw_occurrences', 'survey_id = ? AND taxon_id = ?', P2, 't3') === 1, 'merge: their new occurrence comes in');
ok(A.count('fw_occurrences', 'survey_id = ? AND taxon_id = ?', P2, 't9') === 1, 'merge: the duplicate is not added by default');
ok(A.one(`SELECT investigators AS i, notes FROM fw_surveys WHERE id = ?`, P2).i === '甲,乙' && A.one(`SELECT notes FROM fw_surveys WHERE id = ?`, P2).notes === '霧', 'merge: investigators pooled, their note taken');
ok(c.readComponent(A.ctx, { kind: 'occurrence', id: oR }, 'leaf').len === 5, 'merge: a value changed here only stays');
ok(A.count('fw_frame_units', 'frame_id = ?', F) === 3, 'merge: the plot layout has the new quadrat once');
const bAfter = mergeInto(B, P2b, side(A, P2), baseOf(side(B, P2b)));
ok(bAfter.every((it) => it.kind !== 'conflict'), 'merge back: no conflicts');
ok(c.readComponent(B.ctx, { kind: 'occurrence', id: B.one(`SELECT id FROM fw_occurrences WHERE survey_id = ? AND taxon_id = 't4'`, P2b).id }, 'leaf').len === 5, 'merge back: their value arrives');
void oB;

// ── a teammate deletes; the plot's tables are never deleted from ────────
const removed = side(B, P2b);
removed.funit = [];
removed.flabel = [];
removed.occ = removed.occ.filter((r) => r.data.taxon_id !== 't3');
const delItems = mergeInto(A, P2, removed, baseOf(side(A, P2)));
ok(delItems.some((it) => it.tbl === 'occ' && it.kind === 'remoteDeleted'), 'delete: their deletion is offered');
ok(A.count('fw_occurrences', 'survey_id = ? AND taxon_id = ?', P2, 't3') === 1, 'delete: not taken without a tap (default keeps it)');
const delOps = planOps(delItems, restoreDecisions(delItems));
d.applySurveyDocOps(A.ctx, P2, delOps);
ok(A.count('fw_occurrences', 'survey_id = ? AND taxon_id = ?', P2, 't3') === 0, 'delete: taken when chosen');
ok(A.count('fw_frame_units', 'frame_id = ?', F) === 3 && A.count('fw_frame_labels', 'frame_id = ?', F) === 1, 'delete: the plot layout and morphospecies stay');

// ── a version restore ────────────────────────────────────────────────────
const v0 = d.buildSurveyDoc(A.ctx, P2);
const before = side(A, P2, { frame: false });
c.writeComponent(A.ctx, { kind: 'occurrence', id: oR }, 'leaf', { len: 9 });
const extra = c.addOccurrence(A.ctx, P2, { taxon_id: 't7', unit_id: u2.Q1 });
c.addUnit(A.ctx, P2, { levelKey: 'subplot', code: 'S9' });
c.updateSurvey(A.ctx, P2, { notes: '晴' });
c.removeMedia(A.ctx, { kind: 'unit', id: u2.Q1 }, 'q_photos', 'file:///photos/q1.jpg');
const now = side(A, P2, { frame: false });
const vItems = diffSides(now, d.surveyDocSide(v0, { frame: false }), baseOf(now), takeVersion(d.SURVEY_DOC_COMBINERS));
d.applySurveyDocOps(A.ctx, P2, planOps(vItems, restoreDecisions(vItems)));
ok(sameSide(side(A, P2, { frame: false }), before), 'restore: equal to the version again');
ok(c.getOccurrence(A.ctx, extra) == null && c.readComponent(A.ctx, { kind: 'occurrence', id: oR }, 'leaf').len === 5, 'restore: an added occurrence goes, a value comes back');
ok(A.count('fw_frame_units', 'frame_id = ? AND code = ?', F, 'S9') === 1, 'restore: a unit added to the plot stays on the plot');
ok(d.putBackMediaRows(A.ctx, P2, v0, () => false) === 0 && A.count('fw_media', 'survey_id = ?', P2) === 0, 'media: a row whose file is gone stays gone');
ok(d.putBackMediaRows(A.ctx, P2, v0, () => true) === 1 && A.count('fw_media', 'survey_id = ?', P2) === 1, 'media: a row whose file is here comes back');
ok(d.putBackMediaRows(A.ctx, P2, v0, () => true) === 0, 'media: not twice');
// A version from before the blind phase closed does not reopen it.
const blindDoc = { ...v0, survey: { ...v0.survey, blind_closed_at: null } };
const now2 = side(A, P2, { frame: false });
const bItems = diffSides(now2, d.surveyDocSide(blindDoc, { frame: false }), baseOf(now2), takeVersion(d.SURVEY_DOC_COMBINERS));
d.applySurveyDocOps(A.ctx, P2, planOps(bItems, restoreDecisions(bItems)));
ok(A.one(`SELECT blind_closed_at AS b FROM fw_surveys WHERE id = ?`, P2).b != null, 'restore: a closed blind phase stays closed');

// A version from before the close: the blind records stay as they are now (sealed, §5.5).
c.finishSurvey(A.ctx, P2);
const P3 = c.createSurvey(A.ctx, { template: PL, frameId: F, investigators: '甲' });
const u3 = Object.fromEntries(c.listUnits(A.ctx, P3).map((u) => [u.code, u.id]));
const o3a = c.addOccurrence(A.ctx, P3, { taxon_id: 't1', unit_id: u3.Q1 });
c.writeComponent(A.ctx, { kind: 'occurrence', id: o3a }, 'leaf', { len: 1 });
const vOpen = d.buildSurveyDoc(A.ctx, P3);
ok(d.sealedOccurrences(vOpen, vOpen).occ.size === 0, 'sealed: nothing while the blind phase is open');
const q5 = c.addUnit(A.ctx, P3, { levelKey: 'quadrat', code: 'Q5', parentId: u3.S1 });
const o3b = c.addOccurrence(A.ctx, P3, { taxon_id: 't5', unit_id: q5 });
c.writeComponent(A.ctx, { kind: 'occurrence', id: o3a }, 'leaf', { len: 2 });
c.closeBlindPhase(A.ctx, P3);
const o3c = c.addOccurrence(A.ctx, P3, { taxon_id: 't6', unit_id: u3.Q1 });
const here3 = d.buildSurveyDoc(A.ctx, P3);
const sealed3 = d.sealedOccurrences(here3, vOpen);
ok(sealed3.occ.size === 2 && sealed3.unit.has('quadrat:Q5') && sealed3.unit.has('subplot:S1'), `sealed: the blind records and the units holding them (${[...sealed3.unit]})`);
const now3 = d.surveyDocSide(here3, { frame: false });
const all3 = diffSides(now3, d.surveyDocSide(vOpen, { frame: false }), baseOf(now3), takeVersion(d.SURVEY_DOC_COMBINERS));
const it3 = d.withoutSealed(all3, sealed3);
ok(it3.length < all3.length, 'sealed: restore items touching them are left out');
d.applySurveyDocOps(A.ctx, P3, planOps(it3, restoreDecisions(it3)));
ok(c.getOccurrence(A.ctx, o3b)?.unit_id === q5 && A.count('fw_units', 'id = ?', q5) === 1, 'sealed restore: a blind record added before the close stays, in its unit');
ok(c.readComponent(A.ctx, { kind: 'occurrence', id: o3a }, 'leaf').len === 2, 'sealed restore: a blind value is not reverted');
ok(c.getOccurrence(A.ctx, o3c) == null, 'sealed restore: a recheck occurrence added since goes');
ok(d.putBackMediaRows(A.ctx, P3, { ...vOpen, media: [{ uuid: 'm-s', unit: null, occurrence: vOpen.occurrences[0].uuid, component: 'photos', kind: 'photo', uri: 'x', created_at: 1 }] }, () => true, sealed3.occ) === 0, 'sealed restore: no photo put back onto a sealed record');

// What a teammate gets: no project of this phone, no file paths.
const peer = d.surveyDocForPeer({ ...docA, project_id: 5, frame_labels: docA.frame_labels.map((l) => ({ ...l, photo_uri: 'file:///p.jpg' })) });
ok(d.isSurveyDoc(peer) && !('project_id' in peer) && peer.media.length === 0 && peer.frame_labels.every((l) => l.photo_uri == null), 'peer: without project, photo rows or paths');
ok(d.surveyIdent(peer) === d.surveyIdent(docA), 'peer: same identity');

// ── team sync carries the survey before it (a teammate's recheck list) ──
const docPrev = d.buildSurveyDoc(A.ctx, P2, { previous: true });
ok(docA.previous === undefined && d.buildSurveyDoc(A.ctx, P2).previous === undefined, 'previous: not in a record version');
ok(docPrev.previous?.survey.census_no === 1 && docPrev.previous.occurrences.length === A.count('fw_occurrences', 'survey_id = ?', P1), 'previous: survey 1 rides with survey 2');
ok(d.buildSurveyDoc(A.ctx, P1, { previous: true }).previous === undefined, 'previous: none for a first survey');
ok(d.buildSurveyDoc(A.ctx, P3, { previous: true }).previous?.rechecks.length === A.count('fw_rechecks', 'survey_id = ?', P2) && A.count('fw_rechecks', 'survey_id = ?', P2) > 0, 'previous: a recheck carried with its answers (survey 3 carries survey 2)');
const D = await phone('d');
const P2d = (() => {
  D.sqlite.exec('BEGIN');
  const peer = d.surveyDocForPeer(docPrev);
  const prevId = d.insertPreviousFromDoc(D.ctx, peer);
  const id = d.insertSurveyFromDoc(D.ctx, peer, { status: 'done', projectId: 0 });
  D.sqlite.exec('COMMIT');
  ok(prevId != null && D.one(`SELECT status, census_no AS n FROM fw_surveys WHERE id = ?`, prevId).n === 1 && D.one(`SELECT status FROM fw_surveys WHERE id = ?`, prevId).status === 'done', 'previous: made here, finished');
  return id;
})();
const taxa = (p, id) => (c.recheckState(p.ctx, id)?.candidates ?? []).map((x) => `${x.taxonId}|${x.verbatim ?? ''}`).sort().join(',');
ok(c.recheckState(D.ctx, P2d)?.previousId != null && taxa(D, P2d) === taxa(A, P2) && taxa(A, P2) !== '', `previous: the teammate's recheck lists what this phone's does (${taxa(D, P2d)})`);
ok(c.recheckState(D.ctx, P2d).answers.length === c.recheckState(A.ctx, P2).answers.length, 'previous: the answers come with survey 2');
ok(d.insertPreviousFromDoc(D.ctx, d.surveyDocForPeer(docPrev)) === null && D.count('fw_surveys', "style <> 'individual'") === 2, 'previous: not made twice');

// ── a survey without a plot, and refusals ────────────────────────────────
const CL = withRequired({ ...PL, id: 'user:checklist', style: 'checklist', units: undefined, components: [{ key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['count'], default: 'count' } }] });
const K = c.createSurvey(A.ctx, { template: CL });
c.addOccurrence(A.ctx, K, { taxon_id: 't1', organism_quantity: '3', organism_quantity_type: 'individuals' });
const docK = d.buildSurveyDoc(A.ctx, K);
ok(docK.frame == null && d.surveyIdent(docK) === docK.survey.uuid, 'checklist: no plot, identified by uuid');
const Kb = d.insertSurveyFromDoc(B.ctx, docK, { status: 'done', projectId: 99 });
ok(sameSide(side(A, K), side(B, Kb)) && B.one(`SELECT project_id AS p, status FROM fw_surveys WHERE id = ?`, Kb).p === 0, 'checklist: copied; an unknown project falls back to 未分類');
ok(B.one(`SELECT status FROM fw_surveys WHERE id = ?`, Kb).status === 'done', 'checklist: the status asked for (recovered ones land finished)');
ok(d.surveyByIdent(B.ctx, docK) === Kb, 'checklist: found by uuid');
const C = await phone('c');
s.createFrame(C.ctx, { code: 'TP1', sizeXM: 20, sizeYM: 20 });
throwsCode(() => d.insertSurveyFromDoc(C.ctx, docA, { status: 'done', projectId: 0 }), 'frame_code_taken', 'refused: another plot holds the code');
const twin = { ...docA, survey: { ...docA.survey, uuid: 'other' } };
throwsCode(() => d.insertSurveyFromDoc(B.ctx, twin, { status: 'done', projectId: 0 }), 'number_taken', 'refused: the series already has the number');

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-doc: copies, merges, version restores and refusals of a checklist / plot-style survey hold on two phones');
