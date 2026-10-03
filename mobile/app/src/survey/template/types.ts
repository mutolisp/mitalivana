/**
 * The survey template language (docs/planned/Modular_survey.md §4).
 *
 * A template is versioned JSON: `id` stays the same across versions, `version`
 * grows. A survey stores a frozen copy (fw_surveys.template_snapshot), so what
 * it shows, exports and merges never changes under it.
 *
 * Pure: check:templates runs it under Node.
 */
export type SurveyStyle = 'checklist' | 'plot' | 'individual';

/** Levels a component can sit on, per style. `unit` is one of a plot-style
 *  template's unit levels, named by the component's `unit`. */
export type SurveyLevel = 'frame' | 'survey' | 'unit' | 'occurrence' | 'quadrat' | 'individual' | 'stem';

export const STYLE_LEVELS: Readonly<Record<SurveyStyle, readonly SurveyLevel[]>> = {
  checklist: ['survey', 'occurrence'],
  plot: ['frame', 'survey', 'unit', 'occurrence'],
  individual: ['frame', 'survey', 'quadrat', 'individual', 'stem'],
};

/** How many unit levels a plot-style template has (plot → subplot → quadrat). */
export const MAX_UNIT_LEVELS = 3;

/** User-written text is content, not an i18n key; built-ins use a key. */
export type Label = { text: string; tr?: Readonly<Record<string, string>> } | { i18n: string };

export type CodeItem = {
  code: string;
  label: Label;
  description?: Label;
  source?: string;
  deprecated?: boolean;
  /**
   * An interaction type (Phase 2F; Modular_survey.md §5.6), in a list an
   * Interaction component names: both ways (A ↔ B) rather than one way, how
   * it reads from B's side (one way only), and its relation IRI (optional;
   * the OBO Relation Ontology's, as the built-in types).
   */
  mutual?: boolean;
  inverse?: Label;
  iri?: string;
};

export type CodeList = { id: string; label: Label; items: readonly CodeItem[] };

/** One level of a plot-style survey's units, top first. `key` is stored on
 *  every unit (fw_units.level_key, fw_frame_units.level_key). */
export type UnitLevel = { key: string; label: Label };

export type ComponentInstance = {
  /** Unique within the template; the same type may appear twice under two keys. */
  key: string;
  type: string;
  level: SurveyLevel;
  /** On the `unit` level: the key of the unit level it sits on. */
  unit?: string;
  label?: Label;
  required: boolean;
  params: Readonly<Record<string, unknown>>;
};

export type SurveyTemplate = {
  schema: 1;
  id: string;
  version: number;
  origin: 'builtin' | 'user' | 'imported';
  builtin_key?: string;
  builtin_version?: number;
  name: Label;
  description?: Label;
  style: SurveyStyle;
  /** Plot style only: 1–MAX_UNIT_LEVELS unit levels, top first. */
  units?: readonly UnitLevel[];
  components: readonly ComponentInstance[];
  codelists: readonly CodeList[];
  /** Whether the species tab / taxonomy tree / favorites may add straight into it. */
  quick_add: boolean;
};
