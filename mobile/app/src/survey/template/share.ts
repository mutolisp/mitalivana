/**
 * A template as a file (`.mtpl.json`, 2D-b): sharing carries the structure
 * only — components, parameters, unit levels, code lists — never a project,
 * a plot or people (Modular_survey.md §2).
 *
 * Reading one: a file this app version cannot read (unknown components, from
 * a newer app) is refused with the types it names; a template whose id is
 * already here, or a built-in, comes in under a new id instead of over it
 * (decided 2026-10-03); its unit levels go on the positional keys, so it
 * shares a permanent plot's layout with the user's other templates.
 *
 * Pure: check:templates runs it.
 */
import { componentDef } from '../registry';
import { rekeyUnits } from './edit';
import type { SurveyTemplate } from './types';
import { validateTemplate, withRequired } from './validate';

export const TEMPLATE_FILE_FORMAT = 'mitalivana-template';
export const TEMPLATE_FILE_EXT = '.mtpl.json';

export type TemplateFile = { format: typeof TEMPLATE_FILE_FORMAT; schema: 1; exported_at: number; template: SurveyTemplate };

/** The file's content (JSON, two-space indented: a person may read it). */
export function templateFileText(t: SurveyTemplate, now: number): string {
  const file: TemplateFile = { format: TEMPLATE_FILE_FORMAT, schema: 1, exported_at: now, template: t };
  return JSON.stringify(file, null, 2);
}

export type TemplateRead =
  | { ok: true; template: SurveyTemplate; renamed: boolean }
  | { ok: false; reason: 'not_a_template' }
  | { ok: false; reason: 'newer_app'; types: string[] }
  | { ok: false; reason: 'invalid'; detail: string };

/**
 * Read a template file as one to store here (origin 'imported'; the store
 * gives it its first version). `taken`: ids already here; `newId` makes one.
 */
export function readTemplateFile(text: string, taken: ReadonlySet<string>, newId: () => string): TemplateRead {
  let file: Partial<TemplateFile> | null = null;
  try {
    file = JSON.parse(text) as Partial<TemplateFile>;
  } catch {
    return { ok: false, reason: 'not_a_template' };
  }
  const t = file?.template;
  if (!file || file.format !== TEMPLATE_FILE_FORMAT || file.schema !== 1 || !t || typeof t !== 'object' || !Array.isArray(t.components)) return { ok: false, reason: 'not_a_template' };
  const unknown = [...new Set(t.components.map((c) => String(c?.type)).filter((type) => !componentDef(type)))];
  if (unknown.length) return { ok: false, reason: 'newer_app', types: unknown };
  const clash = typeof t.id !== 'string' || !t.id || taken.has(t.id) || t.origin === 'builtin' || t.id.startsWith('builtin:');
  const { builtin_key: _k, builtin_version: _v, ...rest } = t;
  const template = rekeyUnits(withRequired({ ...rest, id: clash ? newId() : t.id, version: 1, origin: 'imported', codelists: Array.isArray(t.codelists) ? t.codelists : [] }));
  const problems = validateTemplate(template);
  if (problems.length) return { ok: false, reason: 'invalid', detail: problems.join('\n') };
  return { ok: true, template, renamed: clash };
}
