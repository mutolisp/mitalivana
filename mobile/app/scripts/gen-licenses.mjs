#!/usr/bin/env node
/**
 * Third-party licence manifest for the in-app attribution screen.
 *
 * Why generated rather than written by hand: the runtime dependency closure is
 * ~670 packages. A hand-kept list is wrong the first time someone runs
 * `npm install`, and a wrong attribution list is worse than an honest
 * "generated on <date>" one.
 *
 * What is collected: every package reachable from `dependencies`, with its
 * version, SPDX id and the verbatim text of its LICENSE/COPYING file.
 *
 * That closure is a SUPERSET of what actually ships. npm lists the Metro
 * bundler's own tooling under `dependencies`, so build-time-only packages come
 * along: `lightningcss` (NativeWind's CSS compiler, a Rust NAPI addon Hermes
 * cannot even load) and `caniuse-lite` (via browserslist) were both verified
 * absent from a production Hermes bundle — `css-to-rn`, lightningcss's only
 * importer, greps to zero while NativeWind's `cssInterop` runtime is present.
 *
 * Over-listing is deliberate: it is not a compliance problem, and the exact
 * set would require intersecting a `--dump-sourcemap` export, which would make
 * `check:licenses` need a full build. The screen's wording says "dependency
 * list", not "contained in this app", so the list does not overstate itself. The text is reproduced BYTE
 * FOR BYTE; identical texts are stored once and referenced by index, which is
 * safe because it is exact deduplication, not templating. Nothing is
 * paraphrased or reconstructed — MIT and BSD both require the notice itself,
 * not a summary of it.
 *
 * Usage:
 *   node scripts/gen-licenses.mjs           # write src/generated/licenses.json
 *   node scripts/gen-licenses.mjs --check   # exit 1 if that file is stale
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'src/generated/licenses.json';
const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)(\.|$)/i;

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** The licence text a package ships, or '' when it ships none. */
function licenseText(dir) {
  if (!existsSync(dir)) return '';
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return '';
  }
  // LICENSE first, NOTICE appended: Apache-2.0 §4(d) requires the NOTICE
  // contents to travel with the work, and they are not in the licence itself.
  const parts = [];
  for (const kind of [/^(LICEN[CS]E|COPYING)(\.|$)/i, /^NOTICE(\.|$)/i]) {
    const f = names.find((n) => kind.test(n) && LICENSE_FILE.test(n));
    if (!f) continue;
    try {
      const t = readFileSync(join(dir, f), 'utf8').trim();
      if (t) parts.push(t);
    } catch {
      // Unreadable is reported as absent rather than guessed at.
    }
  }
  return parts.join('\n\n');
}

function collect() {
  const root = readJson('package.json');
  if (!root) throw new Error('no package.json');
  const seen = new Set();
  const out = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const dir = join('node_modules', name);
    const p = readJson(join(dir, 'package.json'));
    if (!p) return;
    out.push({
      n: name,
      v: p.version ?? '',
      l: p.license || (p.licenses?.[0]?.type ?? ''),
      text: licenseText(dir),
      url:
        typeof p.repository === 'string' ? p.repository : (p.repository?.url ?? p.homepage ?? ''),
    });
    for (const d of Object.keys(p.dependencies || {})) visit(d);
  };
  for (const d of Object.keys(root.dependencies || {})) visit(d);
  out.sort((a, b) => a.n.localeCompare(b.n));
  return out;
}

function build() {
  const pkgs = collect();
  const texts = [];
  const index = new Map();
  const packages = pkgs.map((p) => {
    let t = -1;
    if (p.text) {
      if (!index.has(p.text)) {
        index.set(p.text, texts.length);
        texts.push(p.text);
      }
      t = index.get(p.text);
    }
    return { n: p.n, v: p.v, l: p.l, t, u: cleanUrl(p.url) };
  });
  return { packages, texts };
}

/** `git+https://github.com/x/y.git` → `https://github.com/x/y`. */
function cleanUrl(u) {
  if (!u) return '';
  return u
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

const data = build();
// Two spaces would add ~40% for no benefit; this file is read by a screen, not
// by a person.
const json = JSON.stringify(data) + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error(
      `✖ ${OUT} is stale — dependencies changed since it was generated.\n` +
        '  Run: npm run licenses',
    );
    process.exit(1);
  }
  console.log(`✓ licences: ${data.packages.length} packages, ${data.texts.length} distinct texts`);
} else {
  writeFileSync(OUT, json);
  const missing = data.packages.filter((p) => p.t < 0);
  console.log(
    `✓ ${OUT}: ${data.packages.length} packages, ${data.texts.length} distinct texts, ` +
      `${(json.length / 1024).toFixed(0)} KB`,
  );
  if (missing.length) {
    console.log(`  ${missing.length} ship no licence file (SPDX id only):`);
    console.log(
      '  ' +
        missing
          .slice(0, 10)
          .map((p) => `${p.n} (${p.l || '?'})`)
          .join(', ') +
        (missing.length > 10 ? ' …' : ''),
    );
  }
}
