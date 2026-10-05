/**
 * Team sync of a tree census (src/survey/db/censusSyncCore.ts), on two
 * node:sqlite databases standing for two phones, real migrated schema with
 * foreign keys ON. Documents go between them as JSON, as the relay carries
 * them (sealed, but that is check:team-crypto's).
 *
 * What must hold:
 *   - blocks: k × k quadrats from the lower left, clipped at the edge; a
 *     write stamps its block, a tree moved across blocks stamps both;
 *   - a teammate's header creates the census here (same uuid, plot, series,
 *     block size); a later census needs the one before it; another plot
 *     holding the code, another block size, or another census template for
 *     the same census (not another version of it), is refused;
 *   - two groups in two blocks: each phone ends with both blocks; an edit on
 *     one side comes over without a question (the sender's base); edits on
 *     both sides to one value are a conflict;
 *   - one tag on two trees far apart: a clash; renumbering theirs travels
 *     back and their phone takes it without a question;
 *   - one tag, same place, same species: one tree without asking, the smaller
 *     uuid kept on both phones, stems joined by number;
 *   - two new tags ≤ 0.5 m apart, same species: a possible duplicate; "one
 *     tree" travels as a `merge` row and the other phone folds the same two;
 *   - a merge never deletes a tree or stem; a tree moved to another block
 *     lands there; a measurement removed by them goes only when asked;
 *   - the tags given up in a fold are retired;
 *   - nothing is left for the integrity sweep to find.
 *
 * Run: npm run check:census-sync
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { CASCADE_ORPHANS } from '../src/db/integrityRules.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as cs from '../src/survey/db/censusSyncCore.ts';
import * as sl from '../src/survey/db/sliceCore.ts';
import { defaultDecision, needsReview } from '../src/lib/mergeEngine.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const throwsSync = (fn, code, msg) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof cs.CensusSyncError && e.code === code, `${msg} (threw ${e.message})`);
    return;
  }
  ok(false, `${msg} (did not throw)`);
};

let clock = 1000;
async function phone(prefix) {
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
  let n = 0;
  const ctx = { db, now: () => ++clock, uuid: () => `${prefix}-${String(++n).padStart(4, '0')}` };
  const tx = (fn) => {
    sqlite.exec('BEGIN');
    try {
      const r = fn();
      sqlite.exec('COMMIT');
      return r;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  };
  const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
  const count = (table, where = '1', ...a) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).n;
  // The merge base of the census, as sync_base keeps it.
  // base: the census's sync base (baseAfterMerge); stored: the same as the phone keeps it, change by change (patchSyncBase).
  return { sqlite, db, ctx, tx, one, count, base: [], stored: new Map(), name: prefix };
}

const A = await phone('a');
const B = await phone('b');
const taxon = (id) => ({ taxonId: id, usedScientificName: `Sp ${id}` });
const xy = (x, y) => ({ method: 'xy', x, y });
const sd = (over) => ({ stemNo: null, dbhCm: null, pomM: 1.3, stemDead: false, codes: [], notes: null, ...over });
const draft = (over) => ({
  individualId: null,
  tag: null,
  taxon: taxon('k1'),
  location: xy(5, 5),
  notes: null,
  heightM: null,
  treeCodes: [],
  mainStemNo: 1,
  stems: [sd({ dbhCm: 10 })],
  recordedBy: null,
  ...over,
});
const tree = (P, uuid) => P.one('SELECT * FROM fw_individuals WHERE uuid = ?', uuid);
const dbhOf = (P, sid, treeUuid, stemNo = 1) =>
  P.one(
    `SELECT m.dbh_cm AS d FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id JOIN fw_individuals i ON i.id = st.individual_id WHERE m.survey_id = ? AND i.uuid = ? AND st.stem_no = ?`,
    sid,
    treeUuid,
    stemNo,
  )?.d;

// ── blocks ───────────────────────────────────────────────────────────────
ok(cs.blockOf('0000', 5) === 'b0_0' && cs.blockOf('0904', 5) === 'b1_0' && cs.blockOf('0405', 5) === 'b0_1', 'blocks: k × k quadrats from the lower left');
ok(JSON.stringify(cs.allBlocks(10, 5, 5)) === '["b0_0","b1_0"]', 'blocks: a 200 × 100 m plot in 1 ha blocks is two');
ok(cs.blockQuadratCodes(10, 5, 5, 'b1_0').length === 25 && cs.blockQuadratCodes(7, 3, 5, 'b1_0').join() === '0500,0501,0502,0600,0601,0602', 'blocks: clipped at the plot edge');
ok(cs.parseBlock('b3_12')?.br === 12 && cs.parseBlock('0102') == null, 'blocks: ids parse');

// ── a census reaches the other phone ─────────────────────────────────────
const FA = s.createFrame(A.ctx, { code: 'TS1', sizeXM: 200, sizeYM: 100 });
const CA = s.startCensus(A.ctx, { frameId: FA, template: STEMMAP_TEMPLATE });
cs.setBlockSize(A.ctx, CA, 5);
const header = JSON.parse(JSON.stringify(cs.buildTeamHeader(A.ctx, CA, ['b0_0'], 'Ann')));
ok(cs.isTeamHeader(header) && header.block_quadrats === 5 && header.claims.join() === 'b0_0', 'header: block size and claims');
const got = B.tx(() => cs.ensureCensus(B.ctx, header));
const CB = got.surveyId;
ok(got.created && s.getSurvey(B.ctx, CB).uuid === s.getSurvey(A.ctx, CA).uuid && s.getSurvey(B.ctx, CB).sync_block_quadrats === 5, 'header: the census is created here with its uuid and block size');
ok(B.one('SELECT uuid FROM fw_frames').uuid === s.getFrame(A.ctx, FA).uuid && s.getSurvey(B.ctx, CB).project_id === 0, 'header: with its plot; unfiled here');
ok(!B.tx(() => cs.ensureCensus(B.ctx, header)).created, 'header: the second time it is found');
ok(cs.identOfCensus(B.ctx, CB) === cs.identOfCensus(A.ctx, CA), 'header: same plot + series + number on both');
// Another block size (two phones chose apart, code review M1): linked, not refused; the census sync settles on the smaller.
ok(!B.tx(() => cs.ensureCensus(B.ctx, { ...header, block_quadrats: 3 })).created && s.getSurvey(B.ctx, CB).sync_block_quadrats === 5, 'header M1: another block size is linked, the size here kept until the sync');
ok(cs.teamBlockSize(5, [3, undefined, 4]) === 3 && cs.teamBlockSize(null, [undefined]) === null && cs.teamBlockSize(2, [5]) === 2, 'header M1: the team\'s block size is the smallest any phone has');
// A 10 × 5 quadrat plot: block b1_0 at size 5 is quadrats 5–9 × 0–4, the blocks b1_0, b2_0, b3_0, b1_1… at size 2.
ok(JSON.stringify(cs.regroupBlocks(['b1_0'], 10, 5, 5, 2)) === JSON.stringify(['b2_0', 'b2_1', 'b2_2', 'b3_0', 'b3_1', 'b3_2', 'b4_0', 'b4_1', 'b4_2']), `header M1: claims regroup onto the blocks they overlap (${cs.regroupBlocks(['b1_0'], 10, 5, 5, 2)})`);
B.tx(() => cs.changeBlockSize(B.ctx, CB, 3));
ok(s.getSurvey(B.ctx, CB).sync_block_quadrats === 3, 'header M1: the block size changes to the team\'s');
B.tx(() => cs.changeBlockSize(B.ctx, CB, 5));
{
  const app = (await import('node:fs')).readFileSync(new URL('../src/survey/censusSync.ts', import.meta.url), 'utf8');
  ok(/else if \(teamK != null && teamK < k\) \{\s*switchBlockSize\(/.test(app) && !/block_size_differs/.test(app), 'header M1: the sync takes a smaller team size instead of failing');
  ok(/if \(doc\?\.record_type === 'census_block' && doc\.ident === ident && doc\.block_quadrats !== k\) continue;/.test(app), 'header M1: a teammate block at another size is not marked seen');
  ok(/DELETE FROM sync_links WHERE record_kind = 'survey_block'/.test(app) && /DELETE FROM sync_seen WHERE team_id = \? AND rec_key = \?/.test(app), 'header M1: a switch resends every block and reads the teammates\' again');
}
// Another census template for the same plot, series and number (decided 2026-10-03): refused; another version of the same template is not.
throwsSync(() => B.tx(() => cs.ensureCensus(B.ctx, { ...header, survey: { ...header.survey, template_id: 'user:other-census' } })), 'template_differs', 'header: another template refused');
ok(!B.tx(() => cs.ensureCensus(B.ctx, { ...header, survey: { ...header.survey, template_version: 2 } })).created, 'header: the same template at another version is the same census');
ok(cs.templateDiffers('builtin:stemmap', { template_id: 'user:x' }) && !cs.templateDiffers('builtin:stemmap', { template_id: 'builtin:stemmap' }), 'header: templateDiffers compares template ids');
// The round's own fields come with a teammate's header (code review V12): never asked about.
{
  const sv = (id) => B.one('SELECT investigators, start_ts, stop_ts, notes FROM fw_surveys WHERE id = ?', id);
  const b0 = sv(CB);
  B.sqlite.prepare(`UPDATE fw_surveys SET investigators = '乙', notes = '北側陡坡\n草本層稀疏' WHERE id = ?`).run(CB);
  const theirs = { ...header.survey, investigators: '甲,丙', start_ts: b0.start_ts - 1000, stop_ts: b0.start_ts + 5000, notes: '北側陡坡\n樣樁 3 號遺失' };
  ok(B.tx(() => cs.mergeCensusHeader(B.ctx, CB, theirs)), 'header V12: a teammate\'s round fields change the census here');
  const after = sv(CB);
  ok(after.investigators === '乙,甲,丙', `header V12: investigators pooled (${after.investigators})`);
  ok(after.start_ts === b0.start_ts - 1000, 'header V12: the earlier start');
  ok(after.stop_ts == null, 'header V12: still open here stays open');
  ok(after.notes === '北側陡坡\n草本層稀疏\n樣樁 3 號遺失', `header V12: the teammate's note lines added once, these kept (${JSON.stringify(after.notes)})`);
  ok(!B.tx(() => cs.mergeCensusHeader(B.ctx, CB, theirs)), 'header V12: the same header again changes nothing');
  B.sqlite.prepare(`UPDATE fw_surveys SET stop_ts = ? WHERE id = ?`).run(b0.start_ts + 100, CB);
  B.tx(() => cs.mergeCensusHeader(B.ctx, CB, theirs));
  ok(sv(CB).stop_ts === b0.start_ts + 5000, 'header V12: ended here too: the later end');
  B.sqlite.prepare(`UPDATE fw_surveys SET investigators = '乙' WHERE id = ?`).run(CB);
  B.tx(() => cs.ensureCensus(B.ctx, { ...header, survey: theirs }));
  ok(sv(CB).investigators === '乙,甲,丙', 'header V12: ensureCensus merges the header of a census already here');
  B.sqlite.prepare(`UPDATE fw_surveys SET investigators = ?, start_ts = ?, stop_ts = ?, notes = ? WHERE id = ?`).run(b0.investigators, b0.start_ts, b0.stop_ts, b0.notes, CB);
  // The sync itself reads every teammate's header through it (src/survey/censusSync.ts runs on the device).
  const app = (await import('node:fs')).readFileSync(new URL('../src/survey/censusSync.ts', import.meta.url), 'utf8');
  ok(/withTransaction\(\(\) => core\.mergeCensusHeader\(c, surveyId, doc\.survey\)\)/.test(app), 'header V12: the census sync merges each teammate header it reads');
}
// A block over the relay's record limit (code review V6): measured before its photos or
// itself go, skipped while the others still go; block sizes are offered against the same limit.
{
  const app = (await import('node:fs')).readFileSync(new URL('../src/survey/censusSync.ts', import.meta.url), 'utf8');
  const put = app.slice(app.indexOf('const putBlock = async'), app.indexOf('const sendBlock = async'));
  const at = (x) => put.indexOf(x);
  ok(at('const body = sealForRelay(') > -1 && at('body.length > limits.maxObjectBytes') > at('const body = sealForRelay(') && at('sendRecordMedia(') > at('body.length > limits.maxObjectBytes') && at('putSealedBody(') > at('sendRecordMedia('),
    'V6: a block is measured against the relay limit before its photos and itself are sent');
  ok((app.match(/await putBlock\(/g) ?? []).length === 1 && (app.match(/await sendBlock\(/g) ?? []).length === 2, 'V6: every block goes through sendBlock, so one too large does not stop the rest');
  ok(/if \(err\.code !== 'objectTooLarge'\) throw e;/.test(app), 'V6: only a block too large is skipped; other failures still stop the sync');
  ok(/blockSizeOptions\(surveyId, limits\)/.test(app) && /chooseSyncBlock\(\{[^}]*\blimits \}\)/.test(app) && /tooLarge: estimatedBytes > limits\.maxObjectBytes/.test(app), 'V6: block sizes are offered against the relay limit');
}
const C = await phone('c');
s.createFrame(C.ctx, { code: 'TS1', sizeXM: 100, sizeYM: 100 });
throwsSync(() => C.tx(() => cs.ensureCensus(C.ctx, header)), 'frame_code_taken', 'header: a different plot here with that code refused');
const D = await phone('d');
throwsSync(
  () => D.tx(() => cs.ensureCensus(D.ctx, { ...header, ident: header.ident.replace(/\|1$/, '|2'), survey: { ...header.survey, census_no: 2, uuid: 'later' } })),
  'previous_missing',
  'header: census 2 needs census 1 here',
);

// ── exchanging blocks ────────────────────────────────────────────────────
/** What one phone uploads for a block: the doc plus the part of its base about the block (sync.base). */
const send = (P, sid, block) => {
  const doc = cs.buildBlockDoc(P.ctx, sid, block);
  return JSON.parse(JSON.stringify({ ...doc, base: cs.baseForSlice(P.base, doc.slice) }));
};
/** Receives where the quadrats read before openBlock missed a tree it folded away (M10). */
const foldTakes = [];
let foldsSeen = 0;
/** Blocks after which the stored base (patched) differs from the whole base rewritten. */
const baseDrift = [];
/** Receive a block: open, settle, items, apply (decisions: collision id → decision, item id → decision). */
function receive(P, sid, doc, { collisions = new Map(), items: pick = () => null, expect } = {}) {
  return P.tx(() => {
    // What the app reads before openBlock to keep as before_merge (code review M10): the
    // quadrats of trees their folds take here, before they are folded away.
    const takes = cs.quadratsTheirFoldsTake(P.ctx, doc.slice);
    const takenTrees = P.sqlite.prepare(`SELECT uuid FROM fw_individuals WHERE quadrat_code IN (${takes.map(() => '?').join(', ') || "''"})`).all(...takes).map((t) => t.uuid);
    const opened = cs.openBlock(P.ctx, sid, doc.slice);
    const gone = takenTrees.filter((u) => !P.one('SELECT id FROM fw_individuals WHERE uuid = ?', u));
    foldsSeen += opened.folded;
    if ((takes.length > 0) !== (opened.folded > 0) || gone.length !== opened.folded) foldTakes.push(`${P.name} ${doc.block}: ${takes} / folded ${opened.folded}, gone ${gone.length}`);
    if (expect) expect(opened);
    const remote = cs.settleCollisions(P.ctx, sid, opened, collisions, P.name);
    const items = cs.blockItems(P.ctx, sid, doc.block, remote, doc.base, P.base);
    const decisions = new Map(items.map((it) => [it.id, pick(it) ?? defaultDecision(it)]));
    cs.applyBlockItems(P.ctx, sid, items, decisions, remote);
    const change = cs.baseChangeAfterMerge(P.base, opened.sent);
    P.base = cs.baseAfterMerge(P.base, opened.sent);
    // What the phone writes: DELETE the dropped keys, INSERT OR REPLACE the put ones (code review M6).
    for (const [t, k] of change.drop) P.stored.delete(`${t}\u0000${k}`);
    for (const [t, k, h] of change.put) P.stored.set(`${t}\u0000${k}`, h);
    const whole = new Map(P.base.map(([t, k, h]) => [`${t}\u0000${k}`, h]));
    if (whole.size !== P.stored.size || [...whole].some(([k, h]) => P.stored.get(k) !== h)) baseDrift.push(`${P.name} ${doc.block}`);
    return { opened, items, change };
  });
}

const a1 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ location: xy(10, 10), stems: [sd({ dbhCm: 12 }), sd({ dbhCm: 4 })] })));
const a1u = s.getIndividual(A.ctx, a1).uuid;
const b1 = B.tx(() => s.saveTreeDraft(B.ctx, CB, draft({ location: xy(150, 50), taxon: taxon('k2'), stems: [sd({ dbhCm: 30 })] })));
const b1u = s.getIndividual(B.ctx, b1).uuid;
const stampA = cs.blockStamps(A.ctx, CA, 5);
ok(stampA.has('b0_0') && !stampA.has('b1_0'), 'stamps: a write stamps its block only');

let r = receive(B, CB, send(A, CA, 'b0_0'));
ok(r.items.every((it) => !needsReview(it)) && tree(B, a1u)?.tag === s.getIndividual(A.ctx, a1).tag, 'blocks: their new tree comes in without a question');
ok(dbhOf(B, CB, a1u, 2) === 4 && B.count('fw_stems', 'individual_id = ?', tree(B, a1u).id) === 2, 'blocks: with its stems and measurements');
r = receive(A, CA, send(B, CB, 'b1_0'));
ok(tree(A, b1u)?.taxon_id === 'k2' && dbhOf(A, CA, b1u) === 30, 'blocks: and the other way');
{
  const back = receive(A, CA, send(B, CB, 'b0_0'));
  const keys = [...back.change.drop, ...back.change.put].map(([, k]) => k.split('|')[0]);
  ok(A.base.some(([, k]) => k === b1u) && keys.includes(a1u) && !keys.includes(b1u), 'base: a block rewrites only its own rows, not the census (code review M6)');
}
// A tree another series recorded first (a census this phone does not have) comes in without it, not refused (code review M1).
{
  const other = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ location: xy(12, 12), stems: [sd({ dbhCm: 8 })] })));
  const otherU = s.getIndividual(A.ctx, other).uuid;
  const doc = send(A, CA, 'b0_0');
  for (const t of doc.slice.trees) if (t.uuid === otherU) t.first_survey_uuid = 'a-census-of-another-series';
  for (const st of doc.slice.stems) if (st.tree_uuid === otherU) st.first_survey_uuid = 'a-census-of-another-series';
  receive(B, CB, doc);
  ok(tree(B, otherU) != null && tree(B, otherU).first_survey_id == null, 'blocks: a tree first recorded in a census not here comes in, with no first census');
}

// a photo row carries a path on their phone: it is not merged (files come through the file manifest)
A.tx(() => s.addTreeMedia(A.ctx, CA, a1, 'file:///phone-a/photo1.jpg'));
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(B.count('fw_media') === 0 && r.items.every((it) => it.tbl !== 'media'), "photos: their photo row (a path on their phone) is not merged");

// an edit on one side comes over (the sender's base says the other side did not change it)
A.tx(() => s.updateMeasure(A.ctx, A.one('SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 1', a1).id, { dbhCm: 12.4 }));
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(r.items.length > 0 && r.items.every((it) => !needsReview(it)) && dbhOf(B, CB, a1u) === 12.4, `edit: one side's change comes over without a question (${r.items.map((i) => i.kind)})`);
// both change one value → conflict
A.tx(() => s.updateMeasure(A.ctx, A.one('SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 1', a1).id, { dbhCm: 12.6 }));
const b_a1 = tree(B, a1u).id;
B.tx(() => s.updateMeasure(B.ctx, B.one('SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 1', b_a1).id, { dbhCm: 12.8 }));
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(r.items.some((it) => it.kind === 'conflict' && it.tbl === 'measure') && dbhOf(B, CB, a1u) === 12.8, 'edit: both changed one value → a conflict; kept here by default');

// ── one tag on two trees far apart ───────────────────────────────────────
// A tags a tree 901 and has not synced; B uses 901 too, by mistake.
const a5 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '901', location: xy(60, 60) })));
const a5u = s.getIndividual(A.ctx, a5).uuid;
const b2 = B.tx(() => s.saveTreeDraft(B.ctx, CB, draft({ tag: '901', location: xy(70, 70), taxon: taxon('k3') })));
const b2u = s.getIndividual(B.ctx, b2).uuid;
const docB = send(B, CB, 'b0_0');
let clash;
let threw = null;
try {
  receive(A, CA, docB, {
    expect: (o) => {
      clash = o.collisions[0];
    },
  });
} catch (e) {
  threw = e;
}
ok(clash?.kind === 'tag' && clash.local.uuid === a5u && clash.remote.uuid === b2u, 'clash: one tag, far apart → asked');
ok(threw instanceof cs.CensusSyncError && threw.code === 'undecided' && tree(A, b2u) == null, 'clash: unanswered, nothing is merged (one tag cannot sit on two trees)');
threw = null;
try {
  receive(A, CA, docB, { collisions: new Map([[`tag:${b2u}`, { kind: 'renumber', which: 'remote', tag: s.getIndividual(A.ctx, a1).tag }]]) });
} catch (e) {
  threw = e;
}
ok(threw instanceof s.SurveyError && threw.code === 'tag_taken', 'clash: a new number already in use refused');
r = receive(A, CA, docB, { collisions: new Map([[`tag:${b2u}`, { kind: 'renumber', which: 'remote', tag: '888' }]]) });
ok(tree(A, b2u)?.tag === '888' && tree(A, a5u).tag === '901', 'clash: renumber theirs → their tree here as 888');
{
  const all = (d) => new Map(r.opened.collisions.map((c) => [c.id, d]));
  ok(
    r.opened.collisions.length === 1 &&
      cs.decisionsCorrectTheirs(r.opened, all({ kind: 'renumber', which: 'remote', tag: '888' })) &&
      !cs.decisionsCorrectTheirs(r.opened, all({ kind: 'renumber', which: 'local', tag: '888' })),
    'clash: a new number for their tree sends their block back, one for ours does not (code review M8)',
  );
}
ok(A.count('fw_individual_history', "field = 'tag' AND individual_id = ?", tree(A, b2u).id) === 1, 'clash: the renumbering is a tag correction');
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(tree(B, b2u).tag === '888' && tree(B, a5u)?.tag === '901', 'clash: their phone takes the new number and our 901');
ok(r.opened.collisions.length === 0 && r.items.every((it) => !needsReview(it)), `clash: without a question (${r.items.filter(needsReview).map((i) => `${i.tbl}:${i.kind}:${i.fields}`)})`);

// ── one tag, same place, same species ────────────────────────────────────
const a3 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '500', location: xy(30, 30), stems: [sd({ dbhCm: 20 }), sd({ dbhCm: 5 })] })));
const b3 = B.tx(() => s.saveTreeDraft(B.ctx, CB, draft({ tag: '500', location: xy(30.4, 30.2), stems: [sd({ dbhCm: 20.5 })] })));
const a3u = s.getIndividual(A.ctx, a3).uuid;
const b3u = s.getIndividual(B.ctx, b3).uuid;
const keep = a3u < b3u ? a3u : b3u;
r = receive(A, CA, send(B, CB, 'b0_0'));
ok(r.opened.sameTree.length === 1 && r.opened.collisions.length === 0, 'same tree: not asked');
ok(tree(A, keep) && A.count('fw_individuals', "tag = '500'") === 1, 'same tree: one tree here, the smaller uuid');
ok(A.count('fw_stems', 'individual_id = ?', tree(A, keep).id) === 2, 'same tree: stems joined by number');
ok(A.count('fw_individual_history', "field = 'merge' AND individual_id = ?", tree(A, keep).id) === 1, 'same tree: a merge row on the tree kept');
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(tree(B, keep) && B.count('fw_individuals', "tag = '500'") === 1, 'same tree: their phone keeps the same one');

// ── possible duplicate: two new tags on one tree ─────────────────────────
const a4 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '601', location: xy(45, 45), taxon: taxon('k4') })));
const b4 = B.tx(() => s.saveTreeDraft(B.ctx, CB, draft({ tag: '602', location: xy(45.3, 45.2), taxon: taxon('k4') })));
const a4u = s.getIndividual(A.ctx, a4).uuid;
const b4u = s.getIndividual(B.ctx, b4).uuid;
const keep4 = a4u < b4u ? a4u : b4u;
r = receive(A, CA, send(B, CB, 'b0_0'), { collisions: new Map([[`possible:${b4u}`, { kind: 'same', tag: '601' }]]) });
ok(r.opened.collisions.some((c) => c.kind === 'possible' && c.local.uuid === a4u), 'possible duplicate: asked');
ok(
  cs.decisionsCorrectTheirs(r.opened, new Map([[`possible:${b4u}`, { kind: 'same', tag: '601' }]])) && !cs.decisionsCorrectTheirs(r.opened, new Map([[`possible:${b4u}`, { kind: 'both' }]])),
  'possible duplicate: "one tree" sends their block back, "keep both" does not (code review M8)',
);
ok(A.count('fw_individuals', "taxon_id = 'k4'") === 1 && tree(A, keep4)?.tag === '601', 'possible duplicate: "one tree" keeps one, under the tag chosen');
ok(s.retiredTags(A.ctx, FA).has('602') && !s.retiredTags(A.ctx, FA).has('601'), 'possible duplicate: the tag given up is retired, the one kept is not');
// Their phone has 602 on its tree: no tag in common, so only the merge row can tell it.
r = receive(B, CB, send(A, CA, 'b0_0'));
ok(B.count('fw_individuals', "taxon_id = 'k4'") === 1 && tree(B, keep4)?.tag === '601' && r.opened.collisions.length === 0, 'possible duplicate: their phone folds the same two without asking');
ok(r.opened.folded === 1, `possible duplicate: openBlock says it folded one (${r.opened.folded}) — the census screen drops its undo steps on it`);

// they had our tree and tagged it again next to it: still a possible duplicate, asked once
const a7 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '701', location: xy(55, 55), taxon: taxon('k7') })));
receive(B, CB, send(A, CA, 'b0_0'));
const b7 = B.tx(() => s.saveTreeDraft(B.ctx, CB, draft({ tag: '702', location: xy(55.2, 55.1), taxon: taxon('k7') })));
const b7u = s.getIndividual(B.ctx, b7).uuid;
r = receive(A, CA, send(B, CB, 'b0_0'), { collisions: new Map([[`possible:${b7u}`, { kind: 'both' }]]) });
ok(r.opened.collisions.some((c) => c.kind === 'possible' && c.local.uuid === s.getIndividual(A.ctx, a7).uuid), 'possible duplicate: asked even when they already had our tree');
ok(A.count('fw_individuals', "taxon_id = 'k7'") === 2, 'possible duplicate: "keep both" keeps both');
r = receive(A, CA, send(B, CB, 'b0_0'));
ok(r.opened.collisions.length === 0, 'possible duplicate: once answered, not asked again');

// ── a tree moves to the other block ──────────────────────────────────────
const before = A.count('fw_individuals');
// a6: only A has ever sent it, so A's base knows nothing of it; B's base does.
const a6 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '650', location: xy(15, 85), taxon: taxon('k6'), stems: [sd({ dbhCm: 9 })] })));
const a6u = s.getIndividual(A.ctx, a6).uuid;
receive(B, CB, send(A, CA, 'b0_0'));
A.tx(() => s.editRecruit(A.ctx, a1, CA, { location: xy(110, 10) }));
A.tx(() => s.editRecruit(A.ctx, a6, CA, { location: xy(115, 85) }));
const stamps = cs.blockStamps(A.ctx, CA, 5);
ok(stamps.has('b0_0') && stamps.has('b1_0'), 'move: both blocks stamped');
// Even "take theirs" on everything deletes no tree.
r = receive(B, CB, send(A, CA, 'b0_0'), { items: () => ({ pick: 'remote' }) });
ok(tree(B, a1u) != null && tree(B, a6u) != null, 'move: their block without the trees deletes nothing, whatever is picked');
ok(!r.items.some((it) => (it.tbl === 'tree' || it.tbl === 'stem') && it.remote == null), 'move: and offers no tree or stem for deletion');
r = receive(B, CB, send(A, CA, 'b1_0'));
ok(tree(B, a1u)?.quadrat_code === '0500' && dbhOf(B, CB, a1u, 2) === 4, 'move: the other block brings it to its new place, with its measurements');
ok(tree(B, a6u)?.quadrat_code === '0504' && r.items.every((it) => !needsReview(it)), `move: a tree only this phone's base knows moves without a question (${r.items.filter(needsReview).map((i) => `${i.tbl}:${i.kind}:${i.fields}`)})`);
ok(A.count('fw_individuals') === before + 1, '(no tree lost on the moving phone)');

// ── a measurement they removed ───────────────────────────────────────────
A.tx(() => A.ctx.db.executeSync(`DELETE FROM fw_stem_measures WHERE id = (SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 2)`, [a1]));
A.tx(() => s.touchFgQuadrat(A.ctx, CA, '0500'));
r = receive(B, CB, send(A, CA, 'b1_0'));
const removal = r.items.find((it) => it.kind === 'remoteDeleted' && it.tbl === 'measure');
ok(removal && needsReview(removal) && dbhOf(B, CB, a1u, 2) === 4, 'removed: asked, kept until a tap');
ok(r.items.every((it) => it.tbl !== 'tree' || it.kind !== 'remoteDeleted'), 'removed: no tree is ever offered for deletion');
// a fresh removal, taken
A.tx(() => A.ctx.db.executeSync(`DELETE FROM fw_stem_measures WHERE id = (SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 1)`, [a1]));
A.tx(() => s.touchFgQuadrat(A.ctx, CA, '0500'));
r = receive(B, CB, send(A, CA, 'b1_0'), { items: (it) => (it.kind === 'remoteDeleted' ? { pick: 'remote' } : null) });
ok(dbhOf(B, CB, a1u, 1) == null && tree(B, a1u) != null, 'removed: taken → the measurement goes, the tree stays');

// ── one stem number added on both phones (code review M9) ────────────────
{
  const t9 = A.tx(() => s.saveTreeDraft(A.ctx, CA, draft({ tag: '990', location: xy(62, 62), stems: [sd({ dbhCm: 15 })] })));
  const t9u = s.getIndividual(A.ctx, t9).uuid;
  receive(B, CB, send(A, CA, 'b0_0'));
  const stemsOf = (P) =>
    P.sqlite
      .prepare(`SELECT st.stem_no AS n, st.uuid AS u FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.uuid = ? ORDER BY st.stem_no`)
      .all(t9u)
      .map((r) => `${r.n}:${r.u}`)
      .join();
  A.tx(() => s.addStem(A.ctx, t9, CA));
  B.tx(() => s.addStem(B.ctx, tree(B, t9u).id, CB));
  ok(stemsOf(A) !== stemsOf(B), '(both phones added stem 2, each its own)');
  let threw = null;
  let r9 = null;
  try {
    r9 = receive(B, CB, send(A, CA, 'b0_0'));
  } catch (e) {
    threw = e;
  }
  ok(!threw && r9.opened.stemsJoined === 1, `same stem number: their stem 2 is the same stem as ours, no error (${threw?.message ?? r9.opened.stemsJoined})`);
  receive(A, CA, send(B, CB, 'b0_0'));
  ok(stemsOf(A) === stemsOf(B) && stemsOf(A).split(',').length === 2, `same stem number: one stem 2 on both phones, under one uuid (${stemsOf(A)} / ${stemsOf(B)})`);
  // A census made from a file (fillSlice) follows the same rule.
  A.tx(() => s.addStem(A.ctx, t9, CA));
  B.tx(() => s.addStem(B.ctx, tree(B, t9u).id, CB));
  B.tx(() => sl.fillSlice(B.ctx, CB, cs.buildBlockDoc(A.ctx, CA, 'b0_0').slice));
  const nos = stemsOf(B).split(',').map((x) => x.split(':')[0]).join();
  const third = (P) => stemsOf(P).split(',')[2];
  ok(nos === '1,2,3' && third(A).split(':')[1] <= third(B).split(':')[1] === (third(A) === third(B)), `file: a stem the file's phone added under a number ours has is that stem, not a 4th (${stemsOf(B)})`);
}
{
  // A stem whose tree a decision keeps out stays out with it, its measurement too, instead of failing the merge.
  const ops = [
    { op: 'insert', tbl: 'stem', row: { key: 'st-x', data: { tree_uuid: 'no-such-tree', stem_no: 1 } } },
    { op: 'insert', tbl: 'measure', row: { key: 'st-x', data: {} } },
    { op: 'insert', tbl: 'sval', row: { key: 'st-x|c|f|0', data: { stem_uuid: 'st-x' } } },
    { op: 'insert', tbl: 'ival', row: { key: 'no-such-tree|c|f|0', data: { tree_uuid: 'no-such-tree' } } },
    { op: 'update', tbl: 'tree', key: 'whatever', data: {} },
  ];
  const kept = cs.withParents(A.ctx, ops);
  ok(kept.length === 1 && kept[0].op === 'update', `merge: rows without their tree or stem are left out (${kept.map((o) => `${o.op} ${o.tbl}`)})`);
}

// ── this phone's roll of tags ────────────────────────────────────────────
const fa = s.getFrame(A.ctx, FA);
ok(s.suggestTag(A.ctx, fa, { x: 150, y: 50 }, 7001) === '7001', 'roll: a new tree takes the roll\'s first number, wherever it stands');
ok(s.suggestTag(A.ctx, fa, { x: 5, y: 5 }, 601) === '603', 'roll: used (601) and retired (602) numbers are skipped');
ok(s.suggestTag(A.ctx, fa, { x: 150, y: 50 }) !== '7001', 'roll: without one, the tag block decides');

ok(foldsSeen > 0 && foldTakes.length === 0, `merge versions: the quadrats read before a block is opened hold every tree its folds take (${foldsSeen} folds; ${foldTakes.join('; ') || 'none missed'}) (code review M10)`);
ok(baseDrift.length === 0, `base: patched block by block, the same as rewriting the whole census (${baseDrift.join(', ') || 'every block'})`);

// ── integrity ────────────────────────────────────────────────────────────
for (const P of [A, B]) {
  for (const [table, where] of CASCADE_ORPHANS) {
    if (!table.startsWith('fw_')) continue;
    ok(P.count(table, where) === 0, `integrity (${P.name}): no ${table} orphans`);
  }
  ok(P.sqlite.prepare('PRAGMA foreign_key_check').all().length === 0, `integrity (${P.name}): foreign keys hold`);
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ census-sync: blocks, headers, clashes, folds and moves merge the same on both phones');
