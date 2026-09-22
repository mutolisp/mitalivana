/**
 * Every term this app emits must be a real, current term of the vocabulary it
 * claims — checked against cached copies of the official lists.
 *
 * Until this existed, conformance rested on a hand-written comment in
 * `dwcArchive.ts`. The comment happened to be right, but nothing would have
 * said so if a column were renamed, if a term were deprecated upstream, or if
 * someone invented a name that merely looks like Darwin Core.
 *
 * `check-vegmatrix` already compares meta.xml against the ColSpec arrays, but
 * it does `.split('/').pop()` first, so it compares local names only: swap a
 * term's namespace from dwc: to eco: and it still passes. This compares the
 * full IRI.
 *
 * The cached vocabularies live in scripts/vocab/ with their source URL and
 * retrieval date. Refresh them by re-downloading from those URLs; a term that
 * has since been deprecated will then fail here, which is the point.
 *
 * Run: npm run check:dwc
 */
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { DWC_FIELD_MAP } from '../src/lib/dwcMapper.ts';
import { publishedTaxonId } from '../src/lib/taxonId.ts';
import {
  establishmentMeansDwcValue,
  higherClassificationOf,
  individualCountOf,
} from '../src/lib/dwcMultiValue.ts';
import {
  DWCA_INTERNALS,
  EVENT_COLS,
  HUMBOLDT_COLS,
  OCCURRENCE_COLS,
  buildDwcArchive,
} from '../src/lib/dwcArchive.ts';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};

const here = new URL('.', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(`vocab/${name}`, here), 'utf8'));
const dwc = load('dwc-current-terms.json');
const gbif = load('gbif-extension-terms.json');
const DWC_TERMS = new Set(dwc.terms);
const extByName = new Map(gbif.extensions.map((e) => [e.name, e]));
const EXT_TERMS = new Set(gbif.extensions.flatMap((e) => e.terms));

/**
 * Names this app emits that no vocabulary defines.
 *
 * Every entry is a deliberate app-specific field, not an oversight — but each
 * has to be written down here, so inventing a fifteenth one is a conscious act
 * rather than a typo that ships.
 */
const APP_SPECIFIC = {
  familyVernacularName: 'Chinese family name; DwC has vernacularName for the taxon only',
  kingdomVernacularName: 'as above, per rank',
  phylumVernacularName: 'as above, per rank',
  classVernacularName: 'as above, per rank',
  orderVernacularName: 'as above, per rank',
  genusVernacularName: 'as above, per rank',
  alternativeVernacularName: 'TaiCOL alternative common name',
  iucnRedListCategory: 'GBIF SPECIES_LIST download column; not a term in any hosted extension',
  protectionStatus: '臺灣保育類等級 / 文資法 — a national status DwC does not model',
  endemic: 'TaiCOL endemism flag',
  isBrackish: 'TaiCOL habitat flag. speciesprofile defines isFreshwater / isMarine / '
    + 'isTerrestrial but NOT isBrackish, so this one is ours while its siblings are theirs',
  leafPhenology: 'vegetation attribute; no DwC term',
  detectionType: 'how the observation was made; no DwC term',
  establishmentRemarks: 'free text beside establishmentMeans; no DwC term',
};

// ── 1. The archive's own column specs ────────────────────────────────────
const checkCols = (label, cols, allowed, vocabLabel) => {
  for (const { key, term } of cols) {
    if (!allowed.has(term)) fail(`${label}: ${term} is not a current ${vocabLabel} term`);
    const localName = term.split('/').pop();
    if (key !== localName) fail(`${label}: key "${key}" does not match term local name "${localName}"`);
  }
};
checkCols('EVENT_COLS', EVENT_COLS, DWC_TERMS, 'Darwin Core');
checkCols('OCCURRENCE_COLS', OCCURRENCE_COLS, DWC_TERMS, 'Darwin Core');
const humboldt = extByName.get('humboldt');
checkCols('HUMBOLDT_COLS', HUMBOLDT_COLS, new Set(humboldt.terms), 'Humboldt extension');

// ── 2. What meta.xml actually emits ──────────────────────────────────────
// The full IRI, from the real generated file — the ColSpec arrays above could
// be right while the writer emits something else.
{
  const zip = buildDwcArchive({
    meta: { packageId: 'check', title: 't', creator: '', abstract: '', pubDate: '2026-09-21' },
    events: [{ eventID: 'e1' }],
    occurrences: [{ coreEventID: 'e1', occurrenceID: 'o1' }],
    humboldt: [{ coreEventID: 'e1', siteCount: 1 }],
  });
  const files = unzipSync(zip);
  const metaXml = strFromU8(files['meta.xml']);
  const emitted = [...metaXml.matchAll(/term="([^"]+)"/g)].map((m) => m[1]);
  const expected = [...EVENT_COLS, ...OCCURRENCE_COLS, ...HUMBOLDT_COLS].map((c) => c.term);
  for (const t of emitted) {
    if (!expected.includes(t)) fail(`meta.xml emits ${t}, which is in no ColSpec array`);
  }
  for (const t of expected) {
    if (!emitted.includes(t)) fail(`meta.xml never emits ${t}`);
  }
  const eco = [...metaXml.matchAll(/rowType="([^"]+)"/g)].map((m) => m[1]);
  if (!eco.includes(humboldt.rowType)) {
    fail(`meta.xml rowTypes ${JSON.stringify(eco)} do not include the extension's ${humboldt.rowType}`);
  }
  if (typeof DWCA_INTERNALS.buildMetaXml !== 'function') fail('DWCA_INTERNALS.buildMetaXml missing');
}

// ── 3. Every name the mapper can emit ────────────────────────────────────
// Each output is one of: a current DwC/DC term, a term of a GBIF extension the
// app uses, or an entry in APP_SPECIFIC above. Nothing else.
{
  const DC = ['http://purl.org/dc/terms/', 'http://purl.org/dc/elements/1.1/'];
  const isDwc = (n) =>
    DWC_TERMS.has(`http://rs.tdwg.org/dwc/terms/${n}`) || DC.some((ns) => DWC_TERMS.has(ns + n));
  const isExt = (n) => [...EXT_TERMS].some((t) => t.split('/').pop() === n);
  for (const name of new Set(Object.values(DWC_FIELD_MAP))) {
    if (isDwc(name) || isExt(name) || name in APP_SPECIFIC) continue;
    fail(`DWC_FIELD_MAP emits "${name}", which is in no vocabulary and not in APP_SPECIFIC`);
  }
  for (const name of Object.keys(APP_SPECIFIC)) {
    if (!Object.values(DWC_FIELD_MAP).includes(name)) {
      fail(`APP_SPECIFIC."${name}" is no longer emitted by DWC_FIELD_MAP (stale entry)`);
    }
    if (isDwc(name) || isExt(name)) {
      fail(`APP_SPECIFIC."${name}" IS a real vocabulary term — remove it from the list`);
    }
  }
}

// ── establishmentMeans must stay inside the controlled vocabulary ─────────
// Term NAMES are checked above; this checks the VALUES, which GBIF validates
// separately and which a mapping can silently invent.
{
  const vocab = new Set(
    JSON.parse(readFileSync(new URL('./vocab/establishment-means-values.json', import.meta.url)))
      .concepts,
  );
  const cases = [
    ['native', 'false', 'native'],
    ['native', 'true', 'nativeEndemic'],
    ['naturalized', 'false', 'introduced'],
    ['invasive', 'false', 'introduced'],
    // Cultivation is degreeOfEstablishment, not a means of establishment.
    ['cultured', 'false', ''],
    // Absent data is not `uncertain` — that would assert we investigated.
    ['', '', ''],
    [null, null, ''],
    ['something-taicol-invented', 'false', ''],
  ];
  for (const [alien, endemic, want] of cases) {
    const got = establishmentMeansDwcValue(alien, endemic);
    if (got !== want) {
      fail(`establishmentMeansDwcValue(${alien}, ${endemic}) = "${got}", want "${want}"`);
    }
    if (got !== '' && !vocab.has(got)) {
      fail(`establishmentMeansDwcValue emitted "${got}", which is not in the pinned vocabulary`);
    }
  }
}

// ── individualCount only when the quantity really counts individuals ──────
{
  const cases = [
    ['5', 'individuals', '5'],
    ['0', 'individuals', '0'],
    // Cover classes, percentages and DBH arrays are NOT counts.
    ['3', 'Braun-Blanquet Scale', ''],
    ['35', '% cover', ''],
    ['[12.4,18.1]', 'DBH (cm)', ''],
    ['many', 'individuals', ''],
    [null, 'individuals', ''],
    ['5', null, ''],
  ];
  for (const [q, t, want] of cases) {
    const got = individualCountOf(q, t);
    if (got !== want) fail(`individualCountOf(${q}, ${t}) = "${got}", want "${want}"`);
  }
}

// ── higherClassification drops empty ranks rather than leaving holes ──────
{
  const full = higherClassificationOf({
    kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida',
    order: 'Fagales', family: 'Fagaceae',
  });
  if (full !== 'Plantae|Tracheophyta|Magnoliopsida|Fagales|Fagaceae') {
    fail(`higherClassification full chain wrong: "${full}"`);
  }
  const gappy = higherClassificationOf({ kingdom: 'Fungi', phylum: '', class: null, family: 'Xylariaceae' });
  if (gappy !== 'Fungi|Xylariaceae') fail(`higherClassification left a hole: "${gappy}"`);
  if (higherClassificationOf({}) !== '') fail('higherClassification of nothing must be empty');
}

// ── taxonID published in the archive must be resolvable, or absent ─────────
// Locally minted ids ('g…' / 'gi…' / 'gm…') mean nothing outside this app.
// Publishing one claims an identifier the receiver cannot look up, which is
// worse than publishing none.
{
  const cases = [
    ['t0301', 't0301', 'TaiCOL id passes through'],
    ['y12345', 'y12345', 'Japan id passes through'],
    ['g2492463', 'https://www.gbif.org/species/2492463', 'GBIF numeric key → URI'],
    ['g5XCJ3', 'https://www.gbif.org/species/5XCJ3', 'ChecklistBank key → URI'],
    ['gBOLD.AAA1234', 'https://www.gbif.org/species/BOLD.AAA1234', 'BOLD bin → URI'],
    ['gi58583', 'https://www.inaturalist.org/taxa/58583', 'iNat key → URI'],
    ['gm3f2a9c', '', 'manual entry has no external identity'],
  ];
  for (const [input, want, why] of cases) {
    const got = publishedTaxonId(input);
    if (got !== want) fail(`publishedTaxonId(${input}) = "${got}", want "${want}" — ${why}`);
  }
  // The whole point: nothing locally minted may survive into the archive.
  for (const id of ['g1', 'gi1', 'gm0123abcdef']) {
    const got = publishedTaxonId(id);
    if (got === id) fail(`publishedTaxonId(${id}) returned the local id verbatim`);
  }
}

if (failures > 0) {
  console.error(`✗ dwc-terms: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `✓ dwc-terms: ${EVENT_COLS.length + OCCURRENCE_COLS.length + HUMBOLDT_COLS.length} archive columns`
    + ` + ${new Set(Object.values(DWC_FIELD_MAP)).size} mapper outputs check out`
    + ` (DwC ${dwc.retrieved}, extensions ${gbif.extensions[0].retrieved})`,
);
