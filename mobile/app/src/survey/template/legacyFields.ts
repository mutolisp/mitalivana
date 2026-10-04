/**
 * 自訂選項 and Traits become 自訂欄位 (six-item plan D, 2026-10-04), and a
 * template file's fields join the library.
 *
 *   - convertLegacyComponents: a checklist / plot-style template's 自訂選項
 *     becomes one text field (its codes' names the allowed values, their
 *     English names kept, retired codes retired values, several as before);
 *     each trait of a Traits component a numeric field (unit, range, integer
 *     as they were). In place, with the component's 必填; a code list only
 *     those choices used goes. The builder does it when it opens such a
 *     template: saving it is then a breaking change, so surveys already
 *     started stay on their version, whose choices and traits still work.
 *     A tree census keeps its Traits.
 *   - fitTemplateFields: a template file's fields as the library has them
 *     (merged where they match, under `key_2` where they differ).
 *
 * Both say what the library must store; the caller stores it. Pure:
 * check:fields runs it.
 */
import type { TraitDef } from '../registry';
import { codeListUsers, labelParts, nextKey } from './edit';
import { FIELD_KEY, fieldDefOf, libraryFit, MAX_VALUE, suggestKey, type AllowedValue, type LibraryWrite, type ObsFieldDef } from './obsField';
import type { ComponentInstance, SurveyTemplate } from './types';

/** Allowed values from a code list's items: their names (the code when nameless or a repeat), single-line, no |. */
function allowedOf(items: readonly { code: string; label: unknown; deprecated?: boolean }[]): AllowedValue[] {
  const out: AllowedValue[] = [];
  for (const it of items) {
    const parts = labelParts(it.label as never);
    const clean = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
    let value = clean(parts.text) || clean(it.code);
    if (!value || out.some((a) => a.value === value)) value = clean(it.code);
    if (!value || out.some((a) => a.value === value)) continue;
    out.push({ value, ...(parts.en.trim() ? { en: parts.en.trim() } : {}), ...(it.deprecated ? { deprecated: true } : {}) });
  }
  return out;
}

/** A key from an English name, else `fallback` (a component key or trait id, already a valid key). */
const keyFrom = (en: string, fallback: string) => {
  const k = en.trim() ? suggestKey(en, new Set()) : fallback;
  return FIELD_KEY.test(k) && k !== 'field' ? k : fallback;
};

function choiceDef(t: SurveyTemplate, c: ComponentInstance): ObsFieldDef {
  const list = t.codelists.find((l) => l.id === c.params.list);
  const own = labelParts(c.label);
  const ln = labelParts(list?.label);
  const allowed = allowedOf(list?.items ?? []);
  const en = own.en || ln.en;
  return {
    key: keyFrom(en, c.key),
    name: own.text || ln.text || c.key,
    ...(en ? { name_en: en } : {}),
    datatype: 'text',
    // A list of fewer than two names cannot restrict (iNaturalist's rule): free text.
    ...(allowed.length >= 2 ? { allowed, ...(c.params.multi === true ? { multi: true } : {}) } : {}),
  };
}

function traitDefs(c: ComponentInstance): ObsFieldDef[] {
  const traits = (Array.isArray(c.params.traits) ? c.params.traits : []) as TraitDef[];
  return traits.map((tr) => {
    const parts = labelParts(tr.label as never);
    return {
      key: tr.id,
      name: parts.text || tr.id,
      ...(parts.en ? { name_en: parts.en } : {}),
      datatype: 'numeric',
      numeric_kind: tr.integer ? 'integer' : 'float',
      ...(tr.min != null ? { min: tr.min } : {}),
      ...(tr.max != null ? { max: tr.max } : {}),
      ...(tr.unit ? { unit: tr.unit } : {}),
    };
  });
}

export type FieldsResult<T> = { template: T; writes: LibraryWrite[] };

/** Fit each definition in turn, the library growing as it goes (two copies of one field land together). */
function fitter(library: ReadonlyMap<string, ObsFieldDef>) {
  const lib = new Map(library);
  const writes: LibraryWrite[] = [];
  return {
    writes,
    fit(def: ObsFieldDef): ObsFieldDef {
      const r = libraryFit(lib, def);
      if (r.write) {
        const at = writes.findIndex((w) => w.def.key === r.write!.def.key);
        // Written twice in one go: the second is the first one widened; keep it as one write.
        if (at >= 0) writes[at] = { def: r.write.def, ...(writes[at].prevKey ? { prevKey: writes[at].prevKey } : {}) };
        else writes.push(r.write);
        lib.set(r.def.key, r.def);
      }
      return r.def;
    },
  };
}

/**
 * A checklist / plot-style template with its 自訂選項 and Traits as fields
 * (the same object, and no writes, when it has none). `converted`: how many
 * components were.
 */
export function convertLegacyComponents(t: SurveyTemplate, library: ReadonlyMap<string, ObsFieldDef>): FieldsResult<SurveyTemplate> & { converted: number } {
  const legacy = t.components.filter((c) => c.type === 'choice' || c.type === 'traits');
  if (t.style === 'individual' || !legacy.length) return { template: t, writes: [], converted: 0 };
  const lib = fitter(library);
  const kept = { components: t.components.filter((c) => c.type !== 'choice' && c.type !== 'traits') };
  const made: ComponentInstance[] = [];
  const components = t.components.flatMap((c): ComponentInstance[] => {
    if (c.type !== 'choice' && c.type !== 'traits') return [c];
    const defs = c.type === 'choice' ? [choiceDef(t, c)] : traitDefs(c);
    return defs.map((d) => {
      const def = lib.fit(d);
      const field: ComponentInstance = {
        key: nextKey({ components: [...kept.components, ...made] }, def.key),
        type: 'field',
        level: c.level,
        ...(c.unit !== undefined ? { unit: c.unit } : {}),
        required: c.required,
        params: { ...def },
      };
      made.push(field);
      return field;
    });
  });
  // The copies as the library ends up (a later one may have widened an earlier one's field).
  const final = new Map(made.map((f) => [String(f.params.key), f.params]));
  const next = { ...t, components: components.map((c) => (c.type === 'field' && final.has(String(c.params.key)) ? { ...c, params: { ...final.get(String(c.params.key))! } } : c)) };
  // A code list only the converted choices used goes with them.
  const used = new Set(legacy.filter((c) => c.type === 'choice').map((c) => String(c.params.list)));
  const codelists = next.codelists.filter((l) => !used.has(l.id) || codeListUsers(next, l.id).length > 0);
  return { template: { ...next, codelists }, writes: lib.writes, converted: legacy.length };
}

/**
 * A template file's fields as the library has them: each field's copy is
 * fitted (libraryFit) — merged into the library's field of the same key, or
 * moved to `key_2`… when they differ. `renamed`: the keys moved.
 */
export function fitTemplateFields<T extends { components: readonly ComponentInstance[] }>(t: T, library: ReadonlyMap<string, ObsFieldDef>): FieldsResult<T> & { renamed: string[] } {
  const fields = t.components.filter((c) => c.type === 'field');
  if (!fields.length) return { template: t, writes: [], renamed: [] };
  const lib = fitter(library);
  const fitted = new Map<string, ObsFieldDef>();
  for (const c of fields) {
    const def = fieldDefOf(c.params);
    if (def && !fitted.has(def.key)) fitted.set(def.key, lib.fit(def));
  }
  // Every copy of a key as the library ends up holding it.
  const finalOf = (key: string) => {
    const f = fitted.get(key);
    return f ? (lib.writes.find((w) => w.def.key === f.key)?.def ?? f) : undefined;
  };
  const components = t.components.map((c) => {
    if (c.type !== 'field') return c;
    const def = finalOf(String(c.params.key));
    return def ? { ...c, params: { ...def } } : c;
  });
  const renamed = [...fitted].filter(([from, to]) => from !== to.key).map(([from]) => from);
  return { template: { ...t, components } as T, writes: lib.writes, renamed };
}
