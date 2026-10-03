/**
 * A tree census as a file and back (src/survey/db/censusExportCore.ts) and its
 * tables (src/survey/stemmap/censusTables.ts), on node:sqlite databases with
 * the real migrated schema and foreign keys ON.
 *
 * What must hold:
 *   - the document carries every column of every fw_* table that is data
 *     (ids, foreign-key ids and stamps excepted, listed below with why), so a
 *     new column cannot be left out silently;
 *   - yml out → yml in on an empty device gives the same rows (by uuid), the
 *     censuses finished, nothing left for the integrity sweep;
 *   - census.csv lists every tree in every census (Condit 1998 p.166): P before
 *     a tree's first census, D when dead, F alive under the threshold, A; dbh
 *     in mm is the largest live stem; trees.csv gives the subquadrat; stems.csv
 *     one row per measured stem; the vegan table sums live basal area per
 *     quadrat and species; census.csv and stems.csv carry each census's
 *     eventID (plot code plus series code, the plot rule) and the census
 *     template's traits and own code lists (2D-b) after the earlier columns;
 *   - importing where censuses are here: skip leaves them, overwrite makes
 *     them equal to the file (what was added here since goes), merge hands
 *     them to the census merge; a census created from the file only adds rows
 *     (a correction made here since stays); a census here under another uuid
 *     (same plot, series and number) counts as here.
 *
 * Run: npm run check:census-export
 */
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { runUserMigrations } from '../src/db/migrations.ts';
import { CASCADE_ORPHANS } from '../src/db/integrityRules.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as ex from '../src/survey/db/censusExportCore.ts';
import * as cs from '../src/survey/db/censusSyncCore.ts';
import * as tb from '../src/survey/stemmap/censusTables.ts';
import { basalArea } from '../src/lib/dwcAbundanceCore.ts';
import { defaultDecision } from '../src/lib/mergeEngine.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { readRecordImportFromBytes } from '../src/lib/recordImportZip.ts';
import { strToU8, zipSync } from 'fflate';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};

let clock = 1_000_000;
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
  const all = (sql, ...a) => sqlite.prepare(sql).all(...a);
  const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
  return { sqlite, ctx, tx, all, one, name: prefix };
}

const taxon = (id) => ({ taxonId: id, usedScientificName: `Sp ${id}` });
const xy = (x, y) => ({ method: 'xy', x, y });
const sd = (over) => ({ stemNo: null, dbhCm: null, pomM: 1.3, stemDead: false, codes: [], notes: null, ...over });
const draft = (over) => ({ individualId: null, tag: null, taxon: taxon('k1'), location: xy(5, 5), notes: null, heightM: null, treeCodes: [], mainStemNo: 1, stems: [sd({ dbhCm: 10 })], recordedBy: 'A', ...over });

// ── a plot with two censuses on phone A ──────────────────────────────────
const A = await phone('a');
const F = s.createFrame(A.ctx, { code: 'EX1', sizeXM: 40, sizeYM: 40 });
const C1 = s.startCensus(A.ctx, { frameId: F, template: STEMMAP_TEMPLATE });
const t1 = A.tx(() => s.saveTreeDraft(A.ctx, C1, draft({ location: xy(3, 6), stems: [sd({ dbhCm: 12 }), sd({ dbhCm: 30 })], heightM: 9 })));
const t2 = A.tx(() => s.saveTreeDraft(A.ctx, C1, draft({ location: xy(25, 25), taxon: taxon('k2'), stems: [sd({ dbhCm: 20 })] })));
const t3 = A.tx(() => s.saveTreeDraft(A.ctx, C1, draft({ location: xy(26, 5), taxon: taxon('k2'), stems: [sd({ dbhCm: 4 })] })));
A.tx(() => s.correctIndividual(A.ctx, t2, { tag: '200' }, { surveyId: C1, reason: 'retag', by: 'A' }));
A.tx(() => s.addTreeMedia(A.ctx, C1, t1, 'file:///phone-a/photos/t1.jpg'));
A.tx(() => s.setFgQuadratStatus(A.ctx, C1, '0000', 'done'));
s.finishCensus(A.ctx, C1);
const C2 = s.startCensus(A.ctx, { frameId: F, template: STEMMAP_TEMPLATE });
const v = (id) => s.loadTree(A.ctx, C2, id);
const again = (id, stems, over = {}) =>
  A.tx(() => s.saveTreeDraft(A.ctx, C2, { ...draft({}), individualId: id, taxon: null, location: null, mainStemNo: v(id).stems[0].stem.stem_no, stems, ...over }));
again(t1, [sd({ stemNo: 1, dbhCm: 12.6 }), sd({ stemNo: 2, dbhCm: 31 })]);
// Dead standing, its DBH still written down: neither census.csv nor the vegan table may count it.
again(t2, [sd({ stemNo: 1, dbhCm: 20, codes: [] })], { treeCodes: ['DS'] });
again(t3, [sd({ stemNo: 1, dbhCm: 0.5, codes: ['R'] })]);
const t4 = A.tx(() => s.saveTreeDraft(A.ctx, C2, draft({ location: xy(30, 30), taxon: taxon('k3'), stems: [sd({ dbhCm: 6 })] })));
const uuidOf = (P, id) => P.one('SELECT uuid FROM fw_individuals WHERE id = ?', id).uuid;
const [u1, u2, u3, u4] = [t1, t2, t3, t4].map((id) => uuidOf(A, id));

const built = ex.buildCensusExport(A.ctx, C2, (id) => `Name ${id}`);
// What the bundle does with photos: the device path becomes the file's name in the zip.
for (const c of built.censuses) for (const m of c.media) {
  m.file = 'photo1.jpg';
  delete m.uri;
}
const text = ex.censusExportText(built);
const doc = ex.censusExportFromFile(JSON.parse(text));
ok(JSON.stringify(doc) === JSON.stringify(JSON.parse(JSON.stringify(built))), 'file: the document comes back as written, nulls included');
ok(JSON.stringify(ex.censusExportFromFile(yaml.load(text))) === JSON.stringify(doc), 'file: it is YAML as well (js-yaml reads the same document)');
ok(text.split('\n').length > doc.trees.length + doc.stems.length + doc.censuses.reduce((a, c) => a + c.measures.length, 0), 'file: one row per line');
ok(!/"(uuid|tag|taxon_id)":/.test(text.split('"trees"')[1].split('"stems"')[0]), 'file: tree rows carry no column names (written once)');
const older = yaml.dump(built, { lineWidth: -1, noRefs: true });
ok(JSON.stringify(ex.censusExportFromFile(yaml.load(older))) === JSON.stringify(doc), 'file: a 1D row-mapping yml still reads');
ok(ex.isCensusExport(doc) && doc.censuses.length === 2 && doc.trees.length === 4, 'export: census 2 with census 1, every tree once');
ok(doc.censuses[0].media.length === 1 && doc.censuses[0].media[0].file === 'photo1.jpg', 'export: photos by file name');
ok(doc.taxa.k1 === 'Sp k1', 'export: names to re-point unknown taxa');

// ── every data column is in the document ─────────────────────────────────
// Not carried, and why: own ids and stamps are this device's; foreign-key ids
// become uuids (tree_uuid, stem_uuid, survey uuid, first_survey_uuid).
const NOT_CARRIED = {
  fw_frames: { id: 'local id', project_id: 'projects are per device', site_id: 'sites are per device', created_at: 'stamp', updated_at: 'stamp' },
  fw_frame_series: { id: 'local id', frame_id: 'the document has one frame', created_at: 'stamp', updated_at: 'stamp' },
  fw_surveys: {
    id: 'local id',
    style: "always 'individual' in a census document; set on import",
    frame_id: 'frame',
    series_id: 'series',
    blind_closed_at: "the plot style's blind phase; NULL on a census",
    name: 'checklist / plot-style name (v84); NULL on a census, named by frame code and number',
    project_id: 'projects are per device',
    site_id: 'sites are per device',
    starred: 'pinned on this device',
    created_at: 'stamp',
    updated_at: 'stamp',
  },
  fw_survey_quadrats: { id: 'local id', survey_id: 'its census part', created_at: 'stamp', updated_at: 'stamp' },
  fw_individuals: { id: 'local id', frame_id: 'frame', first_survey_id: 'first_survey_uuid', created_at: 'stamp', updated_at: 'stamp' },
  fw_individual_history: { id: 'local id', individual_id: 'tree_uuid', survey_id: 'survey_uuid' },
  fw_stems: { id: 'local id', individual_id: 'tree_uuid', first_survey_id: 'first_survey_uuid', created_at: 'stamp', updated_at: 'stamp' },
  fw_stem_measures: { id: 'local id', survey_id: 'its census part', stem_id: 'stem_uuid', created_at: 'stamp', updated_at: 'stamp' },
  fw_stem_values: { id: 'local id', measure_id: 'stem_uuid + its census part', updated_at: 'stamp' },
  fw_individual_values: { id: 'local id', survey_id: 'its census part', individual_id: 'tree_uuid', updated_at: 'stamp' },
  fw_media: {
    id: 'local id',
    survey_id: 'its census part',
    individual_id: 'tree_uuid',
    measure_id: 'stem_uuid',
    unit_id: 'plot-style owner; NULL on a census photo',
    occurrence_id: 'plot-style owner; NULL on a census photo',
    uri: 'file (the name in the zip)',
    created_at: 'stamp',
  },
};
/** fw_* tables a census never has rows in (checklist / plot-style surveys, v83); their export is Phase 2E. */
const NOT_CENSUS = {
  fw_frame_units: "a permanent plot's unit layout (plot style)",
  fw_frame_labels: "a permanent plot's morphospecies (plot style)",
  fw_units: 'plot-style units',
  fw_occurrences: 'checklist / plot-style occurrences',
  fw_survey_values: 'checklist / plot-style survey values',
  fw_unit_values: 'plot-style unit values',
  fw_occurrence_values: 'checklist / plot-style occurrence values',
  fw_rechecks: 'recheck answers of a plot-style survey (v84)',
};
const keysIn = (rows) => new Set(rows.flatMap((r) => Object.keys(r)));
const DOC_ROWS = {
  fw_frames: [doc.frame],
  fw_frame_series: [doc.series],
  fw_surveys: doc.censuses.map((c) => c.survey),
  fw_survey_quadrats: doc.censuses.flatMap((c) => c.quadrats),
  fw_individuals: doc.trees,
  fw_individual_history: doc.history,
  fw_stems: doc.stems,
  fw_stem_measures: doc.censuses.flatMap((c) => c.measures),
  fw_stem_values: doc.censuses.flatMap((c) => c.stemValues),
  fw_individual_values: doc.censuses.flatMap((c) => c.treeValues),
  fw_media: doc.censuses.flatMap((c) => c.media),
};
const fwTables = A.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fw\\_%' ESCAPE '\\'`).map((r) => r.name);
for (const table of Object.keys(NOT_CENSUS)) if (!fwTables.includes(table)) ok(false, `NOT_CENSUS.${table}: no such table (stale)`);
for (const table of fwTables) {
  if (table in NOT_CENSUS) continue;
  if (!(table in DOC_ROWS)) {
    ok(false, `coverage: ${table} is not in the document (add it, or say why not)`);
    continue;
  }
  const have = keysIn(DOC_ROWS[table]);
  for (const { name } of A.all(`PRAGMA table_info(${table})`)) {
    if (have.has(name) || name in (NOT_CARRIED[table] ?? {})) continue;
    ok(false, `coverage: ${table}.${name} is neither in the document nor in NOT_CARRIED`);
  }
  for (const col of Object.keys(NOT_CARRIED[table] ?? {})) {
    if (!A.all(`PRAGMA table_info(${table})`).some((c) => c.name === col)) ok(false, `NOT_CARRIED.${table}.${col}: no such column (stale)`);
  }
}

// ── the tables ───────────────────────────────────────────────────────────
const names = (id) => ({ scientific: `Name ${id}`, vernacular: null });
const census = tb.censusTable(doc);
const col = (t, name) => t.header.indexOf(name);
const row = (t, no, uuid) => t.rows.find((r) => r[col(t, 'census_no')] === String(no) && r[col(t, 'individual_uuid')] === uuid);
ok(census.rows.length === 8, `census.csv: every tree in every census (${census.rows.length})`);
ok(row(census, 1, u4)[col(census, 'status')] === 'P', 'census.csv: P before a tree is first recorded');
ok(row(census, 1, u1)[col(census, 'status')] === 'A' && row(census, 1, u1)[col(census, 'dbh_mm')] === '300', 'census.csv: A, dbh in mm of the largest live stem');
ok(row(census, 1, u1)[col(census, 'stems')] === '2', 'census.csv: live stems counted');
ok(row(census, 2, u2)[col(census, 'status')] === 'D' && row(census, 2, u2)[col(census, 'dbh_mm')] === '' && row(census, 2, u2)[col(census, 'codes')] === 'DS', 'census.csv: D with its code, no dbh');
ok(row(census, 2, u3)[col(census, 'status')] === 'F', 'census.csv: F alive under the threshold (resprout)');
ok(row(census, 1, u1)[col(census, 'height_m')] === '9', 'census.csv: height');
const trees = tb.treesTable(doc, names);
const t1row = trees.rows.find((r) => r[col(trees, 'individual_uuid')] === u1);
ok(t1row[col(trees, 'quadrat')] === '0000' && t1row[col(trees, 'subquadrat')] === '12' && t1row[col(trees, 'first_census')] === '1', `trees.csv: quadrat, subquadrat, first census (${t1row})`);
ok(trees.rows.find((r) => r[col(trees, 'individual_uuid')] === u2)[col(trees, 'tag')] === '200', 'trees.csv: the corrected tag');
const stems = tb.stemsTable(doc);
ok(stems.rows.length === 9 && stems.rows.some((r) => r[col(stems, 'stem_tag')].endsWith('-2') && r[col(stems, 'dbh_mm')] === '310'), `stems.csv: one row per measured stem, cm and mm (${stems.rows.length})`);
ok(!stems.header.some((h) => h.startsWith('ams_')), 'stems.csv: no AMS columns for a census-codes-only file');
// eventIDs (§7.4): the plot rule inside the series, base plot code (+ series code).
{
  const ev = tb.censusEventIds(doc);
  const code = String(doc.frame.code);
  ok(ev.get(1) === code && ev.get(2)?.startsWith(`${code}_`), `eventID: census 1 the plot code, census 2 dated (${[...ev.values()]})`);
  ok(row(census, 2, u1)[col(census, 'eventID')] === ev.get(2) && stems.rows.every((r) => r[col(stems, 'eventID')] === ev.get(Number(r[col(stems, 'census_no')]))), 'census.csv / stems.csv: each row its census’s eventID');
  const coded = JSON.parse(JSON.stringify(doc));
  coded.series.series_code = 'ams';
  ok(tb.censusEventIds(coded).get(1) === `${code}_ams`, 'eventID: a later series adds its code');
}
// A census template's traits and own code list (2D-b): columns of their own, values as recorded.
{
  const withT = JSON.parse(JSON.stringify(doc));
  const last = withT.censuses[withT.censuses.length - 1];
  const tpl = JSON.parse(last.survey.template_snapshot);
  tpl.codelists = [{ id: 'list_1', label: { text: '損傷' }, items: [{ code: '1', label: { text: '蟲害' } }, { code: '2', label: { text: '折枝' } }] }];
  tpl.components = [
    ...tpl.components.map((c) => (c.type === 'health' ? { ...c, params: { codesets: ['forestgeo-census-1998', 'list_1'] } } : c)),
    { key: 'traits', type: 'traits', level: 'individual', required: false, params: { traits: [{ id: 'crown_width', label: { text: '冠幅' }, unit: 'm' }] } },
  ];
  last.survey.template_snapshot = JSON.stringify(tpl);
  const treeUuid = last.treeValues[0]?.tree_uuid ?? withT.trees[0].uuid;
  const stemUuid = last.measures[0].stem_uuid;
  last.treeValues.push({ uuid: 'tv-1', tree_uuid: treeUuid, component: 'traits', field: 'crown_width', idx: 0, value_num: 5.5, value_text: null, unit: 'm' });
  last.stemValues.push({ uuid: 'sv-1', stem_uuid: stemUuid, component: 'health', field: 'codes_list_1', idx: 0, value_num: null, value_text: '["1","2"]', unit: null });
  const ct = tb.censusTable(withT);
  const st = tb.stemsTable(withT);
  const n = String(last.survey.census_no);
  ok(ct.header.at(-1) === 'traits.crown_width' && ct.header.slice(0, census.header.length).join() === census.header.join(), `census.csv: a trait column after the others (${ct.header.slice(-2)})`);
  ok(ct.rows.find((r) => r[col(ct, 'individual_uuid')] === treeUuid && r[col(ct, 'census_no')] === n)[col(ct, 'traits.crown_width')] === '5.5', 'census.csv: the trait value');
  ok(st.header.includes('codes_list_1') && st.rows.find((r) => r[col(st, 'stem_uuid')] === stemUuid && r[col(st, 'census_no')] === n)[col(st, 'codes_list_1')] === '1;2', 'stems.csv: the code list column, codes joined with ;');
}
// The same file as an AMS census would write it (2B): AMS columns, values as written.
{
  const withAms = JSON.parse(JSON.stringify(doc));
  const last = withAms.censuses[withAms.censuses.length - 1];
  const tpl = JSON.parse(last.survey.template_snapshot);
  tpl.components = tpl.components.map((c) => (c.type === 'health' ? { ...c, params: { codesets: ['forestgeo-census-1998', 'forestgeo-ams-2021'] } } : c));
  last.survey.template_snapshot = JSON.stringify(tpl);
  const stemUuid = last.measures[0].stem_uuid;
  const v = (field, value_num, value_text) => ({ uuid: `v-${field}`, stem_uuid: stemUuid, component: 'health', field, idx: 0, value_num, value_text, unit: null });
  last.stemValues.push(v('ams_survival_status', null, 'A'), v('ams_mode', null, '["B","U"]'), v('ams_leaning_deg', 12, null), v('ams_living_length_m', null, '<POM'));
  const at = tb.stemsTable(withAms);
  const amsCols = at.header.filter((h) => h.startsWith('ams_'));
  ok(amsCols.length === 14 && at.header.slice(0, stems.header.length).join() === stems.header.join(), `stems.csv: an AMS census adds the 14 AMS columns after the others (${amsCols.length})`);
  const row = at.rows.find((r) => r[col(at, 'stem_uuid')] === stemUuid && r[col(at, 'census_no')] === String(last.survey.census_no));
  ok(
    row && row[col(at, 'ams_survival_status')] === 'A' && row[col(at, 'ams_mode')] === 'B;U' && row[col(at, 'ams_leaning_deg')] === '12' && row[col(at, 'ams_living_length_m')] === '<POM',
    `stems.csv: AMS values as written, lists joined with ; (${row && amsCols.map((h) => row[col(at, h)]).join('|')})`,
  );
}
// Tag order without localeCompare (1E): the same as its numeric order on tags as people write them.
const TAGS = ['10', '2', '1', '100', '12A', '12', '12B', 'A2', 'A10', 'B1', '9', '0099', '1-2', '1-10'];
const tagged = { ...doc, trees: TAGS.map((tag) => ({ ...doc.trees[0], tag })) };
const ordered = tb.treesTable(tagged, names).rows.map((r) => r[0]);
const expected = [...TAGS].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
ok(JSON.stringify(ordered) === JSON.stringify(expected), `tags: reading order (${ordered.join(' ')} vs ${expected.join(' ')})`);
const vegan = tb.veganBasalArea(doc, 1, names);
const cell = (q, sp) => Number(vegan.rows.find((r) => r[0] === q)[vegan.header.indexOf(sp)]);
ok(vegan.rows.length === 4, 'vegan: every quadrat');
ok(Math.abs(cell('0000', 'Name k1') - Math.round(basalArea([12.6, 31]) * 100) / 100) < 1e-9, 'vegan: basal area of live stems in cm²');
ok(cell('0101', 'Name k2') === 0, 'vegan: a dead tree adds nothing, even with a DBH written down');

// ── the file as the record importer reads it ─────────────────────────────
const asYml = readRecordImportFromBytes(strToU8(text));
ok(asYml.kind === 'survey' && JSON.stringify(asYml.census) === JSON.stringify(doc), 'reader: a census yml is a census, rows restored');
const asOlder = readRecordImportFromBytes(strToU8(older));
ok(asOlder.kind === 'survey' && JSON.stringify(asOlder.census) === JSON.stringify(doc), 'reader: a 1D row-mapping yml too');
const zip = zipSync({
  'EX1_census2/EX1_census2.yml': strToU8(text),
  'EX1_census2/EX1_census2_trees.csv': strToU8('tag\n1\n'),
  'EX1_census2/manifest.json': strToU8(JSON.stringify({ app: 'mitalivana', kind: 'survey' })),
  'EX1_census2/photos/photo1.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
});
const asZip = readRecordImportFromBytes(zip);
ok(asZip.kind === 'survey' && asZip.photos.length === 1 && asZip.photos[0].name === 'photo1.jpg' && JSON.stringify(asZip.census) === JSON.stringify(doc), 'reader: a census zip, with its photos');

// ── import on an empty device ────────────────────────────────────────────
const B = await phone('b');
const planB = ex.planCensusImport(B.ctx, doc);
ok(!planB.frameCodeTaken && planB.censuses.every((c) => c.localId == null), 'import: nothing here yet');
const resB = B.tx(() => ex.importCensusDoc(B.ctx, doc, 'skip', (f) => (f === 'photo1.jpg' ? 'file:///phone-b/photo1.jpg' : null)));
ok(resB.created.length === 2, 'import: both censuses created');
// Local ids and stamps differ by nature; a census lands finished; a photo points at this device's file.
const STAMPS = new Set(['id', 'created_at', 'updated_at', 'frame_id', 'series_id', 'survey_id', 'individual_id', 'stem_id', 'measure_id', 'first_survey_id', 'project_id', 'site_id']);
const ALSO = { fw_surveys: ['status'], fw_media: ['uri'] };
const snapshot = (P, table) => {
  const out = new Map();
  for (const r of P.all(`SELECT * FROM ${table}`)) {
    const key = r.uuid ?? JSON.stringify(r);
    out.set(key, Object.fromEntries(Object.entries(r).filter(([k]) => !STAMPS.has(k) && !(ALSO[table] ?? []).includes(k))));
  }
  return out;
};
for (const table of fwTables) {
  const a = snapshot(A, table);
  const b = snapshot(B, table);
  ok(a.size === b.size, `round trip: ${table} has ${b.size} rows here, ${a.size} there`);
  for (const [k, row] of a) ok(JSON.stringify(row) === JSON.stringify(b.get(k)), `round trip: ${table} ${k} differs\n    ${JSON.stringify(row)}\n    ${JSON.stringify(b.get(k))}`);
}
ok(B.all('SELECT status FROM fw_surveys').every((r) => r.status === 'done'), 'import: censuses land finished');
ok(B.one('SELECT uri FROM fw_media').uri === 'file:///phone-b/photo1.jpg', 'import: photos point at this device\'s files');
ok(B.sqlite.prepare('PRAGMA foreign_key_check').all().length === 0, 'import: foreign keys hold');
for (const [table, where] of CASCADE_ORPHANS) if (table.startsWith('fw_')) ok(B.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).n === 0, `import: no ${table} orphans`);

// ── import where census 1 is here ────────────────────────────────────────
const doc1 = ex.censusExportFromFile(JSON.parse(ex.censusExportText(ex.buildCensusExport(A.ctx, C1))));
const freshWithCensus1 = async (prefix) => {
  const P = await phone(prefix);
  P.tx(() => ex.importCensusDoc(P.ctx, doc1, 'skip'));
  return P;
};
// skip: census 1 untouched; census 2 created, and a correction made here since stays (created only adds)
const D = await freshWithCensus1('d');
const d1 = D.one('SELECT id FROM fw_surveys WHERE census_no = 1').id;
const dT1 = D.one('SELECT id FROM fw_individuals WHERE uuid = ?', u1).id;
D.tx(() => s.correctIndividual(D.ctx, dT1, { taxon: taxon('k9') }, { surveyId: d1, reason: 'species', by: 'D' }));
const planD = ex.planCensusImport(D.ctx, doc);
ok(planD.censuses[0].localId === d1 && planD.censuses[1].localId == null, 'plan: census 1 here, census 2 not');
const resD = D.tx(() => ex.importCensusDoc(D.ctx, doc, 'skip'));
ok(resD.skipped.length === 1 && resD.created.length === 1, 'skip: census 1 left, census 2 created');
ok(D.one('SELECT taxon_id FROM fw_individuals WHERE id = ?', dT1).taxon_id === 'k9', 'skip: a correction made here since stays');
ok(D.one('SELECT COUNT(*) AS n FROM fw_individuals').n === 4, 'skip: the new census brings its new tree');

// overwrite: census 1 equal to the file again — a DBH changed here goes back, a tree added here since goes
const E = await freshWithCensus1('e');
const e1 = E.one('SELECT id FROM fw_surveys WHERE census_no = 1').id;
const eT1 = E.one('SELECT id FROM fw_individuals WHERE uuid = ?', u1).id;
const em = E.one(`SELECT m.id FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND st.stem_no = 1 AND m.survey_id = ?`, eT1, e1).id;
E.tx(() => s.updateMeasure(E.ctx, em, { dbhCm: 99 }));
clock += 10; // after the file was made
const late = E.tx(() => s.saveTreeDraft(E.ctx, e1, draft({ location: xy(35, 35), taxon: taxon('k5') })));
const docLater = { ...doc, exported_at: doc.exported_at };
const resE = E.tx(() => ex.importCensusDoc(E.ctx, docLater, 'overwrite'));
ok(resE.overwritten.length === 1 && resE.created.length === 1, 'overwrite: census 1 overwritten, census 2 created');
ok(E.one('SELECT dbh_cm FROM fw_stem_measures WHERE id = ?', em).dbh_cm === 12, 'overwrite: a value changed here goes back to the file');
ok(E.one('SELECT id FROM fw_individuals WHERE id = ?', late) == null, 'overwrite: a tree added here since goes');

// merge: census 1 handed to the census merge; their change comes in, ours stays
const G = await freshWithCensus1('g');
const g1 = G.one('SELECT id FROM fw_surveys WHERE census_no = 1').id;
const resG = G.tx(() => ex.importCensusDoc(G.ctx, doc, 'merge'));
ok(resG.merges.length === 1 && resG.merges[0].surveyId === g1, 'merge: census 1 handed to the merge');
ok(resG.merges[0].slice.trees.every((t) => t.first_survey_uuid !== doc.censuses[0].survey.uuid), 'merge: the census as THIS_CENSUS in the slice');
const mergeItems = G.tx(() => {
  const opened = cs.openBlock(G.ctx, g1, resG.merges[0].slice);
  const remote = cs.settleCollisions(G.ctx, g1, opened, new Map(), null);
  const items = cs.blockItems(G.ctx, g1, cs.ALL_QUADRATS, remote, resG.merges[0].base, []);
  cs.applyBlockItems(G.ctx, g1, items, new Map(items.map((it) => [it.id, defaultDecision(it)])), remote);
  return items;
});
ok(mergeItems.length === 0, `merge: the same census merges to nothing (${mergeItems.map((i) => `${i.tbl}:${i.kind}`)})`);

// a census here under another uuid (started on another phone) counts as here
const H = await phone('h');
const otherDoc = JSON.parse(JSON.stringify(doc1));
otherDoc.censuses[0].survey.uuid = 'someone-elses-census';
for (const t of otherDoc.trees) if (t.first_survey_uuid === doc1.censuses[0].survey.uuid) t.first_survey_uuid = 'someone-elses-census';
for (const st of otherDoc.stems) if (st.first_survey_uuid === doc1.censuses[0].survey.uuid) st.first_survey_uuid = 'someone-elses-census';
H.tx(() => ex.importCensusDoc(H.ctx, otherDoc, 'skip'));
const planH = ex.planCensusImport(H.ctx, doc);
ok(planH.censuses[0].localId != null && planH.censuses[1].localId == null, 'plan: same plot + series + number under another uuid counts as here');
const resH = H.tx(() => ex.importCensusDoc(H.ctx, doc, 'skip'));
ok(resH.created.length === 1 && H.one('SELECT COUNT(*) AS n FROM fw_surveys').n === 2, 'import: then census 2 joins it');
ok(H.one(`SELECT first_survey_id AS f FROM fw_individuals WHERE uuid = ?`, u4).f === H.one('SELECT id FROM fw_surveys WHERE census_no = 2').id, 'import: its recruit first seen in census 2 here');

// the same plot + series + number here on another census template (2026-10-03): neither merged nor overwritten
const J = await phone('j');
const otherTpl = JSON.parse(JSON.stringify(otherDoc));
otherTpl.censuses[0].survey.template_id = 'user:other-census';
J.tx(() => ex.importCensusDoc(J.ctx, otherTpl, 'skip'));
const jHere = J.one('SELECT id, uuid FROM fw_surveys WHERE census_no = 1');
for (const choice of ['merge', 'overwrite']) {
  const r = J.tx(() => ex.importCensusDoc(J.ctx, doc, choice));
  ok(
    r.templateDiffers.length === 1 && r.templateDiffers[0] === jHere.id && !r.merges.some((m) => m.surveyId === jHere.id) && !r.overwritten.includes(jHere.id),
    `${choice}: a census here on another template is left alone (${JSON.stringify({ d: r.templateDiffers, m: r.merges.length, o: r.overwritten })})`,
  );
}
ok(J.one('SELECT template_id FROM fw_surveys WHERE id = ?', jHere.id).template_id === 'user:other-census', 'import: … and keeps its own template');

// a plot code another plot holds here
const K = await phone('k');
s.createFrame(K.ctx, { code: 'EX1', sizeXM: 20, sizeYM: 20 });
ok(ex.planCensusImport(K.ctx, doc).frameCodeTaken, 'plan: another plot with the code here is refused');

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ census-export: the document carries every column, round-trips, and its tables follow Condit 1998');
