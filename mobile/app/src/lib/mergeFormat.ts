/**
 * How merge fields read on screen: a label per column and a value formatter
 * (masks as counts, times, taxon names, JSON lists). Shared by the merge
 * review (app/merge.tsx) and the merge log (app/merge-log.tsx).
 */
import { searchByTaxonId } from '~/db/search';
import { isoStamp } from '~/lib/datetime';

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
]);
/** GLORIA 完成 locks and other 1 / null flags. */
const LOCKS = new Set(['done_locked', 'freq_locked', 'pf_locked', 'locked', 'photo_open', 'photo_closed', 'no_researchers']);
/** Grids and point strings: shown as a count, not 100–400 characters. */
const MASKS = new Set(['freq_cells', 'point_hits', 'dist_hi1', 'dist_hi2', 'dist_hi3', 'point_surface']);
const TIMES = /(_ts|_at)$/;

export function fieldLabel(t: (k: string) => string, f: string): string {
  if (f.startsWith('cov_') || f.startsWith('sub_')) return t(`gloria.cover.${f}`);
  const k = FIELD_KEY[f] ?? (LABELLED.has(f) ? f : null);
  return k ? t(`teamMerge.field.${k}`) : f;
}

export function fmt(f: string, v: unknown): string {
  if (LOCKS.has(f)) return v ? '✓' : '—';
  if (v === null || v === undefined || v === '') return '—';
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

