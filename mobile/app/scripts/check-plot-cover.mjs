/**
 * The total-vegetation-cover sanity rule.
 *
 * Σ species cover ≥ total cover, because crowns overlap. A total above the sum
 * is impossible in the field. The rule is only meaningful when every layer
 * holding records measures in per cent, and getting that condition wrong makes
 * the warning either useless (fires always) or absent.
 *
 * Run: npm run check:plotcover
 */
import { checkPlotCover } from '../src/lib/plotCoverCheck.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};
const pct = (layer, v) => ({ layer, organism_quantity: String(v), organism_quantity_type: '% cover' });
const L = (i, method) => ({ layer_index: i, method });

// Overlap is normal: three species covering 40% each under a 60% canopy.
eq('sum above total is fine', checkPlotCover(60, [L(2, 'percent')],
  [pct('E2', 40), pct('E2', 40), pct('E2', 40)]).kind, 'ok');

// The impossible case.
eq('total above sum warns', checkPlotCover(80, [L(2, 'percent')], [pct('E2', 30)]),
  { kind: 'total-exceeds-species', total: 80, speciesSum: 30 });

// Equality is the boundary and must NOT warn.
eq('equal is fine', checkPlotCover(50, [L(2, 'percent')], [pct('E2', 20), pct('E2', 30)]).kind, 'ok');

// A DBH layer contributes no cover, so its species would be missing from the
// sum — checking anyway would warn on every mixed-method plot.
eq('a DBH layer in use disables the check',
  checkPlotCover(80, [L(2, 'percent'), L(5, 'DBH')], [pct('E2', 30), { layer: 'E5', organism_quantity: '22', organism_quantity_type: 'DBH (cm)' }]),
  { kind: 'not-applicable', reason: 'non-percent-method' });

// Braun-Blanquet midpoints are estimates; they do not get to call real data wrong.
eq('a BB layer in use disables the check',
  checkPlotCover(80, [L(2, 'BB')], [{ layer: 'E2', organism_quantity: '3', organism_quantity_type: 'Braun-Blanquet Scale' }]).kind,
  'not-applicable');

// An unused DBH layer must not silence a plot that is otherwise all per cent.
eq('an EMPTY DBH layer does not disable it',
  checkPlotCover(80, [L(2, 'percent'), L(5, 'DBH')], [pct('E2', 30)]).kind,
  'total-exceeds-species');

eq('no total recorded', checkPlotCover(null, [L(2, 'percent')], [pct('E2', 30)]),
  { kind: 'not-applicable', reason: 'no-total' });
eq('no species yet', checkPlotCover(80, [L(2, 'percent')], []),
  { kind: 'not-applicable', reason: 'no-species' });
eq('zero total never warns', checkPlotCover(0, [L(2, 'percent')], [pct('E2', 30)]).kind, 'ok');
eq('unparseable values are skipped, not counted as 0',
  checkPlotCover(20, [L(2, 'percent')], [pct('E2', 30), { layer: 'E2', organism_quantity: 'abundant', organism_quantity_type: '% cover' }]).kind,
  'ok');
eq('float noise is not a contradiction',
  checkPlotCover(60, [L(2, 'percent')], [pct('E2', 20.1), pct('E2', 19.9), pct('E2', 20)]).kind, 'ok');
// Transect rows carry layer 'T' and no layer row; they must not trip the method gate.
eq('transect layer is ignored by the method gate',
  checkPlotCover(80, [], [pct('T', 30)]).kind, 'total-exceeds-species');

if (failures > 0) {
  console.error(`✗ plot-cover: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ plot-cover: total ≤ Σ species, and only where per-cent cover is the unit');
