/**
 * Names inside one zip must not repeat: `finalizeZip` refuses two different
 * files under one name (code review H4), so whatever builds a zip from many
 * sources hands its names out here (H7 photo backup, H8 multi-record and
 * project exports).
 *
 * Pure, for scripts/check-zip-writer.mjs.
 */

/** `name` with `suffix` before the extension of its last path segment. */
export function withSuffix(name: string, suffix: string): string {
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  return dot > slash + 1 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
}

/** File names within one zip. */
export function createEntryNamer() {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const claim = (name: string): string => {
    let out = name;
    for (let k = 2; used.has(out); k++) out = withSuffix(name, `-${k}`);
    used.add(out);
    return out;
  };
  return {
    /** `name`, or `name-2`, `name-3`… before the extension when it is taken. */
    claim,
    /** `folder/label_n.ext`, n counting per folder and label across every source. */
    numbered(folder: string, label: string, ext: string): string {
      const key = `${folder}/${label}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return claim(`${folder}/${label}_${n}.${ext}`);
    },
  };
}

/** Top-level folders within one zip: `folder`, then `folder_2`, `folder_3`… */
export function createFolderNamer() {
  const used = new Set<string>();
  return (folder: string): string => {
    let out = folder;
    for (let k = 2; used.has(out); k++) out = `${folder}_${k}`;
    used.add(out);
    return out;
  };
}

/** The entry name with its leading `from/` replaced by `to/`; other names unchanged. */
export function moveUnder(name: string, from: string, to: string): string {
  return from !== to && name.startsWith(`${from}/`) ? `${to}/${name.slice(from.length + 1)}` : name;
}
