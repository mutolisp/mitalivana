/**
 * Export → import round-trip check for checklist / plot-survey ymls.
 *
 * The app has no test runner, and the one failure this feature must never have
 * is silent: a field gets added to a record, the exporter writes it, and the
 * importer quietly drops it (or the reverse). So this drives the two halves
 * against each other, with no device involved:
 *
 *     DB-shaped fixture → buildPlotYamlDoc → yaml.dump → parsePlotYaml → compare
 *
 * It also asserts COVERAGE against the REAL schema: `schema-columns.mjs` runs
 * the migrations in memory, and every column that comes out must either appear
 * in the yml or be listed in NOT_RESTORABLE below with a reason.
 *
 * Coverage used to be driven by the hand-written fixtures instead, which meant
 * a column the fixture never mentioned was invisible to it — `starred`,
 * `audio_paths` and the four `inat_*` columns were all added to the tables and
 * never noticed. The whitelist was also one flat key set shared by every
 * table, so a reason written for `sessions.notes` silently excused
 * `collection_trips.notes`, which really was missing.
 *
 * Run: npm run check:roundtrip
 */
import { locationTerms, sourceFromVerticalDatum } from '../src/lib/dwcLocation.ts';
import yaml from 'js-yaml';
import { strToU8, zipSync } from 'fflate';
import {
  buildCollectionYamlDoc,
  buildPlotYamlDoc,
  buildSessionYamlDoc,
  recordToYamlItem,
  specimenToYamlItem,
} from '../src/lib/bundleYaml.ts';
import { convertToDwc } from '../src/lib/dwcMapper.ts';
import { establishmentDwcValue } from '../src/lib/dwcMultiValue.ts';
import { collectionFromDoc, parseCollectionYaml } from '../src/lib/collectionImport.ts';
import { parsePlotYaml } from '../src/lib/plotImport.ts';
import { parseSessionYaml } from '../src/lib/sessionImport.ts';
import { schemaColumns } from './schema-columns.mjs';
import { buildGloriaDoc, validateGloriaDoc } from '../src/modules/gloria/export/yaml.ts';
import {
  readRecordImportFromBytes,
  readRecordYamlTextFromBytes,
  safeMediaBasename,
} from '../src/lib/recordImportZip.ts';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};

// ── Columns that deliberately do not round-trip ───────────────────────────
// Keyed by table: a reason is an assertion about ONE column of ONE table, and
// sharing one flat set between tables is how `collection_trips.notes` hid
// behind the reason written for `sessions.notes`.
const ROW_ID = 'device-local row id';
const IMPORT_TIME = 'set to import time';
const STARRED = 'device-local organisation (v34), deliberately not exported';
const INAT = {
  inat_observation_id: 'iNat upload bookkeeping (v30)',
  inat_media_done: 'iNat upload bookkeeping (v30)',
  inat_uploaded_at: 'iNat upload bookkeeping (v30)',
  inat_sync_hash: 'iNat sync fingerprint (v31)',
};
const NAME_USAGE = {
  used_scientific_name: 'IS the exported scientificName; recovered from it on import',
};

/** Columns restored from a DIFFERENT yml key rather than one of their own:
 *  the altitude's source travels as the DwC verticalDatum it implies
 *  (dwcLocation.ts), so the occurrence CSV carries no app-only column. */
const RESTORED_VIA = {
  checklist_records: { elevation_source: 'vertical_datum' },
  collection_specimens: { elevation_source: 'vertical_datum' },
};

const GLORIA_SUMMIT = 'exported as the survey\'s `summit:` block; the summit row is upserted by full_code';
const NOT_RESTORABLE = {
  gloria_summits: {
    id: ROW_ID,
    created_at: IMPORT_TIME,
    updated_at: IMPORT_TIME,
  },
  gloria_surveys: {
    id: ROW_ID,
    summit_id: GLORIA_SUMMIT,
    status: "imported records are always 'done' (single-active invariant)",
    prev_survey_id: 're-linked on import from the summit\'s other surveys by mocy',
    project_id: 'exported by name (`project_name`), re-resolved on import',
    site_id: 'not exported yet — GLORIA surveys have no site sidecar',
    grid_ok_n: 'exported inside `grid_ok` {N,E,S,W}',
    grid_ok_e: 'exported inside `grid_ok` {N,E,S,W}',
    grid_ok_s: 'exported inside `grid_ok` {N,E,S,W}',
    grid_ok_w: 'exported inside `grid_ok` {N,E,S,W}',
    starred: STARRED,
  },
  gloria_points: {
    id: ROW_ID,
    survey_id: 'structural — points live inside their survey in the yml',
  },
  gloria_units: {
    id: ROW_ID,
    survey_id: 'structural — units live inside their survey in the yml',
  },
  gloria_taxa: {
    id: ROW_ID,
    survey_id: 'structural — the roster lives inside its survey in the yml',
  },
  gloria_unit_species: {
    id: ROW_ID,
    unit_id: 'exported as the unit CODE (`unit`), ids are per-device',
    gloria_taxon_id: 'exported as the roster SERIAL (`serial`)',
  },
  sessions: {
    id: ROW_ID,
    project_id: 'exported by name (`project`), re-resolved on import',
    site_id: 'exported as the `site:` block + site.* sidecars',
    resumed_at: 'reopen bookkeeping, meaningless for a fresh import',
    starred: STARRED,
    uuid: 'exported as event.eventUUID',
    name: 'exported as event.eventID',
    type: 'exported as event.eventType',
    started_at: 'exported as event.startedAt (ISO)',
    ended_at: 'exported as event.endedAt (ISO)',
    gps_mode: 'exported as event.gpsMode',
    start_lat: 'exported as event.decimalLatitude',
    start_lng: 'exported as event.decimalLongitude',
    track_geojson: 'exported as event.trackGeoJSON',
    notes: 'exported as event.eventRemarks',
    recorded_by: 'exported as event.recordedBy',
  },
  checklist_records: {
    id: ROW_ID,
    session_id: 'structural — the record lives inside its session in the yml',
    observed_at: 'exported as eventDate (ISO)',
    photo_paths: 'exported as photo_files / associatedMedia (filenames in the zip)',
    audio_paths: 'exported as audio_files (filenames in the zip audio/)',
    updated_at: IMPORT_TIME,
    ...NAME_USAGE,
    ...INAT,
  },
  plot_surveys: {
    id: ROW_ID,
    project_id: 'exported by name (`project`), re-resolved on import',
    site_id: 'exported as the `site:` block + site.* sidecars',
    status: "imported records are always 'done' (single-active invariant)",
    resumed_at: 'reopen bookkeeping, meaningless for a fresh import',
    starred: STARRED,
    created_at: IMPORT_TIME,
    updated_at: IMPORT_TIME,
    env_photos_json: 'exported as `env_photo_files` (filenames, not device URIs)',
    // The pre-v12 per-layer columns were dropped in v42; the guard's own
    // stale-entry check is what said so.
  },
  plot_species_records: {
    id: ROW_ID,
    plot_survey_id: 'structural — the record lives inside its plot in the yml',
    subplot_id: 'exported as the subplot LABEL (ids are per-device)',
    photo_paths: 'exported as photo_files (filenames in the zip)',
    audio_paths: 'exported as audio_files (filenames in the zip audio/)',
    created_at: IMPORT_TIME,
    updated_at: IMPORT_TIME,
    bb_value: 'legacy pre-v9 abundance, superseded by organism_quantity',
    percent: 'legacy pre-v9 abundance',
    dbh_values_json: 'legacy pre-v9 abundance',
    ...NAME_USAGE,
    ...INAT,
  },
  plot_survey_layers: {
    id: ROW_ID,
    plot_survey_id: 'structural — layers live inside their plot in the yml',
  },
  plot_subplots: {
    id: ROW_ID,
    plot_survey_id: 'structural — subplots live inside their plot in the yml',
    created_at: IMPORT_TIME,
  },
  subplot_layers: {
    id: ROW_ID,
    subplot_id: 'structural — nested inside its subplot in the yml',
  },
  collection_trips: {
    id: ROW_ID,
    project_id: 'exported by name (`project`), re-resolved on import',
    status: "imported records are always 'done' (single-active invariant)",
    starred: STARRED,
    created_at: IMPORT_TIME,
    updated_at: IMPORT_TIME,
    uuid: 'exported as event.eventUUID',
    name: 'exported as event.eventID',
    started_at: 'exported as event.startedAt (ISO)',
    ended_at: 'exported as event.endedAt (ISO)',
    recorded_by: 'exported as event.recordedBy',
    institution_code: 'exported as event.institutionCode (the trip default)',
    site_id: 'exported as the `site:` block + site.* sidecars',
    notes: 'exported as event.eventRemarks',
  },
  collection_specimens: {
    id: ROW_ID,
    trip_id: 'structural — the specimen lives inside its trip in the yml',
    collected_at: 'exported as eventDate (ISO)',
    record_number_seq: 'numeric tail of record_number, re-derived on import',
    photo_paths: 'exported as photo_files / associatedMedia (filenames in the zip)',
    audio_paths: 'exported as audio_files (filenames in the zip audio/)',
    created_at: IMPORT_TIME,
    updated_at: IMPORT_TIME,
    ...NAME_USAGE,
    ...INAT,
  },
};

const SCHEMA = await schemaColumns();

/**
 * Every real column of `table` must be in the yml or have a reason.
 *
 * Also checks the two directions that keep the list honest: a reason for a
 * column that no longer exists is stale, and a reason for a column the yml
 * does carry is a lie.
 */
function checkCoverage(table, ymlKeys) {
  const cols = SCHEMA.get(table);
  if (!cols) {
    fail(`${table}: not in the migrated schema — table renamed or dropped?`);
    return;
  }
  const reasons = NOT_RESTORABLE[table] ?? {};
  for (const col of cols) {
    if (ymlKeys.has(col)) continue;
    if (col in reasons) continue;
    const via = RESTORED_VIA[table]?.[col];
    if (via && ymlKeys.has(via)) continue;
    fail(`${table}: column "${col}" is in neither the yml nor NOT_RESTORABLE.${table}`);
  }
  for (const col of Object.keys(reasons)) {
    if (!cols.has(col)) fail(`NOT_RESTORABLE.${table}.${col}: no such column (stale entry)`);
    else if (ymlKeys.has(col)) fail(`NOT_RESTORABLE.${table}.${col}: the yml does carry it`);
  }
}

// ── DwC datum / elevation terms (dwcLocation.ts) ─────────────────────────
{
  eq('gnss altitude: both limits + ellipsoid datum', locationTerms(24.7, 612, 'gnss'), {
    geodeticDatum: 'EPSG:4326',
    minimumElevationInMeters: 612,
    maximumElevationInMeters: 612,
    verticalDatum: 'EPSG:7030',
  });
  eq('typed altitude: datum not recorded', locationTerms(24.7, 612, 'manual').verticalDatum, 'not recorded');
  eq('legacy altitude (no source): datum not recorded', locationTerms(24.7, 612, null).verticalDatum, 'not recorded');
  eq('no altitude: no vertical datum, no limits', locationTerms(24.7, null, 'gnss'), {
    geodeticDatum: 'EPSG:4326',
    minimumElevationInMeters: '',
    maximumElevationInMeters: '',
    verticalDatum: '',
  });
  eq('no coordinate: no geodetic datum', locationTerms(null, null, null).geodeticDatum, '');
  eq('import: EPSG:7030 ⇒ gnss', sourceFromVerticalDatum('EPSG:7030', 612), 'gnss');
  eq('import: anything else ⇒ manual', sourceFromVerticalDatum('not recorded', 612), 'manual');
  eq('import: no altitude ⇒ null', sourceFromVerticalDatum('EPSG:7030', null), null);
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const SITE = {
  name: '福山樣區',
  notes: '林道終點',
  geometry: { type: 'Polygon', coordinates: [[[121.5, 24.7], [121.6, 24.7], [121.6, 24.8], [121.5, 24.7]]] },
};
const TRACK = JSON.stringify({ type: 'MultiLineString', coordinates: [[[121.5, 24.7], [121.51, 24.71]]] });

const plotRow = {
  id: 7, uuid: 'plot-uuid-1', plotid: 'PLOT_2026_001', plot_type: 'fixed',
  track_geojson: TRACK, track_finalized: 1, project_id: 3, site_id: 2,
  start_ts: 1756500000000, stop_ts: 1756510000000, resumed_at: null, status: 'done',
  decimal_longitude: 121.5, decimal_latitude: 24.7, coord_uncertainty_m: 5,
  point_radius_m: 25, sample_size_value: 400, sample_size_unit: 'm2',
  sampling_protocol: '方形樣區', total_cover_pct: 85, recorded_by: '林政道',
  locality: '福山植物園', field_note: '雨後', elevation_m: 620, elevation_source: 'manual', slope_deg: 12,
  aspect_deg: 210, terrain_position: '中坡', rock_cover_pct: 5, gravel_cover_pct: 2,
  bareland_cover_pct: 1, vascular_cover_pct: 80, bryophyte_cover_pct: 10,
  lichen_cover_pct: 1, litter_cover_pct: 30, layer_count: 3,
  env_photos_json: '["ph://env1"]',
  e0_cover_pct: null, e0_height_cm: null, e1_cover_pct: null, e1_height_cm: null,
  e2_cover_pct: null, e2_height_cm: null, e3_cover_pct: null, e3_height_cm: null,
  e0_method: 'BB', e1_method: 'BB', e2_method: 'BB', e3_method: 'DBH',
  created_at: 1, updated_at: 2,
};

const plotSpecies = [
  {
    id: 1, plot_survey_id: 7, taxon_id: 't0301', occurrence_id: 'occ-1', subplot_id: 11,
    layer: 'E2', bb_value: null, percent: null, dbh_values_json: null, notes: '幼樹',
    photo_paths: '["ph://a","ph://b"]', observed_at: 1756500100000, created_at: 1,
    sex: 'unknown', life_stage: 'adult', reproductive_condition: '["flowering","fruiting"]',
    leaf_phenology: '["evergreen"]', organism_quantity: '3', organism_quantity_type: 'individuals',
    lat: 24.71, lng: 121.51, accuracy: 4, elevation_m: 1350, elevation_source: 'gnss', detection_type: 'seen',
    degree_of_establishment: 'cultivated',
    verbatim_identification: 'Lauraceae sp2',
    used_name_id: 165943, used_scientific_name: 'Lycopodium tamariscinum',
    used_status: 'not-accepted', used_stale: false, used_accepted_name: 'Selaginella tamariscina',
    simple_name: 'Lycopodium tamariscinum', name_author: '(P.Beauv.) Desv.', common_name_c: '小西氏石櫟',
    family: 'Fagaceae', family_c: '殼斗科', rank: 'species', is_endemic: 'true',
    alien_type: '', is_hybrid: 'false', kingdom: 'Plantae', kingdom_c: '植物界',
    class: 'Magnoliopsida', class_c: '', phylum: 'Tracheophyta', phylum_c: '',
    order: 'Fagales', order_c: '', genus: 'Lithocarpus', genus_c: '',
    redlist: 'NT', iucn: '', cites: '', protected: '',
  },
  {
    id: 2, plot_survey_id: 7, taxon_id: 't0301', occurrence_id: 'occ-2', subplot_id: null,
    layer: 'E1', bb_value: null, percent: null, dbh_values_json: null, notes: null,
    photo_paths: '["ph://c"]', observed_at: 1756500200000, created_at: 1,
    sex: null, life_stage: null, reproductive_condition: null, leaf_phenology: null,
    degree_of_establishment: null,
    organism_quantity: '2', organism_quantity_type: 'individuals',
    lat: null, lng: null, accuracy: null, elevation_m: null, elevation_source: null, detection_type: null,
    used_name_id: null, used_scientific_name: null,
    used_status: '', used_stale: false, used_accepted_name: '',
    simple_name: 'Lithocarpus konishii', name_author: 'Hayata', common_name_c: '小西氏石櫟',
    family: 'Fagaceae', family_c: '殼斗科', rank: 'species', is_endemic: 'true',
    alien_type: '', is_hybrid: 'false', kingdom: 'Plantae', kingdom_c: '植物界',
    class: 'Magnoliopsida', class_c: '', phylum: 'Tracheophyta', phylum_c: '',
    order: 'Fagales', order_c: '', genus: 'Lithocarpus', genus_c: '',
    redlist: 'NT', iucn: '', cites: '', protected: '',
  },
];

console.log('check:roundtrip');

// ── 1. Plot ───────────────────────────────────────────────────────────────
{
  const doc = buildPlotYamlDoc({
    plot: plotRow,
    projectName: '森林動態樣區',
    species: plotSpecies,
    layers: [
      { id: 1, plot_survey_id: 7, layer_index: 1, cover_pct: 60, height_cm: 1500, height_unit: 'm', method: 'DBH' },
      { id: 2, plot_survey_id: 7, layer_index: 2, cover_pct: 30, height_cm: 200, height_unit: 'cm', method: 'BB' },
    ],
    subplots: [
      {
        id: 11, plot_survey_id: 7, idx: 1, label: 'S1', width_m: 10, length_m: 10, created_at: 1,
        layers: [{ id: 1, subplot_id: 11, layer_index: 1, cover_pct: 55, height_cm: 1400 }],
      },
    ],
    subplotLabelById: new Map([[11, 'S1']]),
    site: SITE,
    photoNames: new Map([
      ['occ-1', ['t0301_小西氏石櫟_1.jpg', 't0301_小西氏石櫟_2.jpg']],
      ['occ-2', ['t0301_小西氏石櫟_3.jpg']],
    ]),
    envPhotoNames: ['PLOT_2026_001_20260830_env-1.jpg'],
  });

  const back = parsePlotYaml(yaml.dump(doc, { lineWidth: -1, noRefs: true }));

  eq('plot.uuid', back.uuid, plotRow.uuid);
  eq('plot.plotid', back.plotid, plotRow.plotid);
  eq('plot.plot_type', back.plot_type, plotRow.plot_type);
  eq('plot.project', back.project_name, '森林動態樣區');
  eq('plot.layer_count', back.layer_count, plotRow.layer_count);
  eq('plot.track_geojson', back.track_geojson, TRACK);
  eq('plot.track_finalized', back.track_finalized, 1);
  eq('plot.env_photo_files', back.env_photo_files, ['PLOT_2026_001_20260830_env-1.jpg']);
  eq('plot.site', back.site, SITE);
  for (const k of ['start_ts', 'stop_ts', 'recorded_by', 'locality', 'field_note',
    'sampling_protocol', 'sample_size_value', 'sample_size_unit', 'coord_uncertainty_m',
    'point_radius_m',
    'elevation_m', 'elevation_source', 'slope_deg', 'aspect_deg', 'terrain_position', 'total_cover_pct',
    'rock_cover_pct', 'gravel_cover_pct', 'bareland_cover_pct', 'vascular_cover_pct',
    'bryophyte_cover_pct', 'lichen_cover_pct', 'litter_cover_pct']) {
    eq(`plot.${k}`, back[k], plotRow[k]);
  }
  eq('plot.decimal_latitude', back.decimal_latitude, plotRow.decimal_latitude);
  eq('plot.decimal_longitude', back.decimal_longitude, plotRow.decimal_longitude);

  eq('layers', back.layers, [
    { layer_index: 1, cover_pct: 60, height_cm: 1500, height_unit: 'm', method: 'DBH' },
    { layer_index: 2, cover_pct: 30, height_cm: 200, height_unit: 'cm', method: 'BB' },
  ]);
  eq('subplots', back.subplots, [
    { idx: 1, label: 'S1', width_m: 10, length_m: 10,
      layers: [{ layer_index: 1, cover_pct: 55, height_cm: 1400 }] },
  ]);

  const s0 = back.species[0];
  eq('species[0].occurrence_id', s0.occurrence_id, 'occ-1');
  eq('species[0].taxon_id', s0.taxon_id, 't0301');
  eq('species[0].subplot', s0.subplot, 'S1');
  eq('species[0].layer', s0.layer, 'E2');
  eq('species[0].quantity', [s0.organism_quantity, s0.organism_quantity_type], ['3', 'individuals']);
  eq('species[0].notes', s0.notes, '幼樹');
  eq('species[0].sex', s0.sex, 'unknown');
  eq('species[0].life_stage', s0.life_stage, 'adult');
  eq('species[0].reproductive_condition', s0.reproductive_condition, '["flowering","fruiting"]');
  eq('species[0].leaf_phenology', s0.leaf_phenology, '["evergreen"]');
  eq('species[0].degree_of_establishment', s0.degree_of_establishment, 'cultivated');
  // A field determination finer than the taxon (`sp1` under a family) is the
  // whole reason two rows can share a taxon_id; losing it merges them.
  eq('species[0].verbatim_identification', s0.verbatim_identification, 'Lauraceae sp2');
  eq('species[0].detection_type', s0.detection_type, 'seen');
  eq('species[0].gnss', [s0.lat, s0.lng, s0.accuracy], [24.71, 121.51, 4]);
  eq('species[0].elevation_m', s0.elevation_m, 1350);
  eq('species[0].elevation_source', s0.elevation_source, 'gnss');
  eq('species[0].observed_at', s0.observed_at, 1756500100000);
  eq('species[0].photo_files', s0.photo_files, ['t0301_小西氏石櫟_1.jpg', 't0301_小西氏石櫟_2.jpg']);
  eq('species[0].name', s0.name, 'Lycopodium tamariscinum');
  eq('species[1].photo_files', back.species[1].photo_files, ['t0301_小西氏石櫟_3.jpg']);
  // The recorder's own determination must survive export → import; reverting
  // it to the accepted name would silently rewrite what they identified.
  eq('species[0].used_name_id', s0.used_name_id, 165943);
  eq('species[0].used_scientific_name', s0.used_scientific_name, 'Lycopodium tamariscinum');
  eq('species[1] has no adoption', back.species[1].used_name_id, null);

  const ymlKeys = new Set(Object.keys(doc.plot));
  ymlKeys.add('layers').add('subplots').add('species');
  checkCoverage('plot_surveys', ymlKeys);
  checkCoverage('plot_species_records', new Set(Object.keys(doc.species[0])));
  checkCoverage('plot_survey_layers', new Set(Object.keys(doc.layers[0])));
  checkCoverage('plot_subplots', new Set(Object.keys(doc.subplots[0])));
  checkCoverage('subplot_layers', new Set(Object.keys(doc.subplots[0].layers[0])));
}

// ── 2. Session ────────────────────────────────────────────────────────────
{
  const sessionRow = {
    id: 4, uuid: 'session-uuid-1', name: '2026-08-30 09:12', type: 'abundance',
    project_id: 3, site_id: 2, started_at: 1756500000000, ended_at: 1756510000000,
    resumed_at: null, gps_mode: 'full_track', start_lat: 24.7, start_lng: 121.5,
    track_geojson: TRACK, notes: '晴，午後雷陣雨', recorded_by: '林政道,王小明',
  };
  const records = [
    {
      id: 1, session_id: 4, taxon_id: 't0455', occurrence_id: 'socc-1',
      observed_at: 1756500300000, notes: '路邊', photo_paths: '["ph://x"]',
      lat: 24.72, lng: 121.52, accuracy: 8, elevation_m: 88.5, elevation_source: 'gnss', sex: 'female', life_stage: 'adult',
      reproductive_condition: '["flowering"]', leaf_phenology: '["deciduous"]',
      degree_of_establishment: 'wild',
      verbatim_identification: 'Orchidaceae sp1',
      organism_quantity: '5', organism_quantity_type: 'individuals',
      used_name_id: 166665, used_scientific_name: 'Lycopodium circinale',
      used_status: 'misapplied', used_stale: false, used_accepted_name: 'Ficus caulocarpa',
      simple_name: 'Lycopodium circinale', name_author: 'L.', common_name_c: '大葉雀榕',
      family: 'Moraceae', family_c: '桑科', rank: 'species', is_endemic: 'false',
      alien_type: '', is_hybrid: 'false', kingdom: 'Plantae', kingdom_c: '植物界',
      class: 'Magnoliopsida', class_c: '', phylum: 'Tracheophyta', phylum_c: '',
      order: 'Rosales', order_c: '', genus: 'Ficus', genus_c: '',
      redlist: 'LC', iucn: '', cites: '', protected: '',
    },
  ];

  const doc = buildSessionYamlDoc({
    session: sessionRow,
    projectName: '森林動態樣區',
    records,
    site: SITE,
    photoNames: new Map([['socc-1', ['t0455_大葉雀榕_1.jpg']]]),
  });

  const back = parseSessionYaml(yaml.dump(doc, { lineWidth: -1, noRefs: true }));

  eq('session.uuid', back.uuid, sessionRow.uuid);
  eq('session.name', back.name, sessionRow.name);
  eq('session.type', back.type, 'abundance');
  eq('session.project', back.project_name, '森林動態樣區');
  eq('session.started_at', back.started_at, sessionRow.started_at);
  eq('session.ended_at', back.ended_at, sessionRow.ended_at);
  eq('session.recorded_by', back.recorded_by, sessionRow.recorded_by);
  eq('session.notes', back.notes, sessionRow.notes);
  eq('session.start_lat', back.start_lat, sessionRow.start_lat);
  eq('session.start_lng', back.start_lng, sessionRow.start_lng);
  eq('session.gps_mode', back.gps_mode, 'full_track');
  eq('session.track_geojson', back.track_geojson, TRACK);
  eq('session.site', back.site, SITE);

  const r0 = back.records[0];
  eq('record.occurrence_id', r0.occurrence_id, 'socc-1');
  eq('record.taxon_id', r0.taxon_id, 't0455');
  eq('record.observed_at', r0.observed_at, 1756500300000);
  eq('record.notes', r0.notes, '路邊');
  eq('record.gnss', [r0.lat, r0.lng, r0.accuracy], [24.72, 121.52, 8]);
  eq('record.elevation_m', r0.elevation_m, 88.5);
  // Restored from verticalDatum (EPSG:7030 ⇒ gnss), not from a key of its own.
  eq('record.elevation_source', r0.elevation_source, 'gnss');
  eq('record.quantity', [r0.organism_quantity, r0.organism_quantity_type], ['5', 'individuals']);
  eq('record.sex', r0.sex, 'female');
  eq('record.life_stage', r0.life_stage, 'adult');
  eq('record.reproductive_condition', r0.reproductive_condition, '["flowering"]');
  eq('record.leaf_phenology', r0.leaf_phenology, '["deciduous"]');
  eq('record.degree_of_establishment', r0.degree_of_establishment, 'wild');
  eq('record.verbatim_identification', r0.verbatim_identification, 'Orchidaceae sp1');

  // The yml and the _occurrence_dwc.csv share one item builder but answer to different
  // masters: the yml round-trips back into the app and must keep 'wild', while
  // the CSV is a DwC deliverable and must not emit a value TDWG never defined.
  // These two assertions are what stop the split from silently collapsing.
  const ymlItem = convertToDwc(recordToYamlItem(records[0]));
  eq('yml keeps raw establishment', ymlItem.degreeOfEstablishment, 'wild');
  eq(
    'csv blanks non-TDWG establishment',
    establishmentDwcValue(ymlItem.degreeOfEstablishment),
    '',
  );
  eq('scientificNameAuthorship is the bare author', ymlItem.scientificNameAuthorship, 'L.');
  eq('fullname is not emitted as a column', ymlItem.fullname, undefined);
  eq('record.photo_files', r0.photo_files, ['t0455_大葉雀榕_1.jpg']);
  eq('record.name', r0.name, 'Lycopodium circinale');
  eq('record.used_name_id', r0.used_name_id, 166665);
  eq('record.used_scientific_name', r0.used_scientific_name, 'Lycopodium circinale');

  const ymlKeys = new Set(Object.keys(doc.event));
  ymlKeys.add('checklist').add('project').add('site');
  checkCoverage('sessions', ymlKeys);
  // Against the pre-DwC item: the doc's keys are DwC terms, and matching column
  // names against those would compare two different vocabularies.
  checkCoverage('checklist_records', new Set(Object.keys(recordToYamlItem(records[0]))));
}

// ── 3. Backward compatibility: a pre-v27 yml must still import ───────────
{
  const legacy = `plot:
  uuid: old-uuid
  plotid: OLD_PLOT
  plot_type: fixed
  project: 舊計畫
  layer_count: 4
species:
  - taxon_id: t0301
    layer: E0
    observed_at: 1700000000000
`;
  const back = parsePlotYaml(legacy);
  eq('legacy.uuid', back.uuid, 'old-uuid');
  eq('legacy.site', back.site, null);
  eq('legacy.env_photo_files', back.env_photo_files, []);
  eq('legacy.track_finalized', back.track_finalized, null);
  eq('legacy.species[0].photo_files', back.species[0].photo_files, []);
  // E0 is not a valid layer any more; importPlotSurvey coerces it, the parser
  // just passes it through.
  eq('legacy.species[0].layer', back.species[0].layer, 'E0');

  const legacySession = `event:
  eventID: 舊名錄
  eventDate: 2026-01-02T08:00:00+08:00
  startedAt: 2026-01-02T08:00:00+08:00
checklist:
  - taxonID: t0455
    scientificName: Ficus caulocarpa
    vernacularName: 大葉雀榕
    eventDate: 2026-01-02T08:30:00+08:00
`;
  const s = parseSessionYaml(legacySession);
  eq('legacySession.uuid', s.uuid, '');
  eq('legacySession.type', s.type, 'checklist');
  eq('legacySession.started_at', s.started_at, Date.parse('2026-01-02T08:00:00+08:00'));
  eq('legacySession.records[0].observed_at', s.records[0].observed_at, Date.parse('2026-01-02T08:30:00+08:00'));
  eq('legacySession.site', s.site, null);
}

// ── 4. The export zip itself ─────────────────────────────────────────────
// A user picking the .zip an export produced is the normal case, and reading
// it as text is what failed on device ("the text encoding of its contents
// can't be determined"). Build a zip the way finalizeZip does and read it back.
{
  const BASE = '名錄_森林動態樣區';
  const sessionYml = yaml.dump(
    buildSessionYamlDoc({
      session: {
        id: 1, uuid: 'zip-session-uuid', name: '名錄', type: 'checklist', project_id: 0,
        site_id: null, started_at: 1756500000000, ended_at: 1756503600000, resumed_at: null,
        gps_mode: null, start_lat: null, start_lng: null, track_geojson: null,
        notes: null, recorded_by: null,
      },
      projectName: '森林動態樣區',
      records: [{
        id: 1, session_id: 1, taxon_id: 't0455', occurrence_id: 'z-occ-1',
        observed_at: 1756500300000, notes: null, photo_paths: '["ph://x"]',
        lat: null, lng: null, accuracy: null, sex: null, life_stage: null,
        reproductive_condition: null, leaf_phenology: null,
        organism_quantity: null, organism_quantity_type: null,
        simple_name: 'Ficus caulocarpa', name_author: '(Miq.) Miq.', common_name_c: '大葉雀榕',
        family: 'Moraceae', family_c: '桑科', rank: 'species', is_endemic: 'false',
        alien_type: '', is_hybrid: 'false', kingdom: 'Plantae', kingdom_c: '植物界',
        class: 'Magnoliopsida', class_c: '', phylum: 'Tracheophyta', phylum_c: '',
        order: 'Rosales', order_c: '', genus: 'Ficus', genus_c: '',
        redlist: 'LC', iucn: '', cites: '', protected: '',
      }],
      site: null,
      photoNames: new Map([['z-occ-1', ['t0455_大葉雀榕_1.jpg']]]),
      audioNames: new Map([['z-occ-1', ['t0455_大葉雀榕_1.m4a']]]),
    }),
    { lineWidth: -1, noRefs: true },
  );

  const zip = zipSync({
    [`${BASE}/${BASE}.yml`]: strToU8(sessionYml),
    [`${BASE}/名錄_occurrence_dwc.csv`]: strToU8('taxonID\nt0455\n'),
    [`${BASE}/${BASE}.md`]: strToU8('# 名錄\n'),
    [`${BASE}/photos/t0455_大葉雀榕_1.jpg`]: new Uint8Array([1, 2, 3]),
    [`${BASE}/audio/t0455_大葉雀榕_1.m4a`]: new Uint8Array([4, 5, 6]),
    // Entry names are attacker-controlled. Both of these must be dropped by
    // safeMediaBasename rather than written anywhere.
    [`${BASE}/audio/..%2F..%2Fuser.db`]: new Uint8Array([9]),
    [`${BASE}/audio/evil.sh`]: new Uint8Array([9]),
    [`${BASE}/manifest.json`]: strToU8(JSON.stringify({ app: 'checklister-ng-mobile', kind: 'session' })),
  });

  const read = readRecordImportFromBytes(zip);
  eq('zip.kind', read.kind, 'session');
  eq('zip.session.uuid', read.session.uuid, 'zip-session-uuid');
  eq('zip.session.records', read.session.records.length, 1);
  eq('zip.photos', read.photos.map((p) => p.name), ['t0455_大葉雀榕_1.jpg']);
  // Clips ride in audio/ and come back as their own list — folding them into
  // associatedMedia would put them in photo_paths on import.
  eq('zip.audio', read.audio.map((a) => a.name), ['t0455_大葉雀榕_1.m4a']);
  eq('zip.audio bytes', Array.from(read.audio[0].bytes), [4, 5, 6]);
  eq('zip.record.audio_files', read.session.records[0].audio_files, ['t0455_大葉雀榕_1.m4a']);
  eq('traversal + non-media entries dropped', read.audio.length, 1);
  eq('safeMediaBasename rejects traversal', safeMediaBasename('audio/../../user.db', ['m4a']), null);
  eq('safeMediaBasename rejects foreign ext', safeMediaBasename('audio/evil.sh', ['m4a']), null);
  // The batch species importer takes this path.
  if (!readRecordYamlTextFromBytes(zip).includes('t0455')) fail('zip → yml text lost the checklist');
  // A bare .yml must still work through the same entry point.
  eq('bare yml kind', readRecordImportFromBytes(strToU8(sessionYml)).kind, 'session');

  // Track fallback: yml with no track + a track.gpx sidecar.
  const plotYml = yaml.dump({
    plot: { uuid: 'gpx-plot', plotid: 'GPX_PLOT', plot_type: 'transect', project: '', layer_count: 1 },
    species: [],
  }, { lineWidth: -1, noRefs: true });
  const gpx = '<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><trkseg>' +
    '<trkpt lat="24.7" lon="121.5"></trkpt><trkpt lat="24.71" lon="121.51"></trkpt>' +
    '</trkseg></trk></gpx>';
  const gpxZip = zipSync({
    'P/P.yml': strToU8(plotYml),
    'P/track.gpx': strToU8(gpx),
    'P/manifest.json': strToU8(JSON.stringify({ kind: 'plot' })),
  });
  const gpxRead = readRecordImportFromBytes(gpxZip);
  eq('gpx fallback track', gpxRead.plot.track_geojson,
    JSON.stringify({ type: 'MultiLineString', coordinates: [[[121.5, 24.7], [121.51, 24.71]]] }));

  // Refusals: a multi-record bundle and a 採集 export.
  const bundle = zipSync({
    'bundle_manifest.json': strToU8('{}'),
    'A/A.yml': strToU8(sessionYml),
  });
  try {
    readRecordImportFromBytes(bundle);
    fail('multi-record bundle was accepted');
  } catch (e) {
    eq('bundle refusal', e.code, 'unsupportedBundle');
  }
}

// ── 5. Collection (採集) ──────────────────────────────────────────────────
// Was export-only until E1: `recordImportZip` refused the kind outright, so a
// collection export was a one-way trip. Both halves are exercised now, and the
// refusal assertion that used to live here has been replaced by the real
// round-trip below — a guard that pins a limitation has to be retired with it.
{
  const tripRow = {
    id: 7, uuid: 'trip-uuid-9', name: '2026-09-20 福山採集', project_id: 3, status: 'done',
    started_at: 1789860000000, ended_at: 1789880000000, recorded_by: '林政道',
    locality: '宜蘭縣員山鄉福山', notes: '午後雷陣雨，提前結束',
    site_id: 11, institution_code: 'TAI',
    created_at: 1789860000000, updated_at: 1789880000000, starred: 0,
  };
  // Two specimens of ONE taxon: the shape that made the missing photo binding
  // unrecoverable, since the zip filenames count per taxon across the export.
  const specimen = (n, occ) => ({
    id: n, trip_id: 7, occurrence_id: occ, taxon_id: 't0301',
    record_number: `CTL-100${n}`, record_number_seq: 1000 + n,
    collected_at: 1789864200000, recorded_by: '林政道', identified_by: '王小明',
    date_identified: '2026-09-21',
    lat: 24.76, lng: 121.58, accuracy: 6, locality: '福山植物園',
    // Every optional column carries a value: the item builders emit these
    // conditionally, so a null here would silently skip the assertion.
    degree_of_establishment: 'wild', sex: 'female', life_stage: 'adult',
    verbatim_identification: 'Fagaceae sp1',
    duplicate_count: 3, institution_code: 'HAST', other_catalog_numbers: 'TAI 123456',
    catalog_number: '13450', elevation_m: 612.5, elevation_source: 'manual',
    reproductive_condition: '["flowering"]', leaf_phenology: '["evergreen"]',
    notes: `第 ${n} 份`, photo_paths: '["ph://a"]', audio_paths: '["file:///audio/a.m4a"]',
    used_name_id: 165943, used_scientific_name: 'Lithocarpus konishii',
    used_status: 'misapplied', used_accepted_name: 'Lithocarpus amygdalifolius',
    created_at: 1789864200000, updated_at: 1789864200000,
    inat_observation_id: null, inat_media_done: 0, inat_uploaded_at: null, inat_sync_hash: null,
    simple_name: 'Lithocarpus konishii', name_author: 'Hayata', common_name_c: '小西氏石櫟',
    family: 'Fagaceae', family_c: '殼斗科', kingdom: 'Plantae', phylum: 'Tracheophyta',
    class: 'Magnoliopsida', order: 'Fagales', genus: 'Lithocarpus',
    is_endemic: 'true', is_hybrid: 'false', rank: 'species', alien_type: '',
    iucn: '', redlist: 'NT', cites: '', protected: '',
  });
  const specimens = [specimen(1, 'c-occ-A'), specimen(2, 'c-occ-B')];
  const photoNames = new Map([
    ['c-occ-A', ['t0301_小西氏石櫟_1.jpg']],
    ['c-occ-B', ['t0301_小西氏石櫟_2.jpg']],
  ]);
  const audioNames = new Map([['c-occ-A', ['t0301_小西氏石櫟_1.m4a']]]);

  const tripSite = { name: '福山哈盆步道', notes: '', geometry: { type: 'Point', coordinates: [121.58, 24.76] } };
  const doc = buildCollectionYamlDoc({
    trip: tripRow, projectName: '福山長期樣區', specimens, site: tripSite, photoNames, audioNames,
  });

  eq('trip.eventUUID', doc.event.eventUUID, 'trip-uuid-9');
  eq('trip.eventRemarks', doc.event.eventRemarks, '午後雷陣雨，提前結束');
  // Each specimen keeps its OWN photos: one shared list would make duplicates
  // of the same species indistinguishable once the zip is opened.
  eq('specimen A media', doc.specimens[0].associatedMedia, 't0301_小西氏石櫟_1.jpg');
  eq('specimen B media', doc.specimens[1].associatedMedia, 't0301_小西氏石櫟_2.jpg');
  eq('specimen A audio', doc.specimens[0].audio_files, 't0301_小西氏石櫟_1.m4a');
  eq('specimen verbatimIdentification', doc.specimens[0].verbatimIdentification, 'Fagaceae sp1');
  // v43 herbarium fields. `duplicate_count` keeps its own key on purpose:
  // DwC's `preparations` is a list of preparation METHODS and
  // `individualCount` counts individuals, so neither can carry "3 sheets".
  eq('specimen duplicate_count', doc.specimens[0].duplicate_count, 3);
  eq('specimen institutionCode', doc.specimens[0].institutionCode, 'HAST');
  eq('specimen otherCatalogNumbers', doc.specimens[0].otherCatalogNumbers, 'TAI 123456');
  eq('trip institutionCode', doc.event.institutionCode, 'TAI');
  eq('trip site name', doc.site?.name, '福山哈盆步道');
  eq('specimen B has no audio', doc.specimens[1].audio_files, undefined);

  const ymlKeys = new Set(Object.keys(doc.event));
  ymlKeys.add('specimens').add('project').add('site');
  checkCoverage('collection_trips', ymlKeys);
  checkCoverage(
    'collection_specimens',
    new Set(Object.keys(specimenToYamlItem(specimens[0], photoNames, audioNames))),
  );

// ── 6. Collection round-trip (E1) ────────────────────────────────────────
// The half that did not exist: export → parse → compare every value. A field
// that serialises but never comes back is exactly how the plot importer lost
// `degree_of_establishment` for three versions without anything failing.
{
  const yml = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  const back = parseCollectionYaml(yml);

  eq('trip uuid survives', back.uuid, tripRow.uuid);
  eq('trip name survives', back.name, tripRow.name);
  eq('trip recorded_by survives', back.recorded_by, tripRow.recorded_by);
  eq('trip locality survives', back.locality, tripRow.locality);
  eq('trip institution_code survives', back.institution_code, tripRow.institution_code);
  eq('trip notes survives', back.notes, tripRow.notes);
  eq('trip started_at survives', back.started_at, tripRow.started_at);
  eq('trip ended_at survives', back.ended_at, tripRow.ended_at);
  eq('trip project survives', back.project_name, '福山長期樣區');
  eq('trip site survives', back.site?.name, '福山哈盆步道');
  eq('specimen count survives', back.specimens.length, 2);

  const a = back.specimens[0];
  const src = specimens[0];
  eq('specimen occurrence_id survives', a.occurrence_id, src.occurrence_id);
  eq('specimen taxon_id survives', a.taxon_id, src.taxon_id);
  eq('specimen record_number survives', a.record_number, src.record_number);
  eq('specimen collected_at survives', a.collected_at, src.collected_at);
  eq('specimen recorded_by survives', a.recorded_by, src.recorded_by);
  eq('specimen identified_by survives', a.identified_by, src.identified_by);
  eq('specimen date_identified survives', a.date_identified, src.date_identified);
  eq('specimen lat survives', a.lat, src.lat);
  eq('specimen lng survives', a.lng, src.lng);
  eq('specimen accuracy survives', a.accuracy, src.accuracy);
  eq('specimen locality survives', a.locality, src.locality);
  eq('specimen sex survives', a.sex, src.sex);
  eq('specimen life_stage survives', a.life_stage, src.life_stage);
  eq('specimen reproductive_condition survives', a.reproductive_condition, src.reproductive_condition);
  eq('specimen leaf_phenology survives', a.leaf_phenology, src.leaf_phenology);
  eq('specimen degree_of_establishment survives', a.degree_of_establishment, src.degree_of_establishment);
  eq('specimen verbatim_identification survives', a.verbatim_identification, src.verbatim_identification);
  eq('specimen duplicate_count survives', a.duplicate_count, src.duplicate_count);
  eq('specimen institution_code survives', a.institution_code, src.institution_code);
  eq('specimen other_catalog_numbers survives', a.other_catalog_numbers, src.other_catalog_numbers);
  eq('specimen catalog_number survives', a.catalog_number, src.catalog_number);
  eq('specimen elevation_m survives', a.elevation_m, src.elevation_m);
  eq('specimen elevation_source survives (via verticalDatum)', a.elevation_source, 'manual');
  eq('specimen notes survives', a.notes, src.notes);
  eq('specimen photo binding survives', a.photo_files?.[0], 't0301_小西氏石櫟_1.jpg');
  eq('specimen audio binding survives', a.audio_files?.[0], 't0301_小西氏石櫟_1.m4a');
  eq('specimen B keeps its OWN photo', back.specimens[1].photo_files?.[0], 't0301_小西氏石櫟_2.jpg');
  eq('specimen used_scientific_name survives', a.used_scientific_name, src.used_scientific_name);
  eq('specimen used_name_id survives', a.used_name_id, src.used_name_id);

  // A recorded 0 is a statement ("no duplicates taken"), not an absence. The
  // serialiser uses `!= null` for exactly this; a truthiness test would drop
  // it and it would come back as "not recorded".
  const zeroDoc = buildCollectionYamlDoc({
    trip: tripRow,
    projectName: '',
    specimens: [{ ...specimens[0], duplicate_count: 0 }],
    site: null,
  });
  eq('duplicate_count 0 survives', collectionFromDoc(zeroDoc).specimens[0].duplicate_count, 0);

  // Kind detection from a BARE yml. A collection document carries an `event:`
  // block just like a session one, so testing `event` first classified it as a
  // session and imported specimens as checklist rows — silently.
  const asZip = zipSync({ 'C/C.yml': strToU8(yml) });
  eq('bare collection yml is detected as a collection',
     readRecordImportFromBytes(strToU8(yml)).kind, 'collection');
  eq('zipped collection is detected as a collection',
     readRecordImportFromBytes(asZip).kind, 'collection');

  // …and the manifest must not be the only thing that saves it.
  const withManifest = zipSync({
    'C/C.yml': strToU8(yml),
    'C/manifest.json': strToU8(JSON.stringify({ kind: 'collection' })),
  });
  const read = readRecordImportFromBytes(withManifest);
  eq('manifest path gives the same kind', read.kind, 'collection');
  eq('manifest path parses the specimens', read.collection.specimens.length, 2);
}
}

// ── GLORIA survey yml (src/modules/gloria/export/yaml.ts) ────────────────
{
  // One fixture row per table with EVERY migrated column set, so a column the
  // builder forgets shows up as missing from the yml keys.
  const full = (table, over = {}) => {
    const row = {};
    for (const c of SCHEMA.get(table)) row[c] = `${table}.${c}`;
    return { ...row, ...over };
  };
  const summit = full('gloria_summits');
  const survey = full('gloria_surveys', { mocy: 5, start_ts: 1, created_at: 1, updated_at: 2 });
  const unit = full('gloria_units', { id: 7, code: 'N33' });
  const taxon = full('gloria_taxa', { id: 9, serial: 3 });
  const species = full('gloria_unit_species', { unit_id: 7, gloria_taxon_id: 9 });
  const doc = buildGloriaDoc({
    summit, survey, projectName: 'P', points: [full('gloria_points')], units: [unit], taxa: [taxon], species: [species],
  });
  const surveyKeys = new Set([...Object.keys(doc.survey), 'project_name']);
  checkCoverage('gloria_summits', new Set(Object.keys(doc.summit)));
  checkCoverage('gloria_surveys', surveyKeys);
  checkCoverage('gloria_points', new Set(Object.keys(doc.points[0])));
  checkCoverage('gloria_units', new Set(Object.keys(doc.units[0])));
  checkCoverage('gloria_taxa', new Set(Object.keys(doc.taxa[0])));
  checkCoverage('gloria_unit_species', new Set(Object.keys(doc.species[0])));
  eq('gloria: species keyed by unit code', doc.species[0].unit, 'N33');
  eq('gloria: species keyed by roster serial', doc.species[0].serial, 3);
  const back = yaml.load(yaml.dump(doc, { lineWidth: -1, noRefs: true }));
  eq('gloria: yml dump → load is lossless', back, JSON.parse(JSON.stringify(doc)));
  eq('gloria: survives validation', validateGloriaDoc({ ...back, schema: 1, survey: { ...back.survey, mocy: 5 } }), []);
  // An older build falls back to "checklist" for unknown yml; ours must not.
  const bytes = strToU8(yaml.dump(doc));
  eq('gloria: bare yml detected as gloria', readRecordImportFromBytes(bytes).kind, 'gloria');
  eq('gloria: zipped yml detected as gloria',
     readRecordImportFromBytes(zipSync({ 'G/G.yml': bytes, 'G/manifest.json': strToU8('{"kind":"gloria"}') })).kind, 'gloria');
}

// ── Summary ──────────────────────────────────────────────────────────────
// Last, deliberately. This block used to sit before sections 5 and 6, so a
// failure in either printed a ✗ and still exited 0. Verified by breaking one
// assertion on purpose: the run reported the failure and returned success.
if (failures > 0) {
  console.error(`\n✗ round-trip: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ round-trip: 名錄 / 樣區 / 採集 / GLORIA yml survive export → import with no field lost');
