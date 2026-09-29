#!/usr/bin/env node
/**
 * `npm run check`: every `check:*` script in package.json, one after another,
 * with a pass / fail line each and a non-zero exit if any failed. Reads the
 * list from package.json, so a new guard is picked up by adding its script.
 *
 * Usage: npm run check
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const scripts = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts)
  .filter((k) => k.startsWith('check:'));
const failed = [];
for (const name of scripts) {
  const r = spawnSync('npm', ['run', '-s', name], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed.push({ name, out: `${r.stdout}${r.stderr}` });
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
if (failed.length) {
  for (const f of failed) console.error(`\n── ${f.name} ──\n${f.out.trim().split('\n').slice(-15).join('\n')}`);
  console.error(`\n✗ check: ${failed.length} of ${scripts.length} failed`);
  process.exit(1);
}
console.log(`\n✓ check: all ${scripts.length} passed`);
