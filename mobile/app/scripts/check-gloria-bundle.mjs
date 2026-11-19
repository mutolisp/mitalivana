/**
 * GLORIA survey zip, assembled by src/modules/gloria/export/bundle.ts — the
 * pure half of bundleExport.ts buildGloriaEntries, also used by the web app
 * (web/gloria). Pins the format both write:
 *
 *   - entry order: yml, sheet CSVs (empty tables left out), point hits,
 *     checklist md (+ docx/odt), photo checklist, photos/, loggers/, forms/,
 *     manifest.json, README.md last;
 *   - the yml is the document passed in (sync block included), as js-yaml
 *     dumps it with lineWidth -1 / noRefs;
 *   - photos only with the switch, named per manual Annex III; an unreadable
 *     photo is skipped and photo_count says how many made it;
 *   - loggers/ and forms/ always, whatever the photo switch;
 *   - a photo-library reference asks for access once, a file:// never;
 *   - manifest kind/uuid/name/record_count; README lists what is there and
 *     carries the Annex III note only when photos are in.
 *
 * Run: npm run check:gloria-bundle
 */
import yaml from 'js-yaml';
import { strFromU8 } from 'fflate';
import { assembleGloriaEntries, gloriaFolderName } from '../src/modules/gloria/export/bundle.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const ok = (label, cond) => eq(label, !!cond, true);

const day = new Date(2026, 7, 14, 9, 0).getTime();
const unit = (code, type, extra) => ({
  code, unit_type: type, start_ts: day, stop_ts: null, freq_start_ts: null, freq_stop_ts: null, recorded_by: null,
  aspect_deg: null, slope_deg: null, cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null,
  cov_bryophytes: null, cov_bare_ground: null, cov_litter: null, sub_lich_below_vasc: null, sub_lich_on_rock: null,
  sub_lich_on_scree: null, sub_bry_below_vasc: null, sub_bry_on_rock: null, sub_bry_on_scree: null,
  dist_hi1: null, dist_hi2: null, dist_hi3: null, point_surface: null, walk_option: null, legacy_surface_hits: null,
  comments: null, uuid: `u-${code}`, photo_paths: null, ...extra,
});
const sp = (code, serial, extra) => ({
  unit_code: code, occurrence_id: `o-${code}-${serial}`, serial, sort_order: null, cover_pct: 1, abundance: null,
  freq_cells: null, freq_count: null, point_hits: null, legacy_hits: null, comments: null, morpho_label: null,
  scientific_name: `Sp ${serial}`, vernacular_name: '', taxon_rank: 'species', family: 'F', ...extra,
});
const point = (key, extra) => ({
  point_key: key, is_p5m: 0, distance_m: null, compass_deg: null, comments: null, uuid: `p-${key}`,
  photo_m2: null, photo_m2f: null, photo_point: null, ...extra,
});

const summit = { full_code: 'TW-SAC-JIA', country: 'TW', target_region: 'SAC', summit: 'JIA' };
const survey = {
  uuid: 'survey-uuid', mocy: 4, year: 2026, start_ts: day, stop_ts: null, recorded_by: 'A', notes: null,
  form1_files: JSON.stringify([{ uri: 'file:///doc/files/f1.pdf', name: 'form1.pdf', size: 3 }]),
  form2_files: JSON.stringify([{ uri: 'ph://scan-2', name: 'IMG_1.jpg', size: 3 }]),
};
const units = [
  unit('N11', 'quadrat', { photo_paths: JSON.stringify(['file:///doc/photos/u1.jpg']) }),
  unit('N-SAS1', 'sas'),
];
const visits = [{
  uuid: 'v1', visit_ts: day, researchers: null, comments: null,
  form4_files: JSON.stringify([{ uri: 'file:///doc/files/f4.jpg', name: 'f4.jpg', size: 3 }]),
  loggers: [{
    uuid: 'l1', role: 'readout', quadrat: 'E22', label: null, serial: 'SN1', logger_type: null, start_ts: null, stop_ts: null,
    utc_diff_h: null, dist11_m: null, dist31_m: null, photo_open: null, photo_closed: null,
    photo_open_uri: 'file:///doc/photos/lo.jpg', photo_closed_uri: null, flags: null, researcher: null, comments: null,
    data_files: JSON.stringify([{ uri: 'file:///doc/files/data.csv', name: 'data.csv', size: 3 }]),
  }],
}];
const data = {
  summit, survey, units, visits,
  points: [],
  species: [sp('N11', 1), sp('N-SAS1', 1, { cover_pct: null, abundance: 'c' })],
};
const points = [point('N11', { photo_m2: 'ph://m2', photo_point: 'file:///doc/photos/missing.jpg' })];
const doc = { record_type: 'gloria', schema: 1, survey: { uuid: 'survey-uuid' }, sync: { base: 'x' } };

const readable = new Set([
  'file:///doc/files/f1.pdf', 'ph://scan-2', 'file:///doc/photos/u1.jpg', 'file:///doc/files/f4.jpg',
  'file:///doc/photos/lo.jpg', 'file:///doc/files/data.csv', 'ph://m2',
]);
const run = async (includePhotos, overrides = {}) => {
  let asked = 0;
  const reads = [];
  const res = await assembleGloriaEntries(
    {
      surveyId: 7, data, doc, points, units,
      checks: [{ id: 1, survey_id: 7, item: 'SU-OV', checked: 1, photo_uri: null, updated_at: 0 }],
      overviewPhotos: null, p5m: {},
      checklist: { md: '# list', doc: { ext: 'docx', bytes: new Uint8Array([1]) } },
      includePhotos,
      ...overrides,
    },
    {
      readMedia: async (uri) => {
        reads.push(uri);
        return readable.has(uri) ? new Uint8Array([9]) : null;
      },
      beforeLibraryRead: async () => {
        asked += 1;
      },
    },
  );
  return { ...res, asked, reads, names: res.entries.map((e) => e.name.slice(e.name.indexOf('/') + 1)) };
};

const base = 'GLORIA_TW-SAC-JIA_mocy4';
eq('folder name', gloriaFolderName(data), base);

// ── with photos ─────────────────────────────────────────────────────────
{
  const r = await run(true);
  eq('folder', r.folderName, base);
  ok('every entry inside the folder', r.entries.every((e) => e.name.startsWith(`${base}/`)));
  eq('yml first', r.names[0], `${base}.yml`);
  eq('yml is the doc (sync kept)', yaml.load(strFromU8(r.entries[0].bytes)), doc);
  const kinds = r.names.map((n) =>
    n.endsWith('.yml') ? 'yml'
      : n.startsWith('photos/') ? 'photos'
        : n.startsWith('loggers/') ? 'loggers'
          : n.startsWith('forms/') ? 'forms'
            : n === 'manifest.json' ? 'manifest'
              : n === 'README.md' ? 'readme'
                : n.endsWith('_photo_checklist.csv') ? 'photo_checklist'
                  : n.endsWith('_checklist.md') || n.endsWith('_checklist.docx') ? 'checklist'
                    : n.endsWith('_point_hits.csv') ? 'point_hits'
                      : 'sheet',
  );
  const order = ['yml', 'sheet', 'point_hits', 'checklist', 'photo_checklist', 'photos', 'loggers', 'forms', 'manifest', 'readme'];
  const seq = kinds.filter((k, i) => k !== kinds[i - 1]);
  eq('entry groups in order', seq, order.filter((k) => seq.includes(k)));
  eq('README last', r.names.at(-1), 'README.md');
  ok('sheet CSVs present (1x1 and SAS species)', r.names.includes(`${base}_12_13_1x1m_sp_freq.csv`) && r.names.includes(`${base}_22_sas_sp.csv`));
  ok('empty sheet tables left out', !r.names.some((n) => n.endsWith('_32_10x10m_sp.csv')));
  eq('checklist md then doc', r.names.filter((n) => n.includes('_checklist.') && !n.includes('photo')), [`${base}_checklist.md`, `${base}_checklist.docx`]);
  const photos = r.names.filter((n) => n.startsWith('photos/'));
  // m2 (ph://), unit photo, logger photo; the missing point photo is skipped.
  eq('photos read and kept (missing one skipped)', photos.length, 3);
  // Annex III: mocy 2 digits, item padded to 8 with '_'; the ordering number is
  // planned before reading, so the skipped photo (00002) leaves a gap.
  eq('Annex III names', photos, [
    'photos/04_TW_SAC_JIA_N11______20260814_00001.jpg',
    'photos/04_TW_SAC_JIA_N11______20260814_00003.jpg',
    'photos/04_TW_SAC_JIA_LOG-E22__20260814_00004_open.jpg',
  ]);
  ok('missing photo was attempted', r.reads.includes('file:///doc/photos/missing.jpg'));
  eq('loggers/: form 4 scan and data file', r.names.filter((n) => n.startsWith('loggers/')).length, 2);
  eq('forms/: form 1 and form 2 scans', r.names.filter((n) => n.startsWith('forms/')).length, 2);
  eq('library access asked once', r.asked, 1);
  const manifest = JSON.parse(strFromU8(r.entries.find((e) => e.name.endsWith('manifest.json')).bytes));
  eq('manifest', [manifest.app, manifest.kind, manifest.id, manifest.uuid, manifest.name, manifest.record_count, manifest.photo_count],
    ['mitalivana', 'gloria', 7, 'survey-uuid', 'TW-SAC-JIA mocy 4', 2, 3]);
  eq('photoCount returned', r.photoCount, 3);
  const readme = strFromU8(r.entries.at(-1).bytes);
  ok('README title', readme.startsWith(`# ${base}`));
  for (const part of ['photos/', '/loggers/', 'forms/', '.yml', '_checklist.md'].map((p) => p.replace(/^\//, '')))
    ok(`README mentions ${part}`, readme.includes(part === '_checklist.md' ? '物種名錄文件（Markdown）' : part));
  ok('README Annex III note with photos', readme.includes('## GLORIA 照片檔名'));
  ok('README formula note (CSV present)', readme.includes('單引號'));
}

// ── without photos ──────────────────────────────────────────────────────
{
  const r = await run(false);
  ok('no photos/ without the switch', !r.names.some((n) => n.startsWith('photos/')));
  eq('loggers/ still there', r.names.filter((n) => n.startsWith('loggers/')).length, 2);
  eq('forms/ still there', r.names.filter((n) => n.startsWith('forms/')).length, 2);
  ok('no photo reads', !r.reads.some((u) => u.includes('/photos/') || u === 'ph://m2'));
  eq('asked once (form 2 scan is a library ref)', r.asked, 1);
  const readme = strFromU8(r.entries.at(-1).bytes);
  ok('no Annex III note without photos', !readme.includes('## GLORIA 照片檔名'));
  const manifest = JSON.parse(strFromU8(r.entries.find((e) => e.name.endsWith('manifest.json')).bytes));
  eq('photo_count 0', manifest.photo_count, 0);
}

// ── file:// only: never asks for library access; no checklist when roster is empty ──
{
  const r = await run(false, {
    data: { ...data, survey: { ...survey, form2_files: null } },
    checklist: null,
  });
  eq('file:// only → never asked', r.asked, 0);
  ok('no checklist entries without a roster', !r.names.some((n) => n.endsWith('_checklist.md')));
  ok('photo checklist always', r.names.includes(`${base}_photo_checklist.csv`));
}

if (failures) {
  console.error(`check:gloria-bundle: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ check:gloria-bundle');
