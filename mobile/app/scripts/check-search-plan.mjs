#!/usr/bin/env node
/**
 * The hot search queries must keep the query plan they were tuned for.
 *
 * `taicol_names` has an index on `usage_status`, a column with about two
 * distinct values over 270k rows. SQLite happily picks it, and the result is
 * a half-table scan that still *returns the right answer* — which is why this
 * kind of regression survives every other check. The `markSensuLato` lookup
 * cost ~17 ms per result row that way, on every keystroke, for every binomial
 * on screen.
 *
 * So this asserts on the PLAN, not the output, against the module actually
 * shipped (`dist/datasets/tw-taicol.db`). Skips when it has not been built.
 *
 * Run: npm run check:searchplan
 */
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DB_PATH = fileURLToPath(new URL('../../../dist/datasets/tw-taicol.db', import.meta.url));
const SEARCH_TS = fileURLToPath(new URL('../src/db/search.ts', import.meta.url));

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};

console.log('check:searchplan');

// The shape has to survive in source even when the module is absent, because
// dropping the `+` is the specific edit that silently undoes the tuning.
{
  const src = readFileSync(SEARCH_TS, 'utf8');
  // Scope to the function body — `simple_name LIKE ?` is legitimate elsewhere
  // in this file (free-text name search), and an earlier version of this check
  // fired on those.
  const start = src.indexOf('function markSensuLato');
  const body = start === -1 ? '' : src.slice(start, src.indexOf('\n}\n', start));
  ok(start !== -1, 'markSensuLato still exists');
  ok(
    /\+t\.usage_status = 'accepted'/.test(body),
    'markSensuLato keeps the unary + that disqualifies idx_taicol_usage_status',
    'without it the planner reverts to the low-selectivity index',
  );
  ok(
    !/simple_name LIKE \?/.test(body),
    'markSensuLato does not use LIKE (it cannot use an index)',
  );
  ok(
    /WITH p\(lo, hi\) AS \(VALUES/.test(body),
    'markSensuLato still batches every binomial into one statement',
  );
}

if (!existsSync(DB_PATH)) {
  console.log('  – plan check skipped: dist/datasets/tw-taicol.db not built (run `make datasets`)');
  process.exit(failed > 0 ? 1 : 0);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// Two binomials is enough: the plan does not change with the row count, and
// this keeps the check instant.
{
  const sql = `WITH p(lo, hi) AS (VALUES (?,?),(?,?))
     SELECT DISTINCT t.simple_name FROM p JOIN taicol_names t
       ON t.simple_name >= p.lo AND t.simple_name < p.hi
      WHERE +t.usage_status = 'accepted'
        AND t.is_in_taiwan LIKE '%true%'
        AND t.rank IN ('Subspecies','Variety','Form')`;
  const plan = db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all('Quercus glauca ', 'Quercus glauca!', 'Ficus erecta ', 'Ficus erecta!')
    .map((r) => r.detail)
    .join(' | ');

  ok(
    /SEARCH t USING INDEX idx_taicol_simple_name/.test(plan),
    'the sensu-lato lookup seeks on idx_taicol_simple_name',
    plan,
  );
  ok(
    !/idx_taicol_usage_status/.test(plan),
    'it does not fall back to the usage_status index',
    plan,
  );
  ok(!/\bSCAN taicol_names\b/.test(plan), 'it is not a full table scan', plan);
}

// And the range bound really is exact: ' ' is 0x20, '!' is 0x21, so every
// string beginning 'X ' sorts below 'X!'. A wrong bound would quietly drop
// or over-collect infraspecific names.
{
  const hit = db
    .prepare(
      `SELECT COUNT(*) AS n FROM taicol_names
        WHERE simple_name >= ? AND simple_name < ?`,
    )
    .get('Quercus glauca ', 'Quercus glauca!').n;
  const viaLike = db
    .prepare(`SELECT COUNT(*) AS n FROM taicol_names WHERE simple_name LIKE ?`)
    .get('Quercus glauca %').n;
  ok(hit === viaLike, 'the range bound matches exactly what the old LIKE matched', `${hit} vs ${viaLike}`);
}

if (failed > 0) {
  console.error(`✗ searchplan: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ searchplan: the sensu-lato lookup keeps its index seek');
