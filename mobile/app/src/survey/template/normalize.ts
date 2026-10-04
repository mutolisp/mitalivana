/**
 * Template schema 2 (2026-10-04): what a schema-1 checklist / plot-style
 * template meant, said the schema-2 way.
 *
 * - 空間資料 became modules (centre card, 地理樣區, track). Every schema-1
 *   template had all three without saying so: they are added.
 * - Comments are always present on the survey level only; one on a unit or
 *   a species is a module the author may make 必填. A schema-1 template marked
 *   those `required` because comments were fixed everywhere, not because
 *   anyone made them 必填: they are cleared.
 *
 * Applied wherever a template is read (saved versions, drafts, survey
 * snapshots, template files, the samples); what is stored is left as it was,
 * so snapshots and their hashes do not change. A census template keeps
 * schema 1: none of this applies to it.
 *
 * Pure: check:templates runs it under Node.
 */
import { SPATIAL_TYPES } from '../registry';
import type { ComponentInstance, SurveyTemplate } from './types';

export const TEMPLATE_SCHEMA = 2;

function freeKey(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function normalizeTemplate(t: SurveyTemplate): SurveyTemplate {
  if (t.schema !== 1 || t.style === 'individual') return t;
  const taken = new Set(t.components.map((c) => c.key));
  const kept = t.components.map((c): ComponentInstance => (c.type === 'comments' && c.level !== 'survey' && c.required ? { ...c, required: false } : c));
  const spatial = SPATIAL_TYPES.filter((type) => !t.components.some((c) => c.type === type)).map((type): ComponentInstance => {
    const key = freeKey(taken, type);
    taken.add(key);
    return { key, type, level: 'survey', required: false, params: {} };
  });
  return { ...t, schema: TEMPLATE_SCHEMA, components: [...kept, ...spatial] };
}

/** A survey's stored template snapshot, as the survey screens and exports read it. */
export const parseSnapshot = (json: string): SurveyTemplate => normalizeTemplate(JSON.parse(json) as SurveyTemplate);
