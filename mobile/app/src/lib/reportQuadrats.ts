/**
 * Plot report sections for the fixed plot's 1×1 m quadrats and its
 * whole-plot frequency (06-plot-quadrats.md §4, phase E). Pure: the report
 * data layer reads the rows, these build tables only, so the three renderers
 * (in-app, HTML, DOCX / ODT) need nothing new and check:report can test them.
 *
 * Definitions follow the spec (§4), not a textbook:
 *   frequency %      = cells occupied ÷ grid_n² × 100
 *   constancy        = quadrats the species occurs in ÷ quadrats
 *   mean cover       = sum of its covers ÷ quadrats (0 where absent)
 *   mean frequency   = sum of its frequency % ÷ quadrats (0 where absent)
 *   relative cover   = its mean cover ÷ sum of all mean covers × 100
 *   relative freq.   = its mean frequency ÷ sum of all mean frequencies × 100
 *   importance value = relative cover + relative frequency (0–200)
 * Species richness of the plot list ∪ the quadrat species appears only in
 * the quadrat section (user decision 2026-09-29); every other section keeps
 * to the plot list.
 */
import { coverFreqIssues } from './quadratIssues';
import { int, num, speciesLabel } from './reportFormat';
import type { ReportRecord } from './reportStats';
import type { ReportSection, Translate } from './reportTypes';

const SURFACE = ['cov_vascular', 'cov_solid_rock', 'cov_scree', 'cov_lichens', 'cov_bryophytes', 'cov_bare_ground', 'cov_litter'] as const;
type SurfaceKey = (typeof SURFACE)[number];

export type ReportQuadratSpecies = ReportRecord & {
  cover_pct: number | null;
  /** Cells occupied (mask count, or the count-mode figure); null = not done. */
  cells: number | null;
};

export type ReportQuadrat = {
  label: string;
  position: string | null;
  size_m: number;
  grid_n: number;
  top_edge: string;
  locked: number;
  species: ReportQuadratSpecies[];
} & Record<SurfaceKey, number | null>;

export type ReportPlotFrequency = {
  gridN: number;
  topEdge: string;
  mode: 'cells' | 'count';
};

export type QuadratSpeciesStat = {
  taxon_id: string;
  label: string;
  covers: (number | null)[];
  meanCover: number;
  meanFreq: number;
  constancy: number;
  relCover: number;
  relFreq: number;
  iv: number;
};

/** Per-species statistics across the quadrats (definitions in the header). */
export function quadratSpeciesStats(quadrats: readonly ReportQuadrat[]): QuadratSpeciesStat[] {
  const n = quadrats.length;
  if (!n) return [];
  const byTaxon = new Map<string, { rec: ReportQuadratSpecies; covers: (number | null)[]; freqs: number[]; present: number }>();
  quadrats.forEach((q, qi) => {
    const total = q.grid_n * q.grid_n;
    for (const s of q.species) {
      const e = byTaxon.get(s.taxon_id) ?? { rec: s, covers: Array.from({ length: n }, (): number | null => null), freqs: [] as number[], present: 0 };
      e.covers[qi] = s.cover_pct;
      if (s.cells != null) e.freqs.push((s.cells / total) * 100);
      e.present += 1;
      byTaxon.set(s.taxon_id, e);
    }
  });
  const rows = [...byTaxon.entries()].map(([taxon_id, e]) => ({
    taxon_id,
    label: speciesLabel(e.rec),
    covers: e.covers,
    meanCover: e.covers.reduce<number>((a, v) => a + (v ?? 0), 0) / n,
    meanFreq: e.freqs.reduce((a, v) => a + v, 0) / n,
    constancy: e.present / n,
  }));
  const sumCover = rows.reduce((a, r) => a + r.meanCover, 0);
  const sumFreq = rows.reduce((a, r) => a + r.meanFreq, 0);
  return rows
    .map((r) => {
      const relCover = sumCover > 0 ? (r.meanCover / sumCover) * 100 : 0;
      const relFreq = sumFreq > 0 ? (r.meanFreq / sumFreq) * 100 : 0;
      return { ...r, relCover, relFreq, iv: relCover + relFreq };
    })
    .sort((a, b) => b.iv - a.iv || b.meanCover - a.meanCover || a.label.localeCompare(b.label));
}

/** Richness of the plot list, the quadrats, and their union (by taxon). */
export function unionRichness(plotTaxa: readonly string[], quadrats: readonly ReportQuadrat[]) {
  const plot = new Set(plotTaxa);
  const quad = new Set(quadrats.flatMap((q) => q.species.map((s) => s.taxon_id)));
  const onlyQuad = [...quad].filter((x) => !plot.has(x));
  return { plot: plot.size, quadrats: quad.size, shared: quad.size - onlyQuad.length, onlyQuadrats: onlyQuad, union: plot.size + onlyQuad.length };
}

/** 12 → "12", 12.5 → "12.5": field covers are mostly whole numbers. */
const compact = (v: number) => (Number.isInteger(v) ? String(v) : num(v, 1));

const sumSurface = (q: ReportQuadrat) =>
  SURFACE.some((k) => q[k] != null) ? SURFACE.reduce<number>((a, k) => a + (q[k] ?? 0), 0) : null;

export function quadratSections(quadrats: readonly ReportQuadrat[], plotRecords: readonly ReportRecord[], t: Translate): ReportSection[] {
  if (!quadrats.length) return [];
  const out: ReportSection[] = [];
  const first = quadrats[0];
  const edge = (e: string) => (e === 'upslope' ? t('plot.quadrats.upslope') : e);

  // Data quality, per quadrat: cover without cells (or the reverse) once both
  // were recorded there, and a surface total other than 100.
  const issues: string[] = [];
  for (const q of quadrats) {
    const both = q.species.some((s) => s.cover_pct != null) && q.species.some((s) => (s.cells ?? 0) > 0);
    const mism = both ? coverFreqIssues(q.species.map((s) => ({ name: speciesLabel(s), cover: s.cover_pct, cells: s.cells ?? 0 }))) : [];
    if (mism.length) issues.push(t('report.quadratIssueFreq', { label: q.label, n: mism.length }));
    const sum = sumSurface(q);
    if (sum != null && Math.abs(sum - 100) > 0.001) issues.push(t('report.quadratIssueSurface', { label: q.label, sum: num(sum, 1) }));
  }

  // Overview: one row per quadrat.
  out.push({
    note: issues.length ? issues.join('；') : undefined,
    id: 'quadrats',
    heading: t('report.secQuadrats'),
    meta: [
      { key: t('report.quadratCount'), value: int(quadrats.length) },
      { key: t('plot.quadrats.size'), value: `${num(first.size_m, 2)} × ${num(first.size_m, 2)} m` },
      { key: t('plot.quadrats.gridN'), value: `${first.grid_n} × ${first.grid_n}` },
      { key: t('plot.quadrats.topEdge'), value: edge(first.top_edge) },
    ],
    table: {
      columns: [t('report.colQuadrat'), t('plot.quadrats.layout'), t('plotStats.richness'), t('report.colSpeciesCoverSum'), t('report.colSurfaceSum'), t('report.colDone')],
      rows: quadrats.map((q) => [
        q.label,
        q.position === 'C' ? t('plot.quadrats.center') : (q.position ?? '–'),
        int(q.species.length),
        num(q.species.reduce<number>((a, s) => a + (s.cover_pct ?? 0), 0), 1),
        num(sumSurface(q), 1),
        q.locked ? '✓' : '–',
      ]),
      align: ['left', 'left', 'right', 'right', 'right', 'left'],
    },
  });

  // Species × quadrat cover: one column per quadrat, nothing else, so a
  // plot with many quadrats still fits a page.
  const stats = quadratSpeciesStats(quadrats);
  if (stats.length) {
    out.push({
      id: 'quadratCover',
      heading: t('report.secQuadratCover'),
      table: {
        columns: [t('report.colSpecies'), ...quadrats.map((q) => q.label)],
        rows: stats.map((s) => [s.label, ...s.covers.map((c) => (c == null ? '–' : compact(c)))]),
        align: ['left', ...quadrats.map(() => 'right' as const)],
      },
    });
    // Frequency, constancy and importance value.
    out.push({
      id: 'quadratSpecies',
      heading: t('report.secQuadratSpecies'),
      table: {
        columns: [
          t('report.colSpecies'),
          t('report.colMeanCover'),
          t('report.colMeanFreq'),
          t('report.colConstancy'),
          t('report.colRelCover'),
          t('report.colRelFreq'),
          t('report.colImportance'),
        ],
        rows: stats.map((s) => [
          s.label,
          num(s.meanCover, 2),
          num(s.meanFreq, 1),
          `${Math.round(s.constancy * quadrats.length)}/${quadrats.length}`,
          num(s.relCover, 1),
          num(s.relFreq, 1),
          num(s.iv, 1),
        ]),
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      },
      chart: {
        kind: 'bar',
        title: t('report.colImportance'),
        rows: stats.slice(0, 15).map((s) => ({ label: s.label, value: Math.round(s.iv * 10) / 10 })),
        max: 200,
      },
      note: t('report.quadratCoverNote'),
    });
  }

  // Surface cover, one row per quadrat and a mean row.
  if (quadrats.some((q) => sumSurface(q) != null)) {
    const mean = (k: SurfaceKey) => {
      const v = quadrats.map((q) => q[k]).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    out.push({
      id: 'quadratSurface',
      heading: t('report.secQuadratSurface'),
      table: {
        columns: [t('report.colQuadrat'), ...SURFACE.map((k) => t(`gloria.cover.short.${k}`)), t('report.colSurfaceSum')],
        rows: [
          ...quadrats.map((q) => [q.label, ...SURFACE.map((k) => num(q[k], 1)), num(sumSurface(q), 1)]),
          [t('report.rowMean'), ...SURFACE.map((k) => num(mean(k), 1)), '–'],
        ],
        align: ['left', ...SURFACE.map(() => 'right' as const), 'right'],
        totalRows: 1,
      },
      note: SURFACE.map((k) => `${t(`gloria.cover.short.${k}`)} = ${t(`gloria.cover.${k}`)}`).join('；'),
    });
  }

  // Richness: plot list ∪ quadrat species — only here (user decision).
  const u = unionRichness(
    plotRecords.map((r) => r.taxon_id),
    quadrats,
  );
  const onlyRows = u.onlyQuadrats
    .map((id) => quadrats.flatMap((q) => q.species).find((s) => s.taxon_id === id))
    .filter((s): s is ReportQuadratSpecies => !!s)
    .map((s) => [speciesLabel(s), int(quadrats.filter((q) => q.species.some((x) => x.taxon_id === s.taxon_id)).length)]);
  out.push({
    id: 'quadratUnion',
    heading: t('report.secQuadratUnion'),
    table: {
      columns: [t('report.colIndex'), t('report.colValue')],
      rows: [
        [t('report.plotListRichness'), int(u.plot)],
        [t('report.quadratRichness'), int(u.quadrats)],
        [t('report.sharedRichness'), int(u.shared)],
        [t('report.onlyQuadratRichness'), int(u.onlyQuadrats.length)],
        [t('report.unionRichness'), int(u.union)],
      ],
      align: ['left', 'right'],
    },
    note: t('report.unionNote'),
  });
  if (onlyRows.length) {
    out.push({
      id: 'quadratOnly',
      heading: t('report.secQuadratOnly'),
      table: { columns: [t('report.colSpecies'), t('report.colQuadratsWith')], rows: onlyRows, align: ['left', 'right'] },
    });
  }
  return out;
}

/** Frequency over the whole plot (v78): one row per plot species record with frequency. */
export function plotFrequencySection(
  records: readonly (ReportRecord & { freq_cells?: string | null; freq_count?: number | null })[],
  freq: ReportPlotFrequency,
  t: Translate,
): ReportSection | null {
  const total = freq.gridN * freq.gridN;
  const layerName = (l?: string) => (l && l !== 'T' ? t(`layer.${l}`).replace(/^E\d\s*/, '') : '');
  const rows = records
    .map((r) => {
      const cells =
        freq.mode === 'count'
          ? (r.freq_count ?? null)
          : r.freq_cells && r.freq_cells.length === total
            ? [...r.freq_cells].filter((c) => c === '1').length
            : null;
      return { r, cells };
    })
    .filter((x): x is { r: (typeof records)[number]; cells: number } => x.cells != null)
    .sort((a, b) => b.cells - a.cells || speciesLabel(a.r).localeCompare(speciesLabel(b.r)));
  if (!rows.length) return null;
  const pctOf = (cells: number) => (cells / total) * 100;
  return {
    id: 'plotFrequency',
    heading: t('report.secPlotFrequency'),
    meta: [
      { key: t('plot.quadrats.gridN'), value: `${freq.gridN} × ${freq.gridN}` },
      { key: t('plot.quadrats.topEdge'), value: freq.topEdge === 'upslope' ? t('plot.quadrats.upslope') : freq.topEdge },
      { key: t('teamMerge.field.freq_mode'), value: freq.mode === 'count' ? t('quadrat.freq.countMode') : t('plot.quadrats.freqModeCells') },
      { key: t('report.recordsWithFreq'), value: `${rows.length}/${records.filter((r) => r.layer !== 'T').length}` },
    ],
    table: {
      columns: [t('report.colSpecies'), t('report.colLayer'), t('report.colCells'), t('report.colFreqPct')],
      rows: rows.map(({ r, cells }) => [speciesLabel(r), layerName(r.layer), `${cells}/${total}`, num(pctOf(cells), 1)]),
      align: ['left', 'left', 'right', 'right'],
    },
    chart: {
      kind: 'bar',
      title: t('report.colFreqPct'),
      rows: rows.slice(0, 15).map(({ r, cells }) => ({ label: `${speciesLabel(r)}${layerName(r.layer) ? ` (${layerName(r.layer)})` : ''}`, value: Math.round(pctOf(cells) * 10) / 10 })),
      max: 100,
    },
  };
}
