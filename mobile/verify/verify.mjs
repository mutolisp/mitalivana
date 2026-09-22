#!/usr/bin/env node
/**
 * Verify the provenance signature on a Mitalivana export. Node 18+, no install.
 *
 *   unzip the export, then:
 *   node verify.mjs ./mitalivana_20260922            # offline checks only
 *   node verify.mjs ./mitalivana_20260922 --orcid    # also ask orcid.org
 *
 * Reads a FOLDER, not the zip, so that this stays a single file with no
 * dependencies — every operating system unzips without help, and a bundled zip
 * reader would be more code than everything else here put together. Ed25519
 * comes from Node's own crypto module.
 *
 * Exit status: 0 everything checks out, 1 something did not, 2 wrong usage.
 *
 * What a PASS means, exactly:
 *
 *   - Every file the manifest lists is present and byte-for-byte what it was
 *     when the export was made.
 *   - The manifest, including the name and ORCID it is attributed to, was
 *     signed by whoever holds the private key for the public key shown.
 *
 * What it does NOT mean: that the data is correct, that it was collected when
 * or where it says, or that the ORCID account was not compromised. With
 * --orcid it additionally confirms the key is published on that ORCID profile,
 * which moves the question to "does that researcher control their ORCID
 * account" and no further. There is no certificate authority and no
 * revocation; a signature proves possession of a key, not the time of signing.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SCHEMA = 'mitalivana-signature/1';
/** RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('-'));
const checkOrcid = args.includes('--orcid');
if (!root || args.includes('-h') || args.includes('--help')) {
  console.error('usage: node verify.mjs <unzipped-export-folder> [--orcid]');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(root).map((p) => relative(root, p).split(sep).join('/'));
} catch (e) {
  console.error(`cannot read ${root}: ${e.message}`);
  process.exit(2);
}
const read = (rel) => readFileSync(join(root, ...rel.split('/')));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function verifyEd25519(messageBytes, signatureHex, publicKeyHex) {
  try {
    const raw = Buffer.from(publicKeyHex, 'hex');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from(signatureHex, 'hex');
    if (sig.length !== 64) return false;
    return edVerify(null, messageBytes, key, sig);
  } catch {
    return false;
  }
}

/** Is this key published on that ORCID profile? Network, hence opt-in. */
async function keyOnOrcidProfile(orcid, publicKeyHex) {
  const url = `https://pub.orcid.org/v3.0/${orcid}/researcher-urls`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`orcid.org returned ${res.status}`);
  const body = await res.json();
  // The key may sit in either half of a "Websites & social links" entry: the
  // label is free text, the URL field is validated as a URL. Accepting both
  // means the researcher does not have to fight whichever one their ORCID
  // account rejects.
  const haystack = (body['researcher-url'] ?? [])
    .flatMap((u) => [u['url-name'] ?? '', u.url?.value ?? ''])
    .join('\n');
  return new RegExp(`ed25519:${publicKeyHex}`, 'i').test(haystack);
}

const manifests = files.filter((f) => f === 'manifest.json' || f.endsWith('/manifest.json') || f.endsWith('bundle_manifest.json'));
if (manifests.length === 0) {
  console.error(`no manifest.json anywhere under ${root} — is this a Mitalivana export?`);
  process.exit(2);
}

let bad = 0;
let signedCount = 0;
console.log(`Mitalivana export: ${root}\n`);

for (const manifestPath of manifests.sort()) {
  const prefix = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
  const sigPath = `${prefix}signature.json`;
  console.log(manifestPath);

  const manifestBytes = read(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    console.log('  ✗ manifest is not valid JSON\n');
    bad += 1;
    continue;
  }

  // ── files ────────────────────────────────────────────────────────────
  const listed = manifest.files ?? [];
  const changed = [];
  const missing = [];
  for (const f of listed) {
    const rel = prefix + f.path;
    if (!files.includes(rel)) missing.push(f.path);
    else if (sha256(read(rel)) !== f.sha256) changed.push(f.path);
  }
  if (listed.length === 0) {
    console.log('  – no file list in this manifest (exported before digests were added)');
  } else if (changed.length === 0 && missing.length === 0) {
    console.log(`  ✓ files        ${listed.length} present and unchanged`);
  } else {
    bad += 1;
    // Named individually and on purpose: "something changed" sends the reader
    // looking through the whole archive. A photo that went through a chat app
    // or a cloud thumbnailer is re-encoded and lands here — that is a
    // different problem from a broken signature and is reported as one.
    for (const p of changed) console.log(`  ✗ changed      ${p}`);
    for (const p of missing) console.log(`  ✗ missing      ${p}`);
  }

  // ── signature ────────────────────────────────────────────────────────
  if (!files.includes(sigPath)) {
    console.log('  – unsigned (no signature.json beside this manifest)\n');
    continue;
  }
  signedCount += 1;
  let sig;
  try {
    sig = JSON.parse(read(sigPath).toString('utf8'));
  } catch {
    console.log('  ✗ signature.json is not valid JSON\n');
    bad += 1;
    continue;
  }
  if (sig.schema !== SCHEMA) {
    console.log(`  ✗ signature    unknown format "${sig.schema}" — this verifier speaks ${SCHEMA}\n`);
    bad += 1;
    continue;
  }

  const valid = verifyEd25519(manifestBytes, sig.signature ?? '', sig.public_key ?? '');
  console.log(`  ${valid ? '✓' : '✗'} signature    ${valid ? 'VALID' : 'INVALID'} (Ed25519)`);
  if (!valid) bad += 1;

  const by = manifest.signed_by ?? {};
  if (by.name) console.log(`    signer       ${by.name}`);
  if (by.orcid) console.log(`    ORCID        ${by.orcid}  https://orcid.org/${by.orcid}`);
  console.log(`    public key   ed25519:${sig.public_key}`);

  if (by.public_key && by.public_key !== sig.public_key) {
    // The manifest says one key, the detached file another. Since the
    // signature verified against sig.public_key, this means the signed
    // document is claiming a different key than the one that signed it.
    console.log('  ✗ the key in the manifest differs from the one that signed it');
    bad += 1;
  }

  if (checkOrcid && valid && by.orcid) {
    try {
      const published = await keyOnOrcidProfile(by.orcid, sig.public_key);
      if (published) {
        console.log('  ✓ ORCID        this key is published on that profile');
      } else {
        console.log('  ✗ ORCID        this key is NOT on that profile — the attribution is unproven');
        bad += 1;
      }
    } catch (e) {
      console.log(`  – ORCID        could not check (${e.message})`);
    }
  } else if (by.orcid && !checkOrcid) {
    console.log('    ORCID        not checked — pass --orcid to confirm the key is published there');
  }
  console.log('');
}

if (signedCount === 0) {
  console.log('This export carries no signature. Its files may still be listed and');
  console.log('digest-checked above, but nothing attributes them to anyone.');
}
if (bad > 0) {
  console.log(`✗ ${bad} problem(s) found.`);
  process.exit(1);
}
console.log('✓ Everything checks out.');
console.log('  This shows the files are unaltered since export and who signed them.');
console.log('  It does not vouch for the data itself, nor rule out a compromised ORCID account.');
