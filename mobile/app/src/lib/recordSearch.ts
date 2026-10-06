/**
 * The records tab's search box: which records a query keeps.
 *
 * Two ways to match, and a project match wins over an item match:
 *   - the PROJECT — name, abstract, location description or notes — keeps the
 *     whole group, because searching a project's name is asking to see it;
 *   - otherwise the RECORD itself, by its title (名錄 name / plotid / trip
 *     name) or the subtitle the list already shows under it.
 *
 * Pure: no DB, no i18n. Types are structural so this runs under Node
 * (`npm run check:recordsearch`).
 */

type SearchableItem = {
  title: string;
  subtitle: string;
  projectId: number;
};

export type SearchableProject = {
  id: number;
  name: string;
  abstract: string | null;
  location_description: string | null;
  notes: string | null;
};

/** Case-folded, with 台 and 臺 treated as one character — the same rule the
 *  desktop search applies, since both spellings appear in place names. */
function fold(s: string): string {
  return s.toLowerCase().replace(/台/g, '臺');
}

/** Normalised query, or '' when there is nothing to search for. */
export function normalizeRecordQuery(q: string): string {
  return fold(q.trim());
}

/** Ids of the projects whose own fields contain the (normalised) query. */
export function matchingProjectIds(projects: SearchableProject[], nq: string): Set<number> {
  const out = new Set<number>();
  if (!nq) return out;
  for (const p of projects) {
    const text = [p.name, p.abstract, p.location_description, p.notes]
      .filter((v): v is string => !!v)
      .join('\n');
    if (fold(text).includes(nq)) out.add(p.id);
  }
  return out;
}

/** Does one record survive the (normalised) query? */
export function recordMatches<T extends SearchableItem>(
  item: T,
  nq: string,
  projectHits: Set<number>,
): boolean {
  if (!nq) return true;
  if (projectHits.has(item.projectId)) return true;
  return fold(item.title).includes(nq) || fold(item.subtitle).includes(nq);
}

/** Groups with their items filtered; groups left empty are dropped. */
export function filterRecordGroups<T extends SearchableItem, G extends { items: T[] }>(
  groups: G[],
  nq: string,
  projectHits: Set<number>,
): G[] {
  if (!nq) return groups;
  const out: G[] = [];
  for (const g of groups) {
    const items = g.items.filter((it) => recordMatches(it, nq, projectHits));
    if (items.length > 0) out.push({ ...g, items });
  }
  return out;
}

/** What a recorded species is found by in its own checklist's or plot's list. */
export type SearchableSpecies = {
  common_name_c?: string | null;
  alternative_name_c?: string | null;
  simple_name?: string | null;
  family?: string | null;
  family_c?: string | null;
  genus_c?: string | null;
  notes?: string | null;
};

/**
 * Does a recorded species match the (normalised) query? Its common and other
 * names, scientific name, family (Latin or Chinese), genus in Chinese, or note.
 * The same folding as the records tab: case and 台/臺 do not matter.
 */
export function speciesMatches(rec: SearchableSpecies, nq: string): boolean {
  if (!nq) return true;
  return [
    rec.common_name_c,
    rec.alternative_name_c,
    rec.simple_name,
    rec.family,
    rec.family_c,
    rec.genus_c,
    rec.notes,
  ].some((v) => !!v && fold(v).includes(nq));
}
