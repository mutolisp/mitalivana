/**
 * Editing a template in the builder (Phase 2D-a; Modular_survey.md §4). Every
 * operation takes a template and returns a new one, so the screens keep the
 * draft as plain data and check:templates runs the rules under Node.
 *
 * - Places: a checklist has the survey and its occurrences; a plot also has
 *   its unit levels between them. The permanent plot's own level is not
 *   offered: nothing stores its values yet (decided 2026-10-03).
 * - Component keys are made from the type (`traits`, `traits_2`, …) and never
 *   change: they name the rows in the values tables.
 * - Unit level keys are positional — `u1` is every template's top level,
 *   `u2` the next — so the templates used on one permanent plot share its
 *   layout, which is kept by level key (fw_frame_units.level_key; decided
 *   2026-10-03). Removing a level renumbers the ones below; moving a level is
 *   offered only before the template is first saved (a saved level's key
 *   would change meaning). Removing a level needs a new survey (classifyChange).
 * - A trait's id is its English name made into a key, while the trait is new;
 *   once a saved version has it, it stays (it names stored values).
 * - Labels are a name plus an optional English one (decided 2026-10-03).
 * - A tree census template is a copy of the built-in one (2D-b): its places
 *   are the census, each quadrat, each tree and each stem, and only what the
 *   census screens ask can change — height, photos and traits on the tree are
 *   added or removed; Health takes the AMS code set and the template's own
 *   code lists beside the ForestGEO census codes, which stay.
 */
import { BUILTIN_INTERACTION_CODES } from '../codesets/interactions';
import { componentDef, componentDefs, defaultParamsOf, fixedAt, SPATIAL_TYPES, type ComponentType, type SurveyGroupKey, type TraitDef } from '../registry';
import type { ObsFieldDef } from './obsField';
import { MAX_UNIT_LEVELS, type CodeItem, type CodeList, type ComponentInstance, type Label, type SurveyLevel, type SurveyStyle, type SurveyTemplate, type UnitLevel } from './types';
import { TEMPLATE_SCHEMA } from './normalize';
import { withRequired } from './validate';

/** Where a component sits in the builder: the survey, one unit level, the occurrences; in a census, each quadrat, tree and stem. */
export type Place = { level: 'survey' } | { level: 'unit'; unit: string } | { level: 'occurrence' } | { level: 'quadrat' } | { level: 'individual' } | { level: 'stem' };

/** What a census template may add or remove, per place: what the tree form asks when the template has it. */
const CENSUS_OPTIONAL: Readonly<Partial<Record<SurveyLevel, readonly ComponentType[]>>> = { individual: ['height', 'photos', 'traits'] };

/** The census code set every census template keeps (its status rules read it). */
export const CENSUS_CODESET = 'forestgeo-census-1998';

/** The styles the builder makes (the tree census is copied from its built-in in 2D-b). */
export type BuilderStyle = Extract<SurveyStyle, 'checklist' | 'plot'>;

export const samePlace = (a: Place, b: Place) => a.level === b.level && (a.level !== 'unit' || (b.level === 'unit' && a.unit === b.unit));

/** Where a component sits (null: on the permanent plot, which the builder does not offer). */
export const placeOf = (c: ComponentInstance): Place | null =>
  c.level === 'unit' ? (c.unit ? { level: 'unit', unit: c.unit } : null) : c.level === 'frame' ? null : { level: c.level };

/** Survey, unit levels top first, occurrences; a census: survey, quadrat, tree, stem. */
export function placesOf(t: SurveyTemplate): Place[] {
  if (t.style === 'individual') return [{ level: 'survey' }, { level: 'quadrat' }, { level: 'individual' }, { level: 'stem' }];
  return [{ level: 'survey' }, ...(t.style === 'plot' ? (t.units ?? []).map((u): Place => ({ level: 'unit', unit: u.key })) : []), { level: 'occurrence' }];
}

/** Whether the builder keeps `c` as it is (no removing): always-present components, and in a census all but its optional ones. */
export function isFixedComponent(t: SurveyTemplate, c: ComponentInstance): boolean {
  const def = componentDef(c.type);
  if (def && fixedAt(def, c.level)) return true;
  return t.style === 'individual' && !(CENSUS_OPTIONAL[c.level] ?? []).includes(c.type as ComponentType);
}

/** Whether the builder offers `c`'s parameters: in a census only Health, Location (its methods) and the optional ones. */
export function hasEditableParams(t: SurveyTemplate, c: ComponentInstance): boolean {
  if (t.style !== 'individual') return true;
  return c.type === 'health' || c.type === 'location' || !isFixedComponent(t, c);
}

export function componentsAt(t: SurveyTemplate, place: Place): ComponentInstance[] {
  return t.components.filter((c) => {
    const p = placeOf(c);
    return p != null && samePlace(p, place);
  });
}

/**
 * Component types that may be added here: optional, offered in this style and
 * on this level, not already here when there can be only one. `group`: on the
 * survey level, only that 調查資料 group's types (the builder's cards,
 * 2026-10-04: 基本資料, 時間資料, 空間資料, 調查法).
 */
export function addableTypes(t: SurveyTemplate, place: Place, group?: SurveyGroupKey): ComponentType[] {
  const here = componentsAt(t, place);
  const census = t.style === 'individual' ? (CENSUS_OPTIONAL[place.level] ?? []) : null;
  return componentDefs()
    // Always-present types only where they are not (a species' or a unit's comments).
    .filter((d) => !fixedAt(d, place.level as SurveyLevel) && (d.offeredIn ?? d.styles).includes(t.style) && d.levels.includes(place.level as SurveyLevel))
    .filter((d) => !census || census.includes(d.type))
    .filter((d) => !group || place.level !== 'survey' || (d.group ?? 'basic') === group)
    .filter((d) => d.cardinality === 'many' || !here.some((c) => c.type === d.type))
    .map((d) => d.type);
}

/** `base`, or `base_2`, `base_3`… — the first key no component of `t` has. */
export function nextKey(t: Pick<SurveyTemplate, 'components'>, base: string): string {
  const taken = new Set(t.components.map((c) => c.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/**
 * Add a 自訂欄位 (2026-10-04): the library's field `def` on `place`, its
 * definition carried in the parameters, under the field's key (with a suffix
 * when the template already has that key, e.g. the same field on a unit and a
 * species).
 */
export function addField(t: SurveyTemplate, place: Place, def: ObsFieldDef): { template: SurveyTemplate; key: string } {
  if (!addableTypes(t, place).includes('field')) throw new Error('a field cannot be added here');
  const key = nextKey(t, def.key);
  const c: ComponentInstance = {
    key,
    type: 'field',
    level: place.level,
    ...(place.level === 'unit' ? { unit: place.unit } : {}),
    required: false,
    params: { ...def },
  };
  return { template: insertAtPlace(t, place, c), key };
}

export function addComponent(t: SurveyTemplate, type: ComponentType, place: Place): { template: SurveyTemplate; key: string } {
  const def = componentDef(type);
  if (!def || !addableTypes(t, place).includes(type)) throw new Error(`${type} cannot be added here`);
  const key = nextKey(t, type);
  const c: ComponentInstance = {
    key,
    type,
    level: place.level,
    ...(place.level === 'unit' ? { unit: place.unit } : {}),
    required: false,
    params: { ...defaultParamsOf(def, place.level) },
  };
  return { template: insertAtPlace(t, place, c), key };
}

/** `c` after the last component of the same place, so the order on screen is the order added. */
function insertAtPlace(t: SurveyTemplate, place: Place, c: ComponentInstance): SurveyTemplate {
  const last = t.components.reduce((at, x, i) => {
    const p = placeOf(x);
    return p && samePlace(p, place) ? i : at;
  }, -1);
  const components = [...t.components];
  components.splice(last < 0 ? components.length : last + 1, 0, c);
  return { ...t, components };
}

/** Always-present components stay (the validator would put them back anyway), and a census's fixed ones. */
export function removeComponent(t: SurveyTemplate, key: string): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  if (!c || isFixedComponent(t, c)) return t;
  return { ...t, components: t.components.filter((x) => x.key !== key) };
}

/** One step up or down among the components of the same place. */
export function moveComponent(t: SurveyTemplate, key: string, dir: -1 | 1): SurveyTemplate {
  const i = t.components.findIndex((c) => c.key === key);
  const place = i < 0 ? null : placeOf(t.components[i]);
  if (!place) return t;
  let j = i + dir;
  while (j >= 0 && j < t.components.length) {
    const p = placeOf(t.components[j]);
    if (p && samePlace(p, place)) break;
    j += dir;
  }
  if (j < 0 || j >= t.components.length) return t;
  const components = [...t.components];
  [components[i], components[j]] = [components[j], components[i]];
  return { ...t, components };
}

/** `label: null` drops the component's own name (its type's name shows). Always-present components stay required; a census's required flags stay as they are. */
export function updateComponent(t: SurveyTemplate, key: string, patch: { params?: Record<string, unknown>; required?: boolean; label?: Label | null }): SurveyTemplate {
  return {
    ...t,
    components: t.components.map((c) => {
      if (c.key !== key) return c;
      const next: ComponentInstance = { ...c };
      if (patch.params) next.params = patch.params;
      if (patch.required !== undefined && !isFixedComponent(t, c) && t.style !== 'individual') next.required = patch.required;
      if (patch.label !== undefined) {
        if (patch.label) next.label = patch.label;
        else delete next.label;
      }
      return next;
    }),
  };
}

// ── unit levels (plot style) ───────────────────────────────────────────────

/** The key of unit level `i` (0 = top). */
export const unitKeyAt = (i: number) => `u${i + 1}`;

/** Keys back in position order (u1, u2, …), the components on each level following their level. */
export function rekeyUnits(t: SurveyTemplate): SurveyTemplate {
  const units = t.units ?? [];
  const to = new Map(units.map((u, i) => [u.key, unitKeyAt(i)]));
  if (units.every((u, i) => u.key === unitKeyAt(i))) return t;
  return {
    ...t,
    units: units.map((u, i) => ({ ...u, key: unitKeyAt(i) })),
    components: t.components.map((c) => (c.level === 'unit' && c.unit != null && to.has(c.unit) ? { ...c, unit: to.get(c.unit) } : c)),
  };
}

/** A level below the lowest one. */
export function addUnitLevel(t: SurveyTemplate, label: Label): SurveyTemplate {
  const units = t.units ?? [];
  if (t.style !== 'plot' || units.length >= MAX_UNIT_LEVELS) return t;
  return rekeyUnits({ ...t, units: [...units, { key: unitKeyAt(units.length), label }] });
}

export function updateUnitLevel(t: SurveyTemplate, key: string, label: Label): SurveyTemplate {
  return { ...t, units: (t.units ?? []).map((u): UnitLevel => (u.key === key ? { ...u, label } : u)) };
}

/** Its components go with it, the levels below move up; a plot keeps at least one level. */
export function removeUnitLevel(t: SurveyTemplate, key: string): SurveyTemplate {
  const units = t.units ?? [];
  if (units.length <= 1) return t;
  return rekeyUnits({ ...t, units: units.filter((u) => u.key !== key), components: t.components.filter((c) => !(c.level === 'unit' && c.unit === key)) });
}

/** Swap a level with its neighbour (with its components); only before the first save (see above). */
export function moveUnitLevel(t: SurveyTemplate, key: string, dir: -1 | 1): SurveyTemplate {
  const units = [...(t.units ?? [])];
  const i = units.findIndex((u) => u.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= units.length) return t;
  [units[i], units[j]] = [units[j], units[i]];
  return rekeyUnits({ ...t, units });
}

// ── starting points ────────────────────────────────────────────────────────

/** An empty checklist or plot-style template (a plot with one unit level). */
export function blankTemplate(style: BuilderStyle, id: string, name: Label, firstUnit: Label): SurveyTemplate {
  return withRequired({
    schema: TEMPLATE_SCHEMA,
    id,
    version: 1,
    origin: 'user',
    name,
    style,
    ...(style === 'plot' ? { units: [{ key: unitKeyAt(0), label: firstUnit }] } : {}),
    // As a survey has had them: the three 空間資料 modules and a species' comments (all removable).
    components: [
      ...SPATIAL_TYPES.map((type): ComponentInstance => ({ key: type, type, level: 'survey', required: false, params: {} })),
      { key: 'occ_notes', type: 'comments', level: 'occurrence', required: false, params: {} },
    ],
    codelists: [],
    // A checklist takes species from the species tab and the taxonomy tree; a plot records them unit by unit.
    quick_add: style === 'checklist',
  });
}

/**
 * A copy under a new id, as the user's own (a sample, a built-in or another of
 * theirs), its unit levels on the positional keys. A built-in's description is
 * an i18n key, which a user template cannot carry: dropped.
 */
export function copyTemplate(src: SurveyTemplate, id: string, name: Label): SurveyTemplate {
  const { builtin_key: _k, builtin_version: _v, description, ...rest } = src;
  return rekeyUnits({ ...rest, ...(description && !('i18n' in description) ? { description } : {}), id, version: 1, origin: 'user', name });
}

// ── labels ─────────────────────────────────────────────────────────────────

/** A name and an optional English name as a template label; null without a name. */
export function makeLabel(text: string, en?: string | null): Label | null {
  const main = text.trim();
  if (!main) return null;
  const english = en?.trim() ?? '';
  return english && english !== main ? { text: main, tr: { en: english } } : { text: main };
}

/** The two parts the builder edits (a built-in's i18n label has none). */
export function labelParts(label: Label | undefined | null): { text: string; en: string } {
  if (!label || 'i18n' in label) return { text: '', en: '' };
  return { text: label.text, en: label.tr?.en ?? '' };
}

// ── traits ─────────────────────────────────────────────────────────────────

const traitsOf = (c: ComponentInstance | undefined): TraitDef[] => (Array.isArray(c?.params.traits) ? (c.params.traits as TraitDef[]) : []);

/** A key from a name: lower-case ASCII, digits and _, starting with a letter (TRAIT_ID). */
export function keyFromName(name: string): string {
  const k = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 28);
  return k || 'trait';
}

function freeTraitId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** A blank trait at the end (its name is filled in next). */
export function addTrait(t: SurveyTemplate, key: string): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  if (!c || c.type !== 'traits') return t;
  const traits = traitsOf(c);
  const id = freeTraitId('trait', new Set(traits.map((x) => x.id)));
  return updateComponent(t, key, { params: { ...c.params, traits: [...traits, { id, label: { text: '' } }] } });
}

/**
 * Change trait `index`. While the saved version (`saved`) does not have this
 * trait, its id follows its English name (else its name); after that it stays.
 */
export function updateTrait(
  t: SurveyTemplate,
  key: string,
  index: number,
  patch: Partial<Pick<TraitDef, 'unit' | 'min' | 'max' | 'integer'>> & { name?: { text: string; en: string } },
  saved: SurveyTemplate | null,
): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  const traits = traitsOf(c);
  const cur = traits[index];
  if (!c || !cur) return t;
  const next: TraitDef = { ...cur };
  for (const f of ['unit', 'min', 'max', 'integer'] as const) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v === undefined || v === null || v === '' || v === false) delete next[f];
    else (next as Record<string, unknown>)[f] = v;
  }
  if (patch.name) {
    next.label = makeLabel(patch.name.text, patch.name.en) ?? { text: '' };
    const savedIds = new Set(traitsOf(saved?.components.find((x) => x.key === key)).map((x) => x.id));
    if (!savedIds.has(cur.id)) {
      const others = new Set(traits.filter((_, i) => i !== index).map((x) => x.id));
      next.id = freeTraitId(keyFromName(patch.name.en.trim() || patch.name.text), others);
    }
  }
  return updateComponent(t, key, { params: { ...c.params, traits: traits.map((x, i) => (i === index ? next : x)) } });
}

export function removeTrait(t: SurveyTemplate, key: string, index: number): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  const traits = traitsOf(c);
  if (!c || traits.length <= 1) return t;
  return updateComponent(t, key, { params: { ...c.params, traits: traits.filter((_, i) => i !== index) } });
}

// ── code lists (2D-b) ───────────────────────────────────────────────────────
//
// A template's own lists: the codes a choice offers, a census's own health
// codes. A code once saved keeps its value (it is what was recorded):
// removing one marks it deprecated instead, and only a code the saved version
// does not have can be renamed (classifyChange: a removed or renamed code is
// breaking).

function freeId(base: string, taken: Set<string>): string {
  for (let i = 1; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

const listOf = (t: SurveyTemplate | null | undefined, id: string): CodeList | undefined => t?.codelists.find((l) => l.id === id);

/** The components that use list `id` (a choice's list, a health component's code sets, an interaction's own types). */
export function codeListUsers(t: SurveyTemplate, id: string): ComponentInstance[] {
  return t.components.filter(
    (c) =>
      ((c.type === 'choice' || c.type === 'interaction') && c.params.list === id) ||
      (c.type === 'health' && Array.isArray(c.params.codesets) && c.params.codesets.includes(id)),
  );
}

/** Whether list `id` holds an interaction component's own types (its codes then have a direction, a reading from B and an IRI). */
export const isInteractionList = (t: SurveyTemplate, id: string) => t.components.some((c) => c.type === 'interaction' && c.params.list === id);

export function addCodeList(t: SurveyTemplate, label: Label): { template: SurveyTemplate; id: string } {
  const id = freeId('list', new Set(t.codelists.map((l) => l.id)));
  return { template: { ...t, codelists: [...t.codelists, { id, label, items: [] }] }, id };
}

export function updateCodeList(t: SurveyTemplate, id: string, label: Label): SurveyTemplate {
  return { ...t, codelists: t.codelists.map((l) => (l.id === id ? { ...l, label } : l)) };
}

/** Only a list nothing uses (a used one would leave a choice pointing nowhere). */
export function removeCodeList(t: SurveyTemplate, id: string): SurveyTemplate {
  if (codeListUsers(t, id).length) return t;
  return { ...t, codelists: t.codelists.filter((l) => l.id !== id) };
}

const setItems = (t: SurveyTemplate, id: string, items: readonly CodeItem[]): SurveyTemplate => ({
  ...t,
  codelists: t.codelists.map((l) => (l.id === id ? { ...l, items } : l)),
});

/** A new code at the end, numbered after the codes there (its name is filled in next). */
export function addCode(t: SurveyTemplate, id: string): SurveyTemplate {
  const l = listOf(t, id);
  if (!l) return t;
  const taken = new Set(l.items.map((x) => x.code));
  let n = l.items.length + 1;
  while (taken.has(String(n))) n++;
  return setItems(t, id, [...l.items, { code: String(n), label: { text: '' } }]);
}

/**
 * Change code `index`: its name, its deprecation, and its value while the
 * saved version (`saved`) does not have it. An interaction type (2F) also
 * has its direction — fixed once saved, as its value — how it reads from B
 * (empty drops it) and its IRI (empty drops it).
 */
export function updateCode(
  t: SurveyTemplate,
  id: string,
  index: number,
  patch: { code?: string; name?: { text: string; en: string }; deprecated?: boolean; mutual?: boolean; inverse?: { text: string; en: string }; iri?: string },
  saved: SurveyTemplate | null,
): SurveyTemplate {
  const l = listOf(t, id);
  const cur = l?.items[index];
  if (!l || !cur) return t;
  const next: CodeItem = { ...cur };
  const isSaved = !!listOf(saved, id)?.items.some((x) => x.code === cur.code);
  if (patch.code !== undefined && !isSaved) next.code = patch.code.trim();
  if (patch.name) next.label = makeLabel(patch.name.text, patch.name.en) ?? { text: '' };
  if (patch.mutual !== undefined && !isSaved) {
    if (patch.mutual) {
      next.mutual = true;
      // Both ways reads the same from either side.
      delete next.inverse;
    } else delete next.mutual;
  }
  if (patch.inverse) {
    const inv = next.mutual ? null : makeLabel(patch.inverse.text, patch.inverse.en);
    if (inv) next.inverse = inv;
    else delete next.inverse;
  }
  if (patch.iri !== undefined) {
    const iri = patch.iri.trim();
    if (iri) next.iri = iri;
    else delete next.iri;
  }
  if (patch.deprecated !== undefined) {
    if (patch.deprecated) next.deprecated = true;
    else delete next.deprecated;
  }
  return setItems(t, id, l.items.map((x, i) => (i === index ? next : x)));
}

/** A code the saved version has is only marked deprecated (still read where it was recorded); a new one goes. */
export function removeCode(t: SurveyTemplate, id: string, index: number, saved: SurveyTemplate | null): SurveyTemplate {
  const l = listOf(t, id);
  const cur = l?.items[index];
  if (!l || !cur) return t;
  if (listOf(saved, id)?.items.some((x) => x.code === cur.code)) return updateCode(t, id, index, { deprecated: true }, saved);
  return setItems(t, id, l.items.filter((_, i) => i !== index));
}

/**
 * Turn one code set of a Health component on or off: the AMS code set, or one
 * of the template's code lists. A census keeps the ForestGEO census codes.
 */
export function setHealthCodeset(t: SurveyTemplate, key: string, set: string, on: boolean): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  if (!c || c.type !== 'health') return t;
  if (!on && t.style === 'individual' && set === CENSUS_CODESET) return t;
  const sets = Array.isArray(c.params.codesets) ? (c.params.codesets as string[]) : [];
  if (on === sets.includes(set)) return t;
  return updateComponent(t, key, { params: { ...c.params, codesets: on ? [...sets, set] : sets.filter((x) => x !== set) } });
}

// ── interaction types (2F) ──────────────────────────────────────────────────

/** Offer a built-in interaction type, or stop offering it (in the order the app lists them). */
export function setInteractionBuiltin(t: SurveyTemplate, key: string, code: string, on: boolean): SurveyTemplate {
  const c = t.components.find((x) => x.key === key);
  if (!c || c.type !== 'interaction' || !BUILTIN_INTERACTION_CODES.includes(code)) return t;
  const cur = Array.isArray(c.params.builtin) ? (c.params.builtin as string[]) : [];
  if (on === cur.includes(code)) return t;
  const next = BUILTIN_INTERACTION_CODES.filter((x) => (x === code ? on : cur.includes(x)));
  return updateComponent(t, key, { params: { ...c.params, builtin: next } });
}

/** A type of the template's own: a new code in the component's list, made (named `newList`) when it has none. */
export function addInteractionType(t: SurveyTemplate, key: string, newList: Label): { template: SurveyTemplate; listId: string; index: number } | null {
  const c = t.components.find((x) => x.key === key);
  if (!c || c.type !== 'interaction') return null;
  let base = t;
  let listId = typeof c.params.list === 'string' && listOf(t, c.params.list) ? c.params.list : null;
  if (!listId) {
    const made = addCodeList(t, newList);
    listId = made.id;
    base = updateComponent(made.template, key, { params: { ...c.params, list: listId } });
  }
  const added = addCode(base, listId);
  const index = (listOf(added, listId)?.items.length ?? 1) - 1;
  return { template: added, listId, index };
}

// ── what still needs the user ──────────────────────────────────────────────

export type DraftIssue =
  | { code: 'name_empty' }
  | { code: 'no_unit_level' }
  | { code: 'unit_label_empty'; unit: string }
  | { code: 'trait_name_empty'; component: string; trait: number }
  | { code: 'trait_range'; component: string; trait: number }
  | { code: 'params'; component: string; detail: string }
  | { code: 'list_name_empty'; list: string }
  | { code: 'list_no_codes'; list: string }
  | { code: 'code_empty'; list: string; index: number }
  | { code: 'code_duplicate'; list: string; index: number }
  | { code: 'code_name_empty'; list: string; index: number }
  | { code: 'choice_list'; component: string }
  | { code: 'interaction_none'; component: string }
  | { code: 'interaction_code'; component: string; typeCode: string };

/** What the builder asks the user to fix before saving (the validator still runs on save). */
export function draftIssues(t: SurveyTemplate): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!labelParts(t.name).text.trim() && !(t.name && 'i18n' in t.name)) out.push({ code: 'name_empty' });
  if (t.style === 'plot') {
    if (!(t.units ?? []).length) out.push({ code: 'no_unit_level' });
    for (const u of t.units ?? []) if (!labelParts(u.label).text.trim() && !('i18n' in u.label)) out.push({ code: 'unit_label_empty', unit: u.key });
  }
  for (const c of t.components) {
    const def = componentDef(c.type);
    if (!def) continue;
    if (c.type === 'traits') {
      traitsOf(c).forEach((tr, i) => {
        if (!labelParts(tr.label as Label).text.trim()) out.push({ code: 'trait_name_empty', component: c.key, trait: i });
        if (tr.min != null && tr.max != null && tr.min > tr.max) out.push({ code: 'trait_range', component: c.key, trait: i });
      });
    }
    if (c.type === 'choice' && !t.codelists.some((l) => l.id === c.params.list)) {
      out.push({ code: 'choice_list', component: c.key });
      continue;
    }
    if (c.type === 'interaction') {
      const own = typeof c.params.list === 'string' ? listOf(t, c.params.list) : undefined;
      const builtin = Array.isArray(c.params.builtin) ? c.params.builtin.length : 0;
      if (!builtin && !own?.items.some((it) => !it.deprecated)) out.push({ code: 'interaction_none', component: c.key });
      for (const it of own?.items ?? []) if (BUILTIN_INTERACTION_CODES.includes(it.code)) out.push({ code: 'interaction_code', component: c.key, typeCode: it.code });
    }
    const problems = def.checkParams(c.params, c.level).filter((p) => c.type !== 'traits' || !/min above max/.test(p));
    if (problems.length) out.push({ code: 'params', component: c.key, detail: problems.join('; ') });
  }
  for (const l of t.codelists) {
    if (!labelParts(l.label).text.trim() && !('i18n' in l.label)) out.push({ code: 'list_name_empty', list: l.id });
    if (!l.items.length) out.push({ code: 'list_no_codes', list: l.id });
    const seen = new Set<string>();
    l.items.forEach((it, i) => {
      if (!it.code.trim()) out.push({ code: 'code_empty', list: l.id, index: i });
      else if (seen.has(it.code)) out.push({ code: 'code_duplicate', list: l.id, index: i });
      seen.add(it.code);
      if (!labelParts(it.label).text.trim() && !('i18n' in it.label)) out.push({ code: 'code_name_empty', list: l.id, index: i });
    });
  }
  return out;
}
