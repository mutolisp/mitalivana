/**
 * Where a fixed-plot quadrat stands (06-plot-quadrats.md §3.2): its status
 * colour and the numbers its list row shows. Pure, so check:quadrats tests it.
 *
 * Status: locked → done; a cover / frequency mismatch → warn; anything
 * recorded → progress; otherwise none. The mismatch only counts when the plot
 * records both cover and frequency and both have begun in this quadrat.
 */
import { popcount } from './grid';
import { coverFreqIssues, type CoverFreqIssue } from './quadratIssues';

export type QuadratStatus = 'none' | 'progress' | 'done' | 'warn';

type QuadratLike = {
  locked: 0 | 1 | number;
  freq_mode: 'cells' | 'count' | string;
  cov_vascular: number | null;
  cov_solid_rock: number | null;
  cov_scree: number | null;
  cov_lichens: number | null;
  cov_bryophytes: number | null;
  cov_bare_ground: number | null;
  cov_litter: number | null;
};
type SpeciesLike = { name: string; cover_pct: number | null; freq_cells: string | null; freq_count: number | null };

export type QuadratProgress = {
  status: QuadratStatus;
  species: number;
  /** Species with a cover value. */
  covered: number;
  /** Species with a frequency (at least one cell, or a count above 0). */
  withFreq: number;
  missingFreq: boolean;
  missingCover: boolean;
  issues: CoverFreqIssue[];
};

/** Cells a species occupies, in the quadrat's current frequency mode. */
export function freqCells(s: Pick<SpeciesLike, 'freq_cells' | 'freq_count'>, mode: string): number {
  return mode === 'count' ? (s.freq_count ?? 0) : popcount(s.freq_cells);
}

export function quadratProgress(
  q: QuadratLike,
  species: readonly SpeciesLike[],
  record: { cover: boolean; freq: boolean },
): QuadratProgress {
  const covered = species.filter((s) => s.cover_pct != null).length;
  const withFreq = species.filter((s) => freqCells(s, q.freq_mode) > 0).length;
  // Only once both halves have begun: cover typed first must not flag every
  // species as missing its frequency before the grid was even opened.
  const issues =
    record.cover && record.freq && covered > 0 && withFreq > 0
      ? coverFreqIssues(species.map((s) => ({ name: s.name, cover: s.cover_pct, cells: freqCells(s, q.freq_mode) })))
      : [];
  const surface = [q.cov_vascular, q.cov_solid_rock, q.cov_scree, q.cov_lichens, q.cov_bryophytes, q.cov_bare_ground, q.cov_litter];
  const hasData = species.length > 0 || surface.some((v) => v != null);
  return {
    status: q.locked ? 'done' : issues.length ? 'warn' : hasData ? 'progress' : 'none',
    species: species.length,
    covered,
    withFreq,
    missingFreq: issues.some((i) => i.kind === 'cover-no-freq'),
    missingCover: issues.some((i) => i.kind === 'freq-no-cover'),
    issues,
  };
}
