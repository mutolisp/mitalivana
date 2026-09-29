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
q.updateQuadrat(db, q1.id, { grid_n: 8, top_edge: 'E', size_m: 2 }, 40);
ok(one('SELECT grid_n, top_edge, size_m FROM plot_quadrats WHERE id = ?', q1.id).grid_n === 8, 'geometry: an empty quadrat can change');
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

sqlite.close();
if (failed) {
  console.error(`check:quadrats — ${failed} failed`);
  process.exit(1);
}
console.log('✓ quadrats: schema CHECKs, layouts, empty-only shrink, geometry / record locks, validation, undo, integrity');
