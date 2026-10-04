/**
 * 自訂欄位 (six-item plan C, 2026-10-04): a field the user defines once in the
 * app-wide library (observation_fields, v90) and adds to any template, after
 * iNaturalist's observation fields — a key, a name (and English name), a
 * description and a data type. Checked against the iNaturalist source
 * (app/models/observation_field.rb, observation_field_value.rb): the types are
 * text, numeric, date, time, datetime, taxon and dna; allowed values apply to
 * text only and are at least two; a DNA value is A, T, C, G and spaces; date
 * is YYYY-MM-DD, time HH:MM, datetime ISO 8601. The app adds, as decided
 * 2026-10-04: each allowed value may have an English name, a text field with
 * allowed values may take several (multi), a numeric field is integer or
 * decimal with an optional range and unit.
 *
 * A template carries the whole definition in the component's parameters (a
 * frozen copy), so a survey's snapshot, a template file, team sync and the
 * exports never need the library. The library is where a field is edited; the
 * builder brings a template's copies up to date (syncTemplateFields).
 *
 * Pure: check:fields runs it under Node.
 */

export const FIELD_DATATYPES = ['text', 'numeric', 'date', 'time', 'datetime', 'taxon', 'dna'] as const;
export type FieldDatatype = (typeof FIELD_DATATYPES)[number];

/** A text field's allowed value: stored as `value`; `en` is its English name; a deprecated one is no longer offered. */
export type AllowedValue = { value: string; en?: string; deprecated?: boolean };

/** A field's definition, as the library stores it and a template's component carries it. */
export type ObsFieldDef = {
  key: string;
  name: string;
  name_en?: string;
  description?: string;
  datatype: FieldDatatype;
  /** text only: the values it may take (at least two). */
  allowed?: AllowedValue[];
  /** text with allowed values only: several may be chosen. */
  multi?: boolean;
  /** numeric only. */
  numeric_kind?: 'integer' | 'float';
  min?: number;
  max?: number;
  unit?: string;
};

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_NAME = 80;
export const MAX_UNIT = 16;
export const MAX_VALUE = 80;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A definition from stored parameters (or a library row), dropping what does not belong to its type; null when it is not one. */
export function fieldDefOf(p: Readonly<Record<string, unknown>> | null | undefined): ObsFieldDef | null {
  if (!p || typeof p.key !== 'string' || typeof p.name !== 'string' || !FIELD_DATATYPES.includes(p.datatype as FieldDatatype)) return null;
  const datatype = p.datatype as FieldDatatype;
  const def: ObsFieldDef = { key: p.key, name: p.name, datatype };
  if (text(p.name_en)) def.name_en = text(p.name_en);
  if (text(p.description)) def.description = text(p.description);
  if (datatype === 'text' && Array.isArray(p.allowed) && p.allowed.length) {
    def.allowed = (p.allowed as unknown[]).map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return { value: String(x.value ?? ''), ...(text(x.en) ? { en: text(x.en) } : {}), ...(x.deprecated === true ? { deprecated: true } : {}) };
    });
    if (p.multi === true) def.multi = true;
  }
  if (datatype === 'numeric') {
    def.numeric_kind = p.numeric_kind === 'integer' ? 'integer' : 'float';
    if (finite(p.min) != null) def.min = finite(p.min);
    if (finite(p.max) != null) def.max = finite(p.max);
    if (text(p.unit)) def.unit = text(p.unit);
  }
  return def;
}

/** What is wrong with a definition (empty: valid). English, as the template validator reports. */
export function checkFieldDef(p: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  if (typeof p.key !== 'string' || !FIELD_KEY.test(p.key)) out.push('key must be lower-case letters, digits or _, starting with a letter (up to 64)');
  if (typeof p.name !== 'string' || !p.name.trim()) out.push('name is required');
  else if (p.name.length > MAX_NAME) out.push(`name is longer than ${MAX_NAME}`);
  if (!FIELD_DATATYPES.includes(p.datatype as FieldDatatype)) {
    out.push(`datatype must be one of ${FIELD_DATATYPES.join(', ')}`);
    return out;
  }
  const isText = p.datatype === 'text';
  if (p.allowed !== undefined) {
    if (!isText) out.push('allowed values are for text fields only');
    else if (!Array.isArray(p.allowed) || p.allowed.length < 2) out.push('allowed values must be at least two');
    else {
      const seen = new Set<string>();
      for (const a of p.allowed as { value?: unknown; en?: unknown }[]) {
        const v = typeof a?.value === 'string' ? a.value : '';
        if (!v.trim()) out.push('an allowed value is empty');
        else if (v !== v.trim() || v.includes('|') || v.length > MAX_VALUE) out.push(`allowed value ${JSON.stringify(v)} must be trimmed, without |, up to ${MAX_VALUE}`);
        else if (seen.has(v)) out.push(`duplicate allowed value ${JSON.stringify(v)}`);
        seen.add(v);
        if (a?.en !== undefined && typeof a.en !== 'string') out.push(`allowed value ${JSON.stringify(v)}: English name must be text`);
      }
    }
  }
  if (p.multi !== undefined && p.multi !== false && !(isText && Array.isArray(p.allowed))) out.push('multi is for text fields with allowed values');
  const isNum = p.datatype === 'numeric';
  for (const k of ['numeric_kind', 'min', 'max', 'unit'] as const) if (p[k] !== undefined && !isNum) out.push(`${k} is for numeric fields only`);
  if (isNum) {
    if (p.numeric_kind !== undefined && p.numeric_kind !== 'integer' && p.numeric_kind !== 'float') out.push('numeric_kind must be integer or float');
    if (p.min !== undefined && finite(p.min) == null) out.push('min must be a number');
    if (p.max !== undefined && finite(p.max) == null) out.push('max must be a number');
    if (finite(p.min) != null && finite(p.max) != null && (p.min as number) > (p.max as number)) out.push('min above max');
    if (p.unit !== undefined && (typeof p.unit !== 'string' || p.unit.length > MAX_UNIT)) out.push(`unit must be text up to ${MAX_UNIT}`);
  }
  return out;
}

export type FieldChange = 'same' | 'additive' | 'breaking';

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * How a field's definition changed (decided 2026-10-04), as surveys already
 * holding its values see it:
 *   - key, data type and unit stay;
 *   - name, English name and description may change;
 *   - allowed values may be added, renamed in English or deprecated, never
 *     dropped; leaving a free text field free is fine, restricting it is not;
 *     allowing all (dropping the list) widens it;
 *   - one value ↔ several changes how it is stored;
 *   - integer → decimal widens, decimal → integer does not;
 *   - a range may only widen.
 */
export function fieldChange(prev: ObsFieldDef, next: ObsFieldDef): FieldChange {
  if (sameJson(prev, next)) return 'same';
  if (prev.key !== next.key || prev.datatype !== next.datatype || (prev.unit ?? null) !== (next.unit ?? null)) return 'breaking';
  if (!!prev.multi !== !!next.multi) return 'breaking';
  if (next.allowed) {
    if (!prev.allowed) return 'breaking';
    if (!prev.allowed.every((a) => next.allowed!.some((b) => b.value === a.value))) return 'breaking';
  }
  if (prev.numeric_kind === 'float' && next.numeric_kind === 'integer') return 'breaking';
  if (next.min != null && (prev.min == null || next.min > prev.min)) return 'breaking';
  if (next.max != null && (prev.max == null || next.max < prev.max)) return 'breaking';
  return 'additive';
}

/** Allowed values as typed: `yes|no`, or one per line; trimmed, empty and repeated ones dropped. */
export function parseAllowedInput(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[|\n]/)) {
    const v = raw.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A key from a name (the English one first): lower-case words joined by _, unique among `taken`. */
export function suggestKey(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/_+$/, '')
      .slice(0, 48) || 'field';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// ── the library takes a definition from elsewhere ─────────────────────────

/**
 * `incoming` folded into the library's `have` (same key), as a template file
 * or a converted 自訂選項 brings it (decided 2026-10-04): when both have the
 * same type, unit and single / several choice, and both or neither restrict
 * text, the result keeps the library's names and has the values of both and
 * the wider range — a change every template using `have` can take
 * (fieldChange is never 'breaking'). Otherwise null: they are different
 * fields under one key.
 */
export function mergeFieldDefs(have: ObsFieldDef, incoming: ObsFieldDef): ObsFieldDef | null {
  if (have.datatype !== incoming.datatype || (have.unit ?? null) !== (incoming.unit ?? null) || !!have.multi !== !!incoming.multi) return null;
  if (!!have.allowed !== !!incoming.allowed) return null;
  const out: Record<string, unknown> = { ...have };
  if (have.allowed && incoming.allowed) out.allowed = [...have.allowed, ...incoming.allowed.filter((x) => !have.allowed!.some((y) => y.value === x.value))];
  if (have.datatype === 'numeric') {
    out.numeric_kind = have.numeric_kind === 'integer' && incoming.numeric_kind === 'integer' ? 'integer' : 'float';
    out.min = have.min == null || incoming.min == null ? undefined : Math.min(have.min, incoming.min);
    out.max = have.max == null || incoming.max == null ? undefined : Math.max(have.max, incoming.max);
  }
  return fieldDefOf(out);
}

export type LibraryWrite = { def: ObsFieldDef; prevKey?: string };

/**
 * Where `def` goes in the library: under its own key when that is free or
 * holds a field it merges with (mergeFieldDefs), else the first of
 * `key_2`, `key_3`… that is free or merges — so bringing the same file in
 * twice lands on the same fields. `def` is the definition the template should
 * carry; `write`, what the library must store (null: it already has it).
 */
export function libraryFit(library: ReadonlyMap<string, ObsFieldDef>, input: ObsFieldDef): { def: ObsFieldDef; write: LibraryWrite | null } {
  const def = fieldDefOf(input) ?? input;
  const base = def.key.slice(0, 60);
  for (let i = 1; ; i++) {
    const key = i === 1 ? def.key : `${base}_${i}`;
    const mine = i === 1 ? def : { ...def, key };
    const have = library.get(key);
    if (!have) return { def: mine, write: { def: mine } };
    const merged = mergeFieldDefs(have, mine);
    if (merged) return { def: merged, write: sameJson(merged, have) ? null : { def: merged, prevKey: key } };
  }
}

// ── values ──────────────────────────────────────────────────────────────────

export type ValueFormat = 'date' | 'time' | 'datetime' | 'dna';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(Z|[+-](0\d|1[0-4]):[0-5]\d)?$/;
const DNA = /^[ATCG]+( [ATCG]+)*$/;

function realDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Whether a stored value has its type's form: a real calendar date, HH:MM, ISO 8601 date and time, or DNA (A, T, C, G, single spaces). */
export function formatOk(format: ValueFormat, value: string): boolean {
  switch (format) {
    case 'date':
      return realDate(value);
    case 'time':
      return TIME.test(value);
    case 'datetime': {
      const m = DATETIME.exec(value);
      return !!m && realDate(m[1]);
    }
    case 'dna':
      return DNA.test(value);
  }
}

/** DNA as typed: upper case, runs of whitespace as one space. */
export const normalizeDna = (s: string): string => s.toUpperCase().replace(/\s+/g, ' ').trim();

const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');

/** A datetime value: local `YYYY-MM-DDTHH:MM` with the device's UTC offset at that moment. */
export function datetimeValue(ts: number): string {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** The epoch ms a date, time (today's) or datetime value stands for; null when it is none. */
export function valueToTs(format: 'date' | 'time' | 'datetime', value: string | null | undefined): number | null {
  if (!value || !formatOk(format, value)) return null;
  if (format === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0).getTime();
  }
  if (format === 'time') {
    const [h, mi] = value.split(':').map(Number);
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi).getTime();
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/** The format a data type's value must have (none for text, numeric and taxon). */
export function formatOf(datatype: FieldDatatype): ValueFormat | undefined {
  return datatype === 'date' || datatype === 'time' || datatype === 'datetime' || datatype === 'dna' ? datatype : undefined;
}

/** A field's name as a template Label: the name, with its English name as the English translation. */
export function fieldLabel(def: ObsFieldDef): { text: string; tr?: Record<string, string> } {
  return { text: def.name, ...(def.name_en ? { tr: { en: def.name_en } } : {}) };
}

/** An allowed value's English name, else the value. */
export function allowedEn(def: ObsFieldDef, value: string): string {
  return def.allowed?.find((a) => a.value === value)?.en || value;
}

// ── templates and the library ──────────────────────────────────────────────

type WithComponents = { components: readonly { type: string; params: Readonly<Record<string, unknown>> }[] };

/** The field keys a template uses. */
export function fieldKeysOf(t: WithComponents): string[] {
  return [...new Set(t.components.filter((c) => c.type === 'field' && typeof c.params.key === 'string').map((c) => String(c.params.key)))];
}

/**
 * A template with its fields' copies brought up to the library's definitions
 * (the builder, when a template is opened and saved). The same object when
 * nothing changed; a field the library no longer has keeps its copy.
 */
export function syncTemplateFields<T extends WithComponents>(t: T, library: ReadonlyMap<string, ObsFieldDef>): T {
  let changed = false;
  const components = t.components.map((c) => {
    if (c.type !== 'field') return c;
    const lib = library.get(String(c.params.key));
    if (!lib || sameJson(fieldDefOf(c.params), lib)) return c;
    changed = true;
    return { ...c, params: { ...lib } };
  });
  return changed ? ({ ...t, components } as T) : t;
}
