#!/usr/bin/env node
/**
 * Which parts of a scientific name are italic — in the app (scientificNameSegments,
 * behind <ScientificName>) and in the checklist export (formatScientificNameMarkdown,
 * behind the DOCX / Markdown export and the specimen labels). Two implementations
 * of one rule, pinned together so they cannot drift.
 *
 * The case that shipped wrong: a genus on its own ("Litsea") was upright
 * everywhere — in the records list, the taxonomy tree and the exported DOCX —
 * because both parsers only italicised "Genus epithet". A lone word is
 * italicised only when the rank says Genus: "Aves" (class) must stay upright.
 *
 * Run: npm run check:sciitalic
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scientificNameMd, scientificNameSegments } from '../src/lib/scientificNameSegments.ts';
import { formatScientificNameMarkdown } from '../src/lib/scientificNameMarkdown.ts';

let failures = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
};
const md = (name, opts) => scientificNameMd(name, opts);

// ── app side ──
eq('genus alone, TaiCOL rank', md('Litsea', { rank: 'Genus' }), '*Litsea*');
eq('genus alone, tree rank key', md('Litsea', { rank: 'genus' }), '*Litsea*');
eq('genus alone, GBIF rank', md('Litsea', { rank: 'GENUS' }), '*Litsea*');
eq('animal genus alone', md('Parus', { rank: 'Genus', kingdom: 'Animalia' }), '*Parus*');
eq('genus with author', md('Litsea Lam.', { rank: 'Genus' }), '*Litsea* Lam.');
eq('lone word without rank stays upright (could be a class)', md('Aves'), 'Aves');
eq('class stays upright', md('Aves', { rank: 'Class' }), 'Aves');
eq('family stays upright', md('Lauraceae', { rank: 'Family' }), 'Lauraceae');
eq('tree family key stays upright', md('Lauraceae', { rank: 'family' }), 'Lauraceae');
eq('species unchanged', md('Litsea cubeba', { rank: 'Species' }), '*Litsea cubeba*');
eq('infraspecific unchanged', md('Litsea acuminata var. glabra', { rank: 'Variety' }), '*Litsea acuminata* var. *glabra*');
eq('segments shape for a genus', scientificNameSegments('Litsea', { rank: 'Genus' }), [{ text: 'Litsea', italic: true }]);

// ── export side (DOCX / Markdown / labels) ──
const ex = (full, kingdom, rank) => formatScientificNameMarkdown(full, kingdom, '', rank);
eq('export: genus with author', ex('Litsea Lam.', 'Plantae', 'Genus'), '*Litsea* Lam.');
eq('export: genus alone', ex('Litsea', 'Plantae', 'Genus'), '*Litsea*');
eq('export: animal genus with author', ex('Parus Linnaeus, 1758', 'Animalia', 'Genus'), '*Parus* Linnaeus, 1758');
eq('export: lone word without rank stays upright', ex('Aves', 'Animalia', ''), 'Aves');
eq('export: family stays upright', ex('Lauraceae Juss.', 'Plantae', 'Family'), 'Lauraceae Juss.');
eq('export: species unchanged', ex('Litsea cubeba (Lour.) Pers.', 'Plantae', 'Species'), '*Litsea cubeba* (Lour.) Pers.');
eq('export: infraspecific unchanged', ex('Litsea acuminata var. glabra Hayata', 'Plantae', 'Variety'), '*Litsea acuminata* var. *glabra* Hayata');

// ── screens: the italic Latin face only through ScientificName (code review L24) ──
// A Text with font-latin set whole made "var.", "subsp." and family names italic.
{
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  const OWN = new Set(['src/components/ScientificName.tsx']);
  const bare = [...walk('src'), ...walk('app')]
    .filter((f) => !OWN.has(f))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (/\bfont-latin(?![-\w])/.test(l) ? [`${f}:${i + 1}`] : [])));
  eq('screens: no font-latin outside ScientificName', bare, []);
}

if (failures > 0) {
  console.error(`✗ sci-italic: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ sci-italic: genus alone is italic in the app and the export; higher ranks stay upright');
