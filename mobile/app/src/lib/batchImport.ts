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
 * 只有臺灣名錄（預設狀態）能走快路徑。
 *
 * 開了日本名錄就得經過 YList 合併與「中文名 / 和名」互補，關掉臺灣就根本不該
 * 查 taicol_names —— 這兩種情況一律回退完整搜尋，行為與快路徑出現前一致。
 * 每筆都重讀設定太浪費（等值查詢本身才 0.1ms），所以一個批次只讀一次。
 */
function twOnlyRegions(): boolean {
  const regions = getEnabledRegions();
  return regions.length === 1 && regions[0] === 'TW';
}

/** 解析單筆並歸類到 exact / ambiguous / unmatched。 */
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

  // 快路徑：名字本來就打對（貼上既有名錄時的常態）。唯一命中才算數，等同於
  // 下面完整搜尋會做的「完全相同就自動升為精確匹配」，只是省掉全表掃描。
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

/** 連續解析多久就讓一次 UI thread（毫秒）。 */
const UI_SLICE_MS = 80;

/**
 * 逐筆解析並歸類，每隔一小段就把控制權還給 UI thread，讓進度條動得起來。
 *
 * 帶 taxon id 的（名錄 yml）直接用 id 查；名字剛好等於某個接受名的走
 * `lookupExactAccepted` 這條索引快路徑；其餘才進 `searchWithFuzzyFallback`，
 * 錯字與語音同音誤判就靠那裡的模糊比對與（`phonetic` 時的）拼音比對救回來。
 *
 * 逐筆 `await` 會讓 100 個名字多付 100 個 frame（每次 setTimeout 至少一個
 * vsync），所以用時間切片：連續解析到超過 UI_SLICE_MS 才讓一次。全部命中快
 * 路徑時整批幾十毫秒跑完，只讓一兩次；有打錯字要走全表掃描與模糊比對時，讓的
 * 次數自然變多，進度條就跟著跳。
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
