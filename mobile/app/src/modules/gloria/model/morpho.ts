/**
 * Morphospecies labels (sp1, sp2, …) on a GLORIA survey roster: a
 * determination that stopped at a genus or family, told apart by label.
 * Pure, so check:gloria can test it.
 */

/** The next free `spN`: one past the highest spN already used (sp1 when none). */
export function nextMorphoLabel(labels: ReadonlyArray<string | null>): string {
  let max = 0;
  for (const l of labels) {
    const m = /^sp(\d+)$/i.exec(l?.trim() ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `sp${max + 1}`;
}

/**
 * What adding "a new one" does when the taxon is already on the roster: an
 * unlabelled entry first gets the next label (so the list never shows 「薹屬」
 * beside 「薹屬 sp2」), then the new entry gets the one after.
 */
export function planNewMorpho(labels: ReadonlyArray<string | null>): { relabel: string | null; label: string } {
  const have = [...labels];
  let relabel: string | null = null;
  if (have.some((l) => !l?.trim())) {
    relabel = nextMorphoLabel(have);
    have.push(relabel);
  }
  return { relabel, label: nextMorphoLabel(have) };
}
