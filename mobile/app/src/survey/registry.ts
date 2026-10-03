/**
 * The survey components (docs/planned/Modular_survey.md §6), as data: where
 * each may sit, what parameters it takes, where its fields are stored, what
 * values they accept and how they leave the app. The inputs are bound to these
 * types on the screens' side (src/survey/components/editors/), so this file
 * stays pure (check:templates runs it under Node).
 *
 * Phase 1 registered what the tree census uses; 2A opened the four
 * always-present components to the checklist and plot styles; 2B adds
 * Abundance, Frequency, Structure, Phenology, Traits, Environment and Audio,
 * opens Workers, Location, Photos and Height to those styles, and gives Health
 * the AMS code set.
 *
 * Storage keys: a values-table row is keyed by the component's key in the
 * template (so two Traits components never mix), then field and idx. Census
 * components keep their Phase 1 keys ('health', 'height').
 */
import { bbRank, kindForType } from '../lib/dwcAbundanceCore';
import { AMS_CODESET, AMS_VARIABLES, amsField } from './codesets/forestgeoAms2021';
import type { SurveyLevel, SurveyStyle } from './template/types';

export type ValueType = 'num' | 'text' | 'json';

export type ValuesTable = 'fw_stem_values' | 'fw_individual_values' | 'fw_survey_values' | 'fw_unit_values' | 'fw_occurrence_values';

/**
 * Where a field lives: a column of the owner's row, a row of an owner's values
 * table, or fw_media. A 'num' field may hold a marker instead of a number
 * ('?', '<POM', 'NA' in the AMS code set): numbers go to value_num, markers to
 * value_text. `repeat`: one row per idx (Structure's per-layer values).
 */
export type FieldStorage =
  | { col: string; valueType: ValueType }
  | { values: ValuesTable; component: string; field: string; valueType: ValueType; unit?: string; repeat?: boolean }
  | { media: 'photo' | 'audio' };

/** What one field accepts. Markers (`markers`) pass every numeric rule. */
export type FieldRule = {
  required?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  oneOf?: readonly string[];
  markers?: readonly string[];
  /** Default 'error'. */
  severity?: 'error' | 'warning';
};

export type FieldDef = { field: string; storage: FieldStorage; rule?: FieldRule };

export type Params = Readonly<Record<string, unknown>>;

/** A field's value: a number, text, a list (json), or per-idx values (repeat). */
export type FieldValue = number | string | readonly string[] | Readonly<Record<number, number | string>> | null;
export type ComponentValues = Readonly<Record<string, FieldValue>>;

export type Problem = { field: string | null; idx?: number; code: string; severity: 'error' | 'warning' };

/** How a field is exported: a Darwin Core term, or a MeasurementOrFact row. */
export type ExportMap = {
  dwc?: Readonly<Record<string, string>>;
  mof?: Readonly<Record<string, { measurementType: string; unit?: string }>>;
};

/** Every component type; the inputs (editors/ComponentEditor.tsx) switch over it exhaustively. */
export const COMPONENT_TYPES = [
  'taxon',
  'timestamp',
  'comments',
  'investigators',
  'workers',
  'location',
  'dbh',
  'height',
  'health',
  'photos',
  'audio',
  'abundance',
  'frequency',
  'structure',
  'phenology',
  'traits',
  'environment',
  'choice',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export type ComponentDef = {
  type: ComponentType;
  /** Always present; the validator adds it when a template leaves it out. */
  required: boolean;
  /** 'one': at most once per level (its fields are columns or fixed keys); 'many': any number, under distinct keys. */
  cardinality: 'one' | 'many';
  levels: readonly SurveyLevel[];
  styles: readonly SurveyStyle[];
  defaultLevel: SurveyLevel;
  /** Where a style puts it when that differs from defaultLevel (Taxon: occurrence outside the census). */
  defaultLevelFor?: Readonly<Partial<Record<SurveyStyle, SurveyLevel>>>;
  defaultParams: Params;
  /** Default parameters on a level where defaultParams would not pass (Location off the census). */
  defaultParamsAt?: Readonly<Partial<Record<SurveyLevel, Params>>>;
  /** Problems with a parameter set on a level (empty = valid). Codesets are checked by the validator. */
  checkParams: (params: Params, level: SurveyLevel) => string[];
  /** Its fields, where they are stored and what they accept, when it sits on `level` under `key`. */
  fields: (params: Params, level: SurveyLevel, key: string) => FieldDef[];
  /** Rules across fields, on top of each field's own. */
  check?: (params: Params, values: ComponentValues, level: SurveyLevel) => Problem[];
  exportMap: ExportMap | ((params: Params, level: SurveyLevel) => ExportMap);
  /** i18n key of its name (built-ins; a template's own label overrides it). */
  labelKey: string;
  /**
   * Which parameter changes a running survey can take (decided 2026-10-03:
   * only those that add choices or widen a range). Left out: any change needs
   * a new survey. Called only when the parameters differ.
   */
  paramsChange?: (prev: Params, next: Params) => ParamsChange;
};

export type ParamsChange = 'same' | 'additive' | 'breaking';

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Lists under `grow` may gain items (any order); keys under `free` may change; anything else must stay. */
const growing =
  (grow: readonly string[], free: readonly string[] = []) =>
  (prev: Params, next: Params): ParamsChange => {
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (grow.includes(k)) {
        const n = asList(next[k]);
        if (!asList(prev[k]).every((x) => n.includes(x))) return 'breaking';
      } else if (!free.includes(k) && !sameJson(prev[k], next[k])) return 'breaking';
    }
    return 'additive';
  };

/** A count may go up, not down (photos, recordings). */
const notLower =
  (key: string) =>
  (prev: Params, next: Params): ParamsChange => {
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (k === key) {
        if (!(Number(next[k]) >= Number(prev[k]))) return 'breaking';
      } else if (!sameJson(prev[k], next[k])) return 'breaking';
    }
    return 'additive';
  };

/** Traits may be added, relabelled, or have their range widened; unit, integer and id stay. */
function traitsChange(prev: Params, next: Params): ParamsChange {
  const nextTraits = asList(next.traits) as TraitDef[];
  for (const p of asList(prev.traits) as TraitDef[]) {
    const n = nextTraits.find((x) => x?.id === p?.id);
    if (!n || (n.unit ?? null) !== (p.unit ?? null) || !!n.integer !== !!p.integer) return 'breaking';
    if (n.min != null && (p.min == null || n.min > p.min)) return 'breaking';
    if (n.max != null && (p.max == null || n.max < p.max)) return 'breaking';
  }
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (k !== 'traits' && !sameJson(prev[k], next[k])) return 'breaking';
  return 'additive';
}

/** How a component's parameters changed between two template versions. */
export function paramsChangeOf(d: ComponentDef, prev: Params, next: Params): ParamsChange {
  if (sameJson(prev, next)) return 'same';
  return d.paramsChange ? d.paramsChange(prev, next) : 'breaking';
}

export function defaultLevelOf(d: ComponentDef, style: SurveyStyle): SurveyLevel {
  return d.defaultLevelFor?.[style] ?? d.defaultLevel;
}

export function defaultParamsOf(d: ComponentDef, level: SurveyLevel): Params {
  return d.defaultParamsAt?.[level] ?? d.defaultParams;
}

export function exportMapOf(d: ComponentDef, params: Params, level: SurveyLevel): ExportMap {
  return typeof d.exportMap === 'function' ? d.exportMap(params, level) : d.exportMap;
}

const ALL_STYLES: readonly SurveyStyle[] = ['checklist', 'plot', 'individual'];
const NEW_STYLES: readonly SurveyStyle[] = ['checklist', 'plot'];

/** The table holding each level's own rows (its `notes` column is the level's comments). */
export const LEVEL_TABLE: Readonly<Record<SurveyLevel, string>> = {
  frame: 'fw_frames',
  survey: 'fw_surveys',
  unit: 'fw_units',
  occurrence: 'fw_occurrences',
  quadrat: 'fw_survey_quadrats',
  individual: 'fw_individuals',
  stem: 'fw_stem_measures',
};

/** The values table of each level that has one (a census tree's: per census, fw_individual_values). */
const VALUES_TABLE: Readonly<Partial<Record<SurveyLevel, ValuesTable>>> = {
  survey: 'fw_survey_values',
  unit: 'fw_unit_values',
  occurrence: 'fw_occurrence_values',
  individual: 'fw_individual_values',
};

const col = (level: SurveyLevel, field: string, valueType: ValueType, rule?: FieldRule): FieldDef => ({
  field,
  storage: { col: `${LEVEL_TABLE[level]}.${field}`, valueType },
  ...(rule ? { rule } : {}),
});

const val = (level: SurveyLevel, key: string, field: string, valueType: ValueType, extra: { unit?: string; repeat?: boolean; rule?: FieldRule } = {}): FieldDef => {
  const table = VALUES_TABLE[level];
  if (!table) throw new Error(`no values table on the ${level} level`);
  const { rule, ...more } = extra;
  return { field, storage: { values: table, component: key, field, valueType, ...more }, ...(rule ? { rule } : {}) };
};

const noParams = () => [];
const isPosNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const subsetOf = (v: unknown, allowed: readonly string[]) =>
  Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every((x) => allowed.includes(x as string));
const pct: FieldRule = { min: 0, max: 100 };

/** Code sets a Health component may name: built in (src/survey/codesets/) or a template code list. */
export const BUILTIN_CODESETS = ['forestgeo-census-1998', 'forestgeo-ams-2021'] as const;

export const LOCATION_METHODS = ['grid', 'xy', 'polar', 'gps'] as const;

/** Abundance inputs (src/components/abundance/AbundanceInputs.tsx) and the
 *  organismQuantityType each stores (src/lib/dwcAbundanceCore.ts); 'custom' is any other type. */
export const ABUNDANCE_KINDS = ['BB', 'percent', 'count', 'DBH', 'custom'] as const;
export const ABUNDANCE_TYPE: Readonly<Record<Exclude<(typeof ABUNDANCE_KINDS)[number], 'custom'>, string>> = {
  BB: 'Braun-Blanquet Scale',
  percent: '% cover',
  count: 'individuals',
  DBH: 'DBH (cm)',
};

export const TOP_EDGES = ['N', 'E', 'S', 'W', 'upslope'] as const;

/** Vegetation layers E1–E6, as plot surveys label them (Structure). */
export const MAX_LAYERS = 6;
export const LAYER_METHODS = ['BB', 'percent', 'DBH'] as const;
export const HEIGHT_UNITS = ['cm', 'm'] as const;

export const PHENOLOGY_FIELDS = ['sex', 'life_stage', 'reproductive_condition', 'leaf_phenology', 'degree_of_establishment'] as const;
const PHENOLOGY_JSON: readonly string[] = ['reproductive_condition', 'leaf_phenology'];

/** Ground covers that share the surface (they sum to at most 100 %), as on the plot screen. */
export const COVER_FIELDS = [
  'vascular_cover_pct',
  'bryophyte_cover_pct',
  'lichen_cover_pct',
  'litter_cover_pct',
  'rock_cover_pct',
  'gravel_cover_pct',
  'bareland_cover_pct',
] as const;
export const ENVIRONMENT_FIELDS = ['elevation_m', 'slope_deg', 'aspect_deg', 'terrain_position', ...COVER_FIELDS] as const;
export type EnvironmentField = (typeof ENVIRONMENT_FIELDS)[number];

const ENVIRONMENT_RULE: Readonly<Record<EnvironmentField, FieldRule>> = {
  elevation_m: { min: -500, max: 9000 },
  slope_deg: { min: 0, max: 90 },
  aspect_deg: { min: 0, max: 359 },
  terrain_position: {},
  vascular_cover_pct: pct,
  bryophyte_cover_pct: pct,
  lichen_cover_pct: pct,
  litter_cover_pct: pct,
  rock_cover_pct: pct,
  gravel_cover_pct: pct,
  bareland_cover_pct: pct,
};

const COVER_TYPE: Readonly<Record<(typeof COVER_FIELDS)[number], string>> = {
  vascular_cover_pct: 'surface cover: vascular plants',
  bryophyte_cover_pct: 'surface cover: bryophytes',
  lichen_cover_pct: 'surface cover: lichens',
  litter_cover_pct: 'surface cover: litter',
  rock_cover_pct: 'surface cover: rock',
  gravel_cover_pct: 'surface cover: gravel',
  bareland_cover_pct: 'surface cover: bare ground',
};

/** A trait as a template declares it (Traits, numeric in 2B). `label` is a template Label. */
export type TraitDef = { id: string; label: unknown; unit?: string; min?: number; max?: number; integer?: boolean };
const TRAIT_ID = /^[a-z][a-z0-9_]{0,31}$/;

export { amsField };

/** Fields a Health component stores, per code set it names. */
function healthFields(params: Params): FieldDef[] {
  const sets = Array.isArray(params.codesets) ? (params.codesets as string[]) : [];
  const out: FieldDef[] = [];
  for (const set of sets) {
    if (set === 'forestgeo-census-1998') {
      out.push(
        { field: 'census_codes', storage: { values: 'fw_stem_values', component: 'health', field: 'census_codes', valueType: 'json' } },
        { field: 'census_tree_codes', storage: { values: 'fw_individual_values', component: 'health', field: 'census_tree_codes', valueType: 'json' } },
      );
    } else if (set === AMS_CODESET) {
      for (const v of AMS_VARIABLES) {
        const field = amsField(v.field);
        // "?": "I can't tell in 30 seconds without binoculars", allowed for every variable (p.3).
        const rule: FieldRule =
          v.kind === 'number'
            ? { min: v.min, max: v.max, markers: ['?', ...(v.special ?? [])] }
            : v.kind === 'flag'
              ? { oneOf: ['Y', 'N', '?'] }
              : { oneOf: ['?', ...v.choices.map((c) => c.code)] };
        const valueType: ValueType = v.kind === 'number' ? 'num' : v.kind === 'multi' ? 'json' : 'text';
        out.push({
          field,
          storage: { values: 'fw_stem_values', component: 'health', field, valueType, ...(v.kind === 'number' ? { unit: v.unit } : {}) },
          rule,
        });
      }
    } else {
      // A template's own code list: its codes on the stem, as a list.
      out.push({ field: `codes_${set}`, storage: { values: 'fw_stem_values', component: 'health', field: `codes_${set}`, valueType: 'json' } });
    }
  }
  return out;
}

const healthMeasurementType = (field: string) =>
  field.startsWith('ams_')
    ? `ForestGEO AMS ${field.slice(4).replace(/_/g, ' ')}`
    : field === 'census_tree_codes'
      ? 'ForestGEO census codes (whole tree)'
      : field === 'census_codes'
        ? 'ForestGEO census codes'
        : `codes (${field.slice(6)})`;

/** The value must fit its quantity type, and the type must be one the template allows. */
function abundanceProblems(p: Params, v: ComponentValues): Problem[] {
  const q = v.organism_quantity;
  const type = v.organism_quantity_type;
  if ((q == null || q === '') && (type == null || type === '')) return [];
  if (typeof type !== 'string' || !type.trim()) return [{ field: 'organism_quantity_type', code: 'required', severity: 'error' }];
  const kinds = Array.isArray(p.kinds) ? (p.kinds as string[]) : [];
  const kind = kindForType(type);
  if (!kinds.includes(kind)) return [{ field: 'organism_quantity_type', code: 'not_allowed', severity: 'error' }];
  if (q == null || q === '') return [{ field: 'organism_quantity', code: 'required', severity: 'error' }];
  const text = String(q);
  const n = Number(text);
  const bad: Problem[] = [{ field: 'organism_quantity', code: 'out_of_range', severity: 'error' }];
  switch (kind) {
    case 'BB':
      return bbRank(text) != null ? [] : bad;
    case 'percent':
      return Number.isFinite(n) && n > 0 && n <= 100 ? [] : bad;
    case 'count':
      return Number.isInteger(n) && n >= 0 ? [] : bad;
    case 'DBH': {
      let arr: unknown = null;
      try {
        arr = JSON.parse(text);
      } catch {
        // not a list
      }
      return Array.isArray(arr) && arr.length > 0 && arr.every(isPosNumber) ? [] : bad;
    }
    case 'custom':
      return [];
  }
}

const DEFS: readonly ComponentDef[] = [
  {
    type: 'taxon',
    required: true,
    cardinality: 'one',
    levels: ['individual', 'occurrence'],
    styles: ALL_STYLES,
    defaultLevel: 'individual',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: {},
    checkParams: noParams,
    fields: (_p, level) => [
      col(level, 'taxon_id', 'text', { required: true }),
      // fw_individuals.used_name_id is TEXT (v80); fw_occurrences follows plot_species_records (INTEGER).
      col(level, 'used_name_id', level === 'individual' ? 'text' : 'num'),
      col(level, 'used_scientific_name', 'text'),
      col(level, 'verbatim_identification', 'text'),
    ],
    exportMap: { dwc: { taxon_id: 'taxonID', used_scientific_name: 'scientificName', verbatim_identification: 'verbatimIdentification' } },
    labelKey: 'survey.component.taxon',
  },
  {
    type: 'timestamp',
    required: true,
    cardinality: 'one',
    levels: ['survey'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: () => [col('survey', 'start_ts', 'num', { required: true }), col('survey', 'stop_ts', 'num')],
    check: (_p, v) =>
      typeof v.start_ts === 'number' && typeof v.stop_ts === 'number' && v.stop_ts < v.start_ts
        ? [{ field: 'stop_ts', code: 'ends_before_start', severity: 'error' }]
        : [],
    exportMap: { dwc: { start_ts: 'eventDate' } },
    labelKey: 'survey.component.timestamp',
  },
  {
    type: 'comments',
    required: true,
    cardinality: 'one',
    levels: ['frame', 'survey', 'unit', 'occurrence', 'quadrat', 'individual', 'stem'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: (_p, level) => [col(level, 'notes', 'text')],
    // An occurrence's comment is about the organism; the others are about their event.
    exportMap: (_p, level) => ({ dwc: { notes: level === 'occurrence' ? 'occurrenceRemarks' : 'eventRemarks' } }),
    labelKey: 'survey.component.comments',
  },
  {
    type: 'investigators',
    required: true,
    cardinality: 'one',
    levels: ['survey'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: () => [col('survey', 'investigators', 'text')],
    exportMap: { dwc: { investigators: 'recordedBy' } },
    labelKey: 'survey.component.investigators',
  },
  {
    type: 'workers',
    required: false,
    cardinality: 'one',
    levels: ['quadrat', 'unit', 'occurrence'],
    styles: ALL_STYLES,
    defaultLevel: 'quadrat',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: { roles: ['recorder'] },
    checkParams: (p, level) => {
      // A census quadrat has a recorder only (fw_survey_quadrats.recorded_by).
      const allowed = level === 'quadrat' ? ['recorder'] : ['recorder', 'identifier'];
      return subsetOf(p.roles, allowed) ? [] : [`roles must be a non-empty list of ${allowed.join(' / ')}`];
    },
    fields: (p, level, key) => {
      const roles = Array.isArray(p.roles) ? (p.roles as string[]) : [];
      const field = (role: string) => (role === 'identifier' ? 'identified_by' : 'recorded_by');
      return roles.map((r) => (level === 'unit' ? val('unit', key, field(r), 'text') : col(level, field(r), 'text')));
    },
    exportMap: { dwc: { recorded_by: 'recordedBy', identified_by: 'identifiedBy' } },
    labelKey: 'survey.component.workers',
    paramsChange: growing(['roles']),
  },
  {
    type: 'location',
    required: false,
    cardinality: 'one',
    levels: ['individual', 'unit', 'occurrence'],
    styles: ALL_STYLES,
    defaultLevel: 'individual',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: { methods: [...LOCATION_METHODS] },
    // Off the census there is no plot grid: a GNSS fix only.
    defaultParamsAt: { unit: { methods: ['gps'] }, occurrence: { methods: ['gps'] } },
    checkParams: (p, level) => {
      const allowed: readonly string[] = level === 'individual' ? LOCATION_METHODS : ['gps'];
      return subsetOf(p.methods, allowed) ? [] : [`methods must be a non-empty subset of ${allowed.join(', ')}`];
    },
    fields: (_p, level) => {
      if (level === 'individual') return [col(level, 'x_m', 'num'), col(level, 'y_m', 'num'), col(level, 'coord_method', 'text')];
      const fix = [col(level, 'lat', 'num', { min: -90, max: 90 }), col(level, 'lng', 'num', { min: -180, max: 180 }), col(level, 'accuracy', 'num', { min: 0 })];
      return level === 'occurrence'
        ? [...fix, col(level, 'elevation_m', 'num'), col(level, 'elevation_source', 'text')]
        : [...fix, col(level, 'geometry_geojson', 'text')];
    },
    // A census tree's lat/lng are derived at export from the frame's origin
    // (coords.ts toLatLng); its plot coordinates travel as measurements.
    exportMap: (_p, level) =>
      level === 'individual'
        ? { mof: { x_m: { measurementType: 'plot x', unit: 'm' }, y_m: { measurementType: 'plot y', unit: 'm' } } }
        : {
            dwc: {
              lat: 'decimalLatitude',
              lng: 'decimalLongitude',
              accuracy: 'coordinateUncertaintyInMeters',
              ...(level === 'occurrence' ? { elevation_m: 'minimumElevationInMeters' } : {}),
            },
          },
    labelKey: 'survey.component.location',
    paramsChange: growing(['methods']),
  },
  {
    type: 'dbh',
    required: false,
    cardinality: 'one',
    levels: ['stem'],
    styles: ['individual'],
    defaultLevel: 'stem',
    defaultParams: { classes: 'condit-qa' },
    checkParams: (p) => {
      const c = p.classes;
      if (c === 'condit-qa' || c === 'eia') return [];
      return Array.isArray(c) && c.length > 0 && c.every(isPosNumber) ? [] : ['classes must be condit-qa, eia, or a list of positive bounds (cm)'];
    },
    // A census stem's rules depend on its state (status.ts validateStem), not on fixed ranges.
    fields: () => [col('stem', 'dbh_cm', 'num'), col('stem', 'pom_m', 'num'), col('stem', 'pom_seq', 'num')],
    exportMap: { mof: { dbh_cm: { measurementType: 'DBH', unit: 'cm' }, pom_m: { measurementType: 'point of measurement height', unit: 'm' } } },
    labelKey: 'survey.component.dbh',
  },
  {
    type: 'height',
    required: false,
    cardinality: 'one',
    levels: ['individual', 'occurrence'],
    styles: ALL_STYLES,
    defaultLevel: 'individual',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: {},
    checkParams: noParams,
    fields: (_p, level, key) =>
      level === 'individual'
        ? [{ field: 'height_m', storage: { values: 'fw_individual_values', component: 'height', field: 'height_m', valueType: 'num', unit: 'm' }, rule: { min: 0 } }]
        : [val(level, key, 'height_m', 'num', { unit: 'm', rule: { min: 0 } })],
    exportMap: (_p, level) => ({ mof: { height_m: { measurementType: level === 'individual' ? 'tree height' : 'height', unit: 'm' } } }),
    labelKey: 'survey.component.height',
  },
  {
    type: 'health',
    required: false,
    cardinality: 'one',
    levels: ['stem'],
    styles: ['individual'],
    defaultLevel: 'stem',
    defaultParams: { codesets: ['forestgeo-census-1998'] },
    checkParams: (p) =>
      Array.isArray(p.codesets) &&
      p.codesets.length > 0 &&
      new Set(p.codesets).size === p.codesets.length &&
      p.codesets.every((c) => typeof c === 'string' && c.length > 0)
        ? []
        : ['codesets must be a non-empty list of distinct code set ids'],
    fields: (p) => healthFields(p),
    check: (_p, v) => {
      const out: Problem[] = [];
      const modeValue = v[amsField('mode')];
      const mode: readonly string[] = Array.isArray(modeValue) ? modeValue : [];
      const survival = v[amsField('survival_status')];
      // "B" and "S" are not compatible (p.4).
      if (mode.includes('S') && mode.includes('B')) out.push({ field: amsField('mode'), code: 'ams_mode_b_and_s', severity: 'error' });
      // "If Mode = U, always fill out the Leaning field" (p.4).
      if (mode.includes('U') && v[amsField('leaning_deg')] == null) out.push({ field: amsField('leaning_deg'), code: 'ams_uprooted_needs_leaning', severity: 'error' });
      // OK: standing and complete main axis (not uprooted, not broken), ≥90 % of the crown (p.3).
      if (survival === 'OK') {
        if (mode.includes('B') || mode.includes('U')) out.push({ field: amsField('mode'), code: 'ams_ok_but_damaged', severity: 'warning' });
        const crown = v[amsField('remaining_crown_pct')];
        if (typeof crown === 'number' && crown < 90) out.push({ field: amsField('remaining_crown_pct'), code: 'ams_ok_but_crown_lost', severity: 'warning' });
      }
      // X: entirely dead tissue above ground, "living length = 0 m" (p.3).
      const living = v[amsField('living_length_m')];
      if (survival === 'X' && typeof living === 'number' && living > 0) out.push({ field: amsField('living_length_m'), code: 'ams_x_with_living_length', severity: 'warning' });
      return out;
    },
    exportMap: (p) => ({
      mof: Object.fromEntries(
        healthFields(p).map((f) => [
          f.field,
          { measurementType: healthMeasurementType(f.field), ...('values' in f.storage && f.storage.unit ? { unit: f.storage.unit } : {}) },
        ]),
      ),
    }),
    labelKey: 'survey.component.health',
    // Adding a code set (AMS, a code list of the template's) only adds fields.
    paramsChange: growing(['codesets']),
  },
  {
    type: 'photos',
    required: false,
    cardinality: 'one',
    levels: ['survey', 'unit', 'occurrence', 'individual', 'stem'],
    styles: ALL_STYLES,
    defaultLevel: 'individual',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: { max: 6 },
    checkParams: (p) => (Number.isInteger(p.max) && (p.max as number) >= 1 && (p.max as number) <= 20 ? [] : ['max must be an integer 1–20']),
    fields: () => [{ field: 'photos', storage: { media: 'photo' } }],
    exportMap: { dwc: { photos: 'associatedMedia' } },
    labelKey: 'survey.component.photos',
    paramsChange: notLower('max'),
  },
  {
    type: 'audio',
    required: false,
    cardinality: 'one',
    levels: ['occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    defaultParams: { max: 6 },
    checkParams: (p) => (Number.isInteger(p.max) && (p.max as number) >= 1 && (p.max as number) <= 20 ? [] : ['max must be an integer 1–20']),
    fields: () => [{ field: 'audio', storage: { media: 'audio' } }],
    exportMap: { dwc: { audio: 'associatedMedia' } },
    labelKey: 'survey.component.audio',
    paramsChange: notLower('max'),
  },
  {
    type: 'abundance',
    required: false,
    cardinality: 'one',
    levels: ['occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    defaultParams: { kinds: ['BB', 'percent', 'count'], default: 'BB' },
    checkParams: (p) => {
      if (!subsetOf(p.kinds, ABUNDANCE_KINDS)) return [`kinds must be a non-empty subset of ${ABUNDANCE_KINDS.join(', ')}`];
      return (p.kinds as string[]).includes(p.default as string) ? [] : ['default must be one of kinds'];
    },
    fields: (_p, level) => [col(level, 'organism_quantity', 'text'), col(level, 'organism_quantity_type', 'text')],
    check: (p, v) => abundanceProblems(p, v),
    exportMap: { dwc: { organism_quantity: 'organismQuantity', organism_quantity_type: 'organismQuantityType' } },
    labelKey: 'survey.component.abundance',
    // The default scale is only what the form opens on.
    paramsChange: growing(['kinds'], ['default']),
  },
  {
    type: 'frequency',
    required: false,
    cardinality: 'one',
    levels: ['occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    // One grid for every unit of a survey (decided for plot frequency in v78).
    defaultParams: { mode: 'cells', n: 10, top_edge: 'N' },
    checkParams: (p) => {
      const out: string[] = [];
      if (p.mode !== 'cells' && p.mode !== 'count') out.push('mode must be cells or count');
      if (!Number.isInteger(p.n) || (p.n as number) < 2 || (p.n as number) > 10) out.push('n must be an integer 2–10');
      if (!(TOP_EDGES as readonly unknown[]).includes(p.top_edge)) out.push(`top_edge must be one of ${TOP_EDGES.join(', ')}`);
      return out;
    },
    fields: (p, level) => {
      const n = Number(p.n) || 10;
      return p.mode === 'count' ? [col(level, 'freq_count', 'num', { min: 0, max: n * n, integer: true })] : [col(level, 'freq_cells', 'text')];
    },
    check: (p, v) => {
      const n = Number(p.n) || 10;
      const cells = v.freq_cells;
      return typeof cells === 'string' && !new RegExp(`^[01]{${n * n}}$`).test(cells) ? [{ field: 'freq_cells', code: 'not_a_mask', severity: 'error' }] : [];
    },
    exportMap: { mof: { freq_cells: { measurementType: 'frequency', unit: '%' }, freq_count: { measurementType: 'frequency', unit: '%' } } },
    labelKey: 'survey.component.frequency',
  },
  {
    type: 'structure',
    required: false,
    cardinality: 'one',
    levels: ['survey', 'unit', 'occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    // The template gives the defaults; each survey sets its own layers, carried from the previous one (§5.5 #8).
    defaultParams: { layers: 4, methods: [...LAYER_METHODS] },
    checkParams: (p) => {
      const out: string[] = [];
      if (!Number.isInteger(p.layers) || (p.layers as number) < 1 || (p.layers as number) > MAX_LAYERS) out.push(`layers must be an integer 1–${MAX_LAYERS}`);
      if (!subsetOf(p.methods, LAYER_METHODS)) out.push(`methods must be a non-empty subset of ${LAYER_METHODS.join(', ')}`);
      return out;
    },
    fields: (p, level, key) => {
      if (level === 'occurrence') return [col(level, 'layer', 'text', { oneOf: Array.from({ length: MAX_LAYERS }, (_, i) => `E${i + 1}`) })];
      const perLayer = [
        val(level, key, 'cover_pct', 'num', { repeat: true, unit: '%', rule: pct }),
        val(level, key, 'height_cm', 'num', { repeat: true, unit: 'cm', rule: { min: 0 } }),
      ];
      if (level === 'unit') return perLayer;
      return [
        val(level, key, 'layer_count', 'num', { rule: { min: 1, max: MAX_LAYERS, integer: true } }),
        ...perLayer,
        val(level, key, 'height_unit', 'text', { repeat: true, rule: { oneOf: HEIGHT_UNITS } }),
        val(level, key, 'method', 'text', { repeat: true, rule: { oneOf: Array.isArray(p.methods) ? (p.methods as string[]) : LAYER_METHODS } }),
      ];
    },
    check: (_p, v, level) => {
      if (level === 'occurrence') return [];
      const out: Problem[] = [];
      const count = typeof v.layer_count === 'number' ? v.layer_count : MAX_LAYERS;
      for (const f of ['cover_pct', 'height_cm', 'height_unit', 'method']) {
        const per = v[f];
        if (per == null || typeof per !== 'object' || Array.isArray(per)) continue;
        for (const idx of Object.keys(per).map(Number)) {
          if (!Number.isInteger(idx) || idx < 1 || idx > count) out.push({ field: f, idx, code: 'layer_out_of_range', severity: 'warning' });
        }
      }
      return out;
    },
    exportMap: {
      mof: {
        layer: { measurementType: 'vegetation layer' },
        cover_pct: { measurementType: 'layer cover', unit: '%' },
        height_cm: { measurementType: 'layer height', unit: 'cm' },
      },
    },
    labelKey: 'survey.component.structure',
  },
  {
    type: 'phenology',
    required: false,
    cardinality: 'one',
    levels: ['occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    defaultParams: { fields: ['reproductive_condition', 'leaf_phenology'] },
    checkParams: (p) => (subsetOf(p.fields, PHENOLOGY_FIELDS) ? [] : [`fields must be a non-empty subset of ${PHENOLOGY_FIELDS.join(', ')}`]),
    fields: (p, level) => (Array.isArray(p.fields) ? (p.fields as string[]) : []).map((f) => col(level, f, PHENOLOGY_JSON.includes(f) ? 'json' : 'text')),
    // leafPhenology has no DwC term; the app already exports it as a measurement (dwcRows.ts).
    exportMap: {
      dwc: { sex: 'sex', life_stage: 'lifeStage', reproductive_condition: 'reproductiveCondition', degree_of_establishment: 'degreeOfEstablishment' },
      mof: { leaf_phenology: { measurementType: 'leafPhenology' } },
    },
    labelKey: 'survey.component.phenology',
    paramsChange: growing(['fields']),
  },
  {
    type: 'traits',
    required: false,
    cardinality: 'many',
    // On a census tree too (2D-b): measured each census, like its height.
    levels: ['occurrence', 'individual'],
    styles: ALL_STYLES,
    defaultLevel: 'occurrence',
    defaultLevelFor: { individual: 'individual' },
    // An example for the builder (2D) to start from; a template writes its own labels.
    defaultParams: { traits: [{ id: 'leaf_length', label: { text: '葉長', tr: { en: 'Leaf length' } }, unit: 'cm', min: 0 }] },
    checkParams: (p) => {
      const list = p.traits;
      if (!Array.isArray(list) || list.length === 0) return ['traits must be a non-empty list'];
      const out: string[] = [];
      const ids = new Set<string>();
      for (const t of list as TraitDef[]) {
        if (typeof t?.id !== 'string' || !TRAIT_ID.test(t.id)) out.push(`trait id ${JSON.stringify(t?.id)} must be lower-case letters, digits or _ (up to 32)`);
        else if (ids.has(t.id)) out.push(`duplicate trait ${t.id}`);
        else ids.add(t.id);
        if (t?.min != null && t?.max != null && !(t.min <= t.max)) out.push(`trait ${t?.id}: min above max`);
        if (t?.unit != null && (typeof t.unit !== 'string' || t.unit.length > 16)) out.push(`trait ${t?.id}: unit must be short text`);
      }
      return out;
    },
    fields: (p, level, key) =>
      (Array.isArray(p.traits) ? (p.traits as TraitDef[]) : []).map((t) => val(level, key, t.id, 'num', { unit: t.unit, rule: { min: t.min, max: t.max, integer: t.integer } })),
    exportMap: (p) => ({
      mof: Object.fromEntries(
        (Array.isArray(p.traits) ? (p.traits as TraitDef[]) : []).map((t) => [t.id, { measurementType: t.id.replace(/_/g, ' '), ...(t.unit ? { unit: t.unit } : {}) }]),
      ),
    }),
    labelKey: 'survey.component.traits',
    paramsChange: traitsChange,
  },
  {
    type: 'environment',
    required: false,
    cardinality: 'one',
    levels: ['survey', 'unit'],
    styles: NEW_STYLES,
    defaultLevel: 'survey',
    defaultParams: { fields: [...ENVIRONMENT_FIELDS] },
    checkParams: (p) => (subsetOf(p.fields, ENVIRONMENT_FIELDS) ? [] : [`fields must be a non-empty subset of ${ENVIRONMENT_FIELDS.join(', ')}`]),
    fields: (p, level, key) =>
      (Array.isArray(p.fields) ? (p.fields as EnvironmentField[]) : []).map((f) =>
        val(level, key, f, f === 'terrain_position' ? 'text' : 'num', {
          unit: f.endsWith('_pct') ? '%' : f.endsWith('_deg') ? '°' : f === 'elevation_m' ? 'm' : undefined,
          rule: ENVIRONMENT_RULE[f],
        }),
      ),
    // The ground covers share the surface; over 100 % is the user's to resolve (the plot screen's rule).
    check: (_p, v) => {
      const sum = COVER_FIELDS.reduce((s, f) => s + (typeof v[f] === 'number' ? (v[f] as number) : 0), 0);
      return Math.round(sum * 100) / 100 > 100 ? [{ field: null, code: 'covers_over_100', severity: 'warning' }] : [];
    },
    exportMap: {
      dwc: { elevation_m: 'minimumElevationInMeters' },
      mof: {
        slope_deg: { measurementType: 'slope', unit: 'degrees' },
        aspect_deg: { measurementType: 'aspect', unit: 'degrees' },
        terrain_position: { measurementType: 'terrain position' },
        ...Object.fromEntries(COVER_FIELDS.map((f) => [f, { measurementType: COVER_TYPE[f], unit: '%' }])),
      },
    },
    labelKey: 'survey.component.environment',
    paramsChange: growing(['fields']),
  },
  {
    // 自訂選項欄 (2D-b): one code, or several, from one of the template's own
    // code lists — the user's categories (microhabitat, substrate …). The
    // validator checks the list exists; codes keep their value once used
    // (classifyChange on code lists).
    type: 'choice',
    required: false,
    cardinality: 'many',
    levels: ['survey', 'unit', 'occurrence'],
    styles: NEW_STYLES,
    defaultLevel: 'occurrence',
    defaultParams: { list: 'list_1', multi: false },
    checkParams: (p) => {
      const out: string[] = [];
      if (typeof p.list !== 'string' || !p.list.trim()) out.push("list must name one of the template's code lists");
      if (typeof p.multi !== 'boolean') out.push('multi must be true or false');
      return out;
    },
    fields: (p, level, key) => [val(level, key, 'value', p.multi ? 'json' : 'text')],
    // The list's own name says what was measured; 2E writes it from the template.
    exportMap: (p) => ({ mof: { value: { measurementType: String(p.list) } } }),
    labelKey: 'survey.component.choice',
  },
];

/** A choice's parameters: which of the template's code lists, one code or several. */
export type ChoiceParams = { list: string; multi: boolean };

const BY_TYPE = new Map<string, ComponentDef>(DEFS.map((d) => [d.type, d]));

export function componentDef(type: string): ComponentDef | undefined {
  return BY_TYPE.get(type);
}

export function componentDefs(): readonly ComponentDef[] {
  return DEFS;
}

/** The code sets a template's Health component names (none without one). */
export function healthCodesets(components: readonly { type: string; params: Params }[]): string[] {
  const h = components.find((c) => c.type === 'health');
  return h && Array.isArray(h.params.codesets) ? (h.params.codesets as string[]) : [];
}
