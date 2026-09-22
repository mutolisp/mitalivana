/**
 * Per-file digests for export manifests — the rule, isolated and pure.
 *
 * This is deliberately its own module rather than a helper inside
 * `bundleExport.ts`: three things outside the app have to reproduce it exactly
 * (the CLI, Python and single-page verifiers planned for provenance signing),
 * and a rule that lives next to `expo-file-system` cannot even be imported by
 * a check script, let alone by them. Keeping it here means `check:manifest`
 * asserts on the real function instead of a copy of its description.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** One file's entry in a manifest's `files` array. */
export type ManifestFile = { path: string; bytes: number; sha256: string };

/** Name of the detached signature that sits beside a manifest. Defined here,
 *  not in `signing.ts`, because this module is the one that has to know not to
 *  list it — and importing it from there would be a cycle. */
export const SIGNATURE_FILE = 'signature.json';

/** A manifest must not list its own signature: the signature covers the
 *  manifest, so a manifest covering the signature would be a cycle. */
export function isSignaturePath(name: string): boolean {
  return name === SIGNATURE_FILE || name.endsWith(`/${SIGNATURE_FILE}`);
}

/** Anything a manifest must not list — including itself. A manifest is the
 *  integrity root of its folder; hashing one root inside another would make
 *  the order they are written in part of the format. */
export function isManifestPath(name: string): boolean {
  return (
    name === 'manifest.json' ||
    name.endsWith('/manifest.json') ||
    name.endsWith('bundle_manifest.json')
  );
}

/**
 * The `files` list for a manifest sitting at `manifestPath`.
 *
 * Scope is the manifest's own folder: `xxx/manifest.json` covers `xxx/…`, and
 * `bundle_manifest.json` at the root covers everything. Paths are stored
 * relative to that folder, so one record's folder verifies identically whether
 * it was exported alone or inside a batch.
 *
 * **Sorted by path**, not by the order the files happened to be produced.
 * Two exports of unchanged data then yield byte-identical manifests — which is
 * the whole point of publishing a digest, and what a signature over the
 * manifest will depend on.
 */
export function manifestFiles(
  manifestPath: string,
  entries: { name: string; bytes: Uint8Array }[],
): ManifestFile[] {
  const slash = manifestPath.lastIndexOf('/');
  const prefix = slash === -1 ? '' : manifestPath.slice(0, slash + 1);
  return entries
    .filter((e) => !isManifestPath(e.name) && !isSignaturePath(e.name) && e.name.startsWith(prefix))
    .map((e) => ({
      path: e.name.slice(prefix.length),
      bytes: e.bytes.length,
      sha256: bytesToHex(sha256(e.bytes)),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Add `files` to every manifest among `entries`, rewriting its bytes in place.
 *
 * Called at finalize time because that is the only point where every file's
 * bytes exist — a manifest written while records are still being walked cannot
 * hash a photo that has not been read yet.
 *
 * A manifest that does not parse as JSON is left untouched: failing to add a
 * digest is recoverable, corrupting the file is not.
 */
export function injectFileDigests(
  entries: { name: string; bytes: Uint8Array }[],
  decode: (b: Uint8Array) => string,
  encode: (s: string) => Uint8Array,
): void {
  for (const m of entries) {
    if (!isManifestPath(m.name)) continue;
    const files = manifestFiles(m.name, entries);
    try {
      const doc = JSON.parse(decode(m.bytes)) as Record<string, unknown>;
      doc.files = files;
      m.bytes = encode(JSON.stringify(doc, null, 2));
    } catch {
      // Not JSON after all — leave it alone rather than corrupt it.
    }
  }
}
