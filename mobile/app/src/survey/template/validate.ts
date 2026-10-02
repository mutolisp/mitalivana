/**
 * Template validation, required-component injection, change classification
 * (docs/planned/Modular_survey.md §4).
 *
 * - `withRequired` adds any always-present component a template left out
 *   (Taxon, Timestamp, Comments, Investigators): the builder cannot remove them.
 * - `validateTemplate` lists every problem; an empty list means usable.
 * - `classifyChange` tells whether version N+1 may upgrade surveys of version N
 *   (additive) or not (breaking). Code values once used never change: removing
 *   one is breaking; marking it deprecated is not.
 *
 * Pure: check:templates runs it under Node.
 */
import { BUILTIN_CODESETS, componentDef, componentDefs, defaultLevelOf } from '../registry';
import { rowHash } from '../../lib/mergeEngine';
import { MAX_UNIT_LEVELS, STYLE_LEVELS, type ComponentInstance, type Label, type SurveyTemplate } from './types';

export function withRequired(t: SurveyTemplate): SurveyTemplate {
  const missing = componentDefs()
    .filter((d) => d.required && d.styles.includes(t.style) && !t.components.some((c) => c.type === d.type))
    .map((d): ComponentInstance => ({ key: d.type, type: d.type, level: defaultLevelOf(d, t.style), required: true, params: { ...d.defaultParams } }));
  return missing.length ? { ...t, components: [...t.components, ...missing] } : t;
}

/**
 * Problems with one label. User-written text is content: a user or imported
 * template carries its words, never an i18n key (a key from another app
 * version would show as the key itself).
 */
function labelProblems(where: string, l: Label | undefined, builtin: boolean, optional = false): string[] {
  if (l == null) return optional ? [] : [`${where}: label missing`];
  if (typeof l !== 'object') return [`${where}: label must be {text} or {i18n}`];
  if ('i18n' in l) {
    if (!builtin) return [`${where}: only a built-in template may use an i18n key`];
    return typeof l.i18n === 'string' && l.i18n.length > 0 ? [] : [`${where}: empty i18n key`];
  }
  if (typeof l.text !== 'string' || !l.text.trim()) return [`${where}: empty label`];
  if (l.tr === undefined) return [];
  if (typeof l.tr !== 'object' || l.tr === null) return [`${where}: tr must be a map of language → text`];
  return Object.entries(l.tr).some(([lang, text]) => !lang.trim() || typeof text !== 'string' || !text.trim())
    ? [`${where}: tr has an empty language or text`]
    : [];
}

export function validateTemplate(t: SurveyTemplate): string[] {
  const out: string[] = [];
  if (t.schema !== 1) out.push('schema must be 1');
  if (!t.id) out.push('id is empty');
  if (!Number.isInteger(t.version) || t.version < 1) out.push('version must be an integer ≥ 1');
  if (!['builtin', 'user', 'imported'].includes(t.origin)) out.push(`unknown origin ${String(t.origin)}`);
  const levels = STYLE_LEVELS[t.style];
  if (!levels) {
    out.push(`unknown style ${String(t.style)}`);
    return out;
  }
  const builtin = t.origin === 'builtin';
  out.push(...labelProblems('name', t.name, builtin), ...labelProblems('description', t.description, builtin, true));
  const units = t.units ?? [];
  if (t.style === 'plot') {
    if (units.length < 1 || units.length > MAX_UNIT_LEVELS) out.push(`a plot-style template has 1–${MAX_UNIT_LEVELS} unit levels`);
  } else if (units.length) {
    out.push(`unit levels belong to the plot style, not ${t.style}`);
  }
  const unitKeys = new Set<string>();
  for (const u of units) {
    if (typeof u.key !== 'string' || !u.key.trim() || u.key !== u.key.trim()) out.push(`unit level key ${JSON.stringify(u.key)} must be non-empty, without outer spaces`);
    if (unitKeys.has(u.key)) out.push(`duplicate unit level ${u.key}`);
    unitKeys.add(u.key);
    out.push(...labelProblems(`unit level ${u.key}`, u.label, builtin));
  }
  const keys = new Set<string>();
  for (const c of t.components) {
    if (keys.has(c.key)) out.push(`duplicate component key ${c.key}`);
    keys.add(c.key);
    const def = componentDef(c.type);
    if (!def) {
      out.push(`${c.key}: unknown component type ${c.type}`);
      continue;
    }
    if (!def.styles.includes(t.style)) out.push(`${c.key}: ${c.type} is not available in the ${t.style} style`);
    if (!levels.includes(c.level) || !def.levels.includes(c.level)) out.push(`${c.key}: ${c.type} cannot sit on the ${c.level} level`);
    if (c.level === 'unit') {
      if (c.unit === undefined || !unitKeys.has(c.unit)) out.push(`${c.key}: names no unit level of this template (${String(c.unit)})`);
    } else if (c.unit !== undefined) {
      out.push(`${c.key}: only a component on the unit level names a unit level`);
    }
    if (def.required && !c.required) out.push(`${c.key}: ${c.type} is always required`);
    out.push(...labelProblems(c.key, c.label, builtin, true));
    for (const p of def.checkParams(c.params)) out.push(`${c.key}: ${p}`);
  }
  for (const d of componentDefs()) {
    if (d.required && d.styles.includes(t.style) && !t.components.some((c) => c.type === d.type)) {
      out.push(`missing required component ${d.type}`);
    }
  }
  const listIds = new Set<string>();
  for (const l of t.codelists) {
    if (typeof l.id !== 'string' || !l.id.trim()) out.push('code list with an empty id');
    if (listIds.has(l.id)) out.push(`duplicate code list ${l.id}`);
    listIds.add(l.id);
    if ((BUILTIN_CODESETS as readonly string[]).includes(l.id)) out.push(`code list ${l.id} shadows a built-in code set`);
    out.push(...labelProblems(`code list ${l.id}`, l.label, builtin));
    const codes = new Set<string>();
    for (const it of l.items) {
      if (typeof it.code !== 'string' || !it.code.trim()) out.push(`code list ${l.id}: empty code`);
      if (codes.has(it.code)) out.push(`code list ${l.id}: duplicate code ${it.code}`);
      codes.add(it.code);
      out.push(
        ...labelProblems(`code list ${l.id} code ${it.code}`, it.label, builtin),
        ...labelProblems(`code list ${l.id} code ${it.code} description`, it.description, builtin, true),
      );
    }
  }
  for (const c of t.components) {
    if (c.type !== 'health' || !Array.isArray(c.params.codesets)) continue;
    for (const id of c.params.codesets as unknown[]) {
      if (typeof id === 'string' && !(BUILTIN_CODESETS as readonly string[]).includes(id) && !listIds.has(id)) {
        out.push(`${c.key}: unknown code set ${id}`);
      }
    }
  }
  return out;
}

/** Hash of a template's content (its snapshot fingerprint). */
export function templateHash(t: SurveyTemplate): string {
  return rowHash(t as unknown as Record<string, unknown>);
}

export type ChangeKind = 'same' | 'additive' | 'breaking';

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether `next` may replace `prev` under a running survey: every component
 * kept with the same type and level and unchanged parameters (labels may
 * change), only optional components added, no code value removed or renamed.
 */
export function classifyChange(prev: SurveyTemplate, next: SurveyTemplate): ChangeKind {
  if (prev.id !== next.id || prev.style !== next.style) return 'breaking';
  let changed = false;
  // Unit levels: the same keys in the same order (units are stored by key); labels may change.
  const pu = prev.units ?? [];
  const nu = next.units ?? [];
  if (pu.length !== nu.length || pu.some((u, i) => u.key !== nu[i].key)) return 'breaking';
  if (!sameJson(pu, nu)) changed = true;
  for (const p of prev.components) {
    const n = next.components.find((c) => c.key === p.key);
    if (!n || n.type !== p.type || n.level !== p.level || n.unit !== p.unit || !sameJson(n.params, p.params)) return 'breaking';
    if (n.required !== p.required) {
      if (n.required) return 'breaking';
      changed = true;
    }
    if (!sameJson(n.label, p.label)) changed = true;
  }
  for (const n of next.components) {
    if (prev.components.some((c) => c.key === n.key)) continue;
    if (n.required) return 'breaking';
    changed = true;
  }
  for (const pl of prev.codelists) {
    const nl = next.codelists.find((l) => l.id === pl.id);
    if (!nl) return 'breaking';
    for (const it of pl.items) {
      const ni = nl.items.find((x) => x.code === it.code);
      if (!ni) return 'breaking';
      if (!sameJson(ni, it)) changed = true;
    }
    if (nl.items.length !== pl.items.length) changed = true;
  }
  if (next.codelists.length !== prev.codelists.length) changed = true;
  if (!sameJson(next.name, prev.name) || !sameJson(next.description, prev.description) || next.quick_add !== prev.quick_add) changed = true;
  return changed ? 'additive' : 'same';
}
