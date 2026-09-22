#!/usr/bin/env node
/**
 * Three independent verifiers must reach the same conclusion.
 *
 * That is the only evidence that the format has no ambiguity in it. A single
 * implementation checked against itself proves nothing: if `verify.mjs` and
 * the app share a misreading, they agree and are both wrong. Writing the
 * checks three times, in three languages, against one fixture is what turns
 * "the signature verifies" into a statement about the format rather than
 * about one piece of code.
 *
 * The fixture is built by the app's OWN export path — `injectFileDigests`
 * then `injectSignatures`, zipped with the same fflate call `finalizeZip`
 * makes — so it is not a hand-written approximation of what ships.
 *
 * Two cases, because a verifier that says PASS to everything passes case 1:
 *   1. an untouched export            → all three PASS
 *   2. one byte flipped in one photo  → all three FAIL, naming that photo
 *
 * `verify.html` is driven too, through `headless.mjs`: everything that page
 * does — DecompressionStream, crypto.subtle, the inlined noble — is a web
 * standard Node implements as well. Layout and the file picker still need a
 * browser and are in mobile/Device_test.md. That harness earned its keep on
 * its first run, catching a name collision between the inlined library and the
 * page that made the whole script a SyntaxError — a blank page in any
 * browser.
 *
 *   node crosscheck.mjs          # exit 1 on any disagreement
 *   node crosscheck.mjs --keep   # leave the fixture on disk to poke at
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync, zipSync } from '../app/node_modules/fflate/esm/browser.js';
import { injectFileDigests } from '../app/src/lib/manifestDigest.ts';
import { injectSignatures, publicKeyFromSeed } from '../app/src/lib/signing.ts';
import { verifyInPage } from './headless.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};

console.log('crosscheck: verify.mjs vs verify.py vs verify.html');

// ── Fixture ───────────────────────────────────────────────────────────────
// A fixed seed, so the fixture is byte-identical on every run and a
// disagreement is never "well, it was a different key that time".
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const SIGNER = {
  name: 'Lin, Cheng-Tao',
  orcid: '0000-0002-1825-0097',
  publicKey: publicKeyFromSeed(SEED),
};

function buildFixtureZip() {
  const base = 'fixture_session';
  const entries = [
    {
      name: `${base}/manifest.json`,
      bytes: enc(
        JSON.stringify(
          { app: 'mitalivana', schema_version: 2, kind: 'session', name: '測試名錄', record_count: 2 },
          null,
          2,
        ),
      ),
    },
    { name: `${base}/record.yml`, bytes: enc('name: 測試名錄\nrecords:\n  - 臺灣杉\n  - 紅檜\n') },
    { name: `${base}/photos/a.jpg`, bytes: enc('PRETEND-JPEG-BYTES-A') },
    { name: `${base}/photos/b.jpg`, bytes: enc('PRETEND-JPEG-BYTES-B') },
  ];
  injectFileDigests(entries, dec, enc);
  injectSignatures(entries, SIGNER, SEED, dec, enc);
  const zippable = {};
  for (const e of entries) zippable[e.name] = e.bytes;
  return zipSync(zippable, { level: 6 });
}

const dir = mkdtempSync(join(tmpdir(), 'mitalivana-verify-'));
const good = buildFixtureZip();
writeFileSync(join(dir, 'good.zip'), good);

// Flip one byte inside one photo, then rezip — exactly what a re-encoding
// chat app or a careless editor does.
{
  const files = unzipSync(good);
  const key = Object.keys(files).find((k) => k.endsWith('photos/b.jpg'));
  files[key] = files[key].slice();
  files[key][0] ^= 0x01;
  writeFileSync(join(dir, 'tampered.zip'), zipSync(files, { level: 6 }));
}

// verify.mjs reads a folder; unpack both.
for (const which of ['good', 'tampered']) {
  const files = unzipSync(
    new Uint8Array(execFileSync('cat', [join(dir, `${which}.zip`)], { encoding: 'buffer' })),
  );
  for (const [name, bytes] of Object.entries(files)) {
    const dest = join(dir, which, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}

// ── Run them ──────────────────────────────────────────────────────────────
function run(cmd, args) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', cwd: HERE }) };
  } catch (e) {
    if (e.code === 'ENOENT') return { code: -1, out: '', missing: true };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const pythonHas = (() => {
  const r = run('python3', ['-c', 'import cryptography']);
  return r.code === 0;
})();

const results = {};
results.node_good = run('node', [join(HERE, 'verify.mjs'), join(dir, 'good', 'fixture_session')]);
results.node_bad = run('node', [join(HERE, 'verify.mjs'), join(dir, 'tampered', 'fixture_session')]);
if (pythonHas) {
  results.py_good = run('python3', [join(HERE, 'verify.py'), join(dir, 'good.zip')]);
  results.py_bad = run('python3', [join(HERE, 'verify.py'), join(dir, 'tampered.zip')]);
}

// ── Case 1: the untouched export ──────────────────────────────────────────
ok(results.node_good.code === 0, 'verify.mjs passes the untouched export', results.node_good.out);
ok(/signature\s+VALID/.test(results.node_good.out), 'verify.mjs reports the signature VALID');
ok(
  results.node_good.out.includes(SIGNER.orcid) && results.node_good.out.includes(SIGNER.name),
  'verify.mjs names the signer and the ORCID',
);
ok(
  results.node_good.out.includes(`ed25519:${SIGNER.publicKey}`),
  'verify.mjs prints the public key in the pasteable form',
);

if (pythonHas) {
  ok(results.py_good.code === 0, 'verify.py passes the untouched export', results.py_good.out);
  ok(/signature\s+VALID/.test(results.py_good.out), 'verify.py reports the signature VALID');
  ok(
    results.py_good.out.includes(SIGNER.orcid) && results.py_good.out.includes(SIGNER.name),
    'verify.py names the signer and the ORCID',
  );
} else {
  console.log("  – verify.py skipped: python3 has no 'cryptography' (pip install cryptography)");
}

// ── Case 2: one byte flipped in one photo ─────────────────────────────────
// The signature must still verify — the manifest was not touched — while the
// photo is named as changed. Conflating the two would tell the reader the
// whole archive is suspect when one image was re-encoded in transit.
for (const [label, r] of Object.entries({
  'verify.mjs': results.node_bad,
  ...(pythonHas ? { 'verify.py': results.py_bad } : {}),
})) {
  ok(r.code === 1, `${label} exits 1 on the tampered export`, r.out);
  ok(/changed\s+photos\/b\.jpg/.test(r.out), `${label} names photos/b.jpg as changed`, r.out);
  ok(!/changed\s+photos\/a\.jpg/.test(r.out), `${label} does not accuse the untouched photo`, r.out);
  ok(/signature\s+VALID/.test(r.out), `${label} still reports the signature VALID`, r.out);
}

// ── Case 3: the same two cases through verify.html ───────────────────────
{
  const htmlGood = await verifyInPage(good);
  ok(/全部通過/.test(htmlGood), 'verify.html passes the untouched export', htmlGood);
  ok(/有效（Ed25519）/.test(htmlGood), 'verify.html reports the signature valid');
  ok(htmlGood.includes(SIGNER.orcid), 'verify.html shows the ORCID');
  ok(
    htmlGood.includes(`ed25519:${SIGNER.publicKey}`),
    'verify.html shows the same public key as the other two',
  );

  const tampered = readFileSync(join(dir, 'tampered.zip'));
  const htmlBad = await verifyInPage(new Uint8Array(tampered));
  ok(/發現 1 項問題/.test(htmlBad), 'verify.html fails the tampered export', htmlBad);
  ok(/已變更[\s\S]*photos\/b\.jpg/.test(htmlBad), 'verify.html names photos/b.jpg', htmlBad);
  ok(!/photos\/a\.jpg/.test(htmlBad), 'verify.html does not accuse the untouched photo', htmlBad);
  ok(/有效（Ed25519）/.test(htmlBad), 'verify.html still reports the signature valid', htmlBad);
}

// ── Do they agree line for line on the verdict? ───────────────────────────
if (pythonHas) {
  const summarise = (out) =>
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[✓✗–]/.test(l))
      .join('\n');
  ok(
    summarise(results.node_good.out) === summarise(results.py_good.out),
    'both verifiers produce the same verdict lines for the untouched export',
    `node:\n${summarise(results.node_good.out)}\npython:\n${summarise(results.py_good.out)}`,
  );
  ok(
    summarise(results.node_bad.out) === summarise(results.py_bad.out),
    'both verifiers produce the same verdict lines for the tampered export',
    `node:\n${summarise(results.node_bad.out)}\npython:\n${summarise(results.py_bad.out)}`,
  );
}

if (process.argv.includes('--keep')) console.log(`\n  fixture left at ${dir}`);
else rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n✗ crosscheck: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ crosscheck: all three verifiers agree, and each names the changed file');
