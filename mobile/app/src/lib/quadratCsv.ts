/**
 * Fixed-plot quadrats as CSV (06-plot-quadrats.md §4, phase E). Pure, so
 * check:quadrats runs it under node.
 *
 *   ${plotid}_quadrats.csv        one row per species in a quadrat: cover,
 *                                 frequency (cells and %), and one column per
 *                                 cell, f{row}{col} counted from 1 (f11 … f1010)
 *   ${plotid}_quadrat_surface.csv one row per quadrat: surface cover and the
 *                                 quadrat's own facts
 *
 * Every quadrat of a plot has the plot's grid (user decision 2026-09-29), so
 * the cell columns are the same for every row. A quadrat recorded as counts
 * only has its count and blank cells. Cell (r, c) is row r from the quadrat's
 * top edge and column c from the left looking at that edge — the same ground
 * frame as the grid on screen.
 */
import { excelCell } from './csvFormula';
import { getBit } from './grid';
import type { QuadratDocInput } from './quadratYaml';
import { publishedTaxonId } from './taxonId';
import { locationTerms } from './dwcLocation';

export const SURFACE_KEYS = [
  'cov_vascular',
  'cov_solid_rock',
  'cov_scree',
  'cov_lichens',
  'cov_bryophytes',
  'cov_bare_ground',
  'cov_litter',
] as const;

/** Cell column names for a grid of n: f11 … f1n, f21 … fnn (row, then column; 1-based). */
export function cellColumns(n: number): string[] {
  const out: string[] = [];
  for (let r = 1; r <= n; r++) for (let c = 1; c <= n; c++) out.push(`f${r}${c}`);
  return out;
}

/**
 * The quadrat's DwC eventID, shared by the CSVs and the archive: under its
 * subplot's event when it sits in one (plot → subplot → quadrat), else under
 * the plot's.
 */
export function quadratEventIds(plotid: string, quadratLabel: string, subplotLabel: string | null): { eventID: string; parentEventID: string } {
  const parent = subplotLabel ? `${plotid}-${subplotLabel}` : plotid;
  return { eventID: `${parent}-${quadratLabel}`, parentEventID: parent };
}

const withBom = (lines: string[]) => '﻿' + lines.map((l) => l).join('\n');
// Excel-bound (BOM): formula-like values get a leading apostrophe (code review L17).
const row = (cells: unknown[]) => cells.map(excelCell).join(',');
const pct = (v: number) => Math.round(v * 100) / 100;

/** Cells occupied by a species, in either frequency mode. */
function cellsOf(s: QuadratDocInput['species'][number], mode: string): number | null {
  if (mode === 'count') return s.freq_count;
  if (s.freq_cells == null) return null;
  return [...s.freq_cells].filter((ch) => ch === '1').length;
}

export function buildQuadratsCsv(
  plotid: string,
  quadrats: readonly QuadratDocInput[],
  subplotLabelById: ReadonlyMap<number, string>,
  /** The plot's stable DwC eventID (db/plots.ts plotEventId), the base of the quadrat eventIDs. */
  eventBase: string = plotid,
): string {
  const n = quadrats[0]?.grid_n ?? 10;
  const cols = cellColumns(n);
  const lines = [
    [
      'plotid', 'quadrat', 'eventID', 'parentEventID', 'position', 'subplot', 'size_m', 'grid_n', 'top_edge',
      'taxonID', 'scientificName', 'vernacularName', 'cover_pct', 'freq_cells', 'freq_pct', 'height_cm', 'notes',
      ...cols,
    ].join(','),
  ];
  for (const q of quadrats) {
    const subplot = q.subplot_id != null ? (subplotLabelById.get(q.subplot_id) ?? null) : null;
    const ids = quadratEventIds(eventBase, q.label, subplot);
    const total = q.grid_n * q.grid_n;
    for (const s of q.species) {
      const cells = cellsOf(s, q.freq_mode);
      const mask = q.freq_mode !== 'count' && s.freq_cells && s.freq_cells.length === total ? s.freq_cells : null;
      lines.push(
        row([
          plotid, q.label, ids.eventID, ids.parentEventID, q.position, subplot, q.size_m, q.grid_n, q.top_edge,
          publishedTaxonId(s.taxon_id), s.simple_name ?? '', s.common_name_c ?? '', s.cover_pct, cells, cells == null ? null : pct((cells / total) * 100),
          s.height_cm, s.notes,
          ...cols.map((_, i) => (mask ? (getBit(mask, i) ? 1 : 0) : '')),
        ]),
      );
    }
  }
  return withBom(lines);
}

export function buildQuadratSurfaceCsv(
  plotid: string,
  quadrats: readonly QuadratDocInput[],
  subplotLabelById: ReadonlyMap<number, string>,
  isoTime: (ts: number) => string,
  eventBase: string = plotid,
): string {
  const lines = [
    [
      'plotid', 'quadrat', 'eventID', 'parentEventID', 'position', 'subplot', 'size_m', 'grid_n', 'top_edge',
      // The datum from locationTerms(), as every coordinate the app writes (code review L52).
      'decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters', 'geodeticDatum',
      ...SURFACE_KEYS, 'cov_sum', 'freq_mode', 'species', 'locked', 'started_at', 'ended_at', 'notes',
    ].join(','),
  ];
  for (const q of quadrats) {
    const subplot = q.subplot_id != null ? (subplotLabelById.get(q.subplot_id) ?? null) : null;
    const ids = quadratEventIds(eventBase, q.label, subplot);
    const values = SURFACE_KEYS.map((k) => q[k]);
    const sum = values.some((v) => v != null) ? pct(values.reduce<number>((a, v) => a + (v ?? 0), 0)) : null;
    lines.push(
      row([
        plotid, q.label, ids.eventID, ids.parentEventID, q.position, subplot, q.size_m, q.grid_n, q.top_edge,
        q.lat, q.lng, q.accuracy, locationTerms(q.lat, null, null).geodeticDatum,
        ...values, sum, q.freq_mode, q.species.length, q.locked ? 1 : 0,
        q.started_at != null ? isoTime(q.started_at) : null, q.ended_at != null ? isoTime(q.ended_at) : null, q.notes,
      ]),
    );
  }
  return withBom(lines);
}

/** What the plot-frequency CSV needs of a plot species record (v78). */
export type PlotFreqRecord = {
  occurrence_id: string;
  taxon_id: string;
  simple_name?: string;
  common_name_c?: string;
  layer: string;
  organism_quantity: string | null;
  organism_quantity_type: string | null;
  freq_cells: string | null;
  freq_count: number | null;
};

/**
 * ${plotid}_frequency.csv — frequency over the whole plot (v78): one row per
 * plot species record (taxon + layer) that has frequency, with the cell
 * columns of the plot grid. `occurrenceID` joins it to the occurrence CSV.
 */
export function buildPlotFrequencyCsv(
  plotid: string,
  grid: { n: number; topEdge: string; mode: 'cells' | 'count' },
  records: readonly PlotFreqRecord[],
): string {
  const { n } = grid;
  const total = n * n;
  const cols = cellColumns(n);
  const lines = [
    [
      'plotid', 'occurrenceID', 'taxonID', 'scientificName', 'vernacularName', 'layer', 'organismQuantity', 'organismQuantityType',
      'grid_n', 'top_edge', 'freq_cells', 'freq_pct', ...cols,
    ].join(','),
  ];
  for (const r of records) {
    const mask = grid.mode !== 'count' && r.freq_cells && r.freq_cells.length === total ? r.freq_cells : null;
    const count = grid.mode === 'count' ? r.freq_count : mask ? [...mask].filter((ch) => ch === '1').length : null;
    if (count == null) continue;
    lines.push(
      row([
        plotid, r.occurrence_id, publishedTaxonId(r.taxon_id), r.simple_name ?? '', r.common_name_c ?? '', r.layer,
        r.organism_quantity, r.organism_quantity_type, n, grid.topEdge, count, pct((count / total) * 100),
        ...cols.map((_, i) => (mask ? (getBit(mask, i) ? 1 : 0) : '')),
      ]),
    );
  }
  return withBom(lines);
}
