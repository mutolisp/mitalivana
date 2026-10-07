#!/usr/bin/env node
/**
 * Guard the usage-mode capability table (src/lib/usageMode.ts).
 *
 *   1. Every capability has a valid value for all three modes.
 *   2. No capability is hidden in pro mode: pro is "everything there is
 *      today", so hiding something there is a regression, not a mode. The
 *      exception is SIMPLE_ONLY: things only the simpler modes have.
 *   3. Every capability is used somewhere outside the table itself. A
 *      capability nobody reads means a screen the table claims to control
 *      but does not.
 *   4. The pure helpers behave: mode parsing, the ＋ defaults a mode offers and
 *      the one kept after a switch, and the label trimming of the simpler
 *      modes.
 *
 * Usage: npm run check:modes   (exit 1 on violation)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SOURCE = 'src/lib/usageMode.ts';
const {
  CAPS,
  SIMPLE_ONLY,
  USAGE_MODES,
  allowedRecordTypeDefaults,
  fieldLabel,
  parseUsageMode,
  settleRecordTypeDefault,
} = await import('../src/lib/usageMode.ts');

const errors = [];
const VIS = new Set(['show', 'adv', 'hide']);

for (const [cap, v] of Object.entries(CAPS)) {
  for (const m of USAGE_MODES) {
    if (!VIS.has(v[m])) errors.push(`${cap}: ${m} is ${JSON.stringify(v[m])}, not show / adv / hide`);
  }
  if (v.pro !== 'show' && !SIMPLE_ONLY.has(cap)) errors.push(`${cap}: hidden or folded in pro mode (pro shows everything)`);
  if (SIMPLE_ONLY.has(cap) && v.pro === 'show') errors.push(`${cap}: in SIMPLE_ONLY but shown in pro`);
}

// Every source file, with the CAPS literal cut out of usageMode.ts so the
// table does not count as its own use.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'app'))];
const corpus = files
  .map((f) => {
    const text = readFileSync(f, 'utf8');
    if (relative(ROOT, f) !== SOURCE) return text;
    const start = text.indexOf('export const CAPS');
    const end = text.indexOf('\n};', start);
    if (start < 0 || end < 0) {
      errors.push(`${SOURCE}: cannot find the CAPS literal`);
      return text;
    }
    return text.slice(0, start) + text.slice(end + 3);
  })
  .join('\n');
for (const cap of Object.keys(CAPS)) {
  if (!new RegExp(`['"]${cap}['"]`).test(corpus)) errors.push(`${cap}: not used outside the CAPS table`);
}

function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) errors.push(`${label}: got ${a}, want ${b}`);
}

eq('parse vol', parseUsageMode('vol'), 'vol');
eq('parse casual', parseUsageMode('casual'), 'casual');
eq('parse unknown', parseUsageMode('volunteer'), null);
eq('parse missing', parseUsageMode(undefined), null);

eq('＋ defaults pro', allowedRecordTypeDefaults('pro'), ['ask', 'session', 'plot', 'collection']);
eq('＋ defaults vol', allowedRecordTypeDefaults('vol'), ['ask', 'session', 'transect', 'point_count']);
eq('settle vol keeps transect', settleRecordTypeDefault('vol', 'transect'), 'transect');
eq('settle pro drops point_count', settleRecordTypeDefault('pro', 'point_count'), 'ask');
eq('＋ defaults casual', allowedRecordTypeDefaults('casual'), []);
eq('settle vol keeps session', settleRecordTypeDefault('vol', 'session'), 'session');
eq('settle vol drops collection', settleRecordTypeDefault('vol', 'collection'), 'ask');
eq('settle vol drops plot', settleRecordTypeDefault('vol', 'plot'), 'ask');
eq('settle pro keeps plot', settleRecordTypeDefault('pro', 'plot'), 'plot');
eq('settle casual', settleRecordTypeDefault('casual', 'session'), 'ask');

eq('label pro keeps the term', fieldLabel('數量 (organismQuantity)', 'pro'), '數量 (organismQuantity)');
eq('label vol drops the term', fieldLabel('數量 (organismQuantity)', 'vol'), '數量');
eq('label casual drops the term', fieldLabel('調查者 (recordedBy)', 'casual'), '調查者');
eq('label long term', fieldLabel('總植被覆蓋度 (totalCoverInPercentage)', 'vol'), '總植被覆蓋度');
eq('label English', fieldLabel('Quantity (organismQuantity)', 'vol'), 'Quantity');
eq('label full-width parentheses', fieldLabel('数量（organismQuantity）', 'vol'), '数量');
eq('label keeps a unit', fieldLabel('覆蓋度 (% cover)', 'vol'), '覆蓋度 (% cover)');
eq('label keeps a unit list', fieldLabel('胸高直徑 (DBH, cm)', 'vol'), '胸高直徑 (DBH, cm)');
eq('label drops a term before a note', fieldLabel('花/果 (reproductiveCondition，可複選)', 'vol'), '花/果 (可複選)');
eq('label drops a term before a note, en', fieldLabel('Leaf (leafPhenology, multi-select)', 'vol'), 'Leaf (multi-select)');
eq('label drops a term before a note, ja', fieldLabel('葉 (leafPhenology、複数選択可)', 'vol'), '葉 (複数選択可)');
eq('label pro keeps a term before a note', fieldLabel('花/果 (reproductiveCondition，可複選)', 'pro'), '花/果 (reproductiveCondition，可複選)');
eq('label keeps a one-letter unit', fieldLabel('寬 (m)', 'vol'), '寬 (m)');
eq('label keeps a two-letter unit', fieldLabel('高度 (cm)', 'vol'), '高度 (cm)');
eq('label keeps percent', fieldLabel('覆蓋度 (%)', 'vol'), '覆蓋度 (%)');
eq('label keeps an abbreviation', fieldLabel('隊伍總容量（MB）', 'vol'), '隊伍總容量（MB）');
eq('label without parentheses', fieldLabel('數量', 'vol'), '數量');
// A plain word opening a list is not a term (code review L56): tm() runs over descriptions too.
eq('label keeps a list in a description, fr', fieldLabel('Toutes les fiches (listes, placettes, collectes et GLORIA réunis)', 'vol'), 'Toutes les fiches (listes, placettes, collectes et GLORIA réunis)');
eq('label keeps a list in a description, es', fieldLabel('Todos los registros (listas, parcelas, colectas y GLORIA)', 'vol'), 'Todos los registros (listas, parcelas, colectas y GLORIA)');

// Observation tips (src/lib/observationTips.ts) are read out of a table, so
// check:i18n cannot see their keys: every one must exist in every locale.
const { allTipKeys } = await import('../src/lib/observationTips.ts');
const LOCALES = ['zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es'];
for (const loc of LOCALES) {
  const dict = JSON.parse(readFileSync(join(ROOT, `src/i18n/locales/${loc}.json`), 'utf8'));
  for (const key of allTipKeys()) {
    const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
    if (typeof v !== 'string' || v === '') errors.push(`observation tip ${key}: missing in ${loc}`);
  }
}

if (errors.length) {
  console.error(`✗ modes: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `✓ modes: ${Object.keys(CAPS).length} capabilities, all used, none hidden in pro; helpers behave; ${allTipKeys().length} tip keys in ${LOCALES.length} locales`,
);
