/**
 * 自訂欄位庫 on the database (v90 observation_fields; six-item plan C,
 * 2026-10-04; the definitions and their rules are template/obsField.ts). Pure
 * like templatesCore: check:fields runs it under node:sqlite on the real
 * migrations.
 *
 * Rules kept here:
 *   - a definition is stored only when valid, under a key no other field has;
 *   - a field a template uses (any saved version, or a draft) keeps its key
 *     and may change only as surveys holding its values can take
 *     (fieldChange: names and description, more allowed values, a wider
 *     range); one no template uses may change in any way, its key too;
 *   - a used field is deprecated, not deleted (it stops being offered);
 *     an unused one may be deleted.
 */
import { parseSnapshot } from '../template/normalize';
import { checkFieldDef, fieldChange, fieldDefOf, fieldKeysOf, type LibraryWrite, type ObsFieldDef } from '../template/obsField';
import type { SurveyTemplate } from '../template/types';
import { SurveyError, type Ctx, type SurveyDb } from './stemmapCore';

type Scalar = string | number | null;
const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];

export type ObsFieldRow = { id: number; uuid: string; def: ObsFieldDef; deprecated: boolean; created_at: number; updated_at: number };

type Raw = {
  id: number;
  uuid: string;
  key: string;
  name: string;
  name_en: string | null;
  description: string | null;
  datatype: string;
  allowed_json: string | null;
  multi: number;
  numeric_kind: string | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  deprecated: number;
  created_at: number;
  updated_at: number;
};

function parseAllowed(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function rowOf(r: Raw): ObsFieldRow | null {
  const def = fieldDefOf({
    key: r.key,
    name: r.name,
    name_en: r.name_en ?? undefined,
    description: r.description ?? undefined,
    datatype: r.datatype,
    allowed: parseAllowed(r.allowed_json),
    multi: r.multi === 1,
    numeric_kind: r.numeric_kind ?? undefined,
    min: r.min ?? undefined,
    max: r.max ?? undefined,
    unit: r.unit ?? undefined,
  });
  return def ? { id: r.id, uuid: r.uuid, def, deprecated: r.deprecated === 1, created_at: r.created_at, updated_at: r.updated_at } : null;
}

/** Every field, by name; deprecated ones only when asked. */
export function listFields(ctx: { db: SurveyDb }, opts: { deprecated?: boolean } = {}): ObsFieldRow[] {
  return rows<Raw>(ctx, `SELECT * FROM observation_fields ${opts.deprecated ? '' : 'WHERE deprecated = 0'} ORDER BY name COLLATE NOCASE, key`)
    .map(rowOf)
    .filter((x): x is ObsFieldRow => x != null);
}

export function getField(ctx: { db: SurveyDb }, key: string): ObsFieldRow | null {
  const r = one<Raw>(ctx, `SELECT * FROM observation_fields WHERE key = ?`, [key]);
  return r ? rowOf(r) : null;
}

/** The library as the builder brings templates up to it: key → definition. */
export function fieldLibrary(ctx: { db: SurveyDb }): Map<string, ObsFieldDef> {
  return new Map(listFields(ctx, { deprecated: true }).map((r) => [r.def.key, r.def]));
}

/** How many templates (by id: any saved version or a draft) use each field key. */
export function fieldUseCounts(ctx: { db: SurveyDb }): Map<string, number> {
  const docs = [
    ...rows<{ id: string; doc: string }>(ctx, `SELECT template_id AS id, doc FROM survey_templates`),
    ...rows<{ id: string; doc: string }>(ctx, `SELECT template_id AS id, doc FROM survey_template_drafts`),
  ];
  const users = new Map<string, Set<string>>();
  for (const { id, doc } of docs) {
    // A cheap test first: most templates have no field at all.
    if (!doc.includes('"field"')) continue;
    let t: SurveyTemplate;
    try {
      t = parseSnapshot(doc);
    } catch {
      continue;
    }
    for (const key of fieldKeysOf(t)) {
      if (!users.has(key)) users.set(key, new Set());
      users.get(key)!.add(id);
    }
  }
  return new Map([...users].map(([k, ids]) => [k, ids.size]));
}

const columns = (d: ObsFieldDef): Scalar[] => [
  d.key,
  d.name.trim(),
  d.name_en ?? null,
  d.description ?? null,
  d.datatype,
  d.allowed ? JSON.stringify(d.allowed) : null,
  d.multi ? 1 : 0,
  d.numeric_kind ?? null,
  d.min ?? null,
  d.max ?? null,
  d.unit ?? null,
];

/**
 * Store a field: a new one (`prevKey` left out) or the one stored under
 * `prevKey`. Refuses an invalid definition, a key another field has, and on a
 * field a template uses, a new key or a change its surveys cannot take.
 * Returns the definition as stored.
 */
export function saveField(ctx: Ctx, input: ObsFieldDef, prevKey?: string): ObsFieldDef {
  const problems = checkFieldDef(input);
  const def = problems.length ? null : fieldDefOf(input);
  if (!def) throw new SurveyError('field_invalid', problems.join('; '));
  const prev = prevKey != null ? getField(ctx, prevKey) : null;
  if (prevKey != null && !prev) throw new SurveyError('not_found', prevKey);
  const clash = one<{ key: string }>(ctx, `SELECT key FROM observation_fields WHERE key = ?`, [def.key]);
  if (clash && clash.key !== prevKey) throw new SurveyError('field_key_taken', def.key);
  if (prev && (fieldUseCounts(ctx).get(prev.def.key) ?? 0) > 0) {
    if (def.key !== prev.def.key || fieldChange(prev.def, def) === 'breaking') throw new SurveyError('field_in_use', prev.def.key);
  }
  const at = ctx.now();
  if (prev) {
    ctx.db.executeSync(
      `UPDATE observation_fields SET key = ?, name = ?, name_en = ?, description = ?, datatype = ?, allowed_json = ?, multi = ?, numeric_kind = ?, min = ?, max = ?, unit = ?, updated_at = ? WHERE id = ?`,
      [...columns(def), at, prev.id],
    );
  } else {
    ctx.db.executeSync(
      `INSERT INTO observation_fields (uuid, key, name, name_en, description, datatype, allowed_json, multi, numeric_kind, min, max, unit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.uuid(), ...columns(def), at, at],
    );
  }
  return def;
}

/** What a template file or a conversion brings (template/legacyFields.ts): new fields, and fields widened. */
export function storeLibraryWrites(ctx: Ctx, writes: readonly LibraryWrite[]): void {
  for (const w of writes) saveField(ctx, w.def, w.prevKey);
}

/** Stop offering a field (or offer it again). */
export function setFieldDeprecated(ctx: Ctx, key: string, deprecated: boolean): void {
  ctx.db.executeSync(`UPDATE observation_fields SET deprecated = ?, updated_at = ? WHERE key = ?`, [deprecated ? 1 : 0, ctx.now(), key]);
}

/** Delete a field no template uses; a used one is deprecated instead (`field_in_use`). */
export function deleteField(ctx: { db: SurveyDb }, key: string): void {
  if ((fieldUseCounts(ctx).get(key) ?? 0) > 0) throw new SurveyError('field_in_use', key);
  ctx.db.executeSync(`DELETE FROM observation_fields WHERE key = ?`, [key]);
}
