/**
 * Region-specific names for taxa not identified to species (Road protocol
 * §2.5.2.1, p. 5): the lowest rank reached, the region code and a number —
 * `Acacia MTN1`, `Asteraceae MTN2` — or, below family, a life form:
 * `shrub ORE3`. The examples number across the whole region (MTN1, MTN2), so
 * the next number is one past the highest already used with that region code,
 * whatever the rank or life form in front of it.
 *
 * The name lives in `verbatim_identification` on a genus- or family-level
 * taxon (as GLORIA's sp1, sp2), so it stays the same entity across years.
 */

export const LIFE_FORMS = ['graminoid', 'herb', 'fern', 'vine', 'shrub', 'tree'] as const;
export type LifeForm = (typeof LIFE_FORMS)[number];

function numberFor(name: string | null | undefined, region: string): number | null {
  const m = /\s([A-Z]{2,3})(\d+)$/.exec(name?.trim() ?? '');
  return m && m[1] === region ? Number(m[2]) : null;
}

export function nextRegionNumber(names: ReadonlyArray<string | null | undefined>, region: string): number {
  let max = 0;
  for (const n of names) max = Math.max(max, numberFor(n, region) ?? 0);
  return max + 1;
}

/** `base` is a genus, a family or a life form. */
export function morphoName(base: string, region: string, names: ReadonlyArray<string | null | undefined>): string {
  return `${base.trim()} ${region}${nextRegionNumber(names, region)}`;
}

export function isMorphoName(name: string | null | undefined, region: string): boolean {
  return numberFor(name, region) != null;
}
