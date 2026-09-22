#!/usr/bin/env node
/**
 * Patterns that make React Compiler give up on a whole component.
 *
 * The compiler bails out of an ENTIRE component when a `try` / `catch` block
 * contains a value block — a ternary, `??`, or optional chaining
 * ("Support value blocks within a try/catch"). Nothing reports it: types pass,
 * lint passes, the app behaves identically and simply re-renders more than it
 * needs to. That is why `e instanceof Error ? e.message : String(e)` spread to
 * 34 call sites before anyone noticed.
 *
 * So this checks for the shape, not the behaviour — the behaviour is correct
 * either way, which is exactly the problem.
 *
 * Run: npm run check:compiler
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Where the helper itself lives; it is the one place the ternary belongs. */
const ALLOWED = 'src/lib/errText.ts';

let failed = 0;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(name)) {
      yield p;
    }
  }
}

console.log('check:compiler');

// The exact shape that was everywhere. Written out rather than "any ternary in
// a catch" because that would need a parser, and this one pattern accounted
// for every occurrence.
const INLINE_ERR = /instanceof Error \? [\w$]+\.message : String\(/;

const offenders = [];
for (const dir of ['src', 'app']) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = file.slice(ROOT.length);
    if (rel === ALLOWED) continue;
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (INLINE_ERR.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
}

if (offenders.length > 0) {
  failed += 1;
  console.error(
    `  ✗ ${offenders.length} inline error ternar${offenders.length === 1 ? 'y' : 'ies'} — ` +
      `use \`errText(e)\` from ~/lib/errText instead`,
  );
  for (const o of offenders.slice(0, 12)) console.error(`      ${o}`);
} else {
  console.log('  ✓ no inline error ternaries outside the helper');
}

// The helper has to keep the ternary — a version that calls itself, or that
// got "simplified" into the call sites' shape, would be worse than useless.
{
  const src = readFileSync(join(ROOT, ALLOWED), 'utf8');
  const ok = /return e instanceof Error \? e\.message : String\(e\);/.test(src);
  if (!ok) {
    failed += 1;
    console.error(`  ✗ ${ALLOWED} no longer returns the message it is supposed to`);
  } else {
    console.log('  ✓ the helper still formats the message itself');
  }
}

if (failed > 0) {
  console.error('✗ compiler: React Compiler would bail out of the components above');
  process.exit(1);
}
console.log('✓ compiler: no known bail-out shapes in src/ or app/');
