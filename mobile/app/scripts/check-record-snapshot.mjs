/**
 * Undo / redo of a whole record (src/db/recordSnapshotCore.ts) on the real
 * migrated schema, with foreign keys ON as the app runs them.
 *
 * What must hold:
 *   - restoring a snapshot brings every row back, with its old id;
 *   - rows added since are removed, rows edited since are reverted;
 *   - a subplot that survives keeps its layers (no REPLACE-style delete that
 *     would cascade into them);
 *   - columns written elsewhere (inat_*, starred, a running track, the
 *     record's own end state) keep their current values;
 *   - redo (restoring the snapshot taken before undo) returns to the edit.
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import {
  restoreRecordSnapshotIn,
  sameSnapshot,
  snapshotRecordIn,
} from '../src/db/recordSnapshotCore.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};

const sqlite = new DatabaseSync(':memory:');
const db = {
  executeSync(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    try {
      return { rows: stmt.all(...params) };
    } catch {
      const res = stmt.run(...params);
      return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
    }
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

/** Insert with every NOT NULL column filled; `vals` overrides. */
function insert(table, vals) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  const row = {};
  for (const c of cols) {
    if (c.pk) continue;
    if (c.notnull && c.dflt_value == null) row[c.name] = /INT/i.test(c.type) ? 1 : /REAL/i.test(c.type) ? 1 : `${table}-${c.name}`;
  }
  Object.assign(row, vals);
  const k = Object.keys(row);
  const res = sqlite
    .prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`)
    .run(...k.map((x) => row[x]));
  return Number(res.lastInsertRowid);
}
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const all = (sql, ...a) => sqlite.prepare(sql).all(...a);

// ── session: remove a record with media, undo, redo ─────────────────────
const sid = insert('sessions', { name: 'S', status: 'active' });
const r1 = insert('checklist_records', { session_id: sid, taxon_id: 't1', notes: 'n1', photo_paths: '["a.jpg"]', occurrence_id: 'occ-1' });
insert('checklist_records', { session_id: sid, taxon_id: 't2' });
const before = snapshotRecordIn(db, 'session', sid);
sqlite.prepare('DELETE FROM checklist_records WHERE id = ?').run(r1);
sqlite.prepare('UPDATE checklist_records SET notes = ? WHERE taxon_id = ?').run('edited', 't2');
const r3 = insert('checklist_records', { session_id: sid, taxon_id: 't3' });
const after = snapshotRecordIn(db, 'session', sid);
ok(!sameSnapshot(before, after), 'session: an edit is seen as a difference');
restoreRecordSnapshotIn(db, before, tx);
const back = one('SELECT * FROM checklist_records WHERE id = ?', r1);
ok(back && back.notes === 'n1' && back.photo_paths === '["a.jpg"]' && back.occurrence_id === 'occ-1', 'session: removed row returns with its id, media and occurrence_id');
ok(!one('SELECT id FROM checklist_records WHERE id = ?', r3), 'session: row added since is removed');
ok(one("SELECT notes FROM checklist_records WHERE taxon_id = 't2'").notes === null, 'session: edited row reverts');
ok(sameSnapshot(before, snapshotRecordIn(db, 'session', sid)), 'session: state equals the snapshot');
restoreRecordSnapshotIn(db, after, tx);
ok(sameSnapshot(after, snapshotRecordIn(db, 'session', sid)), 'session: redo returns to the edited state');

// ── kept columns survive a restore ──────────────────────────────────────
const snapK = snapshotRecordIn(db, 'session', sid);
sqlite.prepare("UPDATE checklist_records SET inat_observation_id = 42, notes = 'x' WHERE taxon_id = 't2'").run();
sqlite.prepare("UPDATE sessions SET status = 'done', starred = 1, track_geojson = ? WHERE id = ?").run('{"t":1}', sid);
restoreRecordSnapshotIn(db, snapK, tx);
const t2 = one("SELECT * FROM checklist_records WHERE taxon_id = 't2'");
ok(t2.inat_observation_id === 42 && t2.notes === 'edited', 'kept: inat_* stays, other columns revert');
const s = one('SELECT * FROM sessions WHERE id = ?', sid);
ok(s.status === 'done' && s.starred === 1 && s.track_geojson === '{"t":1}', 'kept: status, starred and track stay');

// ── plot: subplots, their layers, species linked to a subplot ───────────
const pid = insert('plot_surveys', { plotid: 'P1', status: 'active' });
const sp1 = insert('plot_subplots', { plot_survey_id: pid, idx: 1, label: 'A' });
const sp2 = insert('plot_subplots', { plot_survey_id: pid, idx: 2, label: 'B' });
const sl1 = insert('subplot_layers', { subplot_id: sp1, layer_index: 1, cover_pct: 30 });
const sl2 = insert('subplot_layers', { subplot_id: sp2, layer_index: 1, cover_pct: 40 });
insert('plot_survey_layers', { plot_survey_id: pid, layer_index: 1, cover_pct: 50 });
const ps = insert('plot_species_records', { plot_survey_id: pid, taxon_id: 'p1', layer: 'E1', subplot_id: sp2 });
const pBefore = snapshotRecordIn(db, 'plot', pid);
// Shrink to one subplot: the app deletes subplot 2 (cascade) and unlinks species.
sqlite.prepare('UPDATE plot_species_records SET subplot_id = NULL WHERE subplot_id = ?').run(sp2);
sqlite.prepare('DELETE FROM plot_subplots WHERE id = ?').run(sp2);
sqlite.prepare('UPDATE subplot_layers SET cover_pct = 99 WHERE id = ?').run(sl1);
sqlite.prepare('DELETE FROM plot_survey_layers WHERE plot_survey_id = ?').run(pid);
insert('plot_survey_layers', { plot_survey_id: pid, layer_index: 1, cover_pct: 10 });
ok(!one('SELECT id FROM subplot_layers WHERE id = ?', sl2), 'plot: setup — subplot delete cascaded');
restoreRecordSnapshotIn(db, pBefore, tx);
ok(one('SELECT id FROM plot_subplots WHERE id = ?', sp2), 'plot: deleted subplot returns');
ok(one('SELECT cover_pct FROM subplot_layers WHERE id = ?', sl2)?.cover_pct === 40, "plot: deleted subplot's layer returns");
ok(one('SELECT cover_pct FROM subplot_layers WHERE id = ?', sl1)?.cover_pct === 30, 'plot: surviving subplot keeps its layer, value reverted');
ok(one('SELECT subplot_id FROM plot_species_records WHERE id = ?', ps).subplot_id === sp2, 'plot: species re-linked to its subplot');
ok(all('SELECT cover_pct FROM plot_survey_layers WHERE plot_survey_id = ?', pid).map((r) => r.cover_pct).join() === '50', 'plot: layer row replaced under UNIQUE(plot, index) reverts');
ok(sameSnapshot(pBefore, snapshotRecordIn(db, 'plot', pid)), 'plot: state equals the snapshot');

// ── collection ───────────────────────────────────────────────────────────
const cid = insert('collection_trips', { name: 'C', status: 'done' });
const c1 = insert('collection_specimens', { trip_id: cid, taxon_id: 'c1', record_number: 'L-1' });
const cBefore = snapshotRecordIn(db, 'collection', cid);
sqlite.prepare('DELETE FROM collection_specimens WHERE id = ?').run(c1);
restoreRecordSnapshotIn(db, cBefore, tx);
ok(one('SELECT record_number FROM collection_specimens WHERE id = ?', c1)?.record_number === 'L-1', 'collection: deleted specimen returns with its number');

sqlite.close();
if (failed) {
  console.error(`check:record-snapshot — ${failed} failed`);
  process.exit(1);
}
console.log('✓ record-snapshot: undo / redo restores every row, keeps subplot layers and outside-written columns');
