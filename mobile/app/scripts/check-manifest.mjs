#!/usr/bin/env node
/**
 * Export manifests must describe what is actually in the zip.
 *
 * `manifest.json` used to carry counts only — "42 records, 17 photos" — which
 * says nothing about whether those 17 photos are the ones the yml names, or
 * whether any of them arrived intact. The `files` list closes that: a yml
 * lifted out of the zip on its own can still be checked against its media.
 *
 * Three properties matter enough to pin, because breaking any of them is
 * silent: the digests must be real SHA-256, the order must be stable so two
 * exports of unchanged data match byte for byte, and a manifest must never
 * list itself or another manifest.
 *
 * Usage: npm run check:manifest   (exit 1 on violation)
 */
import { createHash } from 'node:crypto';
import { injectFileDigests, isManifestPath, manifestFiles } from '../src/lib/manifestDigest.ts';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('check:manifest');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const entry = (name, text) => ({ name, bytes: enc(text) });

// ── 1. The digest is really SHA-256 ───────────────────────────────────────
// Checked against node:crypto rather than against another call of the same
// function — a self-consistent wrong hash would pass that.
{
  const files = manifestFiles('rec/manifest.json', [entry('rec/a.yml', 'hello')]);
  const want = createHash('sha256').update('hello').digest('hex');
  ok(files[0]?.sha256 === want, 'sha256 matches node:crypto', `got ${files[0]?.sha256}`);
  ok(files[0]?.bytes === 5, 'byte length recorded', `got ${files[0]?.bytes}`);
}

// ── 2. Stable order regardless of production order ────────────────────────
// Photos are appended as they are read, which depends on the media library.
// Without sorting, the same export would produce a different manifest each
// time and every digest downstream would be noise.
{
  const a = manifestFiles('r/manifest.json', [
    entry('r/photos/z.jpg', '1'), entry('r/a.yml', '2'), entry('r/photos/b.jpg', '3'),
  ]);
  const b = manifestFiles('r/manifest.json', [
    entry('r/photos/b.jpg', '3'), entry('r/photos/z.jpg', '1'), entry('r/a.yml', '2'),
  ]);
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    'file order does not depend on the order files were produced',
  );
  ok(
    a.map((f) => f.path).join(',') === 'a.yml,photos/b.jpg,photos/z.jpg',
    'sorted by path',
    a.map((f) => f.path).join(','),
  );
}

// ── 3. Scope is the manifest's own folder, paths relative to it ───────────
// So one record verifies identically whether exported alone or in a batch.
{
  const entries = [
    entry('recA/a.yml', 'a'), entry('recA/photos/p.jpg', 'p'),
    entry('recB/b.yml', 'b'),
  ];
  const a = manifestFiles('recA/manifest.json', entries);
  ok(a.length === 2 && a.every((f) => !f.path.startsWith('rec')), 'folder-scoped, paths relative',
    JSON.stringify(a.map((f) => f.path)));
  const root = manifestFiles('bundle_manifest.json', entries);
  ok(root.length === 3, 'root bundle manifest covers every folder', `got ${root.length}`);
  ok(
    root.map((f) => f.path).includes('recA/photos/p.jpg'),
    'root manifest keeps full paths',
  );
}

// ── 4. No manifest ever lists a manifest ──────────────────────────────────
// The manifest is the integrity root; hashing one root inside another makes
// the order they are written part of the format.
{
  ok(isManifestPath('manifest.json'), 'isManifestPath: root manifest');
  ok(isManifestPath('rec/manifest.json'), 'isManifestPath: folder manifest');
  ok(isManifestPath('bundle_manifest.json'), 'isManifestPath: bundle manifest');
  ok(!isManifestPath('rec/a.yml'), 'isManifestPath: ordinary file');
  const root = manifestFiles('bundle_manifest.json', [
    entry('recA/manifest.json', '{}'), entry('recA/a.yml', 'a'), entry('manifest.json', '{}'),
  ]);
  ok(root.length === 1 && root[0].path === 'recA/a.yml', 'manifests excluded from file lists',
    JSON.stringify(root.map((f) => f.path)));
}

// ── 5. injectFileDigests rewrites manifests and nothing else ──────────────
{
  const entries = [
    entry('rec/manifest.json', JSON.stringify({ app: 'mitalivana', record_count: 2 })),
    entry('rec/a.yml', 'hello'),
    entry('rec/notes.txt', 'plain'),
  ];
  const before = dec(entries[1].bytes);
  injectFileDigests(entries, dec, enc);
  const doc = JSON.parse(dec(entries[0].bytes));
  ok(doc.app === 'mitalivana' && doc.record_count === 2, 'existing manifest fields survive');
  ok(Array.isArray(doc.files) && doc.files.length === 2, 'files added', JSON.stringify(doc.files));
  ok(dec(entries[1].bytes) === before, 'non-manifest entries untouched');
}

// ── 6. A manifest that is not JSON is left alone, not corrupted ───────────
// Failing to add a digest is recoverable; destroying the file is not.
{
  const entries = [entry('rec/manifest.json', 'not json at all'), entry('rec/a.yml', 'a')];
  injectFileDigests(entries, dec, enc);
  ok(dec(entries[0].bytes) === 'not json at all', 'unparseable manifest left untouched');
}

if (failed > 0) {
  console.error(`✗ manifest: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ manifest: digests are real, ordered, folder-scoped and self-excluding');
