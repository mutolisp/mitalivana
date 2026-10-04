/**
 * Checking a component's values against its registry definition
 * (src/survey/registry.ts): each field's own rule (required, range, integer,
 * allowed values, markers), then the component's rules across fields.
 * Pure: check:templates runs it under Node; the forms (2C) and the tree form
 * show what it finds, and surveyCore refuses values that cannot be stored.
 */
import { componentDef, type ComponentDef, type ComponentValues, type FieldDef, type FieldValue, type Params, type Problem } from './registry';
import type { ComponentInstance, SurveyLevel } from './template/types';

export const isEmpty = (v: FieldValue | undefined) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const numeric = (f: FieldDef) => ('col' in f.storage || 'values' in f.storage) && f.storage.valueType === 'num';

function checkScalar(f: FieldDef, x: unknown, idx: number | undefined, out: Problem[]): void {
  const r = f.rule ?? {};
  const severity = r.severity ?? 'error';
  const at = { field: f.field, ...(idx != null ? { idx } : {}) };
  if (typeof x === 'string' && r.markers?.includes(x)) return;
  if (numeric(f)) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      out.push({ ...at, code: 'not_a_number', severity: 'error' });
      return;
    }
    if (r.min != null && x < r.min) out.push({ ...at, code: 'below_min', severity });
    if (r.max != null && x > r.max) out.push({ ...at, code: 'above_max', severity });
    if (r.integer && !Number.isInteger(x)) out.push({ ...at, code: 'not_integer', severity });
    return;
  }
  if (r.oneOf && !r.oneOf.includes(String(x))) out.push({ ...at, code: 'not_allowed', severity });
}

/** Problems of one component's values on one owner. */
export function componentProblems(def: ComponentDef, params: Params, level: SurveyLevel, key: string, values: ComponentValues): Problem[] {
  const out: Problem[] = [];
  for (const f of def.fields(params, level, key)) {
    if ('media' in f.storage) continue;
    const v = values[f.field];
    if (isEmpty(v)) {
      if (f.rule?.required) out.push({ field: f.field, code: 'required', severity: f.rule.severity ?? 'error' });
      continue;
    }
    if ('values' in f.storage && f.storage.repeat) {
      if (typeof v !== 'object' || Array.isArray(v) || v == null) {
        out.push({ field: f.field, code: 'not_per_layer', severity: 'error' });
        continue;
      }
      for (const [i, x] of Object.entries(v)) if (x != null) checkScalar(f, x, Number(i), out);
      continue;
    }
    if (f.storage.valueType === 'json') {
      if (!Array.isArray(v)) {
        out.push({ field: f.field, code: 'not_a_list', severity: 'error' });
        continue;
      }
      for (const x of v) checkScalar(f, x, undefined, out);
      continue;
    }
    checkScalar(f, v, undefined, out);
  }
  return [...out, ...(def.check?.(params, values, level) ?? [])];
}

/** Field-level codes a store refuses; 'required' and the rules across fields are not among them. */
const FIELD_CODES = new Set(['not_a_number', 'below_min', 'above_max', 'not_integer', 'not_allowed', 'not_a_list', 'not_per_layer']);

/**
 * Whether a template's author made the component 必填 (2G-e; decided
 * 2026-10-04): the four every survey has (taxon, time, comments, surveyors)
 * are `required` because they always exist, not because they must be filled,
 * so they take no part.
 */
export function requiredByAuthor(c: Pick<ComponentInstance, 'type' | 'required'>): boolean {
  return c.required && !componentDef(c.type)?.required;
}

/**
 * A component's problems on one owner, with 必填未填 (`required_missing`, an
 * error) when its author made it required and nothing is in it. An error
 * here is counted when the record is finished and marked on lists; it never
 * stops a value being stored (storeBlockers only looks at fields).
 */
export function instanceProblems(c: ComponentInstance, values: ComponentValues): Problem[] {
  const def = componentDef(c.type);
  if (!def) return [];
  const out = componentProblems(def, c.params, c.level, c.key, values);
  if (requiredByAuthor(c) && !Object.values(values).some((v) => !isEmpty(v))) out.push({ field: null, code: 'required_missing', severity: 'error' });
  return out;
}

/** Problems a store must refuse: values of the wrong kind or outside what a
 *  field accepts. Missing values and rules across fields are left to the forms
 *  (a form saves field by field and passes through incomplete states). */
export function storeBlockers(def: ComponentDef, params: Params, level: SurveyLevel, key: string, values: ComponentValues): Problem[] {
  const own = new Set(def.fields(params, level, key).map((f) => f.field));
  return componentProblems(def, params, level, key, values).filter(
    (p) => p.severity === 'error' && p.field != null && own.has(p.field) && FIELD_CODES.has(p.code),
  );
}
