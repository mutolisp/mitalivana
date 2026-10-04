/**
 * The user's own taxa in the taxonomy tree (src/db/externalTreeCore.ts,
 * 2026-10-04): 自建 on their own chain, GBIF / iNat on the checklist's
 * hierarchy from the lowest rank a checklist knows in the same kingdom,
 * the rest in the kingdom's incomplete bucket; and the tree's counts.
 *
 * With dist/datasets/tw-taicol.db present the lookup query also runs on the
 * real TaiCOL module (skipped, and said so, without it).
 *
 * Run: npm run check:external-tree
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  bucketOf,
  CHAIN,
  checklistAboveSql,
  childrenOf,
  kingdomsOf,
  placedUnder,
  placeRow,
  statsOf,
  treeRank,
} from '../src/db/externalTreeCore.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A checklist: genus / family / order / class → the ranks above it, per kingdom.
const KNOWN = {
  Plantae: {
    genus: { Digitaria: ['Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Poaceae'] },
    family: { Poaceae: ['Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales'], Malvaceae: ['Plantae', 'Tracheophyta', 'Magnoliopsida', 'Malvales'] },
    order: { Poales: ['Plantae', 'Tracheophyta', 'Magnoliopsida'] },
    class: { Magnoliopsida: ['Plantae', 'Tracheophyta'] },
  },
  Animalia: {
    genus: { Pterygota: ['Animalia', 'Arthropoda', 'Insecta', 'Insecta ordo incertae sedis', 'Insecta familia incertae sedis'] },
    family: {},
    order: {},
    class: { Insecta: ['Animalia', 'Arthropoda'] },
  },
};
const asked = [];
const lookup = (rank, name, kingdom) => {
  asked.push(`${rank}:${name}:${kingdom}`);
  const kingdoms = kingdom ? [kingdom] : Object.keys(KNOWN);
  for (const k of kingdoms) {
    const v = KNOWN[k]?.[rank]?.[name];
    if (v) return Object.fromEntries(CHAIN.slice(0, v.length).map((r, i) => [r, v[i]]));
  }
  return null;
};
const row = (over) => ({
  taxon_id: 'g1',
  source: 'gbif',
  simple_name: 'X y',
  name_author: '',
  rank: 'SPECIES',
  common_name_c: '',
  kingdom: '',
  phylum: '',
  class: '',
  order: '',
  family: '',
  genus: '',
  ...over,
});
const gbifMonocot = (over = {}) =>
  row({ kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Liliopsida', order: 'Poales', family: 'Poaceae', genus: 'Digitaria', simple_name: 'Digitaria bicornis', ...over });
const chainOf = (...v) => Object.fromEntries(CHAIN.map((r, i) => [r, v[i]]));

// ── placement ──────────────────────────────────────────────────────────────
ok(
  eq(placeRow(gbifMonocot(), lookup), chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Poaceae', 'Digitaria')),
  `place: a GBIF monocot hangs on the checklist's genus, not under GBIF's Liliopsida (${JSON.stringify(placeRow(gbifMonocot(), lookup))})`,
);
asked.length = 0;
placeRow(gbifMonocot(), lookup);
ok(eq(asked, ['genus:Digitaria:Plantae']), `place: the genus is asked first and the walk stops there (${asked})`);
ok(
  eq(placeRow(gbifMonocot({ genus: 'Neogenus' }), lookup), chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Poaceae', 'Neogenus')),
  'place: a genus the checklist lacks hangs on its family, keeping its own genus',
);
ok(
  eq(placeRow(gbifMonocot({ family: 'Neofamily', genus: 'Neogenus' }), lookup), chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Neofamily', 'Neogenus')),
  'place: then its order, keeping its own family and genus',
);
ok(
  eq(
    placeRow(row({ kingdom: 'Animalia', phylum: 'Arthropoda', class: 'Insecta', order: 'Neoptera', family: 'Neofamily', genus: 'Neogenus' }), lookup),
    chainOf('Animalia', 'Arthropoda', 'Insecta', 'Neoptera', 'Neofamily', 'Neogenus'),
  ),
  'place: then its class',
);
ok(placeRow(gbifMonocot({ class: 'Liliopsida', order: 'Neoorder', family: 'Neofamily', genus: 'Neogenus' }), lookup) === null, 'place: nothing the checklist knows → the bucket (GBIF’s Liliopsida is not matched)');
ok(
  eq(
    placeRow(row({ kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida', order: 'Malvales', family: 'Malvaceae', genus: 'Pterygota', simple_name: 'Pterygota alata' }), lookup),
    chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Malvales', 'Malvaceae', 'Pterygota'),
  ),
  'place: a genus the checklist has only in another kingdom is not matched (a homonym), its family is',
);
ok(placeRow(gbifMonocot({ genus: '' }), lookup) === null, 'place: a rank below the matched one left blank → the bucket (a node nothing could reach)');
ok(eq(placeRow(gbifMonocot({ source: 'inat' }), lookup), placeRow(gbifMonocot(), lookup)), 'place: iNat taxa by the same rule');
const manual = row({ source: 'manual', taxon_id: 'gm1', kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Liliopsida', order: 'Poales', family: 'Poaceae', genus: 'Digitaria' });
asked.length = 0;
ok(eq(placeRow(manual, lookup), chainOf('Plantae', 'Tracheophyta', 'Liliopsida', 'Poales', 'Poaceae', 'Digitaria')) && asked.length === 0, 'place: a 自建 taxon keeps its own chain as typed, no lookup');
ok(placeRow({ ...manual, family: '' }, lookup) === null, 'place: a 自建 taxon with a blank rank → the bucket');
ok(treeRank('SPECIES') === 'Species' && treeRank('variety') === 'Variety' && treeRank('') === 'Species', 'ranks: GBIF upper case reads as the tree’s');

// ── the tree's view ────────────────────────────────────────────────────────
const P = (over, chain) => ({ row: row(over), chain });
const poa = chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Poaceae', 'Digitaria');
const poa2 = chainOf('Plantae', 'Tracheophyta', 'Magnoliopsida', 'Poales', 'Poaceae', 'Miscanthus');
const ins = chainOf('Animalia', 'Arthropoda', 'Insecta', 'Lepidoptera', 'Nymphalidae', 'Danaus');
const rows = [
  P({ taxon_id: 'g1', simple_name: 'Digitaria bicornis', kingdom: 'Plantae' }, poa),
  P({ taxon_id: 'g2', simple_name: 'Digitaria b var. c', rank: 'VARIETY', kingdom: 'Plantae' }, poa),
  P({ taxon_id: 'g3', simple_name: 'Miscanthus x', kingdom: 'Plantae' }, poa2),
  P({ taxon_id: 'gi4', simple_name: 'Danaus z', source: 'inat', kingdom: 'Animalia' }, ins),
  P({ taxon_id: 'gm5', simple_name: 'Aaa b', source: 'manual', kingdom: 'Plantae', family: 'Weirdaceae' }, null),
  P({ taxon_id: 'g6', simple_name: 'Bbb c', kingdom: '' }, null),
  // GBIF gave no kingdom; the checklist's genus placed it (looked up in any kingdom).
  P({ taxon_id: 'g7', simple_name: 'Danaus w', kingdom: '' }, ins),
];
const fam = childrenOf(rows, 'family', { kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida', order: 'Poales' });
ok(
  eq(fam, [{ name: 'Poaceae', stats: { genus: 2, species: 2, infraspecific: 1 } }]),
  `tree: one family node, its genera, species and infraspecific counts (${JSON.stringify(fam)})`,
);
const gen = childrenOf(rows, 'genus', { kingdom: 'Plantae', family: 'Poaceae' });
ok(eq(gen.map((g) => g.name), ['Digitaria', 'Miscanthus']) && gen[0].stats.species === 1, `tree: nodes by name, in order (${gen.map((g) => g.name)})`);
ok(childrenOf(rows, 'class', { kingdom: 'Animalia' }).map((g) => g.name).join() === 'Insecta', 'tree: only rows under the ancestors');
ok(childrenOf(rows, 'phylum', { kingdom: 'Plantae' }).every((g) => g.name !== ''), 'tree: bucket rows make no rank nodes');
const kd = kingdomsOf(rows);
ok(eq(kd.map((k) => k.name), ['Animalia', 'Plantae']), `tree: kingdoms of placed rows and of bucket rows; an unplaced row without a kingdom nowhere (${kd.map((k) => k.name)})`);
ok(kd.find((k) => k.name === 'Animalia').stats.species === 2, 'tree: a placed row counts in its placed kingdom, not its own blank one');
ok(!('kingdom' in kd.find((k) => k.name === 'Plantae').stats) && kd.find((k) => k.name === 'Plantae').stats.species === 3, `tree: a kingdom's counts start at phylum and include its bucket (${JSON.stringify(kd)})`);
ok(eq(bucketOf(rows, 'Plantae').map((x) => x.row.taxon_id), ['gm5']) && bucketOf(rows, '').length === 0, 'tree: the bucket holds its kingdom’s unplaced rows');
ok(eq(placedUnder(rows, { kingdom: 'Animalia' }).map((x) => x.row.taxon_id), ['g7', 'gi4']), 'tree: placed rows by their placed chain');
ok(eq(placedUnder(rows, { genus: 'Digitaria' }).map((x) => x.row.simple_name), ['Digitaria b var. c', 'Digitaria bicornis']), 'tree: species under a node, by scientific name');
ok(eq(statsOf(rows.slice(0, 3), 3), { family: 1, genus: 2, species: 2, infraspecific: 1 }), 'tree: counts below a rank only');

// ── the lookup query on a small table: which rows decide ────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE names (kingdom TEXT, phylum TEXT, class TEXT, "order" TEXT, family TEXT, genus TEXT, rank TEXT, usage_status TEXT, tw TEXT);
    CREATE INDEX idx_names_genus ON names(genus);`);
  const ins = db.prepare('INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const plant = ['Plantae', 'Tracheophyta', 'Magnoliopsida', 'Malvales', 'Malvaceae'];
  const bug = ['Animalia', 'Arthropoda', 'Insecta', 'Hemiptera', 'Miridae'];
  // A homonym genus in two kingdoms; the animal one has more rows.
  ins.run(...plant, 'Homon', 'Species', 'accepted', 'true');
  for (let i = 0; i < 3; i++) ins.run(...bug, 'Homon', 'Species', 'accepted', 'true');
  // Rows the tree leaves out: a genus-rank row, a synonym, one outside the scope.
  ins.run(...plant.slice(0, 4), 'Wrongaceae', 'Lonely', 'Genus', 'accepted', 'true');
  ins.run(...plant.slice(0, 4), 'Wrongaceae', 'Syno', 'Species', 'not-accepted', 'true');
  ins.run(...plant.slice(0, 4), 'Wrongaceae', 'Abroad', 'Species', 'accepted', 'false');
  // Rows that disagree: the most common chain wins.
  ins.run(...plant.slice(0, 4), 'Minorityaceae', 'Split', 'Species', 'accepted', 'true');
  for (let i = 0; i < 2; i++) ins.run(...plant, 'Split', 'Species', 'accepted', 'true');
  const ask = (name, kingdom) => db.prepare(checklistAboveSql('genus', 'names', "tw = 'true'", !!kingdom)).get(...(kingdom ? [name, kingdom] : [name]));
  ok(ask('Homon', 'Plantae')?.family === 'Malvaceae' && ask('Homon', 'Animalia')?.family === 'Miridae', 'lookup: a homonym genus is answered in the kingdom asked');
  ok(ask('Homon', '')?.family === 'Miridae', 'lookup: without a kingdom, the most rows');
  ok(ask('Lonely', 'Plantae') == null && ask('Syno', 'Plantae') == null && ask('Abroad', 'Plantae') == null, 'lookup: only rows the tree is built from (species and below, accepted, in scope)');
  ok(ask('Split', 'Plantae')?.family === 'Malvaceae', 'lookup: rows that disagree → the most common chain');
  db.close();
}

// ── the lookup on the real TaiCOL module ───────────────────────────────────
const TW = new URL('../../../dist/datasets/tw-taicol.db', import.meta.url);
if (!existsSync(TW)) console.log('· external-tree: dist/datasets/tw-taicol.db not built — real-module lookup skipped');
else {
  const db = new DatabaseSync(TW.pathname, { readOnly: true });
  const SCOPE = "is_in_taiwan LIKE '%true%'";
  const ask = (rank, name, kingdom) => {
    const sql = checklistAboveSql(rank, 'taicol_names', SCOPE, !!kingdom);
    const r = db.prepare(sql).get(...(kingdom ? [name, kingdom] : [name]));
    if (!r) return null;
    return Object.fromEntries(CHAIN.slice(0, CHAIN.indexOf(rank)).map((c) => [c, r[c]]));
  };
  ok(eq(ask('genus', 'Digitaria', 'Plantae'), { kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida', order: 'Poales', family: 'Poaceae' }), `TaiCOL: 馬唐屬 Digitaria (${JSON.stringify(ask('genus', 'Digitaria', 'Plantae'))})`);
  ok(ask('class', 'Liliopsida', 'Plantae') === null, 'TaiCOL: no Liliopsida');
  ok(eq(ask('order', 'Poales', 'Plantae'), { kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida' }), 'TaiCOL: an order');
  ok(eq(placeRow(gbifMonocot(), ask), poa), 'TaiCOL: the GBIF 異馬唐 row lands on TaiCOL’s 馬唐屬');
  for (const rank of ['genus', 'family', 'class']) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${checklistAboveSql(rank, 'taicol_names', SCOPE, true)}`).all('x', 'Plantae').map((p) => p.detail).join(' | ');
    ok(plan.includes(`idx_taicol_${rank}`), `TaiCOL: the ${rank} lookup uses its own index (${plan})`);
  }
  db.close();
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ external-tree: 自建 on its own chain, GBIF / iNat on the checklist’s, the rest in the bucket; counts as the tree’s');
