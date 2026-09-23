#!/usr/bin/env node
/**
 * A root-hosted lookup must never be opened straight from inside a Modal.
 *
 * `GbifLookupHost` is a Modal mounted at the navigation root. Presenting it
 * while another Modal is up crashes iOS ("Attempt to present … which is already
 * presenting"). It shipped three times — the species popup's 「編輯自建物種」,
 * the batch importer's 「查 GBIF」, and SearchBox inside the photo import sheet.
 *
 * Text check, same reasoning as check-bottom-dock.mjs: the failure is always a
 * file that renders a <Modal> and also reaches the host directly. In such a
 * file every call must go through `runOverModal`, and every <SearchBox> must be
 * handed `runLookup`.
 *
 * Not covered: a component with no <Modal> of its own that is rendered inside
 * one (SpeciesDetailPanel). That one takes `onEditManualTaxon` from its host.
 *
 * Run: npm run check:modallookup
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.tsx')) files.push(p);
  }
};
walk(join(root, 'src'));
walk(join(root, 'app'));

const CALLS = /\b(lookupGbifName|manualTaxonEntry|editManualTaxon)\(/g;
let failures = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  // The host's own Modal is the one being presented, not one it sits in.
  if (!src.includes('<Modal') || rel.endsWith('GbifLookupHost.tsx')) continue;
  for (const m of src.matchAll(CALLS)) {
    // Wrapped = the call is the thunk handed to a `runOverModal(` that opens
    // just before it (same line or a few lines up when the call is wrapped).
    const before = src.slice(Math.max(0, m.index - 120), m.index);
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const isImport = /^import\b/.test(src.slice(lineStart, m.index));
    if (isImport || before.includes('runOverModal(')) continue;
    failures += 1;
    const line = src.slice(0, m.index).split('\n').length;
    console.error(`  ✗ ${rel}:${line} opens the lookup host directly from a Modal`);
  }
  // Each <SearchBox …> element, up to the closing of its props.
  for (const m of src.matchAll(/<SearchBox\b[\s\S]*?\/>/g)) {
    if (!m[0].includes('runLookup=')) {
      failures += 1;
      const line = src.slice(0, m.index).split('\n').length;
      console.error(`  ✗ ${rel}:${line} <SearchBox> inside a Modal without runLookup`);
    }
  }
}

if (failures > 0) {
  console.error(`✗ modal-lookup: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ modal-lookup: no Modal opens the root lookup host directly');
