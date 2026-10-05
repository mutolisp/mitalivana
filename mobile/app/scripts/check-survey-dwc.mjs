/**
 * Darwin Core rows of a tree census and of a checklist / plot-style survey
 * (src/survey/export/surveyDwcCore.ts, Phase 2E-b), on the real migrated
 * schema, zipped by the archive writer (lib/dwcArchive.ts).
 *
 * What must hold:
 *   - a census: an event per census with the permanent plot as locationID
 *     and its centre when the plot has an origin; a child event per quadrat
 *     holding trees; an occurrence per tree handled in that census only
 *     (a tree left untouched has none), organismID its uuid, occurrenceID
 *     tree + census, vitality alive / dead / uncertain (DN, NF) with the
 *     reason in English beside the Chinese; a stem's measurements only for
 *     stems handled, each with its tag, date and recorder; AMS, the template's
 *     traits and code lists named in English when the template gives it;
 *   - a survey: an event, a child per unit under its parent; occurrences
 *     with their components' DwC terms (organismQuantity, sex, lifeStage …,
 *     occurrenceRemarks for an occurrence's comment); the other values as
 *     measurements on the occurrence or the event (frequency as %, a layer's
 *     cover per layer, a choice by its code's name); a previous species not
 *     found on the recheck as an absence; Humboldt says what is reported;
 *   - every id is unique, every measurement names an occurrence that exists
 *     or sits on an existing event, and the zipped archive's txt files have
 *     the columns meta.xml declares.
 *
 * Run: npm run check:survey-dwc
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { runUserMigrations } from '../src/db/migrations.ts';
import { buildDwcArchive, EVENT_COLS, MEASUREMENT_COLS, OCCURRENCE_COLS, HUMBOLDT_COLS, RELATIONSHIP_COLS, linkMeasurements } from '../src/lib/dwcArchive.ts';
import * as ix from '../src/survey/db/interactionCore.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as c from '../src/survey/db/surveyCore.ts';
import * as d from '../src/survey/db/surveyDocCore.ts';
import { buildCensusExport } from '../src/survey/db/censusExportCore.ts';
import { censusDwcRows, surveyDwcRows, REMARKS } from '../src/survey/export/surveyDwcCore.ts';
import { censusEventIds } from '../src/survey/stemmap/censusTables.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';
import { withRequired } from '../src/survey/template/validate.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
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
let clock = Date.UTC(2026, 9, 3, 1, 0, 0);
let n = 0;
const ctx = { db, now: () => (clock += 60_000), uuid: () => `u-${++n}` };
const words = { i18n: (k) => `[${k}]` };
const taxonCols = (t) => ({ taxonID: t.taxon_id, scientificName: t.used_scientific_name || `Name ${t.taxon_id}` });
const unique = () => {
  const used = new Set();
  return (base) => {
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
    used.add(id);
    return id;
  };
};
const checkLinks = (parts, label) => {
  const events = new Set(parts.events.map((e) => e.eventID));
  const occs = new Set(parts.occurrences.map((o) => o.occurrenceID));
  ok(events.size === parts.events.length, `${label}: eventIDs unique`);
  ok(occs.size === parts.occurrences.length, `${label}: occurrenceIDs unique`);
  ok(new Set(parts.measurements.map((m) => m.measurementID)).size === parts.measurements.length, `${label}: measurementIDs unique`);
  ok(parts.events.every((e) => !e.parentEventID || events.has(e.parentEventID)), `${label}: every parentEventID exists`);
  ok(parts.occurrences.every((o) => events.has(o.coreEventID)), `${label}: every occurrence sits on an event`);
  ok(parts.measurements.every((m) => (m.occurrenceID ? occs.has(m.occurrenceID) : events.has(m.coreEventID))), `${label}: every measurement names an occurrence or an event`);
};

// ── a tree census ─────────────────────────────────────────────────────────
const tpl = {
  ...STEMMAP_TEMPLATE,
  id: 'user:census-dwc',
  origin: 'user',
  name: { text: '每木＋' },
  description: undefined,
  builtin_key: undefined,
  builtin_version: undefined,
  components: [
    ...STEMMAP_TEMPLATE.components.map((x) => (x.type === 'health' ? { ...x, params: { codesets: ['forestgeo-census-1998', 'forestgeo-ams-2021', 'list_1'] } } : x)),
    { key: 'traits', type: 'traits', level: 'individual', required: false, params: { traits: [{ id: 'crown', label: { text: '冠幅', tr: { en: 'Crown width' } }, unit: 'm' }, { id: 'bark', label: { text: '樹皮厚' }, unit: 'mm' }] } },
  ],
  codelists: [{ id: 'list_1', label: { text: '損傷', tr: { en: 'Damage' } }, items: [{ code: '1', label: { text: '蟲害', tr: { en: 'Insect' } } }, { code: '2', label: { text: '折枝' } }] }],
};
const F = s.createFrame(ctx, { code: 'DW1', name: 'dwc plot', sizeXM: 40, sizeYM: 40, originLat: 24, originLng: 121, originAccuracyM: 3 });
const C1 = s.startCensus(ctx, { frameId: F, template: tpl, investigators: '甲' });
const sd = (over) => ({ stemNo: null, dbhCm: null, pomM: 1.3, stemDead: false, codes: [], notes: null, ...over });
const draft = (over) => ({ individualId: null, tag: null, taxon: { taxonId: 't1', usedScientificName: null }, location: { method: 'xy', x: 5, y: 5 }, notes: null, heightM: null, treeCodes: [], mainStemNo: 1, stems: [sd({ dbhCm: 10 })], recordedBy: 'A', ...over });
const alive = s.saveTreeDraft(ctx, C1, draft({ heightM: 12, stems: [sd({ dbhCm: 22, ams: { survival_status: 'A', mode: ['B', 'U'] }, custom: { list_1: ['1', '2'] } }), sd({ dbhCm: 3 })], traits: { traits: { crown: 4.5, bark: 7 } } }));
const two = s.saveTreeDraft(ctx, C1, draft({ location: { method: 'xy', x: 25, y: 5 }, taxon: { taxonId: 't2', usedScientificName: null } }));
const three = s.saveTreeDraft(ctx, C1, draft({ location: { method: 'xy', x: 6, y: 25 }, taxon: { taxonId: 't3', usedScientificName: null }, stems: [sd({ dbhCm: 8, ams: { survival_status: 'NF' } })] }));
const untouched = s.saveTreeDraft(ctx, C1, draft({ location: { method: 'xy', x: 35, y: 35 }, taxon: { taxonId: 't4', usedScientificName: null }, stems: [sd({ dbhCm: 4 })] }));
s.finishCensus(ctx, C1);
const C2 = s.startCensus(ctx, { frameId: F, template: tpl, investigators: '乙' });
const view = (id) => s.loadTree(ctx, C2, id);
const again = (id, patch) => s.saveTreeDraft(ctx, C2, { ...draft({}), individualId: id, taxon: null, location: null, stems: view(id).stems.map((x) => sd({ stemNo: x.stem.stem_no, dbhCm: null, pomM: x.previous?.pom_m ?? 1.3 })), ...patch });
again(alive, { stems: [sd({ stemNo: 1, dbhCm: 23 }), sd({ stemNo: 2, dbhCm: null })] });
again(two, { treeCodes: ['DS'], stems: [sd({ stemNo: 1 })] });
again(three, { treeCodes: ['DN'], stems: [sd({ stemNo: 1 })] });
// `untouched` is not handled in census 2.
s.finishCensus(ctx, C2);
const doc = buildCensusExport(ctx, C2);
const parts = censusDwcRows(doc, { eventIds: censusEventIds(doc), uniqueEventId: unique(), taxonCols, words });
checkLinks(parts, 'census');
const frameUuid = s.getFrame(ctx, F).uuid;
const cEvents = parts.events.filter((e) => !e.parentEventID);
ok(cEvents.length === 2 && cEvents.every((e) => e.locationID === frameUuid && e.sampleSizeValue === 1600 && /\//.test(e.eventDate)), `census: an event per census on the plot (${cEvents.map((e) => e.eventID)})`);
ok(cEvents[0].eventID === 'DW1' && cEvents[0].decimalLatitude > 24 && cEvents[0].coordinateUncertaintyInMeters >= 29 && cEvents[0].geodeticDatum, `census: the plot's centre and reach (${cEvents[0].decimalLatitude} ±${cEvents[0].coordinateUncertaintyInMeters})`);
ok(/ForestGEO tree census; ForestGEO tree mortality and damage \(AMS\)/.test(cEvents[0].samplingProtocol), 'census: the protocol says AMS when the template has it');
const qEvents = parts.events.filter((e) => e.parentEventID);
ok(qEvents.every((e) => e.sampleSizeValue === 400 && e.decimalLatitude != null) && qEvents.some((e) => e.eventID === 'DW1-0000'), `census: quadrats as child events (${qEvents.map((e) => e.eventID)})`);
const occ = (tree, no) => parts.occurrences.find((o) => o.organismID === s.getIndividual(ctx, tree).uuid && o.occurrenceID.endsWith(`:${no}`));
ok(occ(untouched, 1) && !occ(untouched, 2), 'census: a tree left untouched has no occurrence that census');
ok(occ(alive, 1).vitality === 'alive' && occ(two, 2).vitality === 'dead' && occ(three, 2).vitality === 'uncertain', 'census: vitality alive / dead / uncertain (DN)');
ok(occ(three, 1).vitality === 'uncertain' && occ(three, 1).occurrenceRemarks.includes('(AMS survival NF'), 'census: AMS NF on every stem is uncertain, said in English too');
ok(occ(three, 2).occurrenceRemarks === REMARKS.presumedDead && /\(census code DN/.test(REMARKS.presumedDead), 'census: DN said, with English beside');
ok(occ(alive, 1).occurrenceStatus === 'present' && occ(alive, 1).individualCount === 1 && occ(alive, 1).basisOfRecord === 'HumanObservation', 'census: present, one individual');
ok(occ(alive, 1).coreEventID === 'DW1-0000' && occ(two, 1).coreEventID === 'DW1-0100', 'census: on the quadrat event');
ok(occ(alive, 1).decimalLatitude > 24 && occ(alive, 1).coordinateUncertaintyInMeters === 3, 'census: a tree’s position from the plot origin');
// A plot's later series counts its censuses from 1 again: its IDs are its own (code review M2).
{
  const coded = JSON.parse(JSON.stringify(doc));
  coded.series.series_code = 'b';
  const p2 = censusDwcRows(coded, { eventIds: censusEventIds(coded), uniqueEventId: unique(), taxonCols, words });
  const firstOcc = new Set(parts.occurrences.map((o) => o.occurrenceID));
  const firstM = new Set(parts.measurements.map((m) => m.measurementID));
  ok(
    p2.occurrences.length === parts.occurrences.length && p2.occurrences.every((o) => !firstOcc.has(o.occurrenceID)) && p2.measurements.every((m) => !firstM.has(m.measurementID)),
    `census: a later series' occurrence and measurement IDs differ from the first's (${p2.occurrences[0]?.occurrenceID})`,
  );
  ok(parts.occurrences.every((o) => /^[^:]+:\d+$/.test(o.occurrenceID)), "census: the first series' IDs keep their form (tree uuid:census)");
}
const ms = (o) => parts.measurements.filter((m) => m.occurrenceID === o.occurrenceID);
const a1 = ms(occ(alive, 1));
const tagA = `${s.getIndividual(ctx, alive).tag}-1`;
const dbh = a1.find((m) => m.measurementType === 'DBH' && m.measurementRemarks === tagA);
ok(dbh && dbh.measurementValue === '22' && dbh.measurementUnit === 'cm' && dbh.measurementDeterminedBy === 'A' && /^\d{4}-\d\d-\d\dT/.test(dbh.measurementDeterminedDate), `census: DBH with the stem's tag, date, recorder (${JSON.stringify(dbh)})`);
ok(a1.filter((m) => m.measurementType === 'ForestGEO AMS mode').map((m) => m.measurementValue).join('|') === 'B|U', 'census: an AMS list, a row per value');
ok(a1.find((m) => m.measurementType === 'Damage' && m.measurementValue === 'Insect') && a1.find((m) => m.measurementType === 'Damage' && m.measurementValue === '折枝'), 'census: a code list by its English name, codes by theirs (else as named)');
ok(a1.find((m) => m.measurementType === 'Crown width' && m.measurementValue === '4.5' && m.measurementUnit === 'm') && a1.find((m) => m.measurementType === '樹皮厚'), 'census: traits by their English name, else as named');
ok(a1.find((m) => m.measurementType === 'tree height' && m.measurementValue === '12') && a1.find((m) => m.measurementType === 'plot x'), 'census: height and plot position');
const a2 = ms(occ(alive, 2));
ok(a2.some((m) => m.measurementRemarks === tagA) && !a2.some((m) => m.measurementRemarks === `${s.getIndividual(ctx, alive).tag}-2`), 'census: only stems handled in the census have rows');
ok(ms(occ(two, 2)).find((m) => m.measurementType === 'ForestGEO census code' && m.measurementValue === 'DS'), 'census: whole-tree codes');
ok(parts.humboldt.length === 2 && parts.humboldt[0].siteCount === 4 && parts.humboldt[0].isAbundanceReported === true, 'census: Humboldt per census');
// Without an origin: no coordinates anywhere.
s.updateFrame(ctx, F, { originLat: null, originLng: null });
const bare = censusDwcRows(buildCensusExport(ctx, C2), { eventIds: censusEventIds(doc), uniqueEventId: unique(), taxonCols, words });
ok(bare.events.every((e) => e.decimalLatitude == null && e.coordinateUncertaintyInMeters == null) && bare.occurrences.every((o) => o.decimalLatitude == null && o.coordinateUncertaintyInMeters == null && !o.geodeticDatum), 'census: no origin, no coordinates');

// ── a plot-style survey ───────────────────────────────────────────────────
const T = withRequired({
  schema: 1,
  id: 'user:survey-dwc',
  version: 2,
  origin: 'user',
  name: { text: '溪谷樣區', tr: { en: 'Valley plots' } },
  style: 'plot',
  units: [
    { key: 'u1', label: { text: '小區', tr: { en: 'Subplot' } } },
    { key: 'u2', label: { text: '小樣方' } },
  ],
  components: [
    { key: 'layers', type: 'structure', level: 'survey', required: false, params: { layers: 3, methods: ['BB', 'percent'] } },
    { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['elevation_m', 'slope_deg'] } },
    { key: 'where', type: 'location', level: 'unit', unit: 'u1', required: false, params: { methods: ['gps'] } },
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'count'], default: 'BB' } },
    { key: 'pheno', type: 'phenology', level: 'occurrence', required: false, params: { fields: ['sex', 'life_stage', 'reproductive_condition', 'leaf_phenology'] } },
    { key: 'freq', type: 'frequency', level: 'occurrence', required: false, params: { mode: 'cells', n: 2, top_edge: 'N' } },
    { key: 'micro', type: 'choice', level: 'occurrence', required: false, params: { list: 'list_1', multi: true } },
    { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'len', label: { text: '葉長', tr: { en: 'Leaf length' } }, unit: 'cm' }] } },
    { key: 'onote', type: 'comments', level: 'occurrence', required: true, params: {} },
  ],
  codelists: [{ id: 'list_1', label: { text: '微棲地', tr: { en: 'Microhabitat' } }, items: [{ code: 'rock', label: { text: '岩石', tr: { en: 'Rock' } } }, { code: 'log', label: { text: '倒木' } }] }],
  quick_add: false,
});
const PF = s.createFrame(ctx, { code: 'VP1', sizeXM: 20, sizeYM: 20 });
const P1 = c.createSurvey(ctx, { template: T, frameId: PF, investigators: '甲' });
const S1 = c.addUnit(ctx, P1, { levelKey: 'u1', code: 'S1' });
c.addOccurrence(ctx, P1, { taxon_id: 't7', unit_id: S1 });
c.addOccurrence(ctx, P1, { taxon_id: 't8', unit_id: S1 });
c.finishSurvey(ctx, P1);
const P2 = c.createSurvey(ctx, { template: T, frameId: PF, investigators: '乙' });
const u = Object.fromEntries(c.listUnits(ctx, P2).map((r) => [r.code, r.id]));
const Q1 = c.addUnit(ctx, P2, { levelKey: 'u2', code: 'Q1', parentId: u.S1 });
c.writeComponent(ctx, { kind: 'survey', id: P2 }, 'layers', { layer_count: 3, cover_pct: { 1: 40, 2: 10 } });
c.writeComponent(ctx, { kind: 'survey', id: P2 }, 'env', { elevation_m: 820, slope_deg: 25 });
c.writeComponent(ctx, { kind: 'unit', id: u.S1 }, 'where', { lat: 24.5, lng: 121.5, accuracy: 6 });
const o1 = c.addOccurrence(ctx, P2, { taxon_id: 't7', unit_id: Q1, organism_quantity: '5', organism_quantity_type: 'individuals' });
c.writeComponent(ctx, { kind: 'occurrence', id: o1 }, 'pheno', { sex: 'female', life_stage: 'adult', reproductive_condition: ['flowering', 'fruiting'], leaf_phenology: ['green'] });
c.writeComponent(ctx, { kind: 'occurrence', id: o1 }, 'freq', { freq_cells: '1010' });
c.writeComponent(ctx, { kind: 'occurrence', id: o1 }, 'micro', { value: ['rock', 'log'] });
c.writeComponent(ctx, { kind: 'occurrence', id: o1 }, 'leaf', { len: 6.2 });
c.writeComponent(ctx, { kind: 'occurrence', id: o1 }, 'onote', { notes: '葉背有毛' });
c.closeBlindPhase(ctx, P2);
const cand = c.recheckState(ctx, P2).candidates;
c.answerRecheck(ctx, P2, cand.find((x) => x.taxonId === 't8'), 'not_found');
c.answerRecheck(ctx, P2, cand.find((x) => x.taxonId === 't7') ?? cand[0], 'found');
const sdoc = d.buildSurveyDoc(ctx, P2);
const sp = surveyDwcRows(sdoc, { eventId: 'VP1_20261003', uniqueEventId: unique(), taxonCols, words });
checkLinks(sp, 'survey');
const ev = sp.events[0];
ok(ev.eventID === 'VP1_20261003' && ev.locationID === s.getFrame(ctx, PF).uuid && ev.minimumElevationInMeters === 820 && ev.recordedBy === '乙', `survey: its event, plot, elevation, recorder (${JSON.stringify(ev)})`);
ok(ev.maximumElevationInMeters === 820, 'survey: one elevation is both the minimum and the maximum');
// A recorded track's altitudes (v88): the event spans them, its own elevation included.
{
  const ranged = { ...sdoc, survey: { ...sdoc.survey, elevation_min_m: 790, elevation_max_m: 905 } };
  const re = surveyDwcRows(ranged, { eventId: 'VP1_20261003', uniqueEventId: unique(), taxonCols, words }).events[0];
  ok(re.minimumElevationInMeters === 790 && re.maximumElevationInMeters === 905, `survey: a track's range of altitudes (${re.minimumElevationInMeters}–${re.maximumElevationInMeters})`);
  const low = surveyDwcRows({ ...sdoc, survey: { ...sdoc.survey, elevation_min_m: 850, elevation_max_m: 870 } }, { eventId: 'VP1_20261003', uniqueEventId: unique(), taxonCols, words }).events[0];
  ok(low.minimumElevationInMeters === 820 && low.maximumElevationInMeters === 870, `survey: the survey's own elevation stays inside the range (${low.minimumElevationInMeters}–${low.maximumElevationInMeters})`);
  // A document from before v88 keeps the survey's elevation among the environment values.
  const old = { ...sdoc, survey: { ...sdoc.survey, elevation_m: undefined }, survey_values: [...sdoc.survey_values, { uuid: 'x', component: 'env', field: 'elevation_m', idx: 0, value_num: 700, value_text: null, unit: 'm' }] };
  const oe = surveyDwcRows(old, { eventId: 'VP1_20261003', uniqueEventId: unique(), taxonCols, words }).events[0];
  ok(oe.minimumElevationInMeters === 700, `survey: an older document's environment elevation (${oe.minimumElevationInMeters})`);
}
ok(/^Valley plots \(Mitalivana survey template user:survey-dwc v2\)$/.test(ev.samplingProtocol), `survey: the protocol is the template, English name first (${ev.samplingProtocol})`);
const uS1 = sp.events.find((e) => e.eventID === 'VP1_20261003-S1');
const uQ1 = sp.events.find((e) => e.eventID === 'VP1_20261003-S1-Q1');
ok(uS1?.parentEventID === ev.eventID && uQ1?.parentEventID === uS1.eventID && uS1.decimalLatitude === '24.5', `survey: units as children of their parents, with their location (${JSON.stringify(uS1)})`);
const oc = sp.occurrences.find((x) => x.occurrenceID === sdoc.occurrences.find((y) => y.organism_quantity === '5').uuid);
ok(oc.coreEventID === uQ1.eventID && oc.organismQuantity === '5' && oc.organismQuantityType === 'individuals' && oc.individualCount === '5', `survey: abundance terms (${JSON.stringify(oc)})`);
ok(oc.sex === 'female' && oc.reproductiveCondition === 'flowering|fruiting' && oc.lifeStage === 'adult' && oc.occurrenceRemarks === '葉背有毛' && !oc.eventRemarks, 'survey: phenology terms; an occurrence’s comment is occurrenceRemarks');
const om = sp.measurements.filter((m) => m.occurrenceID === oc.occurrenceID);
ok(om.find((m) => m.measurementType === 'frequency' && m.measurementValue === '50' && m.measurementUnit === '%'), `survey: frequency as % (${JSON.stringify(om.filter((m) => m.measurementType === 'frequency'))})`);
ok(om.filter((m) => m.measurementType === 'Microhabitat').map((m) => m.measurementValue).join() === 'Rock,倒木', 'survey: a choice by its list’s English name, a row per code by its name');
ok(om.find((m) => m.measurementType === 'Leaf length' && m.measurementUnit === 'cm') && om.find((m) => m.measurementType === 'leafPhenology' && m.measurementValue === 'green'), 'survey: traits and leaf phenology on the occurrence');
const em = sp.measurements.filter((m) => !m.occurrenceID);
ok(em.filter((m) => m.measurementType === 'layer cover').map((m) => `${m.measurementRemarks}=${m.measurementValue}`).join() === 'E1=40,E2=10' && em.every((m) => m.coreEventID === ev.eventID), 'survey: a layer’s cover per layer, on the event');
ok(em.find((m) => m.measurementType === 'slope' && m.measurementUnit === 'degrees') && !em.some((m) => m.measurementType === 'minimumElevationInMeters'), 'survey: environment on the event (elevation as a term, not a measurement)');
{
  // A unit's 環境 elevation (a value, not a column) on its event (code review M12).
  const withUnitElev = { ...sdoc, unit_values: [...sdoc.unit_values, { uuid: 'ue', unit: 'u1:S1', component: 'uenv', field: 'elevation_m', idx: 0, value_num: 1234, value_text: null }] };
  const ue = surveyDwcRows(withUnitElev, { eventId: 'VP1_20261003', uniqueEventId: unique(), taxonCols, words });
  const eS1 = ue.events.find((e) => e.eventID === 'VP1_20261003-S1');
  const eQ1 = ue.events.find((e) => e.eventID === 'VP1_20261003-S1-Q1');
  ok(
    eS1?.minimumElevationInMeters === 1234 && eS1.maximumElevationInMeters === 1234 && eS1.verticalDatum === 'not recorded' && eQ1?.minimumElevationInMeters === '',
    `unit: its environment elevation on its event, typed in (${eS1?.minimumElevationInMeters}, ${eS1?.verticalDatum}; Q1 ${JSON.stringify(eQ1?.minimumElevationInMeters)})`,
  );
  ok(!ue.measurements.some((m) => m.measurementType === 'minimumElevationInMeters'), 'unit: the elevation as a term, not a measurement');
}
const absent = sp.occurrences.find((x) => x.occurrenceStatus === 'absent');
ok(absent && absent.taxonID === 't8' && absent.coreEventID === uS1.eventID && absent.occurrenceRemarks === REMARKS.absentOnRecheck && /\(recorded in the previous survey/.test(REMARKS.absentOnRecheck), `survey: a species not found on the recheck is an absence where it was looked for (${JSON.stringify(absent)})`);
ok(sp.occurrences.filter((x) => x.occurrenceStatus === 'present').length === sdoc.occurrences.length, 'survey: every occurrence present');
ok(sp.humboldt[0].isAbsenceReported === true && sp.humboldt[0].isAbundanceReported === true && sp.humboldt[0].isVegetationCoverReported === true && sp.humboldt[0].siteNestingDescription === '1 × Subplot; 1 × 小樣方', `survey: Humboldt says what is reported (${JSON.stringify(sp.humboldt[0])})`);

// ── 調查法 and 開闊度 (2G-f): the event's protocol, size and effort; unit sizes ──
{
  const MT = withRequired({
    schema: 1,
    id: 'user:dwc-method',
    version: 1,
    origin: 'user',
    name: { text: '方法', tr: { en: 'Methods' } },
    style: 'plot',
    units: [
      { key: 'u1', label: { text: '小區' } },
      { key: 'u2', label: { text: '小樣方' } },
    ],
    components: [
      { key: 'method', type: 'method', level: 'survey', required: false, params: { methods: [], fixed: null, custom: true } },
      { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['slope_deg', 'openness'] } },
      { key: 'genv', type: 'environment', level: 'unit', unit: 'u1', required: false, params: { fields: ['openness'], openness_list: 'open' } },
    ],
    codelists: [{ id: 'open', label: { text: '開闊度等級', tr: { en: 'Openness grade' } }, items: [{ code: '1', label: { text: '封閉' } }, { code: '5', label: { text: '開闊' } }] }],
    quick_add: false,
  });
  const M = c.createSurvey(ctx, { template: MT, investigators: '戊' });
  const sub = c.addUnit(ctx, M, { levelKey: 'u1', code: 'S1' });
  c.updateUnit(ctx, sub, { widthM: 10, lengthM: 10 });
  const q1 = c.addUnit(ctx, M, { levelKey: 'u2', code: 'Q1', parentId: sub });
  const q2 = c.addUnit(ctx, M, { levelKey: 'u2', code: 'Q2', parentId: sub });
  c.updateUnit(ctx, q2, { widthM: 2, lengthM: 2 });
  c.writeComponent(ctx, { kind: 'survey', id: M }, 'method', { protocol: 'plot_survey', width_m: 20, length_m: 20, description: '沿等高線', quadrat_w_m: 1, quadrat_l_m: 1 });
  c.writeComponent(ctx, { kind: 'survey', id: M }, 'env', { slope_deg: 10, openness_pct: 35 });
  c.writeComponent(ctx, { kind: 'unit', id: sub }, 'genv', { openness_grade: '5' });
  const run = (doc) => surveyDwcRows(doc, { eventId: 'M1', uniqueEventId: unique(), taxonCols, words });
  const mdoc = d.buildSurveyDoc(ctx, M);
  const mp = run(mdoc);
  const me = mp.events[0];
  ok(me.samplingProtocol === 'plot survey' && me.sampleSizeValue === 400 && me.sampleSizeUnit === 'm²' && !me.samplingEffort, `method: the protocol is the method's English name, its area the sample size (${JSON.stringify(me)})`);
  ok(mp.humboldt[0].protocolNames === 'plot survey' && /^沿等高線; Methods \(Mitalivana survey template user:dwc-method v1\)$/.test(mp.humboldt[0].protocolDescriptions), `method: Humboldt names it and describes it, with the template (${mp.humboldt[0].protocolDescriptions})`);
  const size = (code) => mp.events.find((e) => e.eventID.endsWith(`-${code}`))?.sampleSizeValue;
  ok(size('S1') === 100 && size('S1-Q1') === 1 && size('S1-Q2') === 4, `method: a unit's own size, else (a quadrat) the method's shared one (${size('S1')}, ${size('S1-Q1')}, ${size('S1-Q2')})`);
  const om = mp.measurements.filter((m) => m.measurementType === 'sky openness');
  ok(om.some((m) => m.measurementValue === '35' && m.measurementUnit === '%' && m.coreEventID === me.eventID) && om.some((m) => m.measurementValue === '5' && !m.measurementUnit), `openness: a percentage on the survey, a grade on the subplot (${JSON.stringify(om)})`);
  // Other methods: an effort with its unit; one's own name and a duration; the one the template fixes.
  const withValues = (vals, params = MT.components[0].params) => {
    const comp = { ...MT.components[0], params };
    const tpl = { ...MT, components: [comp, ...MT.components.slice(1)] };
    const values = Object.entries(vals).map(([field, v]) => ({ uuid: `m-${field}`, component: 'method', field, idx: 0, value_num: typeof v === 'number' ? v : null, value_text: typeof v === 'string' ? v : null, unit: null }));
    return run({ ...mdoc, survey: { ...mdoc.survey, template_snapshot: JSON.stringify(tpl) }, survey_values: values }).events[0];
  };
  const cam = withValues({ protocol: 'camera_trap', effort_value: 1000, effort_unit: 'camera-hours' });
  ok(cam.samplingProtocol === 'camera trap' && cam.samplingEffort === '1000 camera-hours' && cam.sampleSizeValue == null, `method: an effort with its unit (${JSON.stringify(cam)})`);
  const own = withValues({ protocol: 'custom', protocol_name: '手撈網', size_value: 30, size_unit: 'min' });
  ok(own.samplingProtocol === '手撈網' && own.sampleSizeValue === 30 && own.sampleSizeUnit === 'min', `method: one's own, with a duration (${JSON.stringify(own)})`);
  const fixed = withValues({}, { methods: [], fixed: 'point_count', custom: false });
  ok(fixed.samplingProtocol === 'point count', `method: the one the template fixes when none was recorded (${fixed.samplingProtocol})`);
  const none = withValues({});
  ok(/^Methods \(Mitalivana survey template/.test(none.samplingProtocol) && none.sampleSizeValue == null, `method: nothing recorded, the template is the protocol as before (${none.samplingProtocol})`);
}

// ── interactions as ResourceRelationship (2F-b) ───────────────────────────
const IX = withRequired({
  schema: 1,
  id: 'user:dwc-inter',
  version: 1,
  origin: 'user',
  name: { text: '交互', tr: { en: 'Interactions' } },
  style: 'plot',
  units: [{ key: 'u1', label: { text: '小區' } }],
  components: [
    { key: 'inter', type: 'interaction', level: 'occurrence', required: false, params: { builtin: ['flower_visit', 'mutualism'], list: 'list_1', count: true, photos: 0 } },
    { key: 'onote', type: 'comments', level: 'occurrence', required: true, params: {} },
  ],
  codelists: [{ id: 'list_1', label: { text: '自訂' }, items: [{ code: '1', label: { text: '產卵於' } }] }],
  quick_add: false,
});
const IF = s.createFrame(ctx, { code: 'RR1', sizeXM: 20, sizeYM: 20 });
const IP = c.createSurvey(ctx, { template: IX, frameId: IF, investigators: '丙' });
const IU = c.addUnit(ctx, IP, { levelKey: 'u1', code: 'S1' });
const ia = c.addOccurrence(ctx, IP, { taxon_id: 't7', unit_id: IU });
const ib = c.addOccurrence(ctx, IP, { taxon_id: 't8', unit_id: IU });
const r1 = ix.addInteraction(ctx, { from: ia, partner: { occurrenceId: ib }, type: 'flower_visit', direction: 'forward', count: 3, notes: '清晨', recordedBy: '丁' });
const r2 = ix.addInteraction(ctx, { from: ia, partner: { occurrenceId: ib }, type: 'mutualism', direction: 'mutual' });
const r3 = ix.addInteraction(ctx, { from: ib, partner: { taxonId: 't9' }, type: '1', direction: 'backward' });
const idoc = d.buildSurveyDoc(ctx, IP);
const ip = surveyDwcRows(idoc, { eventId: 'RR1', uniqueEventId: unique(), taxonCols, words });
checkLinks(ip, 'interactions');
const ruuid = (id) => sqlite.prepare('SELECT uuid FROM fw_interactions WHERE id = ?').get(id).uuid;
const ouuid = (id) => sqlite.prepare('SELECT uuid FROM fw_occurrences WHERE id = ?').get(id).uuid;
const rr = (id) => ip.relationships.find((x) => x.resourceRelationshipID === id);
const x1 = rr(ruuid(r1));
ok(x1 && x1.resourceID === ouuid(ia) && x1.relatedResourceID === ouuid(ib) && x1.relationshipOfResource === 'visits flowers of' && x1.relationshipOfResourceID === 'http://purl.obolibrary.org/obo/RO_0002622', `rr: the one doing it, the other, the relation and its RO IRI (${JSON.stringify(x1)})`);
ok(x1.coreEventID === 'RR1-S1' && x1.relationshipAccordingTo === '丁' && /^\d{4}-\d\d-\d\dT/.test(x1.relationshipEstablishedDate) && x1.relationshipRemarks === '次數 3(count 3); 清晨', `rr: on its unit's event, by its recorder, dated, the count in both languages before the note (${x1.relationshipRemarks})`);
const back = rr(`${ruuid(r2)}:reverse`);
ok(rr(ruuid(r2))?.resourceID === ouuid(ia) && back?.resourceID === ouuid(ib) && back.relatedResourceID === ouuid(ia), 'rr: both ways written both ways');
const x3 = rr(ruuid(r3));
const t9 = sqlite.prepare("SELECT uuid FROM fw_occurrences WHERE taxon_id = 't9'").get().uuid;
ok(x3.resourceID === t9 && x3.relatedResourceID === ouuid(ib) && x3.relationshipOfResource === '產卵於' && x3.relationshipOfResourceID === '' && x3.relationshipAccordingTo === '丙', 'rr: an own type by its name (no English, no IRI); the survey’s investigators when no recorder');
ok(ip.relationships.every((x) => ip.occurrences.some((o) => o.occurrenceID === x.resourceID) && ip.occurrences.some((o) => o.occurrenceID === x.relatedResourceID)), 'rr: both sides of every relationship are occurrences of the archive');
const p9 = ip.occurrences.find((o) => o.occurrenceID === t9);
ok(p9.occurrenceStatus === 'present' && p9.occurrenceRemarks === REMARKS.interactionPartner && /\(recorded only as the other side of an interaction/.test(REMARKS.interactionPartner), 'rr: the other-side occurrence is present, said so in both languages');
ok(ip.occurrences.filter((o) => o.occurrenceRemarks === REMARKS.interactionPartner).length === 1, 'rr: only that one');
ok(censusDwcRows(doc, { eventIds: censusEventIds(doc), uniqueEventId: unique(), taxonCols, words }).relationships.length === 0, 'rr: a census has none');

// ── the archive ───────────────────────────────────────────────────────────
{
  const all = {
    events: [...parts.events, ...sp.events, ...ip.events],
    occurrences: [...parts.occurrences, ...sp.occurrences, ...ip.occurrences],
    humboldt: [...parts.humboldt, ...sp.humboldt, ...ip.humboldt],
    measurements: [...parts.measurements, ...sp.measurements, ...ip.measurements],
    relationships: ip.relationships,
  };
  linkMeasurements(all.occurrences, all.measurements);
  ok(all.measurements.every((m) => m.coreEventID), 'archive: every measurement has its core event');
  const files = unzipSync(buildDwcArchive({ meta: { title: 't', abstract: '', creator: '', pubDate: '2026-10-03', packageId: 'p' }, ...all }));
  const header = (name) => strFromU8(files[name]).split('\n')[0].split('\t');
  ok(header('event.txt').join() === EVENT_COLS.map((x) => x.key).join(), 'archive: event.txt has the declared columns');
  ok(header('occurrence.txt').join() === ['coreEventID', ...OCCURRENCE_COLS.map((x) => x.key)].join(), 'archive: occurrence.txt has the declared columns');
  ok(header('measurementorfact.txt').join() === ['coreEventID', ...MEASUREMENT_COLS.map((x) => x.key)].join() && header('humboldt.txt').length === HUMBOLDT_COLS.length + 1, 'archive: the extensions too');
  const rrTxt = strFromU8(files['resourcerelationship.txt']).split('\n');
  ok(rrTxt[0] === ['coreEventID', ...RELATIONSHIP_COLS.map((x) => x.key)].join('\t') && rrTxt.length - 1 === all.relationships.length, 'archive: resourcerelationship.txt, a line per relationship');
  ok(strFromU8(files['meta.xml']).includes('rowType="http://rs.tdwg.org/dwc/terms/ResourceRelationship"'), 'archive: meta.xml declares it');
  const occTxt = strFromU8(files['occurrence.txt']).split('\n');
  ok(occTxt.length - 1 === all.occurrences.length && occTxt.slice(1).every((l) => l.split('\t').length === OCCURRENCE_COLS.length + 1), 'archive: a line per occurrence, no tab broken');
  const vitIdx = OCCURRENCE_COLS.findIndex((x) => x.key === 'vitality') + 1;
  ok(new Set(occTxt.slice(1).map((l) => l.split('\t')[vitIdx]).filter(Boolean)).size === 3, 'archive: vitality written');
}

// ── the rows into the archive ─────────────────────────────────────────────
// A 20 000-tree census has hundreds of thousands of measurements: spread as
// arguments (push(...rows)) they overflow Hermes's stack ("Maximum call stack
// size exceeded", seen on the emulator 2026-10-03). dwcRows.ts runs on the
// app's connection, so its source is checked.
{
  const src = readFileSync(new URL('../src/lib/dwcRows.ts', import.meta.url), 'utf8');
  const spread = src.match(/\.push\(\.\.\.(?:p|parts?)\.\w+\)/g) ?? [];
  ok(spread.length === 0, `dwcRows: a census's rows are not spread into push (${spread.join(', ')})`);
}
// The zip entries likewise: one per photo, so a census's photos (code review V2).
for (const f of ['../src/lib/bundleExport.ts', '../src/lib/projectExport.ts']) {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8');
  const spread = src.match(/\b\w*[eE]ntries\.push\(\.\.\.[^)]*\)/g) ?? [];
  ok(spread.length === 0, `${f.split('/').pop()}: zip entries are not spread into push (${spread.join(', ')})`);
}
// Every coordinate written carries its datum (locationTerms; §19): the quadrat events had none (code review L13).
for (const f of ['../src/lib/dwcRows.ts', '../src/survey/export/surveyDwcCore.ts']) {
  const lines = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n');
  const bare = lines.flatMap((l, i) => (/decimalLatitude:/.test(l) && !lines.slice(i, i + 9).some((x) => /locationTerms\(|\.\.\.elevationTerms/.test(x)) ? [`${f.split('/').pop()}:${i + 1}`] : []));
  ok(bare.length === 0, `datum: each decimalLatitude has locationTerms with it (${bare.join(', ') || f.split('/').pop()})`);
}

if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ survey-dwc: censuses and surveys become events, occurrences and measurements that link up');
