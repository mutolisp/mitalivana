/**
 * Built-in template: tree census / stem mapping (docs/ForestGEO/Stem_mapping.md).
 *
 * Census codes only in Phase 1 (decided 2026-10-01); the AMS mortality and
 * damage code set is registered (src/survey/codesets/forestgeoAms2021.ts) and
 * its screens come with Phase 2. Raise `builtin_version` with any change: old
 * surveys keep their snapshot, and code values once used never change.
 */
import type { SurveyTemplate } from '../template/types';

export const STEMMAP_TEMPLATE: SurveyTemplate = {
  schema: 1,
  id: 'builtin:stemmap',
  version: 1,
  origin: 'builtin',
  builtin_key: 'stemmap',
  builtin_version: 1,
  name: { i18n: 'survey.template.stemmap.name' },
  description: { i18n: 'survey.template.stemmap.description' },
  style: 'individual',
  components: [
    { key: 'timestamp', type: 'timestamp', level: 'survey', required: true, params: {} },
    { key: 'investigators', type: 'investigators', level: 'survey', required: true, params: {} },
    { key: 'comments', type: 'comments', level: 'survey', required: true, params: {} },
    { key: 'workers', type: 'workers', level: 'quadrat', required: false, params: { roles: ['recorder'] } },
    { key: 'taxon', type: 'taxon', level: 'individual', required: true, params: {} },
    { key: 'location', type: 'location', level: 'individual', required: true, params: { methods: ['grid', 'xy', 'polar', 'gps'] } },
    { key: 'height', type: 'height', level: 'individual', required: false, params: {} },
    { key: 'photos', type: 'photos', level: 'individual', required: false, params: { max: 6 } },
    { key: 'dbh', type: 'dbh', level: 'stem', required: true, params: { classes: 'condit-qa' } },
    { key: 'health', type: 'health', level: 'stem', required: false, params: { codesets: ['forestgeo-census-1998'] } },
  ],
  codelists: [],
  quick_add: false,
};
