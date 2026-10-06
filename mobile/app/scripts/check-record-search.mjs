#!/usr/bin/env node
/**
 * The records tab's search: which records a query keeps.
 *
 * Pins the rules in src/lib/recordSearch.ts — a project match keeps the whole
 * group, a record matches by title or subtitle, 台/臺 are one character, and
 * an empty query changes nothing.
 *
 * Run: npm run check:recordsearch
 */
import {
  filterRecordGroups,
  matchingProjectIds,
  normalizeRecordQuery,
  recordMatches,
  speciesMatches,
} from '../src/lib/recordSearch.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};

const projects = [
  { id: 1, name: '玉山植物相調查', abstract: null, location_description: '塔塔加鞍部', notes: null },
  { id: 2, name: 'Kenting survey', abstract: '恆春半島海岸林', location_description: null, notes: '臺灣海棗' },
  { id: 0, name: '未分類', abstract: null, location_description: null, notes: null },
];
const item = (title, subtitle, projectId) => ({ title, subtitle, projectId });
const groups = [
  { projectId: 1, items: [item('塔塔加 09-20', '12 種', 1), item('TTK-01', '樣區', 1)] },
  { projectId: 2, items: [item('Coast day 1', '30 種', 2)] },
  { projectId: 0, items: [item('路邊', '台北 · 3 種', 0), item('Fagaceae trip', '採集', 0)] },
];
const titles = (gs) => gs.map((g) => g.items.map((it) => it.title));
const run = (q) => {
  const nq = normalizeRecordQuery(q);
  return titles(filterRecordGroups(groups, nq, matchingProjectIds(projects, nq)));
};

eq('empty query keeps everything', run('   '), titles(groups));
eq('project name keeps its whole group', run('玉山'), [['塔塔加 09-20', 'TTK-01']]);
eq('project location description', run('鞍部'), [['塔塔加 09-20', 'TTK-01']]);
eq('project abstract', run('海岸林'), [['Coast day 1']]);
eq('project notes, 台 matches 臺', run('台灣海棗'), [['Coast day 1']]);
eq('record title only keeps that record', run('ttk'), [['TTK-01']]);
eq('record subtitle, 臺 matches 台', run('臺北'), [['路邊']]);
eq('case-insensitive', run('FAGACEAE'), [['Fagaceae trip']]);
eq('no match drops every group', run('zzz'), []);
eq('group objects keep their own fields', filterRecordGroups(groups, 'ttk', new Set())[0].projectId, 1);
eq('recordMatches with an empty query', recordMatches(item('a', 'b', 9), '', new Set()), true);

// A species in its own checklist's or plot's list.
const sp = {
  common_name_c: '臺灣二葉松',
  alternative_name_c: '松仔',
  simple_name: 'Pinus taiwanensis',
  family: 'Pinaceae',
  family_c: '松科',
  genus_c: '松屬',
  notes: '稜線上 3 株',
};
const sm = (q) => speciesMatches(sp, normalizeRecordQuery(q));
eq('species: common name, 台 matches 臺', sm('台灣二葉'), true);
eq('species: other name', sm('松仔'), true);
eq('species: scientific name, case-insensitive', sm('PINUS'), true);
eq('species: family (Latin)', sm('pinaceae'), true);
eq('species: family (Chinese)', sm('松科'), true);
eq('species: genus (Chinese)', sm('松屬'), true);
eq('species: note', sm('稜線'), true);
eq('species: no match', sm('樟'), false);
eq('species: empty query keeps it', sm('  '), true);
eq('species: missing fields are skipped', speciesMatches({ simple_name: 'Ficus' }, 'ficus'), true);
eq('species: null fields are skipped', speciesMatches({ common_name_c: null, simple_name: 'x' }, 'y'), false);

if (failures > 0) {
  console.error(`✗ record-search: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ record-search: project fields keep whole groups, records match by title/subtitle, species by names/family/genus/note, 台＝臺');
