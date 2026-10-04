/**
 * Text with scientific names in it, as parts: plain strings, and names the
 * screen sets in italics by rank (components/NameParts.tsx → ScientificName:
 * genus and epithets italic; rank tokens, authors and family names upright).
 * For a name inside a title or a sentence that is otherwise plain text: merge
 * rows, action sheets.
 *
 * Pure: check:merge and check:sheet-layer run it under Node.
 */

/** `taxonId`: given instead of the rank when it is not at hand — the screen looks it up (a genus alone is italic only by its rank). */
export type NamePart = string | { sci: string; rank?: string | null; kingdom?: string | null; taxonId?: string };

/** The same as plain text (search, screen readers, logs). */
export function partsText(parts: readonly NamePart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.sci)).join('');
}

/**
 * A species as the app titles it: its common name when it has one, else its
 * scientific name; `fallback` (a taxon id) when it has neither.
 */
export function speciesParts(
  cname: string | null | undefined,
  sci: string | null | undefined,
  rank?: string | null,
  kingdom?: string | null,
  fallback?: string,
): NamePart[] {
  if (cname) return [cname];
  if (sci) return [{ sci, rank: rank ?? null, kingdom: kingdom ?? null }];
  return fallback ? [fallback] : [];
}

/** A survey occurrence's name (useSurveyForm.occurrenceTitle): its label as written, else common and scientific name. */
export function occurrenceParts(o: {
  verbatim_identification?: string | null;
  common_name_c?: string | null;
  simple_name?: string | null;
  taxon_id: string;
  rank?: string | null;
  kingdom?: string | null;
}): NamePart[] {
  if (o.verbatim_identification) return [o.verbatim_identification];
  return [...(o.common_name_c ? [`${o.common_name_c} `] : []), o.simple_name ? { sci: o.simple_name, rank: o.rank ?? null, kingdom: o.kingdom ?? null } : o.taxon_id];
}

/** A morphospecies name written as `base label` (Acacia MTN1, 薹屬 sp1 → Carex sp1): the base by its rank, the label as text. */
export function morphoParts(full: string, base: string | null | undefined, rank?: string | null, kingdom?: string | null): NamePart[] {
  if (!base || !full.startsWith(`${base} `)) return [full];
  return [{ sci: base, rank: rank ?? null, kingdom: kingdom ?? null }, full.slice(base.length)];
}

/** Parts lists joined with a separator (a list of names in one sentence). */
export function joinParts(lists: readonly (readonly NamePart[])[], sep: string): NamePart[] {
  return lists.flatMap((l, i) => (i ? [sep, ...l] : [...l]));
}

/**
 * A place for a name inside a translated sentence. Names are not plain text:
 * a scientific name is italic by its rank, so the screen puts a component
 * where the slot is (NameText.withSlots, sentenceParts).
 */
export const slot = (name: string) => `\uE000${name}\uE001`;

/** A sentence cut at its slots: text pieces, and the slot names between them. */
export function splitSlots(text: string): Array<{ text: string } | { slot: string }> {
  return text
    .split(/(\uE000\w+\uE001)/)
    .filter(Boolean)
    .map((part) => (part.startsWith('\uE000') ? { slot: part.slice(1, -1) } : { text: part }));
}

/** A translated sentence (written with slot(…) for its names) as parts, each slot filled. */
export function sentenceParts(text: string, names: Readonly<Record<string, readonly NamePart[]>>): NamePart[] {
  return splitSlots(text).flatMap((p) => ('slot' in p ? [...(names[p.slot] ?? [])] : [p.text]));
}
