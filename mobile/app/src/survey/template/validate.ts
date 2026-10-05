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
import { BUILTIN_INTERACTION_CODES, INTERACTION_IRI } from '../codesets/interactions';
import { BUILTIN_CODESETS, componentDef, componentDefs, defaultLevelOf, defaultParamsOf, fixedAt, paramsChangeOf, type ComponentDef, type TraitDef } from '../registry';
import { rowHash } from '../../lib/mergeEngine';
import { fieldDefOf } from './obsField';
import { MAX_UNIT_LEVELS, STYLE_LEVELS, type ComponentInstance, type Label, type SurveyTemplate } from './types';

const COMPONENT_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** Whether `t` has the always-present component `d` where it is always present (comments: on the survey level). */
const hasFixed = (t: SurveyTemplate, d: ComponentDef) => t.components.some((c) => c.type === d.type && fixedAt(d, c.level));

export function withRequired(t: SurveyTemplate): SurveyTemplate {
  const taken = new Set(t.components.map((c) => c.key));
  const missing = componentDefs()
    .filter((d) => d.required && d.styles.includes(t.style) && !hasFixed(t, d))
    .map((d): ComponentInstance => {
      const level = defaultLevelOf(d, t.style);
      // A species' own comments may already hold the type's name as its key.
      let key: string = d.type;
      for (let i = 2; taken.has(key); i++) key = `${d.type}_${i}`;
      taken.add(key);
      return { key, type: d.type, level, required: true, params: { ...defaultParamsOf(d, level) } };
    });
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
  if (t.schema !== 1 && t.schema !== 2) out.push('schema must be 1 or 2');
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
  // A component stored in columns or under fixed keys can sit once per level (and unit level).
  const placed = new Set<string>();
  for (const c of t.components) {
    if (keys.has(c.key)) out.push(`duplicate component key ${c.key}`);
    keys.add(c.key);
    // The key names its rows in the values tables.
    if (typeof c.key !== 'string' || !COMPONENT_KEY.test(c.key)) out.push(`component key ${JSON.stringify(c.key)} must be lower-case letters, digits or _ (up to 32)`);
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
    if (fixedAt(def, c.level) && !c.required) out.push(`${c.key}: ${c.type} is always required`);
    const at = `${c.type}@${c.level}${c.level === 'unit' ? `:${String(c.unit)}` : ''}`;
    if (def.cardinality === 'one' && placed.has(at)) out.push(`${c.key}: ${c.type} sits on this level twice`);
    placed.add(at);
    out.push(...labelProblems(c.key, c.label, builtin, true));
    for (const p of def.checkParams(c.params, c.level)) out.push(`${c.key}: ${p}`);
    if (c.type === 'traits' && Array.isArray(c.params.traits)) {
      for (const tr of c.params.traits as TraitDef[]) out.push(...labelProblems(`${c.key} trait ${String(tr?.id)}`, tr?.label as Label | undefined, builtin));
    }
  }
  // 自訂欄位: every copy of one field in a template is the same definition (the builder keeps them so).
  const fieldCopies = new Map<string, string>();
  for (const c of t.components) {
    if (c.type !== 'field') continue;
    const k = String(c.params.key);
    const def = JSON.stringify(fieldDefOf(c.params));
    if (fieldCopies.has(k) && fieldCopies.get(k) !== def) out.push(`${c.key}: field ${k} differs from its other copy in this template`);
    fieldCopies.set(k, def);
  }
  for (const d of componentDefs()) {
    if (d.required && d.styles.includes(t.style) && !hasFixed(t, d)) {
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
        ...labelProblems(`code list ${l.id} code ${it.code} inverse`, it.inverse, builtin, true),
      );
      // An interaction type's own parts (2F).
      if (it.mutual !== undefined && typeof it.mutual !== 'boolean') out.push(`code list ${l.id} code ${it.code}: mutual must be true or false`);
      if (it.iri !== undefined && (typeof it.iri !== 'string' || !INTERACTION_IRI.test(it.iri))) out.push(`code list ${l.id} code ${it.code}: iri must be an http(s) address`);
    }
  }
  for (const c of t.components) {
    if (c.type === 'choice' && typeof c.params.list === 'string' && !listIds.has(c.params.list)) out.push(`${c.key}: unknown code list ${c.params.list}`);
    // 開闊度 as grades (2G-f): from one of the template's lists.
    if (c.type === 'environment' && typeof c.params.openness_list === 'string' && !listIds.has(c.params.openness_list)) out.push(`${c.key}: unknown code list ${c.params.openness_list}`);
    if (c.type === 'interaction') {
      // A stored type is its code alone: the template's own may not take a built-in's.
      const own = typeof c.params.list === 'string' ? t.codelists.find((l) => l.id === c.params.list) : undefined;
      if (typeof c.params.list === 'string' && !own) out.push(`${c.key}: unknown code list ${c.params.list}`);
      for (const it of own?.items ?? []) if (BUILTIN_INTERACTION_CODES.includes(it.code)) out.push(`${c.key}: code ${it.code} is a built-in interaction type`);
      const offered = (Array.isArray(c.params.builtin) ? c.params.builtin.length : 0) + (own?.items.filter((it) => !it.deprecated).length ?? 0);
      if (!offered) out.push(`${c.key}: offers no interaction type`);
    }
    if (c.type !== 'health' || !Array.isArray(c.params.codesets)) continue;
    // The census's own rules (status, POM, M) read the ForestGEO census codes: a census template keeps them.
    if (t.style === 'individual' && !c.params.codesets.includes('forestgeo-census-1998')) out.push(`${c.key}: a census keeps the forestgeo-census-1998 code set`);
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
 * kept with the same type and level, its parameters unchanged or only widened
 * as its registry entry allows (labels may change), only optional components
 * added, no code value removed or renamed.
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
    if (!n || n.type !== p.type || n.level !== p.level || n.unit !== p.unit) return 'breaking';
    // Parameters: only the widening each component allows (registry paramsChange).
    const def = componentDef(n.type);
    const pc = def ? paramsChangeOf(def, p.params, n.params) : sameJson(p.params, n.params) ? 'same' : 'breaking';
    if (pc === 'breaking') return 'breaking';
    if (pc === 'additive') changed = true;
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
  // The order components show in (the builder moves them): a change, nothing breaks.
  const kept = (a: SurveyTemplate, b: SurveyTemplate) => a.components.filter((c) => b.components.some((x) => x.key === c.key)).map((c) => c.key);
  if (!sameJson(kept(prev, next), kept(next, prev))) changed = true;
  for (const pl of prev.codelists) {
    const nl = next.codelists.find((l) => l.id === pl.id);
    if (!nl) return 'breaking';
    for (const it of pl.items) {
      const ni = nl.items.find((x) => x.code === it.code);
      if (!ni) return 'breaking';
      // An interaction type turned both ways (or one way) changes what its records mean.
      if (!!ni.mutual !== !!it.mutual) return 'breaking';
      if (!sameJson(ni, it)) changed = true;
    }
    if (nl.items.length !== pl.items.length) changed = true;
    // A list renamed or its codes reordered is a change too: it was taken for
    // none, and the builder dropped the draft as unchanged (code review L1).
    if (!sameJson(nl.label, pl.label) || !sameJson(nl.items.map((x) => x.code), pl.items.map((x) => x.code))) changed = true;
  }
  if (next.codelists.length !== prev.codelists.length) changed = true;
  if (!sameJson(next.name, prev.name) || !sameJson(next.description, prev.description) || next.quick_add !== prev.quick_add) changed = true;
  return changed ? 'additive' : 'same';
}
