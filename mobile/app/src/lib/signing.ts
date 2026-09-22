/**
 * Provenance signatures over export manifests.
 *
 * The claim being made is narrow and worth stating exactly, because it is not
 * the claim a "digital signature" usually implies:
 *
 *   > These files are the raw data a particular researcher collected, and that
 *   > researcher is a real, identifiable person.
 *
 * It is NOT tamper-proofing in any legal sense, and it cannot be: the person
 * holding the key is also the person who could alter the data before signing.
 * What it does establish is that a third party who received the zip did not
 * alter it, and that the collector is someone with an ORCID rather than an
 * anonymous handle.
 *
 * ## What gets signed
 *
 * The raw bytes of `manifest.json`, exactly as they sit in the zip. Not a
 * canonicalised re-serialisation of it. This is the whole design:
 *
 *   - The manifest already lists every sibling file with its SHA-256
 *     (`manifestDigest.ts`), so signing the manifest transitively covers the
 *     yml, the CSVs, every photo and every audio clip. One signature answers
 *     both "is this export intact" and "is this one photo the one that was
 *     collected".
 *   - Because the verifier reads those bytes out of the zip rather than
 *     rebuilding them, there is no canonical-JSON rule for three independent
 *     implementations to disagree about — no key ordering, no float format, no
 *     Unicode escaping. The class of bug where Python says invalid and Node
 *     says valid cannot occur.
 *   - The signer's own claim (`signed_by`) is injected INTO the manifest before
 *     signing. Left in `signature.json` it would be unsigned, and anyone could
 *     swap in a different ORCID.
 *
 * `signature.json` therefore carries only the signature and a copy of the
 * manifest's digest for a human to eyeball. It is excluded from the manifest's
 * own `files` list, since a manifest that listed its own signature would be a
 * cycle.
 *
 * ## Trust chain, and where it stops
 *
 *   signature verifies under public key K
 *     → K is published on ORCID profile P          ← the verifier checks this
 *       → P belongs to the named researcher         ← ORCID's own vetting
 *
 * The chain is only as strong as "that ORCID account has not been taken over",
 * and the verifiers must say so rather than printing a green tick. There is no
 * certificate authority, no revocation, and no timestamping authority here; a
 * signature proves possession of the key at some point, not when.
 *
 * Keys are per-device and never leave it (`signingKey.ts`). A replaced phone
 * means a new key, published alongside the old one on the same ORCID profile —
 * old keys are never removed, so signatures stay verifiable forever.
 *
 * This module is pure so `check:sign` and the three verifiers under
 * `mobile/verify/` can exercise the real functions instead of a copy.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { isManifestPath, isSignaturePath, SIGNATURE_FILE } from './manifestDigest';

// noble-ed25519 ships async-only to stay dependency-free; wiring sha512 turns
// on the sync API, which is the step its README documents. Nothing here needs
// `crypto.getRandomValues`: the seed comes from SQLite (see signingKey.ts) and
// Ed25519 signing is deterministic per RFC 8032 §5.1.6, so no CSPRNG polyfill
// is required on React Native.
ed.hashes.sha512 = sha512;

/** Bumped only if the bytes-to-sign change. Verifiers refuse anything else. */
export const SIGNATURE_SCHEMA = 'mitalivana-signature/1';

/** Everything the app knows about who is signing. */
export type SignerIdentity = {
  /** Display name. May be empty — the ORCID is the identifier that matters. */
  name: string;
  /** Bare 19-character form, e.g. `0000-0002-1825-0097`. Empty if unset. */
  orcid: string;
  /** 64 lowercase hex characters (32-byte Ed25519 public key). */
  publicKey: string;
};

/** The block injected into a manifest before it is signed. */
export type SignedBy = {
  alg: 'Ed25519';
  public_key: string;
  orcid: string;
  orcid_url: string;
  name: string;
};

/** The contents of a `signature.json`. */
export type SignatureDoc = {
  schema: typeof SIGNATURE_SCHEMA;
  alg: 'Ed25519';
  /** Name of the file the signature covers, relative to signature.json. */
  manifest: string;
  /** SHA-256 of those bytes. Convenience for humans; not what is verified. */
  manifest_sha256: string;
  public_key: string;
  signature: string;
};

/* ── Hex, everywhere ──────────────────────────────────────────────────────
 * Not base64: the manifest already speaks hex for its SHA-256 digests, and
 * hex needs no implementation in the three verifiers beyond what their
 * standard libraries give them. Doubling the length of a key inside a JSON
 * file costs nothing.
 */

// Re-exported so callers and the verifiers have one import for the format.
export { isSignaturePath, SIGNATURE_FILE };

/** `rec/manifest.json` → `rec/signature.json`; `manifest.json` → `signature.json`. */
export function signaturePathFor(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf('/');
  return slash === -1 ? SIGNATURE_FILE : manifestPath.slice(0, slash + 1) + SIGNATURE_FILE;
}

/**
 * ORCID iD → canonical `0000-0002-1825-0097`, or null if it is not one.
 *
 * The check digit is ISO/IEC 7064 MOD 11-2, ported from ORCID's own reference
 * implementation (`OrcidCheckDigitGenerator.java` in ORCID/ORCID-Source). It
 * is validated rather than merely shape-matched because a typo'd ORCID does
 * not fail loudly — it silently publishes data under an identifier that is
 * either nobody's or, worse, somebody else's.
 *
 * Accepts the bare form, a `https://orcid.org/…` URI, and any of it with
 * stray spaces. The final character may be `X` (value 10) and must be capital.
 */
export function normalizeOrcid(input: string): string | null {
  const digits = input.trim().replace(/^https?:\/\/(www\.)?orcid\.org\//i, '').replace(/[-\s]/g, '');
  if (!/^\d{15}[\dX]$/.test(digits)) return null;
  let total = 0;
  for (const ch of digits.slice(0, 15)) total = (total + Number(ch)) * 2;
  const expected = (12 - (total % 11)) % 11;
  if ((expected === 10 ? 'X' : String(expected)) !== digits[15]) return null;
  return digits.replace(/(.{4})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4');
}

/** The public profile a verifier is told to check the key against. */
export function orcidProfileUrl(orcid: string): string {
  return orcid ? `https://orcid.org/${orcid}` : '';
}

/**
 * The single line a researcher pastes into their ORCID profile.
 *
 * ORCID's public profile has no field for a key, so it goes in "Websites &
 * social links" as a label. Prefixed so a verifier can find it among whatever
 * else is on the profile, and so it is obviously not a URL someone should try
 * to open.
 */
export function publicKeyLabel(publicKey: string): string {
  return `ed25519:${publicKey}`;
}

/** Parse that line back out of an ORCID profile entry. Returns hex or null. */
export function parsePublicKeyLabel(text: string): string | null {
  const m = /ed25519:([0-9a-f]{64})/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Derive the public key from a 32-byte seed. */
export function publicKeyFromSeed(seed: Uint8Array): string {
  return bytesToHex(ed.getPublicKey(seed));
}

/** Sign arbitrary bytes. `seed` is the 32-byte Ed25519 secret key. */
export function signBytes(bytes: Uint8Array, seed: Uint8Array): string {
  return bytesToHex(ed.sign(bytes, seed));
}

/** Verify a hex signature over bytes. Never throws — malformed input is false. */
export function verifyBytes(bytes: Uint8Array, signature: string, publicKey: string): boolean {
  try {
    return ed.verify(hexToBytes(signature), bytes, hexToBytes(publicKey));
  } catch {
    // Wrong length, odd hex, off-curve point: all "does not verify".
    return false;
  }
}

/** The `signed_by` block for an identity. */
export function signedByBlock(signer: SignerIdentity): SignedBy {
  return {
    alg: 'Ed25519',
    public_key: signer.publicKey,
    orcid: signer.orcid,
    orcid_url: orcidProfileUrl(signer.orcid),
    name: signer.name,
  };
}

type Entry = { name: string; bytes: Uint8Array };

/**
 * Add `signed_by` to every manifest, then append a `signature.json` beside it.
 *
 * Runs after `injectFileDigests`, because the bytes that get signed have to be
 * the final ones — a signature over a manifest that later grows a `files` list
 * would verify against nothing in the zip.
 *
 * All-or-nothing by construction: with no signer there is no call, so an
 * export never carries a half-written signature. Returns the signature paths
 * written, for the caller to report.
 */
export function injectSignatures(
  entries: Entry[],
  signer: SignerIdentity,
  seed: Uint8Array,
  decode: (b: Uint8Array) => string,
  encode: (s: string) => Uint8Array,
): string[] {
  const written: string[] = [];
  // Snapshot: we push into `entries` while walking it.
  const manifests = entries.filter((e) => isManifestPath(e.name));
  for (const m of manifests) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(decode(m.bytes)) as Record<string, unknown>;
    } catch {
      // Same rule as injectFileDigests: leaving a manifest unsigned is
      // recoverable, corrupting it is not.
      continue;
    }
    doc.signed_by = signedByBlock(signer);
    m.bytes = encode(JSON.stringify(doc, null, 2));

    const sigPath = signaturePathFor(m.name);
    const slash = sigPath.lastIndexOf('/');
    const sigDoc: SignatureDoc = {
      schema: SIGNATURE_SCHEMA,
      alg: 'Ed25519',
      manifest: m.name.slice(slash === -1 ? 0 : slash + 1),
      manifest_sha256: bytesToHex(sha256(m.bytes)),
      public_key: signer.publicKey,
      signature: signBytes(m.bytes, seed),
    };
    entries.push({ name: sigPath, bytes: encode(JSON.stringify(sigDoc, null, 2)) });
    written.push(sigPath);
  }
  return written;
}

/** What a verifier concluded about one signed manifest. */
export type VerifyResult = {
  manifestPath: string;
  /** The signature is a valid Ed25519 signature over the manifest bytes. */
  signatureValid: boolean;
  /** Files the manifest lists whose bytes no longer hash to what it recorded. */
  changedFiles: string[];
  /** Files the manifest lists that are absent from the archive. */
  missingFiles: string[];
  publicKey: string;
  orcid: string;
  name: string;
};

/**
 * Verify one manifest + its signature against the files around it.
 *
 * Deliberately reports a changed photo separately from an invalid signature.
 * A photo that went through a chat app or a cloud thumbnailer comes back
 * re-encoded and will never match its digest, and calling that "signature
 * invalid" would tell the reader the wrong thing about the whole archive.
 */
export function verifyManifest(
  manifestPath: string,
  manifestBytes: Uint8Array,
  signatureDoc: SignatureDoc,
  siblings: Map<string, Uint8Array>,
  decode: (b: Uint8Array) => string,
): VerifyResult {
  const signatureValid =
    signatureDoc.schema === SIGNATURE_SCHEMA &&
    verifyBytes(manifestBytes, signatureDoc.signature, signatureDoc.public_key);

  const changedFiles: string[] = [];
  const missingFiles: string[] = [];
  let signedBy: Partial<SignedBy> = {};
  try {
    const doc = JSON.parse(decode(manifestBytes)) as {
      files?: { path: string; sha256: string }[];
      signed_by?: SignedBy;
    };
    signedBy = doc.signed_by ?? {};
    for (const f of doc.files ?? []) {
      const bytes = siblings.get(f.path);
      if (!bytes) missingFiles.push(f.path);
      else if (bytesToHex(sha256(bytes)) !== f.sha256) changedFiles.push(f.path);
    }
  } catch {
    // An unparseable manifest cannot have verified above either.
  }

  return {
    manifestPath,
    signatureValid,
    changedFiles,
    missingFiles,
    publicKey: signatureDoc.public_key,
    orcid: signedBy.orcid ?? '',
    name: signedBy.name ?? '',
  };
}
