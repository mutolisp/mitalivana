/**
 * How merge fields read on screen: a label per column and a value formatter
 * (masks as counts, times, taxon names, JSON lists). Shared by the merge
 * review (app/merge.tsx) and the merge log (app/merge-log.tsx).
 */
import { searchByTaxonId } from '~/db/search';
import { isoStamp } from '~/lib/datetime';
import { LAYOUT_KEY } from '~/components/quadrat/names';

/** Field → label key; fields not listed show their column name. */
const FIELD_KEY: Record<string, string> = {
  lat: 'latitude',
  start_lat: 'latitude',
  decimal_latitude: 'latitude',
  lng: 'longitude',
  start_lng: 'longitude',
  decimal_longitude: 'longitude',
  accuracy: 'accuracy',
  coord_uncertainty_m: 'accuracy',
  comments: 'notes',
  field_note: 'notes',
  used_name_id: 'usedName',
  used_scientific_name: 'usedName',
  note: 'notes',
};
/** The same column meaning something else in a checklist / plot-style survey's rows (surveyDocCore.ts). */
const TABLE_FIELD_KEY: Record<string, Record<string, string>> = {
  occ: { unit: 'surveyUnit' },
  surveyval: { unit: 'measureUnit' },
  unitval: { unit: 'measureUnit' },
  occval: { unit: 'measureUnit' },
};
const LABELLED = new Set([
  'name', 'type', 'notes', 'gps_mode', 'taxon_id', 'observed_at', 'elevation_m', 'organism_quantity',
  'organism_quantity_type', 'sex', 'life_stage', 'reproductive_condition', 'leaf_phenology',
  'degree_of_establishment', 'verbatim_identification', 'plotid', 'layer_count', 'locality', 'slope_deg',
  'aspect_deg', 'cover_pct', 'height_cm', 'layer', 'subplot', 'label', 'year', 'unit', 'abundance', 'cf',
  'freq_cells', 'freq_count', 'point_hits', 'distance_m', 'compass_deg', 'is_p5m', 'checked', 'recorded_by',
  'start_ts', 'stop_ts', 'total_cover_pct', 'detection_type', 'done_locked', 'freq_locked', 'pf_locked',
  // Temperature loggers (v65)
  'visit_ts', 'researchers', 'locked', 'role', 'direction', 'quadrat', 'serial', 'logger_type', 'utc_diff_h', 'dist11_m',
  'dist31_m', 'photo_open', 'photo_closed', 'flags', 'researcher', 'visit', 'prev_uuid',
  // A cleared GLORIA unit: no researchers (v66)
  'no_researchers',
  // Fixed-plot quadrats (v77); a quadrat setting's row carries its `value`
  'position', 'size_m', 'grid_n', 'top_edge', 'freq_mode', 'value',
  // Tree census (survey framework, v80)
  'tag', 'dbh_cm', 'pom_m', 'pom_seq', 'is_main', 'stem_dead', 'pending', 'x_m', 'y_m', 'quadrat_code', 'coord_method', 'stem_no',
  'value_num', 'value_text', 'status', 'measured_at', 'local_x_m', 'local_y_m', 'ref_kind', 'ref_code', 'azimuth_deg', 'azimuth_ref',
  // Checklist / plot-style surveys (v83–v84)
  'parent', 'geometry_geojson', 'shape', 'width_m', 'length_m', 'radius_m', 'retired_at', 'phase', 'outcome', 'occurrence',
  'identified_by', 'elevation_source',
]);
/** GLORIA 完成 locks and other 1 / null flags. */
const LOCKS = new Set(['done_locked', 'freq_locked', 'pf_locked', 'locked', 'photo_open', 'photo_closed', 'no_researchers']);
/** Grids and point strings: shown as a count, not 100–400 characters. */
const MASKS = new Set(['freq_cells', 'point_hits', 'dist_hi1', 'dist_hi2', 'dist_hi3', 'point_surface']);
const TIMES = /(_ts|_at)$/;

/** A quadrat setting (a `qconfig` row, keyed by the setting) → its label key. */
const QCONFIG_KEY: Record<string, string> = {
  enabled: 'plot.quadrats.title',
  layout: 'plot.quadrats.layout',
  recordCover: 'plot.quadrats.recordCover',
  recordFreq: 'plot.quadrats.frequency',
  recordSurface: 'plot.quadrats.recordSurface',
  carryPrevious: 'plot.quadrats.carryPrevious',
  sizeM: 'plot.quadrats.sideLength',
  gridN: 'plot.quadrats.gridN',
  topEdge: 'plot.quadrats.topEdge',
  // Frequency over the whole plot (v78).
  freqEnabled: 'plot.quadrats.freqTitle',
  freqGridN: 'plot.quadrats.gridN',
  freqTopEdge: 'plot.quadrats.topEdge',
  freqMode: 'teamMerge.field.freq_mode',
};

/** A row's title on screen: the row's own label, except a quadrat setting's key. */
export function rowLabel(t: (k: string) => string, tbl: string, label: string): string {
  return tbl === 'qconfig' && QCONFIG_KEY[label] ? t(QCONFIG_KEY[label]) : label;
}

/** `tbl`: the row's table, for a column whose meaning depends on it. */
export function fieldLabel(t: (k: string) => string, f: string, tbl?: string): string {
  if (f.startsWith('cov_') || f.startsWith('sub_')) return t(`gloria.cover.${f}`);
  const k = (tbl ? TABLE_FIELD_KEY[tbl]?.[f] : undefined) ?? FIELD_KEY[f] ?? (LABELLED.has(f) ? f : null);
  return k ? t(`teamMerge.field.${k}`) : f;
}

/** Where a value sits, for values that need the row to read (quadrat settings). */
export type FmtContext = { t: (k: string, o?: Record<string, unknown>) => string; tbl: string; key: string };

/** Quadrat settings and fields stored as codes (v77): shown in words. */
function quadratValue(ctx: FmtContext, f: string, v: unknown): string | null {
  const { t } = ctx;
  const edge = (e: unknown) => (e === 'upslope' ? t('plot.quadrats.upslope') : String(e));
  if (ctx.tbl === 'qconfig' && f === 'value') {
    if (ctx.key === 'layout' && typeof v === 'string' && v in LAYOUT_KEY) return t(LAYOUT_KEY[v as keyof typeof LAYOUT_KEY]);
    if (ctx.key === 'topEdge' || ctx.key === 'freqTopEdge') return edge(v);
    if (ctx.key === 'freqGridN' && typeof v === 'number') return `${v} × ${v}`;
    if (ctx.key === 'freqMode') return v === 'count' ? t('quadrat.freq.countMode') : t('plot.quadrats.freqModeCells');
    if (ctx.key === 'sizeM' && typeof v === 'number') return `${v} m`;
    if (ctx.key === 'gridN' && typeof v === 'number') return `${v} × ${v}`;
    return null;
  }
  if (ctx.tbl === 'quadrat' && f === 'top_edge' && v != null) return edge(v);
  if (ctx.tbl === 'quadrat' && f === 'freq_mode' && v != null) return v === 'count' ? t('quadrat.freq.countMode') : t('plot.quadrats.freqModeCells');
  return null;
}

/** A census tree's position codes, in the words the tree editor shows. */
const TREE_CODE_KEY: Record<string, Record<string, string>> = {
  coord_method: { grid: 'survey.loc.grid', xy: 'survey.loc.xy', polar: 'survey.loc.polar', gps: 'survey.loc.gps' },
  ref_kind: { stake: 'survey.loc.refStake', tree: 'survey.loc.refTree' },
  azimuth_ref: { magnetic: 'survey.loc.compass', true: 'survey.frame.trueNorth' },
};

export function fmt(f: string, v: unknown, ctx?: FmtContext): string {
  if (LOCKS.has(f) || typeof v === 'boolean') return v ? '✓' : '—';
  if (v === null || v === undefined || v === '') return '—';
  const quadrat = ctx ? quadratValue(ctx, f, v) : null;
  if (quadrat != null) return quadrat;
  const code = ctx?.tbl === 'tree' && typeof v === 'string' ? TREE_CODE_KEY[f]?.[v] : undefined;
  if (code) return ctx!.t(code);
  // A survey occurrence's phase and a recheck answer, in the words the survey screens use.
  if (ctx?.tbl === 'occ' && f === 'phase' && (v === 'blind' || v === 'recheck')) return ctx.t(`surveyForm.phase.${v}`);
  if (ctx?.tbl === 'recheck' && f === 'outcome' && typeof v === 'string') return ctx.t(`surveyForm.recheck.${v}`);
  if (MASKS.has(f) && typeof v === 'string') {
    const on = f === 'point_surface' ? [...v].filter((c) => c !== '.').length : [...v].filter((c) => c === '1').length;
    return `${on}/${v.length}`;
  }
  if (TIMES.test(f) && typeof v === 'number') return isoStamp(v).slice(0, 16);
  if (f === 'taxon_id' && typeof v === 'string') {
    const hit = searchByTaxonId(v);
    return hit ? [hit.cname, hit.name].filter(Boolean).join(' ') : v;
  }
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}${x}`).join(' ');
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return (JSON.parse(v) as unknown[]).join('、');
    } catch {
      return v;
    }
  }
  return String(v);
}

