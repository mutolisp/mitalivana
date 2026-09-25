/**
 * Pure logic for merging across modules.
 *
 * Once the checklists became separate files, "one answer" often means querying
 * two or more modules and combining the results. The merge rules themselves have
 * no SQLite or native dependency, so they deliberately live here:
 * `scripts/check-datasets.mjs` can then import them directly under Node
 * (`src/db/taxonomy.ts` and `regions.ts` both pull in op-sqlite and
 * expo-file-system, which will not load there).
 *
 * This layer depends on types only, never on a runtime module.
 */
import type { TaxonNode } from './taxonomy';
import type { RegionCode, VernacularLang } from '~/stores/settings';

/**
 * Merge same-level nodes returned by two checklist modules.
 *
 * Nodes with the same name are merged, statistics are summed, and the vernacular
 * name comes from whichever appeared first (callers feed TaiCOL in first, so
 * Taiwan's name wins). The result is re-sorted by name to stay consistent with
 * SQL `ORDER BY name`.
 *
 * **The statistics are additive**: a genus present in both TW and JP is counted
 * twice. That matches what `mergePackNodes` already does for packs (which also
 * documents itself as an approximation). With a single module — the default,
 * Taiwan only — this function never runs a second time, so the numbers are
 * exactly what they were before the split.
 */
export function mergeScopeNodes(acc: TaxonNode[], incoming: TaxonNode[]): TaxonNode[] {
  if (acc.length === 0) return incoming;
  if (incoming.length === 0) return acc;
  const byName = new Map(acc.map((n) => [n.name, n]));
  for (const node of incoming) {
    const existing = byName.get(node.name);
    if (!existing) {
      byName.set(node.name, node);
      continue;
    }
    existing.name_c = existing.name_c || node.name_c;
    for (const [k, v] of Object.entries(node.stats)) {
      existing.stats[k] = (existing.stats[k] ?? 0) + v;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The stitching step for cross-region vernacular names: join "id → sci_norm"
 * with "sci_norm → vernacular name, per region".
 *
 * This is what is left of the old `species_xref` self-JOIN after the split —
 * SQL does two index lookups, and the pairing happens here.
 */
export function stitchCrossRegion(
  idToNorm: Map<string, string>,
  cnamesByRegion: Map<RegionCode, Map<string, string>>,
): Map<string, { tw?: string; jp?: string }> {
  const out = new Map<string, { tw?: string; jp?: string }>();
  for (const [id, norm] of idToNorm) {
    const entry: { tw?: string; jp?: string } = {};
    const tw = cnamesByRegion.get('TW')?.get(norm);
    const jp = cnamesByRegion.get('JP')?.get(norm);
    if (tw) entry.tw = tw;
    if (jp) entry.jp = jp;
    if (entry.tw || entry.jp) out.set(id, entry);
  }
  return out;
}

/** Which checklist carries each vernacular language. Adding a language means
 *  adding its checklist here and to `VernacularLang`. */
export const VERNACULAR_LANGS: readonly { lang: VernacularLang; region: RegionCode }[] = [
  { lang: 'zh-TW', region: 'TW' },
  { lang: 'ja', region: 'JP' },
];
export const MAX_VERNACULAR_LANGS = 3;
export const DEFAULT_VERNACULAR_LANGS: VernacularLang[] = ['zh-TW', 'ja'];

/**
 * The stored `vernacular_langs` setting → known languages, de-duplicated, at
 * most three. `null` when absent or unusable, so the caller applies its default.
 * Shared by the settings store and the DB layer, which reads the same row.
 */
export function parseVernacularLangs(raw: string | null | undefined): VernacularLang[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const known = new Set<string>(VERNACULAR_LANGS.map((v) => v.lang));
    const out = [...new Set(parsed.filter((v): v is VernacularLang => typeof v === 'string' && known.has(v)))];
    return out.length > 0 ? out.slice(0, MAX_VERNACULAR_LANGS) : null;
  } catch {
    return null;
  }
}

/**
 * The vernacular shown for one taxon: the names it has in the user's chosen
 * languages, in the user's order, joined with " / " (a name identical to one
 * already shown is not repeated). When none of the chosen languages has a name,
 * `fallback` (the taxon's own checklist name) is shown rather than nothing — a
 * Japan-only species still needs a name when only zh-TW is ticked.
 */
export function composeByLangs(
  names: Partial<Record<VernacularLang, string>>,
  langs: readonly VernacularLang[],
  fallback: string,
): string {
  const parts: string[] = [];
  for (const lang of langs) {
    const n = names[lang];
    if (n && !parts.includes(n)) parts.push(n);
  }
  return parts.length > 0 ? parts.join(' / ') : fallback;
}

/**
 * The ONE vernacular a herbarium label prints, chosen by the app language:
 * Japanese → the Japanese name (和名), anything else → the Taiwan name; each
 * falls back to the other when it is missing. Unlike `composeVernacular`, never
 * both — a label line has room for one name, and "臺灣俗名 / 和名" read as a
 * single name to anyone who does not know the convention.
 */
export function pickVernacular(
  ownCname: string,
  ownRegion: 'TW' | 'JP',
  cross: { tw?: string; jp?: string } | undefined,
  lang: string,
): string {
  const tw = cross?.tw ?? (ownRegion === 'TW' ? ownCname : undefined);
  const jp = cross?.jp ?? (ownRegion === 'JP' ? ownCname : undefined);
  const name = lang.toLowerCase().startsWith('ja') ? (jp ?? tw) : (tw ?? jp);
  return name ?? '';
}
