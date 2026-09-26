/**
 * GLORIA round-trip document (the `.yml` inside an export zip). Pure.
 *
 * `record_type: gloria` is what lets the importer tell this file from a
 * checklist; older builds without GLORIA fall back to "checklist" for any
 * unknown yml, so the marker must stay at the top level.
 *
 * Every column of the six GLORIA tables is either here or listed as not
 * restorable in scripts/check-roundtrip.mjs.
 */

export const GLORIA_YAML_SCHEMA = 1;

export type GloriaDoc = {
  record_type: 'gloria';
  schema: number;
  summit: {
    full_code: string;
    country: string;
    target_region: string;
    summit: string;
    name: string | null;
    decimal_latitude: number | null;
    decimal_longitude: number | null;
    twd97x: number | null;
    twd97y: number | null;
    elevation_m: number | null;
    veg_zone: string | null;
  };
  survey: {
    uuid: string;
    mocy: number;
    year: number | null;
    start_ts: number;
    stop_ts: number | null;
    recorded_by: string | null;
    project_name: string | null;
    grid_ok: { N: number; E: number; S: number; W: number };
    notes: string | null;
    /** JSON [{ uri, viewpoint }] — summit overview photos (Annex III SU-OV). */
    overview_photos?: string | null;
    created_at: number;
    updated_at: number;
  };
  points: Array<{
    point_key: string;
    is_p5m: number;
    distance_m: number | null;
    compass_deg: number | null;
    photo_m2: string | null;
    photo_m2f: string | null;
    photo_point: string | null;
    comments: string | null;
    uuid: string;
  }>;
  units: Array<Record<string, unknown> & { code: string; uuid: string }>;
  taxa: Array<{
    serial: number;
    taxon_id: string;
    used_name_id: number | null;
    used_scientific_name: string | null;
    verbatim_identification: string | null;
    created_at: number;
    /** Display name at export time, for a reader without the checklist. */
    scientific_name?: string;
  }>;
  /** Photo checklist (v51); optional so older yml still loads. */
  photo_checks?: Array<{ item: string; checked: number; photo_uri: string | null; updated_at: number }>;
  species: Array<{
    unit: string;
    serial: number;
    occurrence_id: string;
    cover_pct: number | null;
    abundance: string | null;
    layer: string | null;
    cf: string | null;
    freq_cells: string | null;
    freq_count?: number | null;
    point_hits: string | null;
    legacy_hits: number | null;
    reproductive_condition?: string | null;
    leaf_phenology?: string | null;
    comments: string | null;
    /** v55; optional so older yml still loads. */
    sort_order?: number | null;
    created_at: number;
    updated_at: number;
  }>;
};

/** Unit columns carried verbatim (everything but ids and the FK). */
export const UNIT_FIELDS = [
  'code', 'unit_type', 'start_ts', 'stop_ts', 'freq_start_ts', 'freq_stop_ts', 'freq_stop_manual', 'freq_locked', 'pf_start_ts', 'pf_stop_ts', 'pf_locked', 'freq_skipped', 'date_only', 'done_locked', 'recorded_by', 'aspect_deg', 'slope_deg',
  'cov_vascular', 'cov_solid_rock', 'cov_scree', 'cov_lichens', 'cov_bryophytes', 'cov_bare_ground', 'cov_litter',
  'sub_lich_below_vasc', 'sub_lich_on_rock', 'sub_lich_on_scree', 'sub_bry_below_vasc', 'sub_bry_on_rock',
  'sub_bry_on_scree', 'dist_hi1', 'dist_hi2', 'dist_hi3', 'freq_mode', 'dist_hi1_n', 'dist_hi2_n', 'dist_hi3_n', 'point_surface', 'walk_option', 'legacy_surface_hits',
  'grazing_note', 'comments', 'photo_paths', 'uuid', 'updated_at',
] as const;

export function isGloriaDoc(doc: unknown): doc is GloriaDoc {
  return !!doc && typeof doc === 'object' && (doc as { record_type?: unknown }).record_type === 'gloria';
}

/** Structural check before an import touches the DB. Returns problems, empty when fine. */
export function validateGloriaDoc(doc: GloriaDoc): string[] {
  const out: string[] = [];
  if (doc.schema !== GLORIA_YAML_SCHEMA) out.push(`schema ${doc.schema}`);
  if (!doc.summit?.full_code) out.push('summit.full_code');
  if (!doc.survey?.uuid) out.push('survey.uuid');
  if (!Number.isInteger(doc.survey?.mocy)) out.push('survey.mocy');
  const serials = new Set((doc.taxa ?? []).map((t) => t.serial));
  const units = new Set((doc.units ?? []).map((u) => u.code));
  for (const s of doc.species ?? []) {
    if (!serials.has(s.serial)) out.push(`species ${s.occurrence_id}: serial ${s.serial}`);
    if (!units.has(s.unit)) out.push(`species ${s.occurrence_id}: unit ${s.unit}`);
  }
  return out;
}

// ── Pure builder (db.ts loads the rows; check-roundtrip feeds it fixtures) ──

type Row = Record<string, unknown>;
const pick = <K extends string>(r: Row, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, r[k] ?? null])) as Record<K, unknown>;

export const SUMMIT_FIELDS = [
  'full_code', 'country', 'target_region', 'summit', 'name', 'decimal_latitude', 'decimal_longitude',
  'twd97x', 'twd97y', 'elevation_m', 'veg_zone',
] as const;
export const POINT_FIELDS = [
  'point_key', 'is_p5m', 'distance_m', 'compass_deg', 'photo_m2', 'photo_m2f', 'photo_point', 'comments', 'uuid',
] as const;
export const TAXON_FIELDS = [
  'serial', 'taxon_id', 'used_name_id', 'used_scientific_name', 'verbatim_identification', 'created_at',
] as const;
export const PHOTO_CHECK_FIELDS = ['item', 'checked', 'photo_uri', 'updated_at'] as const;
export const SPECIES_FIELDS = [
  'occurrence_id', 'cover_pct', 'abundance', 'layer', 'cf', 'freq_cells', 'freq_count', 'point_hits', 'legacy_hits',
  'reproductive_condition', 'leaf_phenology', 'comments', 'sort_order', 'created_at', 'updated_at',
] as const;

export type GloriaDocInput = {
  summit: Row;
  survey: Row;
  projectName: string | null;
  points: Row[];
  units: Row[];
  taxa: Row[];
  /** Unit-species rows; `unit_id` and `gloria_taxon_id` are resolved through the maps. */
  species: Row[];
  photoChecks?: Row[];
  displayName?: (taxonId: string) => string | undefined;
};

export function buildGloriaDoc(i: GloriaDocInput): GloriaDoc {
  const codeOf = new Map(i.units.map((u) => [u.id, u.code as string]));
  const serialOf = new Map(i.taxa.map((t) => [t.id, t.serial as number]));
  const sv = i.survey;
  return {
    record_type: 'gloria',
    schema: GLORIA_YAML_SCHEMA,
    summit: pick(i.summit, SUMMIT_FIELDS) as GloriaDoc['summit'],
    survey: {
      uuid: sv.uuid as string,
      mocy: sv.mocy as number,
      year: (sv.year as number | null) ?? null,
      start_ts: sv.start_ts as number,
      stop_ts: (sv.stop_ts as number | null) ?? null,
      recorded_by: (sv.recorded_by as string | null) ?? null,
      project_name: i.projectName,
      grid_ok: {
        N: Number(sv.grid_ok_n ?? 0),
        E: Number(sv.grid_ok_e ?? 0),
        S: Number(sv.grid_ok_s ?? 0),
        W: Number(sv.grid_ok_w ?? 0),
      },
      notes: (sv.notes as string | null) ?? null,
      overview_photos: (sv.overview_photos as string | null) ?? null,
      created_at: sv.created_at as number,
      updated_at: sv.updated_at as number,
    },
    points: i.points.map((p) => pick(p, POINT_FIELDS) as GloriaDoc['points'][number]),
    units: i.units.map((u) => pick(u, UNIT_FIELDS) as GloriaDoc['units'][number]),
    taxa: i.taxa.map((t) => ({
      ...(pick(t, TAXON_FIELDS) as Omit<GloriaDoc['taxa'][number], 'scientific_name'>),
      scientific_name: i.displayName?.(t.taxon_id as string),
    })),
    species: i.species.map((s) => ({
      unit: codeOf.get(s.unit_id) ?? '',
      serial: serialOf.get(s.gloria_taxon_id) ?? 0,
      ...(pick(s, SPECIES_FIELDS) as Omit<GloriaDoc['species'][number], 'unit' | 'serial'>),
    })),
    photo_checks: (i.photoChecks ?? []).map((c) => pick(c, PHOTO_CHECK_FIELDS) as NonNullable<GloriaDoc['photo_checks']>[number]),
  };
}
