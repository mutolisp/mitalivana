/**
 * The survey components (docs/planned/Modular_survey.md §6), as data: where
 * each may sit, what parameters it takes, where its fields are stored and how
 * they leave the app. The editors are bound to these types on the screens'
 * side, so this file stays pure (check:templates runs it under Node).
 *
 * Phase 1 registers what the tree census uses: Taxon, Timestamp, Comments,
 * Investigators, Workers, Location, DBH, Height, Health, Photos. Phase 2A
 * opens the four always-present ones to the checklist and plot styles (a
 * template of those styles must be valid before any other component is);
 * Abundance, Frequency, Structure, Phenology, Traits, Environment and Audio
 * come with 2B.
 */
import type { SurveyLevel, SurveyStyle } from './template/types';

/** Where a field lives: a typed column, a row of an owner's values table, or fw_media. */
export type FieldStorage =
  | { col: string }
  | {
      values: 'fw_stem_values' | 'fw_individual_values' | 'fw_survey_values' | 'fw_unit_values' | 'fw_occurrence_values';
      component: string;
      field: string;
      valueType: 'num' | 'text' | 'json';
      unit?: string;
    }
  | { media: 'photo' | 'audio' };

export type FieldDef = { field: string; storage: FieldStorage };

/** How a field is exported: a Darwin Core term, or a MeasurementOrFact row. */
export type ExportMap = {
  dwc?: Readonly<Record<string, string>>;
  mof?: Readonly<Record<string, { measurementType: string; unit?: string }>>;
};

export type ComponentDef = {
  type: string;
  /** Always present; the validator adds it when a template leaves it out. */
  required: boolean;
  levels: readonly SurveyLevel[];
  styles: readonly SurveyStyle[];
  defaultLevel: SurveyLevel;
  /** Where a style puts it when that differs from defaultLevel (Taxon: occurrence outside the census). */
  defaultLevelFor?: Readonly<Partial<Record<SurveyStyle, SurveyLevel>>>;
  defaultParams: Readonly<Record<string, unknown>>;
  /** Problems with a parameter set (empty = valid). Codesets are checked by the validator. */
  checkParams: (params: Readonly<Record<string, unknown>>) => string[];
  /** Its fields and where they are stored when it sits on `level`. */
  fields: (params: Readonly<Record<string, unknown>>, level: SurveyLevel) => FieldDef[];
  exportMap: ExportMap;
};

export function defaultLevelOf(d: ComponentDef, style: SurveyStyle): SurveyLevel {
  return d.defaultLevelFor?.[style] ?? d.defaultLevel;
}

const ALL_STYLES: readonly SurveyStyle[] = ['checklist', 'plot', 'individual'];

/** The table holding each level's own rows (its `notes` column is the level's comments). */
const LEVEL_TABLE: Readonly<Record<SurveyLevel, string>> = {
  frame: 'fw_frames',
  survey: 'fw_surveys',
  unit: 'fw_units',
  occurrence: 'fw_occurrences',
  quadrat: 'fw_survey_quadrats',
  individual: 'fw_individuals',
  stem: 'fw_stem_measures',
};

const noParams = () => [];
const isPosNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Code sets a Health component may name: built in (src/survey/codesets/) or a template code list. */
export const BUILTIN_CODESETS = ['forestgeo-census-1998', 'forestgeo-ams-2021'] as const;

export const LOCATION_METHODS = ['grid', 'xy', 'polar', 'gps'] as const;

const DEFS: readonly ComponentDef[] = [
  {
    type: 'taxon',
    required: true,
    levels: ['individual', 'occurrence'],
    styles: ALL_STYLES,
    defaultLevel: 'individual',
    defaultLevelFor: { checklist: 'occurrence', plot: 'occurrence' },
    defaultParams: {},
    checkParams: noParams,
    fields: (_p, level) =>
      ['taxon_id', 'used_name_id', 'used_scientific_name', 'verbatim_identification'].map((field) => ({
        field,
        storage: { col: `${LEVEL_TABLE[level]}.${field}` },
      })),
    exportMap: { dwc: { taxon_id: 'taxonID', used_scientific_name: 'scientificName', verbatim_identification: 'verbatimIdentification' } },
  },
  {
    type: 'timestamp',
    required: true,
    levels: ['survey'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: () => [
      { field: 'start_ts', storage: { col: 'fw_surveys.start_ts' } },
      { field: 'stop_ts', storage: { col: 'fw_surveys.stop_ts' } },
    ],
    exportMap: { dwc: { start_ts: 'eventDate' } },
  },
  {
    type: 'comments',
    required: true,
    levels: ['frame', 'survey', 'unit', 'occurrence', 'quadrat', 'individual', 'stem'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: (_p, level) => [{ field: 'notes', storage: { col: `${LEVEL_TABLE[level]}.notes` } }],
    exportMap: { dwc: { notes: 'eventRemarks' } },
  },
  {
    type: 'investigators',
    required: true,
    levels: ['survey'],
    styles: ALL_STYLES,
    defaultLevel: 'survey',
    defaultParams: {},
    checkParams: noParams,
    fields: () => [{ field: 'investigators', storage: { col: 'fw_surveys.investigators' } }],
    exportMap: { dwc: { investigators: 'recordedBy' } },
  },
  {
    type: 'workers',
    required: false,
    levels: ['quadrat'],
    styles: ['individual'],
    defaultLevel: 'quadrat',
    defaultParams: { roles: ['recorder'] },
    checkParams: (p) => {
      const roles = p.roles;
      return Array.isArray(roles) && roles.length > 0 && roles.every((r) => r === 'recorder' || r === 'identifier')
        ? []
        : ['roles must be a non-empty list of recorder / identifier'];
    },
    fields: () => [{ field: 'recorded_by', storage: { col: 'fw_survey_quadrats.recorded_by' } }],
    exportMap: { dwc: { recorded_by: 'recordedBy' } },
  },
  {
    type: 'location',
    required: false,
    levels: ['individual'],
    styles: ['individual'],
    defaultLevel: 'individual',
    defaultParams: { methods: [...LOCATION_METHODS] },
    checkParams: (p) => {
      const m = p.methods;
      return Array.isArray(m) && m.length > 0 && m.every((x) => (LOCATION_METHODS as readonly unknown[]).includes(x))
        ? []
        : [`methods must be a non-empty subset of ${LOCATION_METHODS.join(', ')}`];
    },
    fields: () => [
      { field: 'x_m', storage: { col: 'fw_individuals.x_m' } },
      { field: 'y_m', storage: { col: 'fw_individuals.y_m' } },
      { field: 'coord_method', storage: { col: 'fw_individuals.coord_method' } },
    ],
    // decimalLatitude / decimalLongitude are derived at export from the frame's
    // origin (coords.ts toLatLng); the plot coordinates travel as measurements.
    exportMap: { mof: { x_m: { measurementType: 'plot x', unit: 'm' }, y_m: { measurementType: 'plot y', unit: 'm' } } },
  },
  {
    type: 'dbh',
    required: false,
    levels: ['stem'],
    styles: ['individual'],
    defaultLevel: 'stem',
    defaultParams: { classes: 'condit-qa' },
    checkParams: (p) => {
      const c = p.classes;
      if (c === 'condit-qa' || c === 'eia') return [];
      return Array.isArray(c) && c.length > 0 && c.every(isPosNumber) ? [] : ['classes must be condit-qa, eia, or a list of positive bounds (cm)'];
    },
    fields: () => [
      { field: 'dbh_cm', storage: { col: 'fw_stem_measures.dbh_cm' } },
      { field: 'pom_m', storage: { col: 'fw_stem_measures.pom_m' } },
      { field: 'pom_seq', storage: { col: 'fw_stem_measures.pom_seq' } },
    ],
    exportMap: { mof: { dbh_cm: { measurementType: 'DBH', unit: 'cm' }, pom_m: { measurementType: 'point of measurement height', unit: 'm' } } },
  },
  {
    type: 'height',
    required: false,
    levels: ['individual'],
    styles: ['individual'],
    defaultLevel: 'individual',
    defaultParams: {},
    checkParams: noParams,
    fields: () => [
      { field: 'height_m', storage: { values: 'fw_individual_values', component: 'height', field: 'height_m', valueType: 'num', unit: 'm' } },
    ],
    exportMap: { mof: { height_m: { measurementType: 'tree height', unit: 'm' } } },
  },
  {
    type: 'health',
    required: false,
    levels: ['stem'],
    styles: ['individual'],
    defaultLevel: 'stem',
    defaultParams: { codesets: ['forestgeo-census-1998'] },
    checkParams: (p) =>
      Array.isArray(p.codesets) && p.codesets.length > 0 && p.codesets.every((c) => typeof c === 'string' && c.length > 0)
        ? []
        : ['codesets must be a non-empty list of code set ids'],
    fields: () => [
      { field: 'census_codes', storage: { values: 'fw_stem_values', component: 'health', field: 'census_codes', valueType: 'json' } },
      { field: 'census_tree_codes', storage: { values: 'fw_individual_values', component: 'health', field: 'census_tree_codes', valueType: 'json' } },
    ],
    exportMap: { mof: { census_codes: { measurementType: 'ForestGEO census codes' }, census_tree_codes: { measurementType: 'ForestGEO census codes (whole tree)' } } },
  },
  {
    type: 'photos',
    required: false,
    levels: ['survey', 'individual', 'stem'],
    styles: ['individual'],
    defaultLevel: 'individual',
    defaultParams: { max: 6 },
    checkParams: (p) => (Number.isInteger(p.max) && (p.max as number) >= 1 && (p.max as number) <= 20 ? [] : ['max must be an integer 1–20']),
    fields: () => [{ field: 'photos', storage: { media: 'photo' } }],
    exportMap: { dwc: { photos: 'associatedMedia' } },
  },
];

const BY_TYPE = new Map(DEFS.map((d) => [d.type, d]));

export function componentDef(type: string): ComponentDef | undefined {
  return BY_TYPE.get(type);
}

export function componentDefs(): readonly ComponentDef[] {
  return DEFS;
}
