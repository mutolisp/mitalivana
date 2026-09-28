/**
 * No new hex colour literals outside the palette files (UI redesign, Phase 2).
 *
 * Colours come from tailwind.config.js classes or, for props that cannot take
 * a class, from `useThemeColors()` in src/theme/colors.ts. Hex that predates
 * the rule is frozen per file in scripts/palette-baseline.json: a file may go
 * down, never up, and a file not listed may have none. Comment lines are not
 * counted, so explaining a colour costs nothing.
 *
 *   npm run check:palette              check
 *   npm run check:palette -- --update  rewrite the baseline after removing hex
 *
 * Text check, like check-add-guard.mjs.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE = 'scripts/palette-baseline.json';
const ALLOW = [
  /^src\/theme\//,
  /^src\/lib\/conservationColors\.ts$/,
  /^src\/lib\/rankColors\.ts$/,
  // NativeWind needs its bg-[#…] colour map as literals (see the file).
  /^src\/components\/SwipeRowActions\.tsx$/,
];
// 3/4/6/8 hex digits, not part of a longer word (`#1234567` is not a colour).
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
walk('src');
walk('app');

const counts = {};
const where = {};
for (const f of files) {
  if (ALLOW.some((re) => re.test(f))) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(HEX)) {
      counts[f] = (counts[f] ?? 0) + 1;
      (where[f] ??= []).push(`${f}:${i + 1}  ${m[0]}`);
    }
  });
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`✓ palette baseline written: ${total} hex literals in ${Object.keys(sorted).length} files`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const errors = [];
let shrunk = 0;
for (const [f, n] of Object.entries(counts)) {
  const allowed = baseline[f] ?? 0;
  if (n > allowed) {
    errors.push(`${f}: ${n} hex literals, baseline ${allowed}. Use a class or useThemeColors() (src/theme/colors.ts).`);
    for (const w of where[f]) errors.push(`    ${w}`);
  }
}
for (const [f, allowed] of Object.entries(baseline)) if ((counts[f] ?? 0) < allowed) shrunk += allowed - (counts[f] ?? 0);

if (errors.length) {
  for (const e of errors) console.error(e.startsWith('    ') ? e : `✖ ${e}`);
  process.exit(1);
}
const base = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`✓ palette: ${total} hex literals outside src/theme/ (baseline ${base})`);
if (shrunk) console.log(`  ${shrunk} fewer than the baseline — run \`npm run check:palette -- --update\` to lock that in.`);
