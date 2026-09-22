#!/usr/bin/env node
/**
 * The provenance signature format, pinned.
 *
 * A signature is the one artefact where "it looked fine" is worthless: a
 * verifier that always says valid, and one that says valid for the wrong
 * reason, are indistinguishable from the app's side. So each property below is
 * checked by breaking it on purpose and requiring the failure.
 *
 * Four of them encode decisions that are easy to undo by accident:
 *
 *   - The signature covers `signed_by`, so nobody can re-attribute a signed
 *     export to a different ORCID.
 *   - A re-encoded photo reports as a CHANGED FILE, not as an invalid
 *     signature. Photos that went through a chat app come back re-encoded, and
 *     telling the reader "signature invalid" would condemn the whole archive.
 *   - Nothing in the signing path needs `crypto.getRandomValues`. That is what
 *     makes this feature free of a native rebuild on React Native, and it is
 *     asserted by deleting the global and signing anyway.
 *   - An incomplete setup signs nothing at all, rather than emitting a
 *     signature that attributes the data to no one.
 *
 * Usage: npm run check:sign   (exit 1 on violation)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { injectFileDigests, manifestFiles } from '../src/lib/manifestDigest.ts';
import {
  injectSignatures,
  normalizeOrcid,
  parsePublicKeyLabel,
  publicKeyFromSeed,
  publicKeyLabel,
  signBytes,
  signaturePathFor,
  SIGNATURE_SCHEMA,
  verifyBytes,
  verifyManifest,
} from '../src/lib/signing.ts';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('check:sign');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const PUB = publicKeyFromSeed(SEED);

const SIGNER = { name: 'Lin, Cheng-Tao', orcid: '0000-0002-1825-0097', publicKey: PUB };

/** A plausible export: a manifest, a yml, two photos. */
function buildExport() {
  const entries = [
    { name: 'rec/manifest.json', bytes: enc(JSON.stringify({ app: 'mitalivana', kind: 'session' }, null, 2)) },
    { name: 'rec/record.yml', bytes: enc('name: 測試名錄\n') },
    { name: 'rec/photos/a.jpg', bytes: enc('JPEG-A') },
    { name: 'rec/photos/b.jpg', bytes: enc('JPEG-B') },
  ];
  injectFileDigests(entries, dec, enc);
  injectSignatures(entries, SIGNER, SEED, dec, enc);
  return entries;
}

/** Re-read an export the way a verifier would: by name, out of the archive. */
function readBack(entries, manifestPath = 'rec/manifest.json') {
  const byName = new Map(entries.map((e) => [e.name, e.bytes]));
  const sigPath = signaturePathFor(manifestPath);
  const sigDoc = JSON.parse(dec(byName.get(sigPath)));
  const prefix = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
  const siblings = new Map();
  for (const [name, bytes] of byName) {
    if (name.startsWith(prefix)) siblings.set(name.slice(prefix.length), bytes);
  }
  return verifyManifest(manifestPath, byName.get(manifestPath), sigDoc, siblings, dec);
}

// ── 1. Ed25519 round trip, against a deliberately broken counterpart ──────
{
  const msg = enc('provenance');
  const sig = signBytes(msg, SEED);
  ok(PUB.length === 64 && /^[0-9a-f]+$/.test(PUB), 'public key is 64 lowercase hex chars', PUB);
  ok(sig.length === 128, 'signature is 128 hex chars (64 bytes)', `got ${sig.length}`);
  ok(verifyBytes(msg, sig, PUB), 'a good signature verifies');
  ok(!verifyBytes(enc('provenancE'), sig, PUB), 'a one-bit message change fails');
  ok(!verifyBytes(msg, sig, publicKeyFromSeed(new Uint8Array(32))), 'another key fails');
  ok(!verifyBytes(msg, 'not-hex', PUB), 'malformed signature returns false rather than throwing');
  ok(!verifyBytes(msg, sig, ''), 'empty key returns false rather than throwing');
}

// ── 2. Signing needs no CSPRNG ────────────────────────────────────────────
// The entire "no native rebuild" claim rests on this: noble's keygen() would
// call crypto.getRandomValues, which React Native does not provide, but we
// pass our own SQLite-derived seed and Ed25519 signing is deterministic
// (RFC 8032 §5.1.6). Proven by removing the global, not by reading the docs.
{
  const saved = globalThis.crypto;
  let signedWithoutCsprng = false;
  let sigA, sigB;
  try {
    // eslint-disable-next-line no-global-assign
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    sigA = signBytes(enc('no-csprng'), SEED);
    sigB = signBytes(enc('no-csprng'), SEED);
    signedWithoutCsprng = verifyBytes(enc('no-csprng'), sigA, publicKeyFromSeed(SEED));
  } catch {
    signedWithoutCsprng = false;
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
  }
  ok(signedWithoutCsprng, 'sign + getPublicKey + verify work with crypto.getRandomValues absent');
  ok(sigA === sigB, 'signing is deterministic — the same bytes give the same signature');
}

// ── 3. ORCID check digit (ISO/IEC 7064 MOD 11-2) ──────────────────────────
// Ported from ORCID's own OrcidCheckDigitGenerator.java. A typo'd ORCID is
// silent — it attributes data to nobody, or to somebody else — so the check
// digit is validated rather than the shape merely matched.
{
  ok(normalizeOrcid('0000-0002-1825-0097') === '0000-0002-1825-0097', 'canonical form passes');
  ok(normalizeOrcid('https://orcid.org/0000-0002-1825-0097') === '0000-0002-1825-0097', 'URI form is accepted');
  ok(normalizeOrcid('0000 0002 1825 0097') === '0000-0002-1825-0097', 'spaces are tolerated');
  ok(normalizeOrcid('0000-0002-1825-0098') === null, 'a wrong check digit is rejected');
  ok(normalizeOrcid('0000-0002-1825-009') === null, 'a short iD is rejected');
  ok(normalizeOrcid('0000-0002-0000-009X') === '0000-0002-0000-009X', 'X as check digit (value 10) passes');
  ok(normalizeOrcid('0000-0002-0000-009x') === null, 'lowercase x is rejected — ORCID requires the capital');
  ok(normalizeOrcid('') === null, 'empty is rejected');
}

// ── 4. The public-key label round-trips ───────────────────────────────────
{
  const label = publicKeyLabel(PUB);
  ok(label === `ed25519:${PUB}`, 'label is ed25519:<hex>', label);
  ok(parsePublicKeyLabel(label) === PUB, 'label parses back to the key');
  ok(parsePublicKeyLabel(`  ${label}  `) === PUB, 'surrounding whitespace is tolerated');
  ok(parsePublicKeyLabel('https://example.org') === null, 'an ordinary profile link is not a key');
}

// ── 5. A signed export verifies end to end ────────────────────────────────
{
  const entries = buildExport();
  const r = readBack(entries);
  ok(r.signatureValid, 'a freshly signed export verifies');
  ok(r.changedFiles.length === 0 && r.missingFiles.length === 0, 'no file is reported as changed or missing');
  ok(r.orcid === SIGNER.orcid, 'the ORCID comes back out of the manifest', r.orcid);
  ok(r.name === SIGNER.name, 'the signer name comes back out of the manifest', r.name);

  const sigDoc = JSON.parse(dec(entries.find((e) => e.name === 'rec/signature.json').bytes));
  ok(sigDoc.schema === SIGNATURE_SCHEMA, 'signature.json carries the schema id', sigDoc.schema);
  ok(sigDoc.manifest === 'manifest.json', 'it names its manifest relatively', sigDoc.manifest);
  const wantDigest = createHash('sha256')
    .update(entries.find((e) => e.name === 'rec/manifest.json').bytes)
    .digest('hex');
  ok(sigDoc.manifest_sha256 === wantDigest, 'the recorded digest is a real SHA-256 of the manifest');
}

// ── 6. The signature covers signed_by ─────────────────────────────────────
// Without this an attacker could take a valid export and claim it as theirs by
// editing one field. It is the reason signed_by lives in the manifest rather
// than in signature.json.
{
  const entries = buildExport();
  const m = entries.find((e) => e.name === 'rec/manifest.json');
  const doc = JSON.parse(dec(m.bytes));
  doc.signed_by.orcid = '0000-0002-0000-009X';
  m.bytes = enc(JSON.stringify(doc, null, 2));
  ok(!readBack(entries).signatureValid, 're-attributing the ORCID invalidates the signature');
}

// ── 7. A re-encoded photo is a changed FILE, not a broken signature ───────
{
  const entries = buildExport();
  entries.find((e) => e.name === 'rec/photos/b.jpg').bytes = enc('JPEG-B-recompressed-by-a-chat-app');
  const r = readBack(entries);
  ok(r.signatureValid, 'the signature still verifies when only a photo changed');
  ok(
    r.changedFiles.length === 1 && r.changedFiles[0] === 'photos/b.jpg',
    'the changed photo is named exactly',
    JSON.stringify(r.changedFiles),
  );
  ok(r.missingFiles.length === 0, 'and nothing is reported missing');
}

// ── 8. A dropped file is reported as missing, separately ──────────────────
{
  const entries = buildExport().filter((e) => e.name !== 'rec/photos/a.jpg');
  const r = readBack(entries);
  ok(r.signatureValid, 'the signature still verifies when a file was dropped');
  ok(
    r.missingFiles.length === 1 && r.missingFiles[0] === 'photos/a.jpg',
    'the dropped file is named exactly',
    JSON.stringify(r.missingFiles),
  );
}

// ── 9. No cycle: a manifest never lists its own signature ─────────────────
{
  const entries = buildExport();
  const doc = JSON.parse(dec(entries.find((e) => e.name === 'rec/manifest.json').bytes));
  const listed = (doc.files ?? []).map((f) => f.path);
  ok(!listed.includes('signature.json'), 'signature.json is absent from files', JSON.stringify(listed));
  ok(listed.includes('record.yml') && listed.includes('photos/a.jpg'), 'the real files are all listed');
  // Belt and braces: the rule must hold even if signing ran before digesting.
  const reordered = [
    { name: 'rec/manifest.json', bytes: enc('{}') },
    { name: 'rec/signature.json', bytes: enc('{}') },
    { name: 'rec/record.yml', bytes: enc('x') },
  ];
  ok(
    !manifestFiles('rec/manifest.json', reordered).some((f) => f.path === 'signature.json'),
    'manifestFiles excludes a signature even when one already exists',
  );
}

// ── 10. Never half-signed ─────────────────────────────────────────────────
// An export with no signer must carry no signature.json at all — a lone
// signature file, or a signed_by with no signature beside it, would each make
// a verifier report something it cannot substantiate.
{
  const entries = [
    { name: 'rec/manifest.json', bytes: enc('{"app":"mitalivana"}') },
    { name: 'rec/record.yml', bytes: enc('x') },
  ];
  injectFileDigests(entries, dec, enc);
  ok(!entries.some((e) => e.name.endsWith('signature.json')), 'digesting alone writes no signature');
  ok(
    !JSON.parse(dec(entries[0].bytes)).signed_by,
    'and writes no signed_by block',
  );

  // The decision itself lives in finalizeZip; assert the guard is still there,
  // because deleting the `if` would silently sign with a null identity.
  const src = readFileSync(fileURLToPath(new URL('../src/lib/bundleExport.ts', import.meta.url)), 'utf8');
  const at = src.indexOf('export async function finalizeZip');
  const body = at === -1 ? '' : src.slice(at, at + 1400);
  ok(at !== -1, 'finalizeZip still exists and is async');
  ok(/const active = await activeSigner\(\);/.test(body), 'finalizeZip asks for a signer');
  ok(
    (body.match(/if \(active\)/g) ?? []).length === 2,
    'both signing steps are gated on there being a signer',
  );

  // Order, not just presence. Two ways to get this wrong, both silent:
  //   · note after digests → the export reports its OWN README as changed
  //   · signing before digests → the signature covers a manifest with no files
  const iNote = body.indexOf('appendSignatureNote');
  const iDigest = body.indexOf('injectFileDigests');
  const iSign = body.indexOf('injectSignatures');
  ok(iNote !== -1 && iDigest !== -1 && iSign !== -1, 'all three steps are present');
  ok(
    iNote < iDigest,
    'the README note is appended BEFORE digests — the README is itself a digested file',
  );
  ok(
    iDigest < iSign,
    'digests are injected BEFORE signing — signing first would cover the wrong bytes',
  );
}

// ── 11. Every manifest in a bundle gets its own signature ────────────────
{
  const entries = [
    { name: 'bundle_manifest.json', bytes: enc('{"app":"mitalivana","kind":"bundle"}') },
    { name: 'a/manifest.json', bytes: enc('{"app":"mitalivana","kind":"session"}') },
    { name: 'a/record.yml', bytes: enc('one') },
    { name: 'b/manifest.json', bytes: enc('{"app":"mitalivana","kind":"plot"}') },
    { name: 'b/record.yml', bytes: enc('two') },
  ];
  injectFileDigests(entries, dec, enc);
  const written = injectSignatures(entries, SIGNER, SEED, dec, enc);
  ok(written.length === 3, 'three manifests produced three signatures', JSON.stringify(written));
  ok(readBack(entries, 'a/manifest.json').signatureValid, 'the first record folder verifies on its own');
  ok(readBack(entries, 'b/manifest.json').signatureValid, 'the second record folder verifies on its own');
  ok(written.includes('signature.json'), 'the bundle root is signed too', JSON.stringify(written));
}

if (failed > 0) {
  console.error(`\n✗ sign: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ sign: signatures verify, and every deliberate break is caught');
