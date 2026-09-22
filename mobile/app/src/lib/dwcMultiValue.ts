/**
 * Pure DwC value helpers, split out of `dwcAttributes.ts`
 * so the import parsers and the yml builders can use it without dragging in
 * `~/i18n` (they must stay runnable outside the app — see
 * scripts/check-roundtrip.mjs). `dwcAttributes` re-exports both for existing
 * call sites.
 */

/**
 * Parse a DB-side string into an array of values.
 *
 *   null / ''     → []
 *   '["a","b"]'   → ['a','b']           (JSON array — current canonical form)
 *   'a|b'         → ['a','b']           (legacy `|` separator, DwC import)
 *   'flowering'   → ['flowering']        (legacy single-value plain string)
 */
export function parseMultiAttribute(s: string | null | undefined): string[] {
  if (s == null || s === '') return [];
  // JSON array form
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch {
      // fall through to single-value treatment
    }
  }
  // `|`-separated legacy form (DwC convention)
  if (s.includes('|')) {
    return s.split('|').map((x) => x.trim()).filter((x) => x.length > 0);
  }
  return [s];
}

/** Serialize a string[] back to a DB cell. Returns null when empty. */
export function serializeMultiAttribute(arr: string[] | null | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}

/**
 * The `degreeOfEstablishment` value a DwC deliverable may carry.
 *
 * `captive` and `cultivated` are TDWG vocabulary values; `wild` is ours and has
 * no term there, so it blanks. Lives in this pure module rather than
 * `dwcAttributes.ts` so `scripts/check-roundtrip.mjs` can assert on the real
 * function instead of a copy of its rule.
 */
export function establishmentDwcValue(v: string | null | undefined): string {
  return v === 'captive' || v === 'cultivated' ? v : '';
}

/**
 * `dwc:establishmentMeans` from TaiCOL's taxon-level alien status.
 *
 * ⚠️ Controlled vocabulary. The seven permitted values are pinned in
 * `scripts/vocab/establishment-means-values.json` (GBIF vocabulary API,
 * retrieved 2026-09-22) and `check:dwc` asserts every value this function can
 * return is one of them — so the mapping cannot invent a concept.
 *
 * Note this is the TAXON-level claim ("is this species native to Taiwan"),
 * which is a different statement from `degreeOfEstablishment` ("was this
 * individual cultivated"). Both can be true at once, which is why they are
 * separate columns.
 *
 * Two deliberate blanks:
 *
 * - `cultured` → ''. Cultivation is `degreeOfEstablishment`, already emitted.
 *   Calling a potted plant `introduced` would assert it established itself
 *   outside cultivation, which is usually false.
 * - unknown / empty → ''. Not `uncertain`: "we have no data" and "we looked and
 *   could not decide" are different claims, and only the second is `uncertain`.
 *
 * `invasive` maps to `introduced` because invasiveness is a degree of impact,
 * not a means of establishment — the vocabulary has no term for it.
 */
export function establishmentMeansDwcValue(
  alienType: string | null | undefined,
  isEndemic: string | null | undefined,
): string {
  if (alienType === 'native') return isEndemic === 'true' ? 'nativeEndemic' : 'native';
  if (alienType === 'naturalized' || alienType === 'invasive') return 'introduced';
  return '';
}

/**
 * `dwc:higherClassification` — the ranks above this taxon, highest first.
 *
 * DwC asks for "a list (concatenated and separated)"; GBIF's own archives use
 * `|`, which is also what this app already uses for multi-values, so the
 * separator stays consistent across every column of the same file.
 *
 * Empty ranks are dropped rather than emitted as empty slots: a consumer
 * splitting on `|` must not be handed a positional list that sometimes has
 * holes. The rank names are still recoverable from the dedicated
 * kingdom/phylum/class/order/family columns, which is where position matters.
 */
export function higherClassificationOf(t: {
  kingdom?: string | null;
  phylum?: string | null;
  class?: string | null;
  order?: string | null;
  family?: string | null;
}): string {
  return [t.kingdom, t.phylum, t.class, t.order, t.family]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0)
    .join('|');
}

/**
 * `dwc:individualCount` — only when the recorded quantity really is a count of
 * individuals.
 *
 * `organism_quantity` is generic (Braun-Blanquet classes, % cover, DBH lists,
 * user-defined units), and every one of those would be a lie as an
 * individualCount. DBH in particular is stored as a JSON array of stem
 * diameters — emitting its first element as a count would be nonsense.
 * The pair stays in `organismQuantity` / `organismQuantityType`, which is
 * exactly the DwC pair designed to carry a unit.
 */
export function individualCountOf(
  quantity: string | null | undefined,
  quantityType: string | null | undefined,
): string {
  if (quantityType !== 'individuals') return '';
  const raw = (quantity ?? '').trim();
  // `Number('')` is 0, so an empty quantity would otherwise publish "we counted
  // zero individuals" — a claim of absence, which is the opposite of no data.
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? String(n) : '';
}
