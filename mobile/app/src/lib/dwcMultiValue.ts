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

/**
 * `threatStatus` for the Distribution extension.
 *
 * ⚠️ Controlled vocabulary, pinned in `scripts/vocab/threat-status-values.json`
 * (GBIF IUCN Threat Status thesaurus, issued 2018-12-06, retrieved 2026-09-22):
 * EX EW RE CR EN VU NT LC DD NA NE.
 *
 * **The leading `N`.** The Taiwan Red List writes national categories as
 * `NCR` / `NEN` / `NVU` / `NNT` / `NLC`. IUCN's regional guidelines use the
 * SAME category set for a national assessment — the `N` only says "national",
 * which in a Distribution row is already stated by `countryCode`. So it is
 * stripped rather than published as an invented category. This is the
 * convention the app already follows for badge colours
 * (`conservationColors.ts`: "National (Taiwan) codes share the same colour by
 * stripping the leading `N`").
 *
 * Anything that does not land in the vocabulary returns '' — notably the
 * pre-2001 `LR/cd` (Lower Risk / conservation dependent), which has no modern
 * equivalent that we can assert without making the assessment ourselves.
 */
const THREAT_STATUS = new Set(['EX', 'EW', 'RE', 'CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NA', 'NE']);

export function threatStatusDwcValue(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return '';
  if (THREAT_STATUS.has(c)) return c;
  if (c.startsWith('N') && THREAT_STATUS.has(c.slice(1))) return c.slice(1);
  return '';
}

/**
 * `appendixCITES` for the Distribution extension.
 *
 * TaiCOL stores compound listings (`I/II`, `I/II/III`) because different
 * populations of one taxon can sit in different appendices, and adds its own
 * `NC` marker for "not listed". A compound value is kept — it is the true
 * listing — but `NC` is dropped: "not in any appendix" is the absence of a
 * value, not an appendix called NC.
 *
 * GBIF publishes no value vocabulary for this term (checked 2026-09-22:
 * rs.gbif.org/vocabulary/gbif/cites_appendix.xml is 404), so this validates
 * shape rather than membership — only I / II / III may appear.
 */
export function citesAppendixDwcValue(code: string | null | undefined): string {
  const parts = (code ?? '')
    .split('/')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p === 'I' || p === 'II' || p === 'III');
  return parts.join('/');
}
