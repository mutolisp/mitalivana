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

/** Levels a component can sit on, per style. */
export type SurveyLevel = 'frame' | 'survey' | 'quadrat' | 'individual' | 'stem';

export const STYLE_LEVELS: Readonly<Record<SurveyStyle, readonly SurveyLevel[]>> = {
  checklist: ['survey'],
  plot: ['frame', 'survey'],
  individual: ['frame', 'survey', 'quadrat', 'individual', 'stem'],
};

/** User-written text is content, not an i18n key; built-ins use a key. */
export type Label = { text: string; tr?: Readonly<Record<string, string>> } | { i18n: string };

export type CodeItem = { code: string; label: Label; description?: Label; source?: string; deprecated?: boolean };

export type CodeList = { id: string; label: Label; items: readonly CodeItem[] };

export type ComponentInstance = {
  /** Unique within the template; the same type may appear twice under two keys. */
  key: string;
  type: string;
  level: SurveyLevel;
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
  components: readonly ComponentInstance[];
  codelists: readonly CodeList[];
  /** Whether the species tab / taxonomy tree / favorites may add straight into it. */
  quick_add: boolean;
};
