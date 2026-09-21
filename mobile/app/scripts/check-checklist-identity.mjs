/**
 * What a checklist document treats as one species.
 *
 * The rule has three parts and losing any one of them is a silent data error
 * that only shows up in a delivered Word file:
 *   - taxon_id alone would merge two determinations of the same taxon
 *   - and would merge `Orchidaceae sp1` with `sp2`, which are two morphospecies
 *   - while the occurrence outputs must keep every record regardless
 *
 * Run: npm run check:checklistid
 */
import { checklistIdentity, uniqueByIdentity } from '../src/lib/checklistIdentity.ts';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};

// An identification that stopped at the family: one taxon_id, two species.
const rows = [
  { id: 1, taxon_id: 't-orchid', used_scientific_name: null, verbatim_identification: 'sp1' },
  { id: 2, taxon_id: 't-orchid', used_scientific_name: null, verbatim_identification: 'sp2' },
  { id: 3, taxon_id: 't-orchid', used_scientific_name: null, verbatim_identification: 'sp1' },
  { id: 4, taxon_id: 't-machilus', used_scientific_name: null, verbatim_identification: null },
  { id: 5, taxon_id: 't-machilus', used_scientific_name: null, verbatim_identification: null },
  { id: 6, taxon_id: 't-machilus', used_scientific_name: 'Machilus japonica', verbatim_identification: null },
];

const kept = uniqueByIdentity(rows).map((r) => r.id);
eq('first row of each identity survives, in order', kept, [1, 2, 4, 6]);
eq('sp1 and sp2 stay apart', uniqueByIdentity(rows).filter((r) => r.taxon_id === 't-orchid').length, 2);
eq(
  'one species photographed five times collapses to one',
  uniqueByIdentity(rows).filter((r) => r.taxon_id === 't-machilus' && !r.used_scientific_name).length,
  1,
);
eq(
  'a deliberate synonym is its own line',
  uniqueByIdentity(rows).some((r) => r.used_scientific_name === 'Machilus japonica'),
  true,
);

eq('identity is all three parts', checklistIdentity(rows[0]), 't-orchid||sp1');
eq('absent parts normalise to empty, never to "null"', checklistIdentity({ taxon_id: 'x' }), 'x||');
eq(
  'null and empty string are the same absence',
  checklistIdentity({ taxon_id: 'x', verbatim_identification: null }),
  checklistIdentity({ taxon_id: 'x', verbatim_identification: '' }),
);
eq('empty input', uniqueByIdentity([]), []);

if (failures > 0) {
  console.error(`✗ checklist-identity: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ checklist-identity: morphospecies stay apart, repeats collapse');
