#!/usr/bin/env node
/**
 * The identification-key scope index, checked against the REAL tw-keys module.
 *
 * Why this exists: the alias index was built under the key's own `scope_rank`,
 * so a family-scoped key aliased to its single genus was filed at
 * `family:Davallia` while every caller asks for `genus:Davallia`. Nothing
 * caught it — the index built fine, the lookup ran fine, and the answer was
 * just empty. `tsc`, `lint` and every other check were green throughout, and
 * the only symptom was a 🔑 icon that never appeared on seven genus nodes.
 *
 * So this asserts on ANSWERS, from the shipped data, not on the shape of the
 * code. It reads `dist/datasets/tw-keys.db`, which is the exact file published
 * to R2 (`make datasets` → `datasets-upload`); when that file is absent the
 * check skips rather than fails, because a fresh clone has not built it yet.
 *
 * Usage: npm run check:keys   (exit 1 on violation)
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildScopeIndex, lookupScope } from '../src/lib/keyScopeIndex.ts';

const DB_PATH = fileURLToPath(new URL('../../../dist/datasets/tw-keys.db', import.meta.url));

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('check:keys');

if (!existsSync(DB_PATH)) {
  console.log(`  – skipped: ${DB_PATH} not built (run \`make datasets\`)`);
  process.exit(0);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const keys = db
  .prepare('SELECT id, scope_rank, scope_name, aliases FROM identification_keys')
  .all();
const index = buildScopeIndex(keys);

ok(keys.length > 500, `loaded ${keys.length} keys from the shipped module`);

// ── 1. Every alias must be reachable at the rank its NAME implies ──────────
// An alias only exists because the name's rank differs from the key's scope,
// so "reachable from the key's own rank" is not the property that matters.
const aliased = keys.filter((k) => k.aliases && k.aliases !== '[]');
ok(aliased.length > 0, `${aliased.length} keys carry aliases`);

for (const k of aliased) {
  for (const alias of JSON.parse(k.aliases)) {
    // A Latin family name ends in -aceae; anything else on a family key is
    // the genus (or, for Bambusoideae, a Chinese subfamily name).
    const probeRank = /aceae$/.test(alias) ? 'family' : 'genus';
    const hit = lookupScope(index, probeRank, alias).some((x) => x.id === k.id);
    ok(hit, `${probeRank}:${alias} → key #${k.id} (${k.scope_rank} ${k.scope_name})`);
  }
}

// ── 2. 骨碎補: the reported case, end to end ───────────────────────────────
// Davalliaceae 骨碎補科 is a single-genus family in TaiCOL; the key is filed at
// family rank, and the tree/детail sheet ask for the genus.
{
  const atGenus = lookupScope(index, 'genus', 'Davallia');
  ok(atGenus.length > 0, '骨碎補: genus:Davallia finds a key', 'this is the regression');
  const atFamily = lookupScope(index, 'family', 'Davalliaceae');
  ok(atFamily.length > 0, '骨碎補: family:Davalliaceae finds a key');
  ok(
    atGenus.some((k) => atFamily.some((f) => f.id === k.id)),
    '骨碎補: both routes reach the same key',
  );
}

// ── 3. Exact-rank lookups must not have changed ───────────────────────────
// The alias bucket is additive. If a key stopped answering at its own
// (scope_rank, scope_name) the fix would have broken more than it fixed.
{
  let missing = 0;
  for (const k of keys) {
    if (!k.scope_name) continue;
    if (!lookupScope(index, k.scope_rank, k.scope_name).some((x) => x.id === k.id)) missing += 1;
  }
  ok(missing === 0, 'every key still answers at its own rank + name', `${missing} missing`);
}

// ── 4. A lookup never returns the same key twice ──────────────────────────
// Selaginella and Asplenium have BOTH a genus key and an aliased family key,
// which is the case where naive concatenation would duplicate.
{
  let dupes = 0;
  for (const k of keys) {
    if (!k.scope_name) continue;
    const got = lookupScope(index, k.scope_rank, k.scope_name);
    if (new Set(got.map((x) => x.id)).size !== got.length) dupes += 1;
  }
  ok(dupes === 0, 'no lookup returns a duplicate key', `${dupes} scopes duplicated`);
}

// ── 5. Null index fails open ──────────────────────────────────────────────
// Tree rendering happens before prewarmKeys() on a cold start; an exception
// there would blank the taxonomy tab.
ok(lookupScope(null, 'genus', 'Davallia').length === 0, 'null index returns [] rather than throwing');

if (failed > 0) {
  console.error(`✗ keys: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`✓ keys: scope index resolves all ${aliased.length} aliased keys from the shipped module`);
