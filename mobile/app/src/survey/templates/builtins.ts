/**
 * The built-in templates. They live in code, not in survey_templates; a
 * survey keeps its own snapshot, so an app update never changes one already
 * started (Modular_survey.md §4).
 */
import type { SurveyTemplate } from '../template/types';
import { STEMMAP_TEMPLATE } from './stemmap';

export const BUILTIN_TEMPLATES: readonly SurveyTemplate[] = [STEMMAP_TEMPLATE];
