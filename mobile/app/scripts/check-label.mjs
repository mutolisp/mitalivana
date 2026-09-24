/**
 * Fixture check for the herbarium label CONTENT (`labelLines` in
 * `src/lib/docxLabels.ts`), which both the DOCX and the ODT sheet render, plus
 * the three inputs the export feeds it: the herbarium number
 * (`catalogLabel`), the geocoded place name (`formatPlace`) and the one
 * vernacular per language (`pickVernacular`).
 *
 * What this is defending: a label is a permanent physical record. The order
 * and captions below are the layout the user specified; a field that silently
 * drops off, or a caption that changes, is only discovered once the sheets are
 * printed and glued.
 *
 * Run: npm run check:label
 */
import { catalogLabel, labelLines } from '../src/lib/docxLabels.ts';
import { formatPlace } from '../src/lib/placeName.ts';
import { TW_COUNTY_EN, TW_DISTRICTS } from '../src/lib/twAdminNames.ts';
import { pickVernacular } from '../src/db/mergeScope.ts';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}:\n      got ${a}\n expected ${b}`);
};

/** A line as `kind|text`, bold runs wrapped in **, italic in _. */
const show = (l) =>
  l.kind === 'blank'
    ? 'blank'
    : `${l.kind}|${l.runs.map((r) => (r.bold ? `**${r.text}**` : r.italic ? `_${r.text}_` : r.text)).join('')}`;

const base = {
  record_number: 'DAO1305',
  simple_name: 'Boerhavia glabrata',
  name_author: 'Blume',
  kingdom: 'Plantae',
  rank: 'Species',
  common_name_c: '光果黃細心',
  family: 'Nyctaginaceae',
  family_c: '紫茉莉科',
  collected_at: new Date(2026, 7, 31, 17, 38, 47).getTime(),
  locality: '臺北市：福州山(TAIPEI: Mt. Fuchou), Taiwan',
  lat: 25.01687,
  lng: 121.53938,
  accuracy: 10,
  recorded_by: '林政道(Cheng-Tao Lin)',
  identified_by: '林政道(Cheng-Tao Lin)',
  notes: null,
  institution_code: 'TAI',
  catalog_number: '13450',
  elevation_m: null,
};
const opts = { title: 'Flora of Taiwan (TAI Herbarium)', includeFamily: true };

// ── the layout from the user's reference label ─────────────────────────────
eq('full label, in order', labelLines(base, opts).map(show), [
  'title|**Flora of Taiwan (TAI Herbarium)**',
  'plain|Nyctaginaceae (紫茉莉科)',
  'plain|**TAI13450**',
  'name|_Boerhavia glabrata_ Blume 光果黃細心',
  'blank',
  'field|**Loc.: **臺北市：福州山(TAIPEI: Mt. Fuchou), Taiwan',
  'sub|25.01687, 121.53938 acc. 10 m',
  'field|**Alt.: **',
  'field|**Coll.: **林政道(Cheng-Tao Lin); **Coll. No.: **DAO1305',
  'field|**Date: **2026-08-31 17:38:47',
  'field|**Det.: **林政道(Cheng-Tao Lin)',
  'field|**Note: **',
]);

// Every caption stays even with no data behind it — a blank is where the
// collector writes by hand. Only the herbarium number line disappears.
eq(
  'empty specimen keeps every caption',
  labelLines(
    {
      ...base,
      locality: null,
      lat: null,
      lng: null,
      accuracy: null,
      recorded_by: null,
      identified_by: null,
      catalog_number: null,
      record_number: '',
    },
    { title: '', includeFamily: false },
  ).map(show),
  [
    'name|_Boerhavia glabrata_ Blume 光果黃細心',
    'blank',
    'field|**Loc.: **',
    'field|**Alt.: **',
    'field|**Coll.: **; **Coll. No.: **',
    'field|**Date: **2026-08-31 17:38:47',
    'field|**Det.: **',
    'field|**Note: **',
  ],
);

eq('altitude in metres', show(labelLines({ ...base, elevation_m: 612 }, opts)[7]), 'field|**Alt.: **612 m');
eq('fractional altitude', show(labelLines({ ...base, elevation_m: 612.25 }, opts)[7]), 'field|**Alt.: **612.3 m');
// User text is printed as typed: an asterisk in a note is not italics.
eq(
  'note with asterisks stays literal',
  show(labelLines({ ...base, notes: 'fl. *white*' }, opts).at(-1)),
  'field|**Note: **fl. *white*',
);
eq(
  'genus-only name italic',
  show(labelLines({ ...base, simple_name: 'Litsea', name_author: '', rank: 'Genus', common_name_c: '' }, opts)[3]),
  'name|_Litsea_',
);

// ── herbarium number ───────────────────────────────────────────────────────
eq('code + number', catalogLabel(base), 'TAI13450');
eq('number already carries the code', catalogLabel({ ...base, catalog_number: 'tai13450' }), 'tai13450');
eq('no code', catalogLabel({ ...base, institution_code: null }), '13450');
eq('no number → no line', catalogLabel({ ...base, catalog_number: '  ' }), '');

// ── geocoded place name ────────────────────────────────────────────────────
// Taiwan: 縣市：鄉鎮市區 + English, district in Tongyong. The same place must
// come out the same whether the geocoder answered in Chinese or in English.
const daan = '臺北市：大安區(Taipei City: Da-an District), Taiwan';
eq(
  'TW, Chinese answer (台→臺, street dropped)',
  formatPlace({ country: '台灣', isoCountryCode: 'TW', region: '台北市', city: '台北市', district: '大安區', street: '辛亥路' }),
  daan,
);
eq(
  'TW, English (Hanyu) answer → same Tongyong line',
  formatPlace({ country: 'Taiwan', isoCountryCode: 'TW', region: 'Taipei City', district: "Da'an District", street: 'Xinhai Rd' }),
  daan,
);
eq(
  'same district name in another county (臺中市大安區)',
  formatPlace({ isoCountryCode: 'TW', region: '臺中市', district: '大安區' }),
  '臺中市：大安區(Taichung City: Da-an District), Taiwan',
);
eq(
  'merged municipality → 2004 township, current suffix',
  formatPlace({ isoCountryCode: 'TW', region: 'New Taipei City', city: 'Banqiao District' }),
  '新北市：板橋區(New Taipei City: Banciao District), Taiwan',
);
eq(
  'Hsinchu County is not Hsinchu City',
  formatPlace({ isoCountryCode: 'TW', region: 'Hsinchu County', city: 'Zhubei City' }),
  '新竹縣：竹北市(Hsinchu County: Jhubei City), Taiwan',
);
eq(
  'renamed district uses its official English',
  formatPlace({ isoCountryCode: 'TW', region: '高雄市', district: '那瑪夏區' }),
  '高雄市：那瑪夏區(Kaohsiung City: Namasia District), Taiwan',
);
eq(
  'county only',
  formatPlace({ isoCountryCode: 'TW', region: '花蓮縣' }),
  '花蓮縣(Hualien County), Taiwan',
);
// Elsewhere: the geocoder's own wording, untouched.
eq(
  'abroad, CJK: largest first with the country',
  formatPlace({ country: '日本', isoCountryCode: 'JP', region: '沖縄県', city: '那覇市' }),
  '日本沖縄県那覇市',
);
eq(
  'abroad, Latin: smallest first',
  formatPlace({ country: 'Japan', isoCountryCode: 'JP', region: 'Okinawa', city: 'Naha' }),
  'Naha, Okinawa, Japan',
);
eq('nothing usable', formatPlace({ country: 'Japan', isoCountryCode: 'JP' }), null);

// The romanisation table itself.
eq('22 counties', Object.keys(TW_COUNTY_EN).length, 22);
eq('368 townships/districts + Dongsha + Nansha', TW_DISTRICTS.length, 370);
eq(
  'no Hanyu-only spelling (q, x, zh) in the Tongyong column',
  TW_DISTRICTS.filter((d) => /q|x|zh/i.test(d.tongyong)).map((d) => d.county + d.district),
  [],
);
eq(
  'every county has districts',
  Object.keys(TW_COUNTY_EN).filter((c) => !TW_DISTRICTS.some((d) => d.county === c)),
  [],
);

// ── one vernacular, by language ────────────────────────────────────────────
const both = { tw: '光果黃細心', jp: 'ナハカノコソウ' };
eq('zh-TW → Taiwan name', pickVernacular('光果黃細心 / ナハカノコソウ', 'TW', both, 'zh-TW'), '光果黃細心');
eq('ja → Japanese name', pickVernacular('光果黃細心 / ナハカノコソウ', 'TW', both, 'ja'), 'ナハカノコソウ');
eq('en → Taiwan name', pickVernacular('x', 'TW', both, 'en'), '光果黃細心');
eq('ja, no Japanese name → Taiwan name', pickVernacular('山胡椒', 'TW', undefined, 'ja'), '山胡椒');
eq('zh-TW, Japan-only taxon → Japanese name', pickVernacular('ナハカノコソウ', 'JP', undefined, 'zh-TW'), 'ナハカノコソウ');
eq('no name at all', pickVernacular('', 'TW', undefined, 'ja'), '');

if (failures > 0) {
  console.error(`check-label: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-label: all assertions passed');
