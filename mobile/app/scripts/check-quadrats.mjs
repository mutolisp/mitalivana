/**
 * Fixed-plot quadrats (v77, src/db/quadratsCore.ts) on the real migrated
 * schema, foreign keys ON as the app runs them.
 *
 * What must hold:
 *   - the schema's CHECKs refuse a 1- or 11-cell grid, a 0 % cover, an
 *     unknown top edge; UNIQUE(plot, idx) and UNIQUE(quadrat, taxon) hold;
 *   - quadrat_config reads back its defaults from nothing or from garbage;
 *   - the count follows the layout (NW NE C SW SE; one per subplot) and
 *     shrinking removes only quadrats holding nothing;
 *   - size / grid / top edge are fixed once a quadrat holds data; a locked
 *     quadrat takes no edit; cover, masks and counts are validated;
 *   - every write stamps the plot; undo / redo (record snapshot) and the
 *     integrity sweep cover both tables; deleting the plot removes them.
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import { restoreRecordSnapshotIn, sameSnapshot, snapshotRecordIn } from '../src/db/recordSnapshotCore.ts';
import { CASCADE_ORPHANS, NULL_DANGLING } from '../src/db/integrityRules.ts';
import * as q from '../src/db/quadratsCore.ts';
import { quadratProgress } from '../src/lib/quadratProgress.ts';
import { hasQuantity, plotFreqIssues } from '../src/lib/quadratIssues.ts';
import { compactSpeciesLabel, shortSciName } from '../src/lib/speciesLabel.ts';
import { KEYPAD_EMPTY, keypadLabel, keypadLongPress, keypadMark, keypadPress } from '../src/lib/gridKeypad.ts';
import { quadratsFromYaml } from '../src/lib/quadratYaml.ts';
import { buildPlotFrequencyCsv, buildQuadratsCsv, buildQuadratSurfaceCsv, cellColumns, quadratEventIds } from '../src/lib/quadratCsv.ts';

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
    ok(e instanceof q.QuadratError && e.code === code, `${msg} (threw ${e.message})`);
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
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const all = (sql, ...a) => sqlite.prepare(sql).all(...a);
let n = 0;
const uuid = () => `u-${++n}`;
const newPlot = (plotid) =>
  Number(
    sqlite
      .prepare(`INSERT INTO plot_surveys (uuid, plotid, project_id, status, plot_type, created_at, updated_at) VALUES (?, ?, 0, 'active', 'fixed', 1, 1)`)
      .run(uuid(), plotid).lastInsertRowid,
  );

// ── config ───────────────────────────────────────────────────────────────
ok(JSON.stringify(q.parseQuadratConfig(null)) === JSON.stringify(q.DEFAULT_QUADRAT_CONFIG), 'config: nothing → defaults');
ok(JSON.stringify(q.parseQuadratConfig('{oops')) === JSON.stringify(q.DEFAULT_QUADRAT_CONFIG), 'config: malformed → defaults');
const bad = q.parseQuadratConfig(JSON.stringify({ enabled: 'yes', layout: 'spiral', gridN: 11, topEdge: 'X', sizeM: -1 }));
ok(bad.enabled === false && bad.layout === 'cornersCenter' && bad.gridN === 10 && bad.topEdge === 'N' && bad.sizeM === 1, 'config: bad values → defaults');
ok(q.parseQuadratConfig(JSON.stringify({ gridN: 2, topEdge: 'upslope' })).gridN === 2, 'config: grid 2 is allowed');

// ── count follows the layout ─────────────────────────────────────────────
const pid = newPlot('P1');
q.setQuadratConfig(db, pid, { enabled: true, gridN: 5, topEdge: 'upslope' }, 10);
ok(one('SELECT updated_at FROM plot_surveys WHERE id = ?', pid).updated_at === 10, 'config: write stamps the plot');
q.setQuadratCount(db, pid, 5, 20, uuid);
let list = q.listQuadrats(db, pid);
ok(list.map((x) => `${x.label}:${x.position}`).join() === 'Q1:NW,Q2:NE,Q3:C,Q4:SW,Q5:SE', 'count: corners + centre placed NW NE C SW SE');
ok(list.every((x) => x.grid_n === 5 && x.top_edge === 'upslope' && x.size_m === 1), 'count: new quadrats take the configured grid / edge / size');
q.setQuadratCount(db, pid, 99, 21, uuid);
ok(q.listQuadrats(db, pid).length === q.MAX_QUADRATS, 'count: clamped to 25');
throwsCode(() => q.addQuadrat(db, pid, uuid(), 21), 'full', 'add: not a 26th either (code review L11)');
q.setQuadratCount(db, pid, 5, 22, uuid);

const [, , , q4, q5] = q.listQuadrats(db, pid);
const s5 = q.addQuadratSpecies(db, q5.id, 't1', 30);
q.updateQuadrat(db, q4.id, { notes: 'moss mat' }, 31);
const kept = q.setQuadratCount(db, pid, 4, 32, uuid);
ok(q.listQuadrats(db, pid).map((x) => x.label).join() === 'Q1,Q2,Q4,Q5', 'shrink: the last empty quadrat goes, the ones with data are passed over');
ok(kept.map((x) => x.label).join() === 'Q5,Q4', 'shrink: quadrats kept for their data are reported');
q.setQuadratCount(db, pid, 1, 33, uuid);
ok(q.listQuadrats(db, pid).map((x) => x.label).join() === 'Q4,Q5', 'shrink: below the data-holding ones, only they stay');
q.setQuadratCount(db, pid, 5, 34, uuid);
ok(q.listQuadrats(db, pid).map((x) => `${x.label}:${x.position}`).join() === 'Q1:NW,Q2:NE,Q3:C,Q4:SW,Q5:SE', 'grow: refills the free idx with their positions');
const [q1, q2] = q.listQuadrats(db, pid);

const pSub = newPlot('P2');
const subs = [1, 2, 3].map((i) => Number(sqlite.prepare(`INSERT INTO plot_subplots (plot_survey_id, idx, label, created_at) VALUES (?, ?, ?, 1)`).run(pSub, i, `S${i}`).lastInsertRowid));
q.setQuadratConfig(db, pSub, { enabled: true, layout: 'perSubplot' }, 1);
q.setQuadratCount(db, pSub, 3, 2, uuid);
ok(q.listQuadrats(db, pSub).map((x) => x.subplot_id).join() === subs.join(), 'perSubplot: one quadrat in each subplot, in order');

// ── geometry lock, record lock, validation ───────────────────────────────
q.updateQuadrat(db, q1.id, { top_edge: 'E', size_m: 2 }, 40);
ok(one('SELECT top_edge, size_m FROM plot_quadrats WHERE id = ?', q1.id).top_edge === 'E', 'geometry: an empty quadrat can change size and top edge');
throwsCode(() => q.updateQuadrat(db, q1.id, { grid_n: 8 }, 40), 'invalid', 'geometry: one quadrat cannot take its own grid (the grid is the plot\'s)');
throwsCode(() => q.updateQuadrat(db, q5.id, { grid_n: 8 }, 41), 'geometry-locked', 'geometry: a quadrat with species keeps its grid');
throwsCode(() => q.updateQuadrat(db, q4.id, { top_edge: 'S' }, 41), 'geometry-locked', 'geometry: a quadrat with a note keeps its top edge');
q.updateQuadrat(db, q5.id, { grid_n: 5, cov_vascular: 40 }, 42);
ok(one('SELECT cov_vascular FROM plot_quadrats WHERE id = ?', q5.id).cov_vascular === 40, 'geometry: the unchanged value may be sent along');
throwsCode(() => q.updateQuadrat(db, q2.id, { grid_n: 11 }, 43), 'invalid', 'geometry: grid 11 refused');
throwsCode(() => q.updateQuadrat(db, q2.id, { cov_scree: 120 }, 43), 'invalid', 'surface: 120 % refused');

throwsCode(() => q.updateQuadratSpecies(db, s5, { cover_pct: 0 }, 44), 'invalid', 'species: 0 % is a delete, not a value');
throwsCode(() => q.updateQuadratSpecies(db, s5, { cover_pct: 100.5 }, 44), 'invalid', 'species: over 100 % refused');
throwsCode(() => q.updateQuadratSpecies(db, s5, { freq_cells: '1'.repeat(100) }, 44), 'invalid', 'species: a mask for another grid refused');
q.updateQuadratSpecies(db, s5, { cover_pct: 12.5, freq_cells: '1'.repeat(3) + '0'.repeat(22), freq_count: 99 }, 45);
const r5 = one('SELECT * FROM plot_quadrat_species WHERE id = ?', s5);
ok(r5.cover_pct === 12.5 && r5.freq_cells.length === 25 && r5.freq_count === 25, 'species: values stored, count clamped to grid_n²');
ok(one('SELECT updated_at FROM plot_surveys WHERE id = ?', pid).updated_at === 45, 'species: every write stamps the plot');
ok(q.addQuadratSpecies(db, q5.id, 't1', 46) === s5, 'species: adding it again keeps the one row');

q.setQuadratLocked(db, q5.id, true, 50);
ok(one('SELECT locked, ended_at FROM plot_quadrats WHERE id = ?', q5.id).ended_at === 50, 'lock: stamps ended_at');
throwsCode(() => q.updateQuadratSpecies(db, s5, { cover_pct: 20 }, 51), 'locked', 'lock: species values refused');
throwsCode(() => q.addQuadratSpecies(db, q5.id, 't2', 51), 'locked', 'lock: new species refused');
throwsCode(() => q.updateQuadrat(db, q5.id, { notes: 'x' }, 51), 'locked', 'lock: quadrat fields refused');
throwsCode(() => q.deleteQuadrat(db, q5.id, 51), 'locked', 'lock: not deleted either until unlocked (code review L10)');
throwsCode(() => q.setFreqMode(db, q5.id, 'count', 51), 'locked', 'lock: mode switch refused');
q.setQuadratLocked(db, q5.id, false, 52);
q.setQuadratLocked(db, q5.id, true, 53);
ok(one('SELECT ended_at FROM plot_quadrats WHERE id = ?', q5.id).ended_at === 50, 'lock: relocking keeps the first ended_at');
q.setQuadratLocked(db, q5.id, false, 54);

// ── schema CHECKs ─────────────────────────────────────────────────────────
rejects(`INSERT INTO plot_quadrats (uuid, plot_survey_id, idx, label, grid_n, created_at, updated_at) VALUES ('x1', ?, 90, 'Q', 1, 1, 1)`, [pid], 'schema: grid 1 refused');
rejects(`INSERT INTO plot_quadrats (uuid, plot_survey_id, idx, label, grid_n, created_at, updated_at) VALUES ('x2', ?, 91, 'Q', 11, 1, 1)`, [pid], 'schema: grid 11 refused');
rejects(`INSERT INTO plot_quadrats (uuid, plot_survey_id, idx, label, top_edge, created_at, updated_at) VALUES ('x3', ?, 92, 'Q', 'X', 1, 1)`, [pid], 'schema: unknown top edge refused');
rejects(`INSERT INTO plot_quadrats (uuid, plot_survey_id, idx, label, created_at, updated_at) VALUES ('x4', ?, 1, 'Q', 1, 1)`, [pid], 'schema: UNIQUE(plot, idx)');
rejects(`INSERT INTO plot_quadrat_species (quadrat_id, taxon_id, cover_pct, created_at, updated_at) VALUES (?, 't9', 0, 1, 1)`, [q2.id], 'schema: 0 % cover refused');
rejects(`INSERT INTO plot_quadrat_species (quadrat_id, taxon_id, created_at, updated_at) VALUES (?, 't1', 1, 1)`, [q5.id], 'schema: UNIQUE(quadrat, taxon)');

// ── not in the plot list ──────────────────────────────────────────────────
q.addQuadratSpecies(db, q2.id, 't2', 60);
q.addQuadratSpecies(db, q2.id, 't3', 61);
sqlite.prepare(`INSERT INTO plot_species_records (plot_survey_id, taxon_id, layer, observed_at, created_at) VALUES (?, 't2', 'E2', 1, 1)`).run(pid);
ok(q.quadratTaxaNotInPlot(db, pid).join() === 't1,t3', 'hint: taxa missing from the plot list, first seen first');

// ── undo / redo covers the quadrats ───────────────────────────────────────
const snap = snapshotRecordIn(db, 'plot', pid);
q.updateQuadratSpecies(db, s5, { cover_pct: 80 }, 70);
q.deleteQuadrat(db, q2.id, 71);
ok(!sameSnapshot(snap, snapshotRecordIn(db, 'plot', pid)), 'undo: a quadrat edit is seen as a difference');
restoreRecordSnapshotIn(db, snap, tx);
ok(one('SELECT cover_pct FROM plot_quadrat_species WHERE id = ?', s5).cover_pct === 12.5, 'undo: species value reverts');
ok(all('SELECT taxon_id FROM plot_quadrat_species WHERE quadrat_id = ? ORDER BY id', q2.id).map((r) => r.taxon_id).join() === 't2,t3', 'undo: deleted quadrat returns with its species');
ok(sameSnapshot(snap, snapshotRecordIn(db, 'plot', pid)), 'undo: state equals the snapshot');

// ── integrity rules, delete ───────────────────────────────────────────────
const rules = new Map(CASCADE_ORPHANS);
ok(rules.has('plot_quadrats') && rules.has('plot_quadrat_species'), 'integrity: both tables swept for orphans');
ok(NULL_DANGLING.some(([t, c]) => t === 'plot_quadrats' && c === 'subplot_id'), 'integrity: a dangling subplot is nulled');
sqlite.exec('PRAGMA foreign_keys = OFF;');
sqlite.prepare(`DELETE FROM plot_surveys WHERE id = ?`).run(pSub);
ok(one(`SELECT COUNT(*) AS n FROM plot_quadrats WHERE ${rules.get('plot_quadrats')}`).n === 3, 'integrity: orphans found with foreign keys off');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.prepare(`DELETE FROM plot_subplots WHERE id = ?`).run(subs[0]); // SET NULL with keys on
sqlite.prepare(`DELETE FROM plot_surveys WHERE id = ?`).run(pid);
ok(one('SELECT COUNT(*) AS n FROM plot_quadrats WHERE plot_survey_id = ?', pid).n === 0, 'delete: the plot takes its quadrats');
ok(one('SELECT COUNT(*) AS n FROM plot_quadrat_species WHERE quadrat_id = ?', q5.id).n === 0, 'delete: and their species');

// ── layout / geometry changes, frequency mode, colours, previous survey ─
const p3 = newPlot('P3');
q.setQuadratConfig(db, p3, { enabled: true }, 1);
q.setQuadratCount(db, p3, 3, 2, uuid);
const s3 = [1, 2].map((i) => Number(sqlite.prepare(`INSERT INTO plot_subplots (plot_survey_id, idx, label, created_at) VALUES (?, ?, ?, 1)`).run(p3, i, `S${i}`).lastInsertRowid));
q.setQuadratConfig(db, p3, { layout: 'perSubplot' }, 3);
q.applyLayout(db, p3, 3);
ok(q.listQuadrats(db, p3).map((x) => `${x.subplot_id}:${x.position}`).join() === `${s3[0]}:null,${s3[1]}:null,null:null`, 'layout: one per subplot moves them into the subplots in order');
q.setQuadratConfig(db, p3, { layout: 'cornersCenter' }, 4);
q.applyLayout(db, p3, 4);
ok(q.listQuadrats(db, p3).map((x) => x.position).join() === 'NW,NE,C', 'layout: corners + centre renames them');
const [a3, b3] = q.listQuadrats(db, p3);
const sa = q.addQuadratSpecies(db, a3.id, 't7', 5);
ok(q.gridChangeable(db, p3), 'grid: changeable while no quadrat has frequency data');
q.setQuadratConfig(db, p3, { gridN: 6, topEdge: 'upslope' }, 6);
ok(q.applyGeometryDefaults(db, p3, 6) === 1, 'geometry defaults: the quadrat with data keeps its top edge (counted)');
ok(q.getQuadrat(db, a3.id).grid_n === 6 && q.getQuadrat(db, b3.id).grid_n === 6, 'geometry defaults: the grid reaches every quadrat');
ok(q.getQuadrat(db, a3.id).top_edge === 'N' && q.getQuadrat(db, b3.id).top_edge === 'upslope', 'geometry defaults: top edge only on empty quadrats');
q.updateQuadratSpecies(db, sa, { freq_cells: '1' + '0'.repeat(35) }, 7);
ok(!q.gridChangeable(db, p3), 'grid: fixed once a quadrat has frequency data');
q.switchFreqMode(db, a3.id, 'count', 8);
ok(q.getQuadrat(db, a3.id).freq_mode === 'count' && one('SELECT freq_cells FROM plot_quadrat_species WHERE id = ?', sa).freq_cells === null, 'freq mode: to counts clears the cells');
q.updateQuadratSpecies(db, sa, { freq_count: 4 }, 9);
q.switchFreqMode(db, a3.id, 'cells', 10);
ok(one('SELECT freq_count FROM plot_quadrat_species WHERE id = ?', sa).freq_count === null, 'freq mode: back to cells clears the counts');
q.setQuadratLocked(db, a3.id, true, 11);
throwsCode(() => q.switchFreqMode(db, a3.id, 'count', 12), 'locked', 'freq mode: refused when locked');
q.addQuadratSpecies(db, b3.id, 't8', 13);
q.addQuadratSpecies(db, b3.id, 't7', 14);

sqlite.prepare(`UPDATE plot_surveys SET start_ts = 1000 WHERE id = ?`).run(p3);
const p4 = Number(sqlite.prepare(`INSERT INTO plot_surveys (uuid, plotid, project_id, status, plot_type, start_ts, created_at, updated_at) VALUES ('u-p4', ' P3 ', 0, 'active', 'fixed', 2000, 1, 1)`).run().lastInsertRowid);
ok(q.previousQuadratTaxa(db, p4, 1).join() === 't7' && q.previousQuadratTaxa(db, p4, 2).join() === 't8,t7', 'previous: same plotid, same quadrat number, names in order');
ok(q.previousQuadratTaxa(db, p3, 1).length === 0, 'previous: nothing before the first survey');

// ── status and list numbers (lib/quadratProgress) ───────────────────────
const blank = { locked: 0, freq_mode: 'cells', cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null, cov_bryophytes: null, cov_bare_ground: null, cov_litter: null };
const on = { cover: true, freq: true };
const sp = (name, cover_pct, cells) => ({ name, cover_pct, freq_cells: cells == null ? null : '1'.repeat(cells) + '0'.repeat(100 - cells), freq_count: null });
ok(quadratProgress(blank, [], on).status === 'none', 'status: nothing recorded → none');
ok(quadratProgress({ ...blank, cov_scree: 0 }, [], on).status === 'progress', 'status: a surface value alone → progress');
ok(quadratProgress(blank, [sp('A', 30, null), sp('B', 5, null)], on).status === 'progress', 'status: cover typed, frequency not begun → no mismatch yet');
const mix = quadratProgress(blank, [sp('A', 30, 4), sp('B', 5, null)], on);
ok(mix.status === 'warn' && mix.missingFreq && !mix.missingCover && mix.withFreq === 1 && mix.covered === 2, 'status: both begun, one species without frequency → warn, missing frequency');
ok(quadratProgress(blank, [sp('A', 30, 4), sp('B', 5, null)], { cover: true, freq: false }).status === 'progress', 'status: no mismatch when frequency is not recorded');
ok(quadratProgress({ ...blank, locked: 1 }, [sp('A', 30, 4), sp('B', 5, null)], on).status === 'done', 'status: locked → done');
ok(quadratProgress({ ...blank, freq_mode: 'count' }, [{ name: 'A', cover_pct: 3, freq_cells: null, freq_count: 7 }], on).withFreq === 1, 'status: count mode reads the counts');

// ── merging plots (mergePlotSurveys): one source per quadrat number ─────
{
  const m1 = newPlot('M1');
  const m2 = newPlot('M2');
  q.setQuadratConfig(db, m1, { enabled: true, gridN: 4 }, 1);
  q.setQuadratConfig(db, m2, { enabled: true, gridN: 7 }, 1);
  q.setQuadratCount(db, m1, 2, 2, uuid);
  q.setQuadratCount(db, m2, 3, 2, uuid);
  const [m1q1] = q.listQuadrats(db, m1);
  const [m2q1, m2q2, m2q3] = q.listQuadrats(db, m2);
  q.addQuadratSpecies(db, m1q1.id, 'a1', 3);
  q.addQuadratSpecies(db, m2q1.id, 'b1', 3);
  const b2 = q.addQuadratSpecies(db, m2q2.id, 'b2', 3);
  q.updateQuadratSpecies(db, b2, { cover_pct: 6, freq_cells: '1'.repeat(49) }, 3);
  q.addQuadratSpecies(db, m2q3.id, 'b3', 3);
  const m2sub = Number(sqlite.prepare(`INSERT INTO plot_subplots (plot_survey_id, idx, label, created_at) VALUES (?, 1, 'S1', 1)`).run(m2).lastInsertRowid);
  sqlite.prepare(`UPDATE plot_quadrats SET subplot_id = ? WHERE id = ?`).run(m2sub, m2q3.id);
  const merged = newPlot('M');
  const msub = Number(sqlite.prepare(`INSERT INTO plot_subplots (plot_survey_id, idx, label, created_at) VALUES (?, 1, 'S1', 1)`).run(merged).lastInsertRowid);
  q.copyMergedQuadrats(db, [m1, m2], merged, (src, old) => (src === m2 && old === m2sub ? msub : null), 9, uuid);
  const mq = q.listQuadrats(db, merged);
  ok(q.getQuadratConfig(db, merged).gridN === 4, 'merge plots: settings from the primary');
  ok(mq.map((x) => `${x.idx}:${q.listQuadratSpecies(db, x.id).map((y) => y.taxon_id).join('+')}`).join() === '1:a1,2:b2,3:b3', 'merge plots: primary\'s Q1, the other\'s Q2 (primary empty) and Q3');
  ok(mq.every((x) => x.grid_n === 4) && mq[2].subplot_id === msub, 'merge plots: one grid (the primary\'s) for every quadrat; subplot re-pointed');
  const mb2 = q.listQuadratSpecies(db, mq[1].id)[0];
  ok(mb2.cover_pct === 6 && mb2.freq_cells === null, 'merge plots: a quadrat from another grid keeps its cover, not its cells');
  ok(new Set(mq.map((x) => x.uuid)).size === 3 && !mq.some((x) => [m1q1.uuid, m2q2.uuid, m2q3.uuid].includes(x.uuid)), 'merge plots: new uuids');
}

// ── one grid per plot after an import or a merge (normalizeGrid) ────────
{
  const pn = newPlot('N');
  q.setQuadratConfig(db, pn, { enabled: true, gridN: 3 }, 1);
  const qa = q.writeQuadratRow(db, pn, { idx: 1, label: 'Q1', position: null, size_m: 1, grid_n: 3, top_edge: 'N', lat: null, lng: null, accuracy: null, cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null, cov_bryophytes: null, cov_bare_ground: null, cov_litter: null, freq_mode: 'cells', locked: 0, started_at: null, ended_at: null, notes: null }, { uuid: uuid(), subplotId: null, photoPaths: null, now: 1 });
  const qb = q.writeQuadratRow(db, pn, { idx: 2, label: 'Q2', position: null, size_m: 1, grid_n: 5, top_edge: 'N', lat: null, lng: null, accuracy: null, cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null, cov_bryophytes: null, cov_bare_ground: null, cov_litter: null, freq_mode: 'cells', locked: 0, started_at: null, ended_at: null, notes: null }, { uuid: uuid(), subplotId: null, photoPaths: null, now: 1 });
  q.writeQuadratSpeciesRow(db, qa, { taxon_id: 'x', cover_pct: 2, freq_cells: '101010101', freq_count: null, height_cm: null, notes: null }, 1);
  q.writeQuadratSpeciesRow(db, qb, { taxon_id: 'y', cover_pct: 3, freq_cells: '1'.repeat(25), freq_count: 20, height_cm: null, notes: null }, 1);
  q.writeQuadratSpeciesRow(db, qa, { taxon_id: 'z', cover_pct: 1, freq_cells: null, freq_count: 12, height_cm: null, notes: null }, 1);
  q.normalizeGrid(db, pn, 2);
  ok(q.listQuadrats(db, pn).every((x) => x.grid_n === 3), 'normalize: every quadrat on the config\'s grid');
  const sp = (qid, taxon) => q.listQuadratSpecies(db, qid).find((x) => x.taxon_id === taxon);
  const [nx, ny, nz] = [sp(qa, 'x'), sp(qb, 'y'), sp(qa, 'z')];
  ok(nx.freq_cells === '101010101' && ny.freq_cells === null && ny.cover_pct === 3, 'normalize: fitting mask kept, other mask dropped, cover kept');
  // 20 of 5 × 5 is 80 %; on 3 × 3 it would read 100 % (capped) — not done instead (code review M15).
  ok(ny.freq_count === null && nz.freq_count === 9, `normalize: a count from another grid is not done, one on this grid capped (${ny.freq_count}, ${nz.freq_count})`);
}

// ── frequency over the whole plot (v78) ─────────────────────────────────
{
  const pf = newPlot('F');
  const cfg0 = q.getQuadratConfig(db, pf);
  ok(!cfg0.freqEnabled && cfg0.freqGridN === 10 && cfg0.freqMode === 'cells', 'plot freq: off by default, 10 × 10, cells');
  q.setQuadratConfig(db, pf, { freqEnabled: true, freqGridN: 3, freqTopEdge: 'W' }, 1);
  const rec = (taxon, layer) => Number(sqlite.prepare(`INSERT INTO plot_species_records (plot_survey_id, taxon_id, layer, observed_at, created_at) VALUES (?, ?, ?, 1, 1)`).run(pf, taxon, layer).lastInsertRowid);
  const r1 = rec('t1', 'E2');
  const r2 = rec('t1', 'E3');
  ok(q.plotFreqChangeable(db, pf), 'plot freq: grid changeable before any frequency');
  throwsCode(() => q.setPlotSpeciesFreq(db, r1, { freq_cells: '1'.repeat(100) }, 2), 'invalid', 'plot freq: a mask for another grid refused');
  q.setPlotSpeciesFreq(db, r1, { freq_cells: '110000001' }, 3);
  q.setPlotSpeciesFreq(db, r2, { freq_count: 50 }, 3);
  const got = (id) => one('SELECT freq_cells, freq_count FROM plot_species_records WHERE id = ?', id);
  ok(got(r1).freq_cells === '110000001' && got(r2).freq_count === 9, 'plot freq: one per record (same taxon, two layers); count capped at 9');
  ok(one('SELECT updated_at FROM plot_surveys WHERE id = ?', pf).updated_at === 3, 'plot freq: a write stamps the plot');
  ok(!q.plotFreqChangeable(db, pf), 'plot freq: grid fixed once a record has frequency');
  q.switchPlotFreqMode(db, pf, 'count', 4);
  ok(q.getQuadratConfig(db, pf).freqMode === 'count' && got(r1).freq_cells === null && got(r2).freq_count === 9, 'plot freq: to counts clears the cells, keeps counts');
  q.switchPlotFreqMode(db, pf, 'cells', 5);
  ok(got(r2).freq_count === null, 'plot freq: back to cells clears the counts');
  sqlite.prepare(`UPDATE plot_species_records SET freq_cells = ?, freq_count = 20 WHERE id = ?`).run('1'.repeat(16), r1);
  q.normalizePlotFreq(db, pf);
  ok(got(r1).freq_cells === null && got(r1).freq_count === 9, 'plot freq: after import / merge, a mask for another grid is dropped, a count capped');
  // A merge across grids (code review M45): a count is a share of the grid it was made on.
  const pm = newPlot('M');
  q.setQuadratConfig(db, pm, { freqEnabled: true, freqMode: 'count', freqGridN: 5 }, 1);
  const recM = (taxon, occ, count) =>
    Number(sqlite.prepare(`INSERT INTO plot_species_records (plot_survey_id, taxon_id, layer, occurrence_id, freq_count, observed_at, created_at) VALUES (?, ?, 'E2', ?, ?, 1, 1)`).run(pm, taxon, occ, count).lastInsertRowid);
  const mine = recM('t1', 'occ-mine', 20); // 20 of 5 × 5 = 80 %
  const theirs = recM('t2', 'occ-theirs', 60); // came with their 10 × 10
  // Their grid taken: our count was made on 5 × 5, theirs on 10 × 10.
  q.setQuadratConfig(db, pm, { freqGridN: 10 }, 2);
  q.dropCrossGridCounts(db, pm, 5, 10, ['occ-theirs']);
  ok(got(mine).freq_count === null && got(theirs).freq_count === 60, 'plot freq merge: their grid taken → our counts dropped, theirs kept');
  // Ours kept: their counts were made on their grid.
  sqlite.prepare(`UPDATE plot_species_records SET freq_count = 20 WHERE id = ?`).run(mine);
  q.setQuadratConfig(db, pm, { freqGridN: 5 }, 3);
  q.dropCrossGridCounts(db, pm, 5, 10, ['occ-theirs']);
  ok(got(mine).freq_count === 20 && got(theirs).freq_count === null, 'plot freq merge: our grid kept → their counts dropped, ours kept');
  // One grid on both: nothing changes.
  sqlite.prepare(`UPDATE plot_species_records SET freq_count = 12 WHERE id = ?`).run(theirs);
  q.dropCrossGridCounts(db, pm, 5, null, ['occ-theirs']);
  ok(got(mine).freq_count === 20 && got(theirs).freq_count === 12, 'plot freq merge: the same grid on both → counts kept');
}

// ── the yml parser coerces instead of throwing (lib/quadratYaml) ────────
{
  const parsed = quadratsFromYaml([
    { idx: 2, grid_n: 11, top_edge: 'X', size_m: -3, cov_scree: 140, species: [{ taxon_id: 'a', cover_pct: 0, freq_cells: '1'.repeat(100), freq_count: 999 }, { taxon_id: 'a' }] },
    { idx: 2, label: 'dup' },
    { idx: 0 },
    { idx: 1, grid_n: 3, locked: 1, photo_files: 'x.jpg|y.jpg', species: [{ taxon_id: 'b', freq_cells: '101010101' }] },
  ]);
  ok(parsed.map((x) => x.idx).join() === '1,2', 'yml: sorted, duplicate and invalid numbers dropped');
  const [p1, p2] = parsed;
  ok(p2.grid_n === 10 && p2.top_edge === 'N' && p2.size_m === 1 && p2.cov_scree === null, 'yml: bad grid / edge / size / cover fall back');
  ok(p2.species.length === 1 && p2.species[0].cover_pct === null && p2.species[0].freq_cells === '1'.repeat(100) && p2.species[0].freq_count === 100, 'yml: 0 % dropped, a fitting mask kept, count clamped, duplicate taxon dropped');
  ok(p1.species[0].freq_cells === '101010101' && p1.locked === 1 && p1.photo_files.join() === 'x.jpg,y.jpg', 'yml: mask of its own grid, lock and photos read');
  ok(quadratsFromYaml([{ idx: 1, grid_n: 3, species: [{ taxon_id: 'c', freq_cells: '1'.repeat(100) }] }])[0].species[0].freq_cells === null, 'yml: a mask for another grid is dropped, never stretched');
  ok(quadratsFromYaml(undefined).length === 0, 'yml: no quadrats key → none');
}

// ── CSV (lib/quadratCsv) ─────────────────────────────────────────────────
{
  ok(cellColumns(2).join() === 'f11,f12,f21,f22' && cellColumns(10).at(-1) === 'f1010', 'csv: cell columns f{row}{col}, 1-based (… f1010)');
  ok(JSON.stringify(quadratEventIds('P', 'Q1', 'S2')) === JSON.stringify({ eventID: 'P-S2-Q1', parentEventID: 'P-S2' }) && quadratEventIds('P', 'Q1', null).parentEventID === 'P', 'csv: a quadrat in a subplot hangs under the subplot event');
  const base = { idx: 1, uuid: 'u', label: 'Q1', position: 'NW', subplot_id: 7, size_m: 1, grid_n: 2, top_edge: 'N', lat: null, lng: null, accuracy: null,
    cov_vascular: 60, cov_solid_rock: 40, cov_scree: null, cov_lichens: null, cov_bryophytes: null, cov_bare_ground: null, cov_litter: null,
    freq_mode: 'cells', locked: 1, started_at: null, ended_at: null, notes: 'a,b', photo_paths: null,
    species: [
      { taxon_id: 't0001', simple_name: 'A a', common_name_c: '甲', cover_pct: 10, freq_cells: '1001', freq_count: null, height_cm: null, notes: null },
      { taxon_id: 't0002', simple_name: 'B b', common_name_c: '乙', cover_pct: 5, freq_cells: null, freq_count: null, height_cm: null, notes: null },
    ] };
  const lines = buildQuadratsCsv('P', [base], new Map([[7, 'S1']])).replace(/^\uFEFF/, '').split('\n');
  const head = lines[0].split(',');
  const col = (line, name) => line.split(',')[head.indexOf(name)];
  ok(head.slice(-4).join() === 'f11,f12,f21,f22', 'csv: cell columns at the end');
  ok(col(lines[1], 'eventID') === 'P-S1-Q1' && col(lines[1], 'freq_cells') === '2' && col(lines[1], 'freq_pct') === '50', 'csv: species row with count and %');
  ok(lines[1].endsWith(',1,0,0,1') && lines[2].endsWith(',,,,'), 'csv: cells as 1/0; no frequency → blank cells');
  const surf = buildQuadratSurfaceCsv('P', [base], new Map([[7, 'S1']]), (ts) => String(ts)).replace(/^\uFEFF/, '').split('\n');
  const sh = surf[0].split(',');
  ok(surf[1].split(',')[sh.indexOf('cov_sum')] === '100' && surf[1].includes('"a,b"'), 'surface csv: sum of the seven, commas quoted');
  const fr = buildPlotFrequencyCsv('P', { n: 2, topEdge: 'E', mode: 'cells' }, [
    { occurrence_id: 'o1', taxon_id: 't0001', layer: 'E2', organism_quantity: '20', organism_quantity_type: '% cover', freq_cells: '0110', freq_count: null },
    { occurrence_id: 'o2', taxon_id: 't0002', layer: 'E3', organism_quantity: null, organism_quantity_type: null, freq_cells: null, freq_count: null },
  ]).replace(/^\uFEFF/, '').split('\n');
  ok(fr.length === 2 && fr[1].startsWith('P,o1,') && fr[1].endsWith(',E,2,50,0,1,1,0'), 'plot frequency csv: only records with frequency; grid, edge, count, %, cells');
}

{
  // Plot frequency ⇄ dominance (the 頻度 and 物種 tabs' banner) and the short labels of the cell chips.
  ok(!hasQuantity(null) && !hasQuantity('') && !hasQuantity('[]') && !hasQuantity('0') && hasQuantity('+') && hasQuantity('[12.5]') && hasQuantity('3'), 'hasQuantity: BB class, stems, count count; 0 / [] / empty do not');
  const r = (id, q, cells, count = null, layer = 'E2') => ({ id, organism_quantity: q, freq_cells: cells, freq_count: count, layer });
  const none = plotFreqIssues([r(1, '20', '0000'), r(2, null, null)], 'cells');
  ok(none.domNoFreq.length === 0 && none.freqNoDom.length === 0, 'plot freq issues: nothing before any frequency is recorded');
  const got = plotFreqIssues([r(1, '20', '0000'), r(2, null, '0100'), r(3, 'r', '1000'), r(4, '5', null, null, 'T')], 'cells');
  ok(got.domNoFreq.map((x) => x.id).join() === '1' && got.freqNoDom.map((x) => x.id).join() === '2', 'plot freq issues: dominance without cells, cells without dominance; T ignored');
  const byCount = plotFreqIssues([r(1, '20', null, 0), r(2, null, null, 3)], 'count');
  ok(byCount.domNoFreq.length === 1 && byCount.freqNoDom.length === 1, 'plot freq issues: count mode reads freq_count');
  ok(shortSciName('Yushania niitakayamensis') === 'Y. niitakayamensis', 'short name: genus to an initial');
  ok(shortSciName('Carex sp.') === 'Carex sp.' && shortSciName('Carex') === 'Carex' && shortSciName('Rubus × hybrida') === 'Rubus × hybrida', 'short name: sp., a bare genus and a hybrid stay whole');
  ok(shortSciName('Rubus rolfei var. rolfei') === 'R. rolfei var. rolfei', 'short name: infraspecific keeps its rank');
  ok(compactSpeciesLabel({ cname: '玉山箭竹', sci: 'Yushania niitakayamensis', fallback: 'x' }) === '玉山箭竹', 'label: vernacular name first');
  ok(compactSpeciesLabel({ cname: null, sci: 'Carex brunnea', qualifier: 'sp.1', fallback: 'x' }) === 'C. brunnea sp.1', 'label: no vernacular → short scientific name, then the qualifier');
}

{
  // The R / C keypad (user spec 2026-09-29): which cell each press toggles.
  const R = (k) => ({ axis: 'r', k });
  const C = (k) => ({ axis: 'c', k });
  const run = (presses, n = 10) => {
    let st = KEYPAD_EMPTY;
    const cells = [];
    for (const [kind, key] of presses) {
      if (kind === 'long') st = keypadLongPress(st, key);
      else {
        const res = keypadPress(st, key, n);
        st = res.state;
        if (res.cell != null) cells.push(res.cell);
      }
    }
    return { st, cells };
  };
  ok(['0', '1', '8', '9'].join() === [9, 0, 7, 8].map(keypadLabel).join(), 'keypad: labels 1–9, 0 for the tenth');
  ok(run([['tap', R(0)], ['tap', C(1)]]).cells.join() === '1', 'keypad: R1 then C2 toggles R1C2 (cell 1)');
  ok(run([['tap', C(1)], ['tap', R(0)]]).cells.join() === '1', 'keypad: C2 then R1 toggles the same cell');
  const one = run([['tap', R(0)]]);
  ok(one.cells.length === 0 && keypadMark(one.st, R(0)) === 'pending', 'keypad: a first tap waits, marked');
  ok(run([['tap', R(0)], ['tap', R(2)], ['tap', C(0)]]).cells.join() === '20', 'keypad: a second R replaces the first (R3C1)');
  ok(run([['tap', R(0)], ['tap', R(0)]]).st.pending === null, 'keypad: the same button again clears the wait');
  const locked = run([['long', R(0)], ['tap', C(1)], ['tap', C(2)], ['tap', C(4)]]);
  ok(locked.cells.join() === '1,2,4' && keypadMark(locked.st, R(0)) === 'locked', 'keypad: long press R1, then C2, C3, C5 → R1C2, R1C3, R1C5');
  ok(run([['long', C(9)], ['tap', R(9)], ['tap', R(0)]]).cells.join() === '99,9', 'keypad: a locked column takes rows (C10: R10C10, R1C10)');
  ok(run([['long', R(0)], ['long', R(0)]]).st.lock === null, 'keypad: long press the locked button again unlocks');
  ok(run([['long', R(0)], ['long', R(3)], ['tap', C(0)]]).cells.join() === '30', 'keypad: long press another button moves the lock');
  ok(run([['long', R(0)], ['tap', R(5)], ['tap', C(0)]]).cells.join() === '50', 'keypad: a tap on the locked axis moves the lock');
  ok(run([['tap', R(0)], ['long', C(0)], ['tap', R(1)]]).cells.join() === '10', 'keypad: a long press drops a waiting tap');
  ok(run([['tap', R(0)], ['tap', C(1)]], 4).cells.join() === '1' && run([['tap', R(2)], ['tap', C(3)]], 4).cells.join() === '11', 'keypad: a 4 × 4 grid (R3C4 = 11)');
  ok(run([['tap', R(5)], ['tap', C(0)]], 4).cells.length === 0, 'keypad: a button past the grid does nothing');
}

// ── adding a species under another of its names (code review V4) ─────────
// Where the record keeps the name chosen in the search, a species already
// there under another name asks merge or separate; where only the accepted
// name is kept (fixed-plot quadrats, GLORIA, MIREN), the chosen name is
// confirmed away. Each SearchBox / FrequencyPanel add in those screens says so.
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const f of ['src/components/quadrat/PlotFreqTab.tsx', 'src/survey/form/PlotSurveyFreqTab.tsx', 'app/survey/form/[id]/quadrat/[uid].tsx']) {
    const src = read(f);
    ok(/await synonymAlreadyHere\(/.test(src) && /used_scientific_name \|\| null\) === \(adopted\?\.scientific_name \|\| null\)/.test(src), `V4: ${f} asks before painting a record under another name`);
  }
  const walk = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.tsx') ? [`${dir}/${e.name}`] : []));
  for (const f of ['app/plot/[id]/quadrat/[qid].tsx', ...walk('app/gloria'), ...walk('app/miren')]) {
    const src = read(f);
    const adds = (src.match(/<SearchBox[\s\S]*?onSelect=|onAdd=\{async \(r/g) ?? []).length;
    const asks = (src.match(/await acceptedNameOnly\(/g) ?? []).length;
    ok(asks >= adds, `V4: ${f}: every species search add confirms a chosen name away (${asks} of ${adds})`);
  }
}
// The pager's swipe is made once and calls the latest step: a filter switch changes the
// list without the index or count, and a memo keyed on those stepped the old list (code review V7).
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/quadrat/SpeciesPager.tsx', import.meta.url), 'utf8');
  ok(/stepRef\.current = step;/.test(src) && /stepRef\.current\(1\)/.test(src) && !/exhaustive-deps/.test(src), 'V7: the pager swipe reads the step of the latest render');
}

// A plot merge clears counts made on the other grid before capping (code review M45);
// both callers say which grid the other copy had.
{
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const tm = read('src/db/teamMerge.ts');
  ok(/dropCrossGridCounts\(db, plotId, localFreqGridN, remoteFreqGridN, freqFromRemote\);\s*normalizePlotFreq\(db, plotId\)/.test(tm), 'M45: applyPlotMerge clears cross-grid counts, then caps');
  ok(read('src/lib/teamMergeFlow.ts').includes('remoteFreqGridN(p.items)') && read('src/db/recordVersions.ts').includes('remoteFreqGridN(items)'), 'M45: team merge and version restore pass the other grid');
}

sqlite.close();
if (failed) {
  console.error(`check:quadrats — ${failed} failed`);
  process.exit(1);
}
console.log('✓ quadrats: schema CHECKs, layouts, empty-only shrink, geometry / record locks, validation, undo, integrity');
