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
 *     is additive (classifyChange); a breaking change needs a new survey;
 *   - (2D-a, v86) the builder edits a draft, one per template id, saved as the
 *     next version when the user is done; a template is archived, never
 *     deleted (surveys carry their own copy), and an archived one is listed
 *     only when asked for.
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

/**
 * Built-ins first, then the latest version of each stored template, oldest
 * first. Archived ones are left out unless `archived` is 'include' or 'only'
 * (then built-ins, never archived, are left out of 'only').
 */
export function listTemplates(ctx: { db: SurveyDb }, opts: { archived?: 'exclude' | 'include' | 'only' } = {}): SurveyTemplate[] {
  const archived = opts.archived ?? 'exclude';
  const where = archived === 'include' ? '' : `AND t.template_id ${archived === 'only' ? 'IN' : 'NOT IN'} (SELECT template_id FROM survey_template_archive)`;
  const stored = rows<{ doc: string }>(
    ctx,
    `SELECT t.doc FROM survey_templates t
      WHERE t.version = (SELECT MAX(version) FROM survey_templates WHERE template_id = t.template_id) ${where}
      ORDER BY (SELECT MIN(created_at) FROM survey_templates WHERE template_id = t.template_id), t.template_id`,
  );
  return [...(archived === 'only' ? [] : BUILTIN_TEMPLATES), ...stored.map((r) => JSON.parse(r.doc) as SurveyTemplate)];
}

// ── drafts (v86) ───────────────────────────────────────────────────────────

/** A template being edited: `baseVersion` is the saved version it started from, null for a new one. */
export type TemplateDraft = { template: SurveyTemplate; baseVersion: number | null; updatedAt: number };

export function getDraft(ctx: { db: SurveyDb }, id: string): TemplateDraft | null {
  const r = one<{ doc: string; base_version: number | null; updated_at: number }>(ctx, `SELECT doc, base_version, updated_at FROM survey_template_drafts WHERE template_id = ?`, [id]);
  return r ? { template: JSON.parse(r.doc) as SurveyTemplate, baseVersion: r.base_version, updatedAt: r.updated_at } : null;
}

/** Every draft, newest first. */
export function listDrafts(ctx: { db: SurveyDb }): TemplateDraft[] {
  return rows<{ doc: string; base_version: number | null; updated_at: number }>(ctx, `SELECT doc, base_version, updated_at FROM survey_template_drafts ORDER BY updated_at DESC`).map((r) => ({
    template: JSON.parse(r.doc) as SurveyTemplate,
    baseVersion: r.base_version,
    updatedAt: r.updated_at,
  }));
}

/** Keep the draft of `t.id` (replacing the previous one). A built-in is never edited in place: copy it first. */
export function saveDraft(ctx: Ctx, t: SurveyTemplate, baseVersion: number | null): void {
  if (builtinOf(t.id) || t.origin === 'builtin') throw new SurveyError('builtin_template', t.id);
  ctx.db.executeSync(
    `INSERT INTO survey_template_drafts (template_id, base_version, doc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(template_id) DO UPDATE SET base_version = excluded.base_version, doc = excluded.doc, updated_at = excluded.updated_at`,
    [t.id, baseVersion, JSON.stringify(t), ctx.now()],
  );
}

export function discardDraft(ctx: { db: SurveyDb }, id: string): void {
  ctx.db.executeSync(`DELETE FROM survey_template_drafts WHERE template_id = ?`, [id]);
}

/**
 * Save the draft as the template's next version (saveTemplate's rules) and
 * drop it. Returns the version now current — the latest unchanged when the
 * draft changed nothing. The caller runs it in a transaction.
 */
export function commitDraft(ctx: Ctx, id: string): SurveyTemplate {
  const draft = getDraft(ctx, id);
  if (!draft) throw new SurveyError('not_found', 'draft');
  const saved = saveTemplate(ctx, draft.template);
  discardDraft(ctx, id);
  return saved;
}

// ── archive (v86) ──────────────────────────────────────────────────────────

export function setTemplateArchived(ctx: Ctx, id: string, archived: boolean): void {
  if (archived) ctx.db.executeSync(`INSERT OR REPLACE INTO survey_template_archive (template_id, archived_at) VALUES (?, ?)`, [id, ctx.now()]);
  else ctx.db.executeSync(`DELETE FROM survey_template_archive WHERE template_id = ?`, [id]);
}

export function isTemplateArchived(ctx: { db: SurveyDb }, id: string): boolean {
  return one(ctx, `SELECT 1 AS x FROM survey_template_archive WHERE template_id = ?`, [id]) != null;
}

// ── use by surveys ─────────────────────────────────────────────────────────

/** How many surveys and censuses use each template id, how many are open, and when the latest was started. */
export function templateUseCounts(ctx: { db: SurveyDb }): Map<string, { all: number; active: number; last: number | null }> {
  return new Map(
    rows<{ template_id: string; n: number; a: number; last: number | null }>(
      ctx,
      `SELECT template_id, COUNT(*) AS n, SUM(status = 'active') AS a, MAX(start_ts) AS last FROM fw_surveys GROUP BY template_id`,
    ).map((r) => [r.template_id, { all: r.n, active: r.a ?? 0, last: r.last ?? null }]),
  );
}

/** Surveys still open on an older version of `t` that could take it (an additive change), oldest first. */
export function upgradableSurveys(ctx: { db: SurveyDb }, t: SurveyTemplate): { id: number; name: string | null; version: number }[] {
  return rows<{ id: number; name: string | null; template_version: number; template_snapshot: string }>(
    ctx,
    `SELECT id, name, template_version, template_snapshot FROM fw_surveys WHERE template_id = ? AND template_version < ? AND status = 'active' ORDER BY id`,
    [t.id, t.version],
  )
    .filter((r) => classifyChange(JSON.parse(r.template_snapshot) as SurveyTemplate, t) === 'additive')
    .map((r) => ({ id: r.id, name: r.name, version: r.template_version }));
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
