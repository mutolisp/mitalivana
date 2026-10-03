/**
 * A checklist / plot-style survey's export (src/survey/export/surveyExportCore.ts,
 * Phase 2E-a), on two databases on the real migrated schema, foreign keys ON.
 *
 * What must hold:
 *   - the file round-trips: the document zipped with its photos and
 *     recordings, read back by the record importer (recordImportZip), its
 *     files mapped to paths on the other phone, inserted there, is the same
 *     survey — every row by its key, its media and the morphospecies photo —
 *     and the survey before it on the plot comes along;
 *   - file names survive the importer's own sanitising; a document naming
 *     paths (a merge backup) keeps those still here and drops the rest;
 *   - eventIDs follow the plot rule inside a series (plot code + series code,
 *     then _YYYYMMDD, then _2); off a plot, the name;
 *   - the tables: a column per component field (`key.field`, repeated fields
 *     per index, a choice's names beside its codes, media by file), units
 *     with their own eventIDs under the survey's, occurrences under their
 *     unit's; the dictionary describes every component column; code lists
 *     and recheck answers are listed;
 *   - community tables: presence, and one per abundance scale with only that
 *     scale's records (Braun-Blanquet as cover %, counts added); custom types
 *     are in none; the project's matrices group by template and take a scale
 *     only from surveys that use it alone.
 *
 * Run: npm run check:survey-export
 */
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import { runUserMigrations } from '../src/db/migrations.ts';
import { baseOf } from '../src/lib/mergeEngine.ts';
import { readRecordImportFromBytes, safeMediaBasename } from '../src/lib/recordImportZip.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as d from '../src/survey/db/surveyDocCore.ts';
import * as x from '../src/survey/export/surveyExportCore.ts';
import * as ix from '../src/survey/db/interactionCore.ts';
import { withRequired } from '../src/survey/template/validate.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};

let clock = Date.UTC(2026, 9, 3, 2, 0, 0);
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
  const ctx = { db, now: () => (clock += 60_000), uuid: () => `${tag}-${++n}` };
  const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
  return { db, ctx, one };
}

const T = withRequired({
  schema: 1,
  id: 'user:export',
  version: 1,
  origin: 'user',
  name: { text: '匯出測試', tr: { en: 'Export test' } },
  style: 'plot',
  units: [
    { key: 'u1', label: { text: '小區' } },
    { key: 'u2', label: { text: '小樣方' } },
  ],
  components: [
    { key: 'layers', type: 'structure', level: 'survey', required: false, params: { layers: 3, methods: ['BB', 'percent'] } },
    { key: 'where', type: 'location', level: 'unit', unit: 'u1', required: false, params: { methods: ['gps'] } },
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'percent', 'count', 'custom'], default: 'BB' } },
    { key: 'micro', type: 'choice', level: 'occurrence', label: { text: '微棲地', tr: { en: 'Microhabitat' } }, required: false, params: { list: 'list_1', multi: true } },
    { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'len', label: { text: '葉長' }, unit: 'cm' }] } },
    { key: 'pics', type: 'photos', level: 'occurrence', required: false, params: { max: 4 } },
    { key: 'calls', type: 'audio', level: 'occurrence', required: false, params: { max: 4 } },
  ],
  codelists: [
    {
      id: 'list_1',
      label: { text: '微棲地', tr: { en: 'Microhabitat' } },
      items: [
        { code: 'rock', label: { text: '岩石', tr: { en: 'Rock' } } },
        { code: 'log', label: { text: '倒木' } },
        { code: 'old', label: { text: '舊碼' }, deprecated: true },
      ],
    },
  ],
  quick_add: false,
});
// A dotted name: file names must not keep the dot the importer would turn into _.
const names = (id) => ({ scientific: { t1: 'Alpha one', t2: 'Beta two subsp. b', t3: 'Gamma three' }[id] ?? null, vernacular: { t1: '甲' }[id] ?? null });
const words = { typeName: (type) => `<${type}>`, i18n: (k) => `[${k}]` };

// ── phone A: a plot, a first survey, the second with everything ─────────
const A = await phone('a');
const F = s.createFrame(A.ctx, { code: 'EX1', sizeXM: 20, sizeYM: 20 });
const P1 = c.createSurvey(A.ctx, { template: T, frameId: F, investigators: '甲' });
const S1 = c.addUnit(A.ctx, P1, { levelKey: 'u1', code: 'S1' });
c.addUnit(A.ctx, P1, { levelKey: 'u2', code: 'Q1', parentId: S1 });
c.addOccurrence(A.ctx, P1, { taxon_id: 't1', unit_id: S1 });
c.finishSurvey(A.ctx, P1);
c.addFrameLabel(A.ctx, F, { taxonId: 't2', verbatim: 'sp1', note: '葉背有毛', firstSurveyId: P1 });
A.db.executeSync(`UPDATE fw_frame_labels SET photo_uri = 'file:///a/label sp1.JPG'`);
const P2 = c.createSurvey(A.ctx, { template: T, frameId: F, investigators: '甲' });
const u = Object.fromEntries(c.listUnits(A.ctx, P2).map((r) => [r.code, r.id]));
c.writeComponent(A.ctx, { kind: 'survey', id: P2 }, 'layers', { layer_count: 3, cover_pct: { 1: 40, 3: 5 } });
c.writeComponent(A.ctx, { kind: 'unit', id: u.S1 }, 'where', { lat: 24.1, lng: 121.2, accuracy: 4 });
// A value in a column no component of the quadrat level uses: not the subplot's location.
A.db.executeSync(`UPDATE fw_units SET lat = 1 WHERE id = ?`, [u.Q1]);
const o1 = c.addOccurrence(A.ctx, P2, { taxon_id: 't1', unit_id: u.Q1, organism_quantity: '3', organism_quantity_type: 'Braun-Blanquet Scale' });
const o2 = c.addOccurrence(A.ctx, P2, { taxon_id: 't1', unit_id: u.Q1, organism_quantity: '+', organism_quantity_type: 'Braun-Blanquet Scale' });
const o3 = c.addOccurrence(A.ctx, P2, { taxon_id: 't2', unit_id: u.S1, verbatim_identification: 'sp1', organism_quantity: '4', organism_quantity_type: 'individuals' });
c.addOccurrence(A.ctx, P2, { taxon_id: 't2', unit_id: u.S1, verbatim_identification: 'sp1', organism_quantity: '3', organism_quantity_type: 'individuals' });
c.addOccurrence(A.ctx, P2, { taxon_id: 't3', unit_id: u.S1, organism_quantity: '7', organism_quantity_type: 'stems per m' });
c.writeComponent(A.ctx, { kind: 'occurrence', id: o1 }, 'micro', { value: ['rock', 'log'] });
c.writeComponent(A.ctx, { kind: 'occurrence', id: o1 }, 'leaf', { len: 4.5 });
c.addMedia(A.ctx, { kind: 'occurrence', id: o1 }, 'pics', 'file:///a/photo one.jpg');
c.addMedia(A.ctx, { kind: 'occurrence', id: o1 }, 'pics', 'file:///a/photo two.jpg');
c.addMedia(A.ctx, { kind: 'occurrence', id: o3 }, 'calls', 'file:///a/clip.m4a');
const live = d.buildSurveyDoc(A.ctx, P2, { previous: true });
ok(live.previous && live.previous.occurrences.length === 1, 'file: the survey before it comes along (n−1)');

// ── the file: named media, through the real importer ─────────────────────
const extOf = (uri) => (/\.([A-Za-z0-9]+)$/.exec(uri)?.[1] ?? '');
const { doc: fileDoc, files } = x.docForFile(live, { names, extOf });
ok(files.length === 4 && fileDoc.media.every((m) => m.uri === undefined && typeof m.file === 'string'), `file: media named by file, no device paths (${files.map((f) => f.file)})`);
ok(fileDoc.frame_labels[0].photo_file && fileDoc.frame_labels[0].photo_uri === undefined, 'file: the morphospecies photo named by file');
ok(
  files.every((f) => safeMediaBasename(`x/${f.kind === 'audio' ? 'audio' : 'photos'}/${f.file}`, ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'm4a', 'mp3', 'wav', 'aac']) === f.file),
  `file: names survive the importer's sanitising (${files.map((f) => f.file)})`,
);
ok(new Set(files.map((f) => f.file)).size === files.length, 'file: names are unique');
const base = 'EX1';
const zipEntries = { [`${base}/${base}.yml`]: strToU8(JSON.stringify(fileDoc)), [`${base}/manifest.json`]: strToU8(JSON.stringify({ kind: 'modular' })) };
for (const f of files) zipEntries[`${base}/${f.kind === 'audio' ? 'audio' : 'photos'}/${f.file}`] = strToU8(`bytes of ${f.file}`);
const read = readRecordImportFromBytes(zipSync(zipEntries));
ok(read.kind === 'modular' && read.photos.length === 3 && read.audio.length === 1, `file: the importer reads a modular zip with its photos and recordings (${read.kind} ${read.photos?.length} ${read.audio?.length})`);
const plain = readRecordImportFromBytes(strToU8(JSON.stringify(fileDoc)));
ok(plain.kind === 'modular' && plain.photos.length === 0, 'file: a bare document (a merge backup) reads as one too');

// ── phone B: inserted, the same survey ───────────────────────────────────
const B = await phone('b');
const blobs = new Map([...read.photos, ...read.audio].map((p) => [p.name, `file:///b/${p.name}`]));
const onB = x.docFromFile(read.survey, (file) => blobs.get(file) ?? null, () => false);
ok(onB.media.length === 3 && onB.media.every((m) => m.uri?.startsWith('file:///b/') && m.file === undefined), 'import: every file maps to its path here');
const idB = (() => {
  // The previous survey from the same document: the plot's morphospecies keep their photo.
  d.insertPreviousFromDoc(B.ctx, onB);
  const id = d.insertSurveyFromDoc(B.ctx, onB, { status: 'done', projectId: 0 });
  d.putBackMediaRows(B.ctx, id, onB, () => true);
  return id;
})();
const sideA = d.surveyDocSide(d.buildSurveyDoc(A.ctx, P2));
const sideB = d.surveyDocSide(d.buildSurveyDoc(B.ctx, idB));
const keyset = (sd) => JSON.stringify(baseOf(sd).map((b) => [b.tbl, b.key, b.hash]).sort());
ok(keyset(sideA) === keyset(sideB), 'import: the survey on B is the same survey, row by row');
ok(B.one(`SELECT COUNT(*) AS n FROM fw_media WHERE survey_id = ?`, idB).n === 3, 'import: its photos and recording are there');
ok(B.one(`SELECT photo_uri FROM fw_frame_labels`).photo_uri?.startsWith('file:///b/label_'), `import: the morphospecies photo too (${B.one(`SELECT photo_uri FROM fw_frame_labels`).photo_uri})`);
ok(B.one(`SELECT COUNT(*) AS n FROM fw_surveys WHERE census_no = 1`).n === 1, 'import: the survey before it was made here');
// A merge backup names paths: the ones still here stay.
const backup = x.docFromFile(live, () => null, (uri) => uri.includes('one'));
ok(backup.media.length === 1 && backup.media[0].uri === 'file:///a/photo one.jpg' && backup.frame_labels[0].photo_uri === null, 'import: a document naming paths keeps those still here');

// ── eventIDs ─────────────────────────────────────────────────────────────
const day = (y, m, dd) => new Date(y, m - 1, dd, 9).getTime();
const ids = x.surveyEventIds([
  { id: 1, base: x.eventBase({ frameCode: 'EX1', seriesCode: '', name: null, uuid: 'u1' }), startTs: day(2026, 1, 1) },
  { id: 2, base: x.eventBase({ frameCode: 'EX1', seriesCode: '', name: null, uuid: 'u2' }), startTs: day(2026, 5, 1) },
  { id: 3, base: x.eventBase({ frameCode: 'EX1', seriesCode: '', name: null, uuid: 'u3' }), startTs: day(2026, 5, 1) },
  { id: 4, base: x.eventBase({ frameCode: 'EX1', seriesCode: 'veg', name: null, uuid: 'u4' }), startTs: day(2026, 5, 1) },
  { id: 5, base: x.eventBase({ frameCode: null, seriesCode: null, name: ' 溪流 ', uuid: 'u5' }), startTs: day(2026, 5, 1) },
  { id: 6, base: x.eventBase({ frameCode: null, seriesCode: null, name: null, uuid: 'abcdef123456' }), startTs: null },
]);
const idList = [1, 2, 3, 4, 5, 6].map((i) => ids.get(i));
ok(idList.join() === 'EX1,EX1_20260501,EX1_20260501_2,EX1_veg,溪流,survey_abcdef12', `eventID: the plot rule per series; a name off a plot (${idList})`);

// ── tables ───────────────────────────────────────────────────────────────
const tb = x.surveyTables(fileDoc, { eventId: 'EX1_20261003', names, words });
const col = (t, name) => t.header.indexOf(name);
const occ = tb.occurrences;
const r1 = occ.rows.find((r) => r[0] === live.occurrences.find((o) => o.taxon_id === 't1' && o.organism_quantity === '3').uuid);
ok(['abundance.organism_quantity', 'abundance.organism_quantity_type', 'micro.value', 'micro.value_name', 'leaf.len', 'pics.photos', 'calls.audio'].every((h) => col(occ, h) >= 0), `tables: a column per component field (${occ.header})`);
ok(col(occ, 'taxon.taxon_id') < 0 && col(occ, 'taxonID') === 3, 'tables: the taxon is the table’s own columns, not a component’s');
ok(r1[col(occ, 'micro.value')] === 'rock;log' && r1[col(occ, 'micro.value_name')] === '岩石;倒木', `tables: a choice's codes and names (${r1[col(occ, 'micro.value')]} / ${r1[col(occ, 'micro.value_name')]})`);
ok(r1[col(occ, 'leaf.len')] === '4.5' && r1[col(occ, 'scientificName')] === 'Alpha one', 'tables: a trait and the name');
ok(r1[col(occ, 'pics.photos')].split(';').length === 2 && r1[col(occ, 'pics.photos')].split(';').every((f) => files.some((ff) => ff.file === f)), 'tables: photos by their file names');
ok(r1[col(occ, 'eventID')] === 'EX1_20261003-S1-Q1' && r1[col(occ, 'unit')] === 'S1/Q1', `tables: an occurrence under its unit's event (${r1[col(occ, 'eventID')]})`);
const sv = tb.survey;
ok(col(sv, 'layers.cover_pct[1]') >= 0 && col(sv, 'layers.cover_pct[3]') >= 0 && col(sv, 'layers.cover_pct[2]') < 0, `tables: a repeated field per index present (${sv.header.filter((h) => h.startsWith('layers'))})`);
ok(sv.rows[0][col(sv, 'layers.cover_pct[1]')] === '40' && sv.rows[0][col(sv, 'template_name')] === '匯出測試' && sv.rows[0][col(sv, 'plot_code')] === 'EX1', 'tables: the survey row');
ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(sv.rows[0][col(sv, 'timestamp.start_ts')]), `tables: times as local stamps (${sv.rows[0][col(sv, 'timestamp.start_ts')]})`);
const un = tb.units;
const s1 = un.rows.find((r) => r[col(un, 'unit')] === 'S1');
const q1 = un.rows.find((r) => r[col(un, 'unit')] === 'S1/Q1');
ok(s1[col(un, 'parentEventID')] === 'EX1_20261003' && q1[col(un, 'parentEventID')] === 'EX1_20261003-S1' && q1[col(un, 'level_name')] === '小樣方', 'tables: units under the survey, sub-units under theirs');
ok(s1[col(un, 'where.lat')] === '24.1' && q1[col(un, 'where.lat')] === '', 'tables: a unit-level component only on its level');
ok(tb.fields.rows.length === sv.header.length - 13 + (un.header.length - 8) + (occ.header.length - 10), `tables: the dictionary has every component column (${tb.fields.rows.length})`);
const dictMicro = tb.fields.rows.find((r) => r[1] === 'micro.value');
ok(dictMicro[4] === '微棲地' && dictMicro[5] === 'Microhabitat' && dictMicro[12] === '微棲地', `tables: the dictionary names the component and the choice's measurement by its list (${dictMicro})`);
ok(tb.fields.rows.find((r) => r[1] === 'abundance.organism_quantity')[11] === 'organismQuantity', 'tables: the dictionary gives DwC terms');
ok(tb.codelists.rows.length === 3 && tb.codelists.rows[2].join() === 'list_1,微棲地,Microhabitat,old,舊碼,,1', 'tables: the code lists, retired codes marked');
ok(tb.rechecks === null, 'tables: no recheck table without answers');

// ── community tables ─────────────────────────────────────────────────────
const comm = x.surveyCommunityTables(fileDoc, { eventId: 'E', names });
const by = Object.fromEntries(comm.tables.map((t) => [t.name, t.table]));
ok(Object.keys(by).join() === 'presence,bb_cover_pct,count', `community: presence and one per scale used (${Object.keys(by)})`);
const cell = (t, row, sp) => t.rows.find((r) => r[0] === row)[t.header.indexOf(sp)];
ok(cell(by.bb_cover_pct, 'E-S1-Q1', 'Alpha one') === '38', 'community: Braun-Blanquet as cover % (3 and + → 38, the larger)');
ok(cell(by.count, 'E-S1', 'Beta two subsp. b sp1') === '7', 'community: counts added (4 + 3), morphospecies as their own column');
ok(by.presence.header.includes('Gamma three') && !by.count.header.includes('Gamma three') && comm.customLeftOut === 1, 'community: a custom quantity type is in presence only');
ok(by.bb_cover_pct.rows.length === 1 && cell(by.presence, 'E-S1', 'Alpha one') === '0', 'community: a scale table holds only its records; absence is 0');
ok(x.surveyCommunityTables({ ...fileDoc, survey: { ...fileDoc.survey, style: 'checklist' } }, { eventId: 'E', names }).tables.length === 0, 'community: none for a checklist');

// ── the project's matrices ───────────────────────────────────────────────
const bbOnly = { ...fileDoc, occurrences: fileDoc.occurrences.filter((o) => o.organism_quantity_type === 'Braun-Blanquet Scale') };
const other = { ...fileDoc, survey: { ...fileDoc.survey, template_id: 'user:other' } };
const pm = x.projectSurveyMatrices(
  [
    { doc: bbOnly, eventId: 'A' },
    { doc: fileDoc, eventId: 'B' },
    { doc: other, eventId: 'C' },
  ],
  names,
);
const pmBy = Object.fromEntries(pm.tables.map((t) => [t.name, t.table]));
const expName = Object.keys(pmBy).find((k) => k.endsWith('_bb_cover_pct') && k.includes('export'));
ok(expName && pmBy[expName].rows.map((r) => r[0]).join() === 'A-S1-Q1', `project: a scale matrix takes only surveys using that scale alone (${Object.keys(pmBy)})`);
const presName = Object.keys(pmBy).find((k) => k.endsWith('_presence') && k.includes('export'));
ok(presName && pmBy[presName].rows.length === 3, 'project: presence takes every survey of the template');
ok(pm.left.join() === 'B,C' && Object.keys(pmBy).filter((k) => k.includes('other')).length === 1, `project: one group per template; mixed scales left out of the scale matrices (${pm.left})`);

// ── interactions (2F-b) ──────────────────────────────────────────────────
{
  const IT = withRequired({
    schema: 1,
    id: 'user:inter-export',
    version: 1,
    origin: 'user',
    name: { text: '交互' },
    style: 'plot',
    units: [{ key: 'u1', label: { text: '小區' } }],
    components: [
      { key: 'inter', type: 'interaction', level: 'occurrence', required: false, params: { builtin: ['flower_visit', 'mutualism'], list: 'list_1', count: true, photos: 2 } },
      { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['count'], default: 'count' } },
      { key: 'spics', type: 'photos', level: 'survey', required: false, params: { max: 2 } },
    ],
    codelists: [{ id: 'list_1', label: { text: '自訂' }, items: [{ code: '1', label: { text: '產卵於', tr: { en: 'lays eggs on' } }, inverse: { text: '被產卵' }, iri: 'http://example.org/oviposits' }] }],
    quick_add: false,
  });
  const G = await phone('g');
  const FI = s.createFrame(G.ctx, { code: 'IXE', sizeXM: 20, sizeYM: 20 });
  const P = c.createSurvey(G.ctx, { template: IT, frameId: FI });
  const U = c.addUnit(G.ctx, P, { levelKey: 'u1', code: 'S1' });
  const a = c.addOccurrence(G.ctx, P, { taxon_id: 't1', unit_id: U, organism_quantity: '2', organism_quantity_type: 'individuals' });
  const b = c.addOccurrence(G.ctx, P, { taxon_id: 't2', unit_id: U, organism_quantity: '1', organism_quantity_type: 'individuals' });
  const i1 = ix.addInteraction(G.ctx, { from: a, partner: { occurrenceId: b }, type: 'flower_visit', direction: 'forward', count: 3 });
  ix.addInteraction(G.ctx, { from: a, partner: { occurrenceId: b }, type: 'flower_visit', direction: 'forward' });
  ix.addInteraction(G.ctx, { from: a, partner: { taxonId: 't3' }, type: '1', direction: 'forward', notes: '葉背' });
  ix.addInteraction(G.ctx, { from: b, partner: { occurrenceId: a }, type: 'mutualism', direction: 'mutual' });
  ix.addInteractionPhoto(G.ctx, i1, 'file:///a/visit one.jpg');
  const live = d.buildSurveyDoc(G.ctx, P);
  const { doc: fd, files: ff } = x.docForFile(live, { names, extOf });
  const interFile = ff.find((f) => f.uri === 'file:///a/visit one.jpg');
  ok(interFile && interFile.file.startsWith('interaction_Alpha_one_') && safeMediaBasename(`x/photos/${interFile.file}`, ['jpg']) === interFile.file, `inter file: its photo named for the interaction, kept by the importer (${interFile?.file})`);
  ok(fd.media[0].interaction === live.interactions[0].uuid && fd.media[0].uri === undefined, 'inter file: the photo still says its interaction');
  // back in, on another phone
  const H = await phone('h');
  const onH = x.docFromFile(fd, (file) => (file === interFile.file ? 'file:///h/visit.jpg' : null), () => false);
  const Ph = d.insertSurveyFromDoc(H.ctx, onH, { status: 'done', projectId: 0 });
  d.putBackMediaRows(H.ctx, Ph, onH, () => true);
  const keys = (sd) => JSON.stringify(baseOf(sd).map((r) => [r[0], r[1], r[2]]).sort());
  ok(keys(d.surveyDocSide(live)) === keys(d.surveyDocSide(d.buildSurveyDoc(H.ctx, Ph))), 'inter import: the same survey there, interactions and the other-side flag included');
  ok(H.one(`SELECT m.uri FROM fw_media m JOIN fw_interactions i ON i.id = m.interaction_id`)?.uri === 'file:///h/visit.jpg', 'inter import: the photo on its interaction');
  // tables
  const t = x.surveyTables(fd, { eventId: 'IXE', names, words });
  const col = (tb, h) => tb.header.indexOf(h);
  const rowOf = (tb, id) => tb.rows.find((r) => r[0] === id);
  const it1 = rowOf(t.interactions, live.interactions[0].uuid);
  ok(t.survey.rows[0][col(t.survey, 'spics.photos')] === '', 'inter table: an interaction’s photo is not the survey’s own');
  ok(it1[col(t.interactions, 'relationship')] === 'visits flowers of' && it1[col(t.interactions, 'relationship_iri')] === 'http://purl.obolibrary.org/obo/RO_0002622', `inter table: the built-in relation and its IRI (${it1})`);
  ok(it1[col(t.interactions, 'subject_scientificName')] === 'Alpha one' && it1[col(t.interactions, 'object_taxonID')] === 't2' && it1[col(t.interactions, 'count')] === '3', 'inter table: both sides, the count');
  ok(it1[col(t.interactions, 'eventID')] === 'IXE-S1' && it1[col(t.interactions, 'photos')] === interFile.file && it1[col(t.interactions, 'type_name')] === '[survey.interaction.type.flower_visit.name]', 'inter table: its unit’s event, its photo by file, a built-in name in the app’s words');
  const own = t.interactions.rows.find((r) => r[col(t.interactions, 'type_code')] === '1');
  ok(own[col(t.interactions, 'relationship')] === 'lays eggs on' && own[col(t.interactions, 'relationship_iri')] === 'http://example.org/oviposits' && own[col(t.interactions, 'notes')] === '葉背', 'inter table: an own type by its English name and IRI');
  ok(t.interactions.rows.find((r) => r[col(t.interactions, 'type_code')] === 'mutualism')[col(t.interactions, 'both_ways')] === '1', 'inter table: both ways marked');
  const types = Object.fromEntries(t.interactionTypes.rows.map((r) => [r[0], r]));
  ok(types.feeding[col(t.interactionTypes, 'offered')] === '0' && types.flower_visit[col(t.interactionTypes, 'offered')] === '1' && types['1'][col(t.interactionTypes, 'reads_from_object')] === '被產卵', 'inter types: every built-in (offered or not) and the own, with how they read from B');
  const t3 = fd.occurrences.find((o) => o.taxon_id === 't3').uuid;
  ok(rowOf(t.occurrences, t3)[col(t.occurrences, 'interaction_partner')] === '1' && rowOf(t.occurrences, live.occurrences[0].uuid)[col(t.occurrences, 'interaction_partner')] === '', 'inter table: the other-side occurrence marked in the occurrence table');
  // community tables and the project's matrices leave it out
  const comm2 = x.surveyCommunityTables(fd, { eventId: 'IXE', names });
  const pres = comm2.tables.find((tb) => tb.name === 'presence').table;
  ok(pres.header.includes('Alpha one') && !pres.header.includes('Gamma three'), `inter community: the other-side species is in no community table (${pres.header})`);
  const pm2 = x.projectSurveyMatrices([{ doc: fd, eventId: 'IXE' }], names);
  ok(pm2.tables.every((tb) => !tb.table.header.includes('Gamma three')) && pm2.left.length === 0, 'inter project: nor in the project’s matrices, nor does it make the scale mixed');
  // a species × species table per type
  const wide = Object.fromEntries(x.surveyInteractionTables(fd, { names }).map((tb) => [tb.name, tb.table]));
  ok(Object.keys(wide).sort().join() === 'interactions_1,interactions_flower_visit,interactions_mutualism', `inter wide: one per type used (${Object.keys(wide)})`);
  const fv = wide.interactions_flower_visit;
  ok(fv.header.join() === 'subject,Beta two subsp. b' && fv.rows.join() === 'Alpha one,4', `inter wide: rows the one doing it, the times added (3 + an uncounted one) (${JSON.stringify(fv)})`);
  ok(wide.interactions_1.rows[0][wide.interactions_1.header.indexOf('Gamma three')] === '1', 'inter wide: the other-side species is a column here');
  // a survey without an Interaction component: no interaction tables
  const plain = x.surveyTables(fileDoc, { eventId: 'E', names, words });
  ok(plain.interactions === null && plain.interactionTypes === null && x.surveyInteractionTables(fileDoc, { names }).length === 0, 'inter: none without an Interaction component');
}

if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-export: the file round-trips with its media, eventIDs, tables and community tables hold');
