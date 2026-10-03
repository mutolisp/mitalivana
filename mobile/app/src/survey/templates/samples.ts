/**
 * Two sample templates for the checklist and plot styles (Phase 2C-a). Since
 * the builder (2D-a) they are only copied, never started from (decided
 * 2026-10-03); the real built-in templates come with Phase 3, when the
 * existing record kinds move onto the framework.
 *
 * One of each quick-add rule: the checklist takes species from the species
 * tab, the taxonomy tree and favorites; the plot does not (they are recorded
 * on its own screen, unit by unit).
 */
import type { SurveyTemplate } from '../template/types';
import { withRequired } from '../template/validate';

/**
 * Whether the screens offer checklist / plot-style surveys at all — the
 * builder, its templates and these samples — so users meet no record kind
 * that duplicates 快速名錄 and 樣區 before Phase 3. In release builds too
 * while the user tests (asked 2026-10-03, as the stress test); back to
 * `__DEV__` when testing is done (docs/Plan.md O).
 */
export const SURVEY_FORMS_OFFERED = true;

export const SAMPLE_CHECKLIST_TEMPLATE: SurveyTemplate = withRequired({
  schema: 1,
  id: 'sample:checklist',
  version: 1,
  origin: 'user',
  name: { text: '測試：名錄型', tr: { en: 'Test: checklist' } },
  style: 'checklist',
  components: [
    { key: 'comments', type: 'comments', level: 'survey', required: true, params: {} },
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['count', 'percent', 'custom'], default: 'count' } },
    { key: 'pheno', type: 'phenology', level: 'occurrence', required: false, params: { fields: ['sex', 'life_stage', 'reproductive_condition'] } },
    { key: 'where', type: 'location', level: 'occurrence', required: false, params: { methods: ['gps'] } },
    { key: 'photos', type: 'photos', level: 'occurrence', required: false, params: { max: 6 } },
    { key: 'occ_notes', type: 'comments', level: 'occurrence', required: true, params: {} },
  ],
  codelists: [],
  quick_add: true,
});

export const SAMPLE_PLOT_TEMPLATE: SurveyTemplate = withRequired({
  schema: 1,
  id: 'sample:plot',
  version: 1,
  origin: 'user',
  name: { text: '測試：樣區型', tr: { en: 'Test: plot' } },
  style: 'plot',
  units: [
    { key: 'subplot', label: { text: '小區', tr: { en: 'Subplot' } } },
    { key: 'quadrat', label: { text: '小樣方', tr: { en: 'Quadrat' } } },
  ],
  components: [
    { key: 'layers', type: 'structure', level: 'survey', required: false, params: { layers: 4, methods: ['BB', 'percent'] } },
    { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['elevation_m', 'slope_deg', 'aspect_deg', 'vascular_cover_pct'] } },
    { key: 'sub_where', type: 'location', level: 'unit', unit: 'subplot', required: false, params: { methods: ['gps'] } },
    { key: 'q_photos', type: 'photos', level: 'unit', unit: 'quadrat', required: false, params: { max: 4 } },
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'percent'], default: 'BB' } },
    { key: 'layer', type: 'structure', level: 'occurrence', required: false, params: { layers: 4, methods: ['BB'] } },
    { key: 'freq', type: 'frequency', level: 'occurrence', required: false, params: { mode: 'cells', n: 5, top_edge: 'upslope' } },
    { key: 'pheno', type: 'phenology', level: 'occurrence', required: false, params: { fields: ['reproductive_condition', 'leaf_phenology'] } },
  ],
  codelists: [],
  quick_add: false,
});

export const SAMPLE_TEMPLATES: readonly SurveyTemplate[] = [SAMPLE_CHECKLIST_TEMPLATE, SAMPLE_PLOT_TEMPLATE];
