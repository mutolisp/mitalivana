/** Zip built entries; photos and scans are stored, not deflated (JPEG/PDF gain nothing, phones save memory). */
import { zipSync, type Zippable } from 'fflate';
import type { BuiltZipEntry } from '~/lib/bundleParts';

export function zipEntries(entries: BuiltZipEntry[]): Uint8Array {
  const files: Zippable = {};
  for (const e of entries) {
    const store = /\/(photos|forms|loggers)\//.test(e.name) && /\.(jpe?g|png|heic|heif|pdf|zip)$/i.test(e.name);
    files[e.name] = [e.bytes, store ? { level: 0 } : (e.zipOpts ?? {})];
  }
  return zipSync(files);
}
