/**
 * Fixed-plot quadrats in the plot yml (06-plot-quadrats.md phase D): the
 * `quadrat_config` mapping in the plot block and the `quadrats:` list, each
 * quadrat with its species. Pure (no RN / DB), shared by the export builder
 * (bundleYaml.ts), the parser (plotImport.ts) and check:quadrats.
 *
 * A quadrat is keyed by its number (`idx`), a species inside it by taxon:
 * the file names a subplot by label, and photos by their names in the zip.
 * NULL-ish fields are left out of the file; the parser reads a missing key
 * as NULL, so an older file without quadrats imports as it always did.
 */
import { parseQuadratConfig, SURFACE_COLUMNS, TOP_EDGES, type QuadratConfig, type SurfaceColumn, type TopEdge } from '../db/quadratsCore';
import { isMask } from './grid';

export type ImportedQuadratSpecies = {
  taxon_id: string;
  /** For people reading the file; the taxon id is what is imported. */
  name?: string | null;
  cname?: string | null;
  cover_pct: number | null;
  freq_cells: string | null;
  freq_count: number | null;
  height_cm: number | null;
  notes: string | null;
};

export type ImportedQuadrat = {
  idx: number;
  uuid: string | null;
  label: string;
  position: string | null;
  /** Subplot label; the importer maps it to this device's subplot. */
  subplot: string | null;
  size_m: number;
  grid_n: number;
  top_edge: TopEdge;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  freq_mode: 'cells' | 'count';
  locked: 0 | 1;
  started_at: number | null;
  ended_at: number | null;
  notes: string | null;
  /** Photo names in the zip (export) or nothing (team documents). */
  photo_files: string[];
  species: ImportedQuadratSpecies[];
} & Record<SurfaceColumn, number | null>;

/** What the export builder needs of a quadrat (a DB row plus its species). */
export type QuadratDocInput = {
  idx: number;
  uuid: string;
  label: string;
  position: string | null;
  subplot_id: number | null;
  size_m: number;
  grid_n: number;
  top_edge: string;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  freq_mode: string;
  locked: number;
  started_at: number | null;
  ended_at: number | null;
  notes: string | null;
  /** JSON list of photo URIs (the column); the export names them in the zip. */
  photo_paths: string | null;
  species: {
    taxon_id: string;
    simple_name?: string;
    common_name_c?: string;
    cover_pct: number | null;
    freq_cells: string | null;
    freq_count: number | null;
    height_cm: number | null;
    notes: string | null;
  }[];
} & Record<SurfaceColumn, number | null>;

const present = (v: unknown) => v !== null && v !== undefined && v !== '';
const dense = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => present(v)));

/** The `quadrats:` list. `photoNames` maps a quadrat number to its photo names in the zip. */
export function quadratsToYaml(
  quadrats: readonly QuadratDocInput[],
  subplotLabelById: ReadonlyMap<number, string>,
  photoNames?: ReadonlyMap<number, string[]>,
): Record<string, unknown>[] {
  return quadrats.map((q) => {
    const photos = photoNames?.get(q.idx) ?? [];
    return dense({
      idx: q.idx,
      uuid: q.uuid,
      label: q.label,
      position: q.position,
      subplot: q.subplot_id != null ? (subplotLabelById.get(q.subplot_id) ?? null) : null,
      size_m: q.size_m,
      grid_n: q.grid_n,
      top_edge: q.top_edge,
      lat: q.lat,
      lng: q.lng,
      accuracy: q.accuracy,
      ...Object.fromEntries(SURFACE_COLUMNS.map((c) => [c, q[c]])),
      freq_mode: q.freq_mode,
      // Only a locked quadrat says so, as GLORIA's locks do.
      locked: q.locked ? 1 : null,
      started_at: q.started_at,
      ended_at: q.ended_at,
      notes: q.notes,
      photo_files: photos.length ? photos.join('|') : null,
      species: q.species.map((s) =>
        dense({
          taxon_id: s.taxon_id,
          name: s.simple_name,
          cname: s.common_name_c,
          cover_pct: s.cover_pct,
          freq_cells: s.freq_cells,
          freq_count: s.freq_count,
          height_cm: s.height_cm,
          notes: s.notes,
        }),
      ),
    });
  });
}

/** The config as a mapping in the plot block (the column holds JSON). */
export function configToYaml(json: string | null): QuadratConfig | null {
  return json ? parseQuadratConfig(json) : null;
}

/** Back to the column's JSON, through the parser so a hand-edited value cannot be stored bad. */
export function configFromYaml(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return JSON.stringify(parseQuadratConfig(JSON.stringify(v)));
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (present(v) ? String(v) : null);
const clampGrid = (v: unknown) => {
  const n = Math.round(num(v) ?? 10);
  return n >= 2 && n <= 10 ? n : 10;
};

/**
 * Read `quadrats:`. Bad values are coerced rather than thrown: the importer
 * writes through CHECKs, and one bad field must not abort a whole import
 * after the previous copy was deleted. A mask that does not fit its grid is
 * dropped (frequency "not done"), never stretched.
 */
export function quadratsFromYaml(raw: unknown): ImportedQuadrat[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: ImportedQuadrat[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const idx = Math.round(num(r.idx) ?? 0);
    if (idx < 1 || seen.has(idx)) continue;
    seen.add(idx);
    const grid = clampGrid(r.grid_n);
    const cells = grid * grid;
    const pct = (v: unknown) => {
      const n = num(v);
      return n != null && n >= 0 && n <= 100 ? n : null;
    };
    const taxa = new Set<string>();
    const species: ImportedQuadratSpecies[] = [];
    for (const s of Array.isArray(r.species) ? (r.species as Record<string, unknown>[]) : []) {
      const taxon = str(s?.taxon_id);
      if (!taxon || taxa.has(taxon)) continue;
      taxa.add(taxon);
      const cover = num(s.cover_pct);
      const mask = str(s.freq_cells);
      const count = num(s.freq_count);
      species.push({
        taxon_id: taxon,
        name: str(s.name),
        cname: str(s.cname),
        cover_pct: cover != null && cover > 0 && cover <= 100 ? cover : null,
        freq_cells: isMask(mask, cells) ? mask : null,
        freq_count: count != null ? Math.max(0, Math.min(cells, Math.round(count))) : null,
        height_cm: num(s.height_cm),
        notes: str(s.notes),
      });
    }
    const size = num(r.size_m);
    out.push({
      idx,
      uuid: str(r.uuid),
      label: str(r.label) ?? `Q${idx}`,
      position: str(r.position),
      subplot: str(r.subplot),
      size_m: size != null && size > 0 ? size : 1,
      grid_n: grid,
      top_edge: TOP_EDGES.includes(r.top_edge as TopEdge) ? (r.top_edge as TopEdge) : 'N',
      lat: num(r.lat),
      lng: num(r.lng),
      accuracy: num(r.accuracy),
      ...(Object.fromEntries(SURFACE_COLUMNS.map((c) => [c, pct(r[c])])) as Record<SurfaceColumn, number | null>),
      freq_mode: r.freq_mode === 'count' ? 'count' : 'cells',
      locked: num(r.locked) ? 1 : 0,
      started_at: num(r.started_at),
      ended_at: num(r.ended_at),
      notes: str(r.notes),
      photo_files: typeof r.photo_files === 'string' ? r.photo_files.split('|').filter(Boolean) : [],
      species,
    });
  }
  return out.sort((a, b) => a.idx - b.idx);
}
