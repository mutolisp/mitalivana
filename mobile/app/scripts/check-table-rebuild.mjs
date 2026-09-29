/**
 * v75 rebuilds sessions, plot_surveys and collection_trips to add CHECKs
 * (data-model audit A4). A rebuild of a table other tables point at is the
 * riskiest kind of migration, so this runs it on data: migrate to v74, fill
 * rows (children, a site bound to a session, an out-of-range status, an
 * AUTOINCREMENT gap), run v75, then check that
 *   - every row and column survived, and bad values were normalised;
 *   - children still reference the rebuilt tables (a cascade still cascades),
 *     and PRAGMA foreign_key_check is clean;
 *   - the CHECKs reject bad values; UNIQUE uuid and every index survived;
 *   - the AUTOINCREMENT counter did not go back (no id reuse).
 */
import { migratedDb, migrateRest } from './schema-columns.mjs';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};
const REBUILT = ['sessions', 'plot_surveys', 'collection_trips'];

const db = await migratedDb(74);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const snapshotOf = (t) => all(`SELECT * FROM ${t} ORDER BY id`);
const indexesOf = (t) => all(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, t);

run(`INSERT INTO sessions (id, uuid, name, type, project_id, started_at, status) VALUES (1, 'u1', 'A', 'checklist', 0, 1000, 'done'), (2, 'u2', 'B', 'checklist', 0, 2000, 'active'), (7, 'u7', 'C', 'checklist', 0, 3000, 'done')`);
run(`DELETE FROM sessions WHERE id = 7`); // counter stays at 7
run(`INSERT INTO sessions (id, uuid, name, type, project_id, started_at, ended_at, status) VALUES (3, 'u3', 'bad', 'checklist', 0, 1500, 1600, 'finished')`);
run(`INSERT INTO checklist_records (session_id, taxon_id, observed_at, occurrence_id) VALUES (1, 't1', 1000, 'o1'), (2, 't2', 2000, 'o2')`);
run(`INSERT INTO sites (id, project_id, session_id, name, geometry_type, geometry_geojson, created_at, updated_at) VALUES (1, 0, 2, 's', 'Point', '{}', 1, 1)`);
run(`UPDATE sessions SET site_id = 1 WHERE id = 2`);
run(`INSERT INTO plot_surveys (id, uuid, plotid, project_id, status, plot_type, created_at, updated_at) VALUES (1, 'p1', 'P-1', 0, 'done', 'transect', 1, 1), (2, 'p2', 'P-2', 0, 'weird', 'hexagon', 1, 1)`);
run(`INSERT INTO plot_species_records (plot_survey_id, taxon_id, layer, observed_at, created_at) VALUES (1, 't1', 'T', 1, 1)`);
run(`INSERT INTO plot_survey_layers (plot_survey_id, layer_index, method) VALUES (1, 1, 'BB')`);
run(`INSERT INTO collection_trips (id, uuid, name, project_id, status, started_at, created_at, updated_at) VALUES (1, 'c1', 'T', 0, 'active', 1, 1, 1)`);
run(`INSERT INTO collection_specimens (trip_id, occurrence_id, taxon_id, record_number, collected_at, created_at) VALUES (1, 'sp1', 't1', 'L-1', 1, 1)`);

const before = Object.fromEntries(REBUILT.map((t) => [t, snapshotOf(t)]));
const idxBefore = Object.fromEntries(REBUILT.map((t) => [t, indexesOf(t)]));
const seqBefore = all(`SELECT seq FROM sqlite_sequence WHERE name = 'sessions'`)[0]?.seq;

await migrateRest(db);

eq('schema reached v75', all(`SELECT MAX(version) AS v FROM schema_version`)[0].v >= 75, true);
// Rows and columns survived; only the out-of-range values changed.
const fixed = { sessions: { 3: { status: 'done' } }, plot_surveys: { 2: { status: 'active', plot_type: 'fixed' } }, collection_trips: {} };
for (const t of REBUILT) {
  const want = before[t].map((r) => ({ ...r, ...(fixed[t][r.id] ?? {}) }));
  // Only the columns v75 saw: later migrations may add more (v77 quadrat_config).
  const cols = Object.keys(before[t][0] ?? {});
  const got = snapshotOf(t).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  eq(`${t}: every row and column kept`, got, want);
  eq(`${t}: indexes kept`, indexesOf(t), idxBefore[t]);
}
eq('children kept', [all(`SELECT COUNT(*) AS n FROM checklist_records`)[0].n, all(`SELECT COUNT(*) AS n FROM plot_species_records`)[0].n, all(`SELECT COUNT(*) AS n FROM collection_specimens`)[0].n], [2, 1, 1]);
eq('children reference the rebuilt tables', ['checklist_records', 'plot_species_records', 'plot_survey_layers', 'collection_specimens', 'sites'].map((t) => all(`PRAGMA foreign_key_list(${t})`).map((f) => f.table).sort()), [['sessions'], ['plot_surveys'], ['plot_surveys'], ['collection_trips'], ['projects', 'sessions']]);
eq('no leftover temp table', all(`SELECT name FROM sqlite_master WHERE name LIKE '%_rebuild'`), []);
run(`PRAGMA foreign_keys = ON`);
eq('foreign_key_check clean', all(`PRAGMA foreign_key_check`), []);
run(`DELETE FROM sessions WHERE id = 1`);
eq('cascade still reaches the children', all(`SELECT session_id FROM checklist_records ORDER BY session_id`).map((r) => r.session_id), [2]);
run(`DELETE FROM sessions WHERE id = 2`);
eq('SET NULL still reaches sites.session_id', all(`SELECT session_id FROM sites`)[0].session_id, null);
const rejects = (sql) => {
  try {
    run(sql);
    return false;
  } catch {
    return true;
  }
};
eq('CHECK rejects a bad session status', rejects(`INSERT INTO sessions (uuid, name, type, project_id, started_at, status) VALUES ('x1', 'x', 'checklist', 0, 1, 'paused')`), true);
eq('CHECK rejects a bad plot status', rejects(`INSERT INTO plot_surveys (uuid, plotid, project_id, status, created_at, updated_at) VALUES ('x2', 'x', 0, 'paused', 1, 1)`), true);
eq('CHECK rejects a bad plot_type', rejects(`INSERT INTO plot_surveys (uuid, plotid, project_id, plot_type, created_at, updated_at) VALUES ('x3', 'x', 0, 'hexagon', 1, 1)`), true);
eq('CHECK rejects a bad trip status', rejects(`INSERT INTO collection_trips (uuid, name, project_id, status, started_at, created_at, updated_at) VALUES ('x4', 'x', 0, 'open', 1, 1, 1)`), true);
eq('UNIQUE uuid still enforced', rejects(`INSERT INTO plot_surveys (uuid, plotid, project_id, created_at, updated_at) VALUES ('p1', 'dup', 0, 1, 1)`), true);
eq('good rows still insert', rejects(`INSERT INTO sessions (uuid, name, type, project_id, started_at) VALUES ('ok', 'ok', 'checklist', 0, 1)`), false);
eq('AUTOINCREMENT does not reuse ids', all(`SELECT id FROM sessions WHERE uuid = 'ok'`)[0].id > seqBefore, true);
db.close();

if (failed) {
  console.error(`\n${failed} table-rebuild check(s) failed`);
  process.exit(1);
}
console.log('✓ v75 table rebuild: rows, children, cascades, indexes, CHECKs and the id counter survive');
