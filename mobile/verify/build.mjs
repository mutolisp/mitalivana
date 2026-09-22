#!/usr/bin/env node
/**
 * Splice noble-ed25519 into `template.html` to produce `verify.html`.
 *
 * `verify.html` is committed, not built on demand: the whole point of that
 * file is that someone can be handed it, or find it years from now, and have
 * it work with no toolchain. This script exists so refreshing the inlined
 * library is a one-liner rather than a careful paste.
 *
 *   node build.mjs            # regenerate verify.html
 *   node build.mjs --check    # fail if verify.html is stale (exit 1)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const LIB = at('../app/node_modules/@noble/ed25519/index.js');
const MARKER = '/*__NOBLE_ED25519__*/';

let lib;
try {
  lib = readFileSync(LIB, 'utf8');
} catch {
  console.error(`cannot read ${LIB} — run npm install in mobile/app first`);
  process.exit(2);
}

const version = JSON.parse(
  readFileSync(at('../app/node_modules/@noble/ed25519/package.json'), 'utf8'),
).version;

// The library's own last line says to drop the export for browser use. An
// inline <script type="module"> cannot be imported from anywhere, so the
// exported names are simply bound into one local object instead.
const exported = /^export \{([^}]*)\};?\s*$/m.exec(lib);
if (!exported) {
  console.error('noble-ed25519 no longer ends in a single export statement — update this script');
  process.exit(2);
}
const names = exported[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Wrapped in an IIFE, not pasted at the top level. The library declares 63
// names of its own, one of which (`hexToBytes`) already collided with the
// page's — and a module-scope collision is a SyntaxError, so the page renders
// nothing at all rather than misbehaving visibly. Giving the library its own
// scope makes that impossible for any future version too.
const body = lib.slice(0, exported.index) + `\nreturn { ${names.join(', ')} };`;
try {
  // A real parse, not a grep: `import` and top-level `await` are both syntax
  // errors inside a function body, so this rejects exactly the library shapes
  // that cannot be wrapped. An earlier regex version flagged the `import` in
  // the library's own JSDoc example instead.
  // eslint-disable-next-line no-new-func
  new Function(body);
} catch (e) {
  console.error(`noble-ed25519 can no longer be inlined as one block: ${e.message}`);
  process.exit(2);
}
const inlined = [
  `// ── @noble/ed25519 v${version} — MIT, inlined verbatim ──────────────────`,
  `// Regenerate with \`node build.mjs\` in this folder; do not edit by hand.`,
  `const ed = (() => {`,
  body,
  `})();`,
  `// ── end of inlined library ────────────────────────────────────────────`,
].join('\n');

const template = readFileSync(at('template.html'), 'utf8');
if (!template.includes(MARKER)) {
  console.error(`template.html no longer contains ${MARKER}`);
  process.exit(2);
}
const html = template.replace(MARKER, inlined);

if (process.argv.includes('--check')) {
  const current = readFileSync(at('verify.html'), 'utf8');
  if (current !== html) {
    console.error('✗ verify.html is stale — run `node mobile/verify/build.mjs`');
    process.exit(1);
  }
  console.log(`✓ verify.html matches template.html + noble-ed25519 v${version}`);
  process.exit(0);
}

writeFileSync(at('verify.html'), html);
console.log(`✓ verify.html written (${(html.length / 1024).toFixed(0)} KB, noble-ed25519 v${version})`);
