import yaml from 'js-yaml';
import { searchWithFuzzyFallback } from '~/db/fuzzy';
import { lookupExactAccepted, searchByTaxonId } from '~/db/search';
import { getEnabledRegions } from '~/db/regions';
import type { SearchResult } from '~/db/types';
import type { AdoptionInput } from '~/db';

export type ImportEntry = {
  raw: string;          // original input line
  matches: SearchResult[];  // search results
  /** Set when the source said this record used a non-accepted name. */
  adopted?: AdoptionInput;
};

export type CategorizedImport = {
  exact: ImportEntry[];        // exactly 1 match
  ambiguous: ImportEntry[];    // 2+ matches
  unmatched: ImportEntry[];    // 0 matches
};

/** One parsed input item. `taxonId` is set only when the source carried a
 *  TaiCOL id (a checklist .yml export) — those resolve by id, skipping the
 *  name search entirely. */
export type ParsedEntry = {
  raw: string;
  taxonId?: string;
  /** Carried through so a record exported under a deliberately adopted name
   *  comes back as that name instead of silently reverting to the accepted
   *  one. `scientificName` in such an export IS the adopted name. */
  adopted?: AdoptionInput;
};

/** Keys carrying a taxon id / a name, across the yml shapes we emit:
 *  web export (`checklist:` + DwC terms), mobile session export (`event:` +
 *  `checklist:`), mobile plot export (`plot:` + `species:`). */
const ID_KEYS = ['taxonID', 'taxon_id'];
/** The name the record was filed under, when it is not the accepted one. */
const USED_NAME_KEYS = ['scientificNameID', 'used_name_id'];
const NAME_KEYS = ['vernacularName', 'cname', 'common_name_c', 'scientificName', 'name', 'simple_name'];

/** Parse text input — pasted names, or the full contents of an exported .yml —
 *  into entries (one per taxon). */
export function parseInput(text: string): ParsedEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const fromYaml = parseYamlEntries(trimmed);
  if (fromYaml) return fromYaml;

  // Line-by-line
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((raw) => ({ raw }));
}

/** Try to read the text as a checklist yml. Returns null when it isn't one
 *  (plain name lists load as a bare string), so the caller falls back to
 *  line-by-line. */
function parseYamlEntries(text: string): ParsedEntry[] | null {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const entries = collectEntries(doc);
  return entries.length > 0 ? entries : null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function collectEntries(data: unknown): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const taxonId = firstString(obj, ID_KEYS);
    const name = firstString(obj, NAME_KEYS);
    if (taxonId) {
      // Only an export that actually says the status was non-accepted carries
      // an adoption; a plain export has neither key.
      const usedId = firstString(obj, USED_NAME_KEYS);
      const status = firstString(obj, ['taxonomicStatus', 'used_status']);
      const sciName = firstString(obj, ['scientificName', 'name', 'simple_name']);
      const adopted =
        status && sciName
          ? { name_id: usedId ? Number(usedId) : null, scientific_name: sciName }
          : undefined;
      out.push({ raw: name ?? taxonId, taxonId, adopted });
      return;
    }
    if (name) {
      out.push({ raw: name });
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(data);
  return out;
}

type ResolveOptions = { phonetic?: boolean };

/**
 * Only the Taiwan checklist alone (the default state) can take the fast path.
 *
 * With the Japan checklist enabled the result has to go through the YList merge
 * and the vernacular/Japanese-name fill-in, and with Taiwan disabled
 * taicol_names must not be queried at all — both cases fall back to the full
 * search, behaving exactly as before the fast path existed. Re-reading the
 * setting per row is wasteful (the equality lookup itself is only 0.1 ms), so it
 * is read once per batch.
 */
function twOnlyRegions(): boolean {
  const regions = getEnabledRegions();
  return regions.length === 1 && regions[0] === 'TW';
}

/** Resolve one entry and file it under exact / ambiguous / unmatched. */
function resolveInto(
  out: CategorizedImport,
  item: string | ParsedEntry,
  opts: ResolveOptions | undefined,
  fastPath: boolean,
): void {
  const { raw, taxonId, adopted } =
    typeof item === 'string' ? { raw: item, taxonId: undefined, adopted: undefined } : item;

  if (taxonId) {
    const hit = searchByTaxonId(taxonId);
    if (hit) {
      out.exact.push({ raw, matches: [hit], adopted });
      return;
    }
    // id not in this bundle's TaiCOL version — fall back to the name below
  }

  // Fast path: the name was typed correctly to begin with (the norm when pasting
  // an existing checklist). Only a unique hit counts, which is the same rule as
    // the full search's "an exact match is promoted automatically", minus the full
    // table scan.
  if (fastPath) {
    const exact = lookupExactAccepted(raw);
    if (exact.length === 1) {
      out.exact.push({ raw, matches: exact });
      return;
    }
  }

  const matches = searchWithFuzzyFallback({ q: raw, phonetic: opts?.phonetic }).slice(0, 5);
  const entry: ImportEntry = { raw, matches };
  if (matches.length === 0) out.unmatched.push(entry);
  else if (matches.length === 1) out.exact.push(entry);
  else {
    // Auto-promote to exact if a perfect cname / name match exists
    const perfect = matches.find(
      (m) => m._raw_cname === raw || m.name === raw,
    );
    if (perfect) {
      out.exact.push({ raw, matches: [perfect] });
    } else {
      out.ambiguous.push(entry);
    }
  }
}

/** How long to resolve continuously before yielding to the UI thread (ms). */
const UI_SLICE_MS = 80;

/**
 * Resolve and classify row by row, handing control back to the UI thread every
 * so often so the progress bar can move.
 *
 * Entries carrying a taxon id (a checklist yml) are looked up by id; a name that
 * happens to equal an accepted name takes the `lookupExactAccepted` index fast
 * path; everything else goes through `searchWithFuzzyFallback`, where typos and
 * homophone mistakes from dictation are recovered by fuzzy matching and (when
 * `phonetic`) pinyin comparison.
 *
 * Awaiting per row would cost 100 names 100 extra frames (every setTimeout is at
 * least one vsync), so this time-slices instead: it only yields after resolving
 * continuously for more than UI_SLICE_MS. When everything hits the fast path the
 * whole batch finishes in tens of milliseconds and yields once or twice; with
 * typos that need a full scan and fuzzy matching it yields far more often, and
 * the progress bar moves accordingly.
 */
export async function resolveBatchProgressive(
  items: (string | ParsedEntry)[],
  opts: ResolveOptions | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<CategorizedImport> {
  const out: CategorizedImport = { exact: [], ambiguous: [], unmatched: [] };
  const fastPath = twOnlyRegions();
  let sliceStart = Date.now();
  for (let i = 0; i < items.length; i++) {
    resolveInto(out, items[i], opts, fastPath);
    if (Date.now() - sliceStart >= UI_SLICE_MS || i === items.length - 1) {
      onProgress(i + 1, items.length);
      await new Promise((r) => setTimeout(r, 0));
      sliceStart = Date.now();
    }
  }
  return out;
}
