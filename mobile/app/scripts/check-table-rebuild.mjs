/**
 * v75 rebuilds sessions, plot_surveys and collection_trips to add CHECKs
 * (data-model audit A4); v83 rebuilds fw_surveys, which seven tables point
 * at, to let a survey have no permanent plot. A rebuild of a table other
 * tables point at is the riskiest kind of migration, so this runs each on
 * data: migrate to the version before, fill rows (children, a site bound to
 * a session, an out-of-range status, an AUTOINCREMENT gap; for v83 two
 * censuses with every kind of child row), run the rest, then check that
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

// ── v83: fw_surveys ─────────────────────────────────────────────────────────
const v = await migratedDb(82);
const vall = (sql, ...p) => v.prepare(sql).all(...p);
const vrun = (sql, ...p) => v.prepare(sql).run(...p);
const FW = ['fw_frames', 'fw_frame_series', 'fw_surveys', 'fw_survey_quadrats', 'fw_individuals', 'fw_individual_history', 'fw_stems', 'fw_stem_measures', 'fw_stem_values', 'fw_individual_values', 'fw_media'];
vrun(`INSERT INTO fw_frames (id, uuid, code, size_x_m, size_y_m, created_at, updated_at) VALUES (1, 'f1', 'P1', 40, 40, 1, 1)`);
vrun(`INSERT INTO fw_frame_series (id, uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES (1, 'se1', 1, 'builtin:stemmap', '', 1, 1)`);
const census = (id, no, status) =>
  vrun(
    `INSERT INTO fw_surveys (id, uuid, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, status, start_ts, stop_ts, investigators, notes, project_id, sync_block_quadrats, lat, lng, accuracy, starred, created_at, updated_at)
     VALUES (?, ?, 1, 1, ?, 'builtin:stemmap', 1, '{"style":"individual"}', 'h', ?, ?, NULL, 'A; B', 'n', 0, 2, 24.1, 121.2, 5, 1, 1, 1)`,
    id, `c${id}`, no, status, 1000 * id,
  );
census(1, 1, 'done');
census(2, 2, 'active');
census(5, 3, 'done');
vrun(`DELETE FROM fw_surveys WHERE id = 5`); // counter stays at 5
vrun(`INSERT INTO fw_survey_quadrats (uuid, survey_id, quadrat_code, created_at, updated_at) VALUES ('q1', 1, '0000', 1, 1), ('q2', 2, '0000', 1, 1)`);
vrun(`INSERT INTO fw_individuals (id, uuid, frame_id, tag, taxon_id, x_m, y_m, quadrat_code, coord_method, first_survey_id, created_at, updated_at) VALUES (1, 'i1', 1, '1', 't1', 1, 1, '0000', 'grid', 1, 1, 1), (2, 'i2', 1, '2', 't2', 2, 2, '0000', 'grid', 2, 1, 1)`);
vrun(`INSERT INTO fw_individual_history (uuid, individual_id, survey_id, field, old_value, new_value, at) VALUES ('h1', 1, 2, 'taxon', 't0', 't1', 1)`);
vrun(`INSERT INTO fw_stems (id, uuid, individual_id, stem_no, first_survey_id, created_at, updated_at) VALUES (1, 's1', 1, 1, 1, 1, 1), (2, 's2', 2, 1, 2, 1, 1)`);
vrun(`INSERT INTO fw_stem_measures (id, uuid, survey_id, stem_id, dbh_cm, created_at, updated_at) VALUES (1, 'm1', 1, 1, 10, 1, 1), (2, 'm2', 2, 1, 11, 1, 1), (3, 'm3', 2, 2, 3, 1, 1)`);
vrun(`INSERT INTO fw_stem_values (uuid, measure_id, component, field, value_text, updated_at) VALUES ('v1', 2, 'health', 'census_codes', '["B"]', 1)`);
vrun(`INSERT INTO fw_individual_values (uuid, survey_id, individual_id, component, field, value_num, updated_at) VALUES ('iv1', 2, 1, 'height', 'height_m', 12, 1)`);
vrun(`INSERT INTO fw_media (uuid, survey_id, individual_id, component, kind, uri, created_at) VALUES ('md1', 2, 1, 'photos', 'photo', 'file:///photos/a.jpg', 1)`);
const vBefore = Object.fromEntries(FW.map((t) => [t, vall(`SELECT * FROM ${t} ORDER BY id`)]));
const vIdx = vall(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fw_surveys' ORDER BY name`);

await migrateRest(v);

eq('v83: schema reached v83', vall(`SELECT MAX(version) AS v FROM schema_version`)[0].v >= 83, true);
for (const t of FW) {
  const cols = Object.keys(vBefore[t][0] ?? {});
  eq(`v83: ${t} rows and columns kept`, vall(`SELECT * FROM ${t} ORDER BY id`).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), vBefore[t]);
}
eq('v83: every census is style individual, no blind phase', vall(`SELECT style, blind_closed_at FROM fw_surveys ORDER BY id`), [
  { style: 'individual', blind_closed_at: null },
  { style: 'individual', blind_closed_at: null },
]);
eq('v83: fw_surveys indexes kept', vall(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fw_surveys' ORDER BY name`), vIdx);
eq(
  'v83: children still reference fw_surveys',
  ['fw_survey_quadrats', 'fw_stem_measures', 'fw_individual_values', 'fw_media', 'fw_individuals', 'fw_stems', 'fw_individual_history'].map((t) =>
    vall(`PRAGMA foreign_key_list(${t})`).some((f) => f.table === 'fw_surveys'),
  ),
  [true, true, true, true, true, true, true],
);
eq('v83: no leftover temp table', vall(`SELECT name FROM sqlite_master WHERE name LIKE '%_rebuild'`), []);
vrun(`PRAGMA foreign_keys = ON`);
eq('v83: foreign_key_check clean', vall(`PRAGMA foreign_key_check`), []);
const vrejects = (sql) => {
  try {
    vrun(sql);
    return false;
  } catch {
    return true;
  }
};
eq('v83: a census still needs its frame', vrejects(`INSERT INTO fw_surveys (uuid, style, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('x', 'individual', 't', 1, '{}', 'h', 1, 1, 1)`), true);
eq('v83: UNIQUE (series, census no) kept', vrejects(`INSERT INTO fw_surveys (uuid, style, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('y', 'individual', 1, 1, 2, 't', 1, '{}', 'h', 1, 1, 1)`), true);
vrun(`INSERT INTO fw_surveys (uuid, style, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('z', 'checklist', 't', 1, '{}', 'h', 1, 1, 1)`);
eq('v83: AUTOINCREMENT does not reuse ids', vall(`SELECT id FROM fw_surveys WHERE uuid = 'z'`)[0].id > 5, true);
vrun(`DELETE FROM fw_surveys WHERE id = 2`);
eq(
  'v83: deleting a census still cascades to its children',
  ['fw_survey_quadrats', 'fw_stem_measures', 'fw_individual_values', 'fw_media'].map((t) => vall(`SELECT COUNT(*) AS n FROM ${t} WHERE survey_id = 2`)[0].n),
  [0, 0, 0, 0],
);
eq('v83: and SET NULL still reaches first_survey_id and the history', [vall(`SELECT first_survey_id AS f FROM fw_individuals WHERE id = 2`)[0].f, vall(`SELECT survey_id AS s FROM fw_individual_history`)[0].s], [null, null]);
v.close();

// A table whose rows were all deleted keeps its counter too (the empty copy still makes a counter row).
const e = await migratedDb(82);
e.prepare(`INSERT INTO fw_frames (id, uuid, code, size_x_m, size_y_m, created_at, updated_at) VALUES (1, 'f1', 'P1', 40, 40, 1, 1)`).run();
e.prepare(`INSERT INTO fw_frame_series (id, uuid, frame_id, template_id, series_code, created_at, updated_at) VALUES (1, 'se1', 1, 't', '', 1, 1)`).run();
e.prepare(
  `INSERT INTO fw_surveys (id, uuid, frame_id, series_id, census_no, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES (9, 'gone', 1, 1, 1, 't', 1, '{}', 'h', 1, 1, 1)`,
).run();
e.prepare(`DELETE FROM fw_surveys`).run();
await migrateRest(e);
e.prepare(`INSERT INTO fw_surveys (uuid, style, template_id, template_version, template_snapshot, template_hash, start_ts, created_at, updated_at) VALUES ('new', 'checklist', 't', 1, '{}', 'h', 1, 1, 1)`).run();
eq('v83: an emptied table does not reuse ids either', e.prepare(`SELECT id FROM fw_surveys WHERE uuid = 'new'`).get().id > 9, true);
e.close();

if (failed) {
  console.error(`\n${failed} table-rebuild check(s) failed`);
  process.exit(1);
}
console.log('✓ v75 and v83 table rebuilds: rows, children, cascades, indexes, CHECKs and the id counter survive');
