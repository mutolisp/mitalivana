/**
 * Survey templates on the database (docs/planned/Modular_survey.md §4,
 * Phase 2A). The user's and imported templates are stored one row per
 * version in survey_templates; built-in templates stay in code
 * (src/survey/templates/). Pure like stemmapCore: check:survey-core runs it
 * under node:sqlite on the real migrations.
 *
 * Rules kept here:
 *   - saving gives the next version of the template's id; saving content
 *     equal to the latest version adds nothing;
 *   - only a valid template is stored, with the always-present components
 *     put in first; a built-in id cannot be saved over;
 *   - a survey moves to a newer version of its template only when the change
 *     is additive (classifyChange); a breaking change needs a new survey.
 */
import type { SurveyTemplate } from '../template/types';
import { classifyChange, templateHash, validateTemplate, withRequired } from '../template/validate';
import { BUILTIN_TEMPLATES } from '../templates/builtins';
import { SurveyError, type Ctx, type SurveyDb } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: (string | number | null)[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: (string | number | null)[] = []) => rows<T>(ctx, sql, params)[0];

const builtinOf = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id);

/** A stored version, or the latest when `version` is left out. Built-ins come from code (their current version only). */
export function getTemplate(ctx: { db: SurveyDb }, id: string, version?: number): SurveyTemplate | null {
  const builtin = builtinOf(id);
  if (builtin) return version == null || version === builtin.version ? builtin : null;
  const row =
    version == null
      ? one<{ doc: string }>(ctx, `SELECT doc FROM survey_templates WHERE template_id = ? ORDER BY version DESC LIMIT 1`, [id])
      : one<{ doc: string }>(ctx, `SELECT doc FROM survey_templates WHERE template_id = ? AND version = ?`, [id, version]);
  return row ? (JSON.parse(row.doc) as SurveyTemplate) : null;
}

/** Built-ins first, then the latest version of each stored template, oldest first. */
export function listTemplates(ctx: { db: SurveyDb }): SurveyTemplate[] {
  const stored = rows<{ doc: string }>(
    ctx,
    `SELECT t.doc FROM survey_templates t
      WHERE t.version = (SELECT MAX(version) FROM survey_templates WHERE template_id = t.template_id)
      ORDER BY (SELECT MIN(created_at) FROM survey_templates WHERE template_id = t.template_id), t.template_id`,
  );
  return [...BUILTIN_TEMPLATES, ...stored.map((r) => JSON.parse(r.doc) as SurveyTemplate)];
}

/**
 * Store `t` as the next version of its id and return what was stored. The
 * version `t` carries is ignored; content equal to the latest version
 * returns that version unchanged.
 */
export function saveTemplate(ctx: Ctx, t: SurveyTemplate): SurveyTemplate {
  if (builtinOf(t.id) || t.origin === 'builtin') throw new SurveyError('builtin_template', t.id);
  const latest = getTemplate(ctx, t.id);
  const next: SurveyTemplate = { ...withRequired(t), version: (latest?.version ?? 0) + 1 };
  const problems = validateTemplate(next);
  if (problems.length) throw new SurveyError('template_invalid', problems.join('; '));
  if (latest && classifyChange(latest, next) === 'same') return latest;
  ctx.db.executeSync(`INSERT INTO survey_templates (template_id, version, origin, doc, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    next.id,
    next.version,
    next.origin,
    JSON.stringify(next),
    templateHash(next),
    ctx.now(),
  ]);
  return next;
}

/**
 * Move a survey (any style) to `to`, a newer version of its template, when the
 * change is additive. Returns false when there is nothing to change; throws
 * template_breaking when the change would not fit the data already recorded.
 */
export function upgradeSurvey(ctx: Ctx, surveyId: number, to: SurveyTemplate): boolean {
  const row = one<{ template_snapshot: string }>(ctx, `SELECT template_snapshot FROM fw_surveys WHERE id = ?`, [surveyId]);
  if (!row) throw new SurveyError('not_found', 'survey');
  const from = JSON.parse(row.template_snapshot) as SurveyTemplate;
  const kind = classifyChange(from, to);
  if (kind === 'same') return false;
  if (kind === 'breaking') throw new SurveyError('template_breaking');
  const problems = validateTemplate(to);
  if (to.version <= from.version) problems.push(`version ${to.version} is not newer than ${from.version}`);
  if (problems.length) throw new SurveyError('template_invalid', problems.join('; '));
  ctx.db.executeSync(`UPDATE fw_surveys SET template_version = ?, template_snapshot = ?, template_hash = ?, updated_at = ? WHERE id = ?`, [
    to.version,
    JSON.stringify(to),
    templateHash(to),
    ctx.now(),
    surveyId,
  ]);
  return true;
}
