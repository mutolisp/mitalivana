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

/**
 * A plot species record's dominance is there when it holds any value — a
 * cover %, a Braun-Blanquet class, a count, DBH stems. Zero and an empty
 * stem list are not a value.
 */
export function hasQuantity(q: string | null | undefined): boolean {
  if (q == null) return false;
  const v = q.trim();
  return v !== '' && v !== '[]' && v !== '0';
}

/**
 * The same rule for the fixed plot's own frequency (v78): a record with
 * frequency should have a dominance, and one with a dominance should have
 * frequency. Only once any record has frequency at all — before that the
 * frequency simply has not been done. Layer 'T' (transects) never has any.
 */
export function plotFreqIssues<R extends { organism_quantity: string | null; freq_cells: string | null; freq_count: number | null; layer: string }>(
  records: readonly R[],
  mode: 'cells' | 'count',
): { domNoFreq: R[]; freqNoDom: R[] } {
  const cellsOf = (r: R) => (mode === 'count' ? (r.freq_count ?? 0) : [...(r.freq_cells ?? '')].filter((c) => c === '1').length);
  const rs = records.filter((r) => r.layer !== 'T');
  const out = { domNoFreq: [] as R[], freqNoDom: [] as R[] };
  if (!rs.some((r) => cellsOf(r) > 0)) return out;
  for (const r of rs) {
    const dom = hasQuantity(r.organism_quantity);
    const cells = cellsOf(r);
    if (dom && cells === 0) out.domNoFreq.push(r);
    else if (!dom && cells > 0) out.freqNoDom.push(r);
  }
  return out;
}
