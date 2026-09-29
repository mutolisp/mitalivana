/**
 * Cover ⇄ frequency cross-check for one quadrat — pure. Shared by GLORIA's
 * 1×1 m quadrats (model/validate.ts) and the fixed plot's quadrats
 * (06-plot-quadrats.md §5).
 *
 * A project rule, not a manual one: on the same species list, a species with
 * cover should have been found in some frequency cell, and one found in a
 * cell should have a cover. Only meaningful once frequency was done at all —
 * the caller decides that.
 */

export type QuadratSpeciesCheck = {
  /** Display name, carried into the issue. */
  name: string;
  cover: number | null;
  /** Cells the species occupies (mask popcount, or the count-mode total). */
  cells: number;
};

export type CoverFreqIssue =
  | { kind: 'cover-no-freq'; species: string; cover: number }
  | { kind: 'freq-no-cover'; species: string; cells: number };

export function coverFreqIssues(species: readonly QuadratSpeciesCheck[]): CoverFreqIssue[] {
  const out: CoverFreqIssue[] = [];
  for (const s of species) {
    const cover = s.cover ?? 0;
    if (cover > 0 && s.cells === 0) out.push({ kind: 'cover-no-freq', species: s.name, cover });
    else if (s.cells > 0 && !(cover > 0)) out.push({ kind: 'freq-no-cover', species: s.name, cells: s.cells });
  }
  return out;
}
