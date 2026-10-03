/**
 * Interactions between occurrences of a checklist / plot-style survey (v87;
 * Phase 2F; docs/planned/Modular_survey.md §5.6, canvas 11c, 14a–14c). As
 * surveyCore: every function takes the connection, clock and uuid source, so
 * check:survey-core runs them under node:sqlite; the app binds them in
 * ./surveys.ts.
 *
 * Rules kept here:
 *   - both sides are occurrences of the survey; the screen is always on one
 *     of them (`from`, A). B is another occurrence, or a taxon: then the
 *     occurrence of that taxon and label in A's unit, made (marked
 *     `via_interaction`) when there is none;
 *   - one row per event whichever side it was recorded from: A ← B is stored
 *     as B → A, A ↔ B as `mutual` (decided 2026-10-03). A one-way type takes
 *     → or ←, a both-ways type only ↔;
 *   - the types are the template's (registry `interaction`): the built-in
 *     ones it offers and its own list's codes; one no longer offered still
 *     reads where it was recorded;
 *   - one recorded during the blind phase is sealed with the blind list;
 *     after it, an interaction may name a sealed occurrence (it changes
 *     nothing on it) — decided 2026-10-03;
 *   - an occurrence made only as B goes when its last interaction goes and
 *     nothing else was recorded on it (surveyCore.pruneViaOccurrence).
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { BUILTIN_INTERACTIONS } from '../codesets/interactions';
import type { ComponentInstance, Label, SurveyTemplate } from '../template/types';
import { SurveyError, type Ctx, type SurveyDb } from './stemmapCore';
import { addOccurrence, getFwSurvey, getOccurrence, phaseNow, pruneViaOccurrence, snapshotOf, surveyOf, type OccurrenceRow } from './surveyCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);

/** As seen from the occurrence the screen is on (A): A does it to B, B does it to A, or both. */
export type Direction = 'forward' | 'backward' | 'mutual';

export type InteractionType = {
  code: string;
  builtin: boolean;
  mutual: boolean;
  /** Its name; a built-in's is an i18n key. */
  label: Label;
  /** How it reads from A (A … B). */
  verb: Label;
  /** How it reads from B, one way only; null when it has none. */
  inverse: Label | null;
  iri: string | null;
  /** The name an export writes (relationshipOfResource). */
  en: string;
  /** Offered for new records: a built-in the template lists, an own code not deprecated. */
  offered: boolean;
};

export type InteractionRow = {
  id: number;
  uuid: string;
  survey_id: number;
  unit_id: number | null;
  subject_occurrence_id: number;
  object_occurrence_id: number;
  type_code: string;
  mutual: number;
  count: number | null;
  observed_at: number;
  recorded_by: string | null;
  notes: string | null;
  phase: 'blind' | 'recheck' | null;
  created_at: number;
  updated_at: number;
};

const i18nKey = (code: string, part: 'name' | 'verb' | 'inverse'): Label => ({ i18n: `survey.interaction.type.${code}.${part}` });

/** The template's Interaction component, if it has one. */
export function interactionComponent(t: SurveyTemplate): ComponentInstance | null {
  return t.components.find((c) => c.type === 'interaction') ?? null;
}

/** Every type a survey's interactions may carry: the built-in ones, then the template's own list. */
export function interactionTypes(t: SurveyTemplate): InteractionType[] {
  const c = interactionComponent(t);
  if (!c) return [];
  const offered = new Set(Array.isArray(c.params.builtin) ? (c.params.builtin as string[]) : []);
  const own = typeof c.params.list === 'string' ? t.codelists.find((l) => l.id === c.params.list) : undefined;
  return [
    ...BUILTIN_INTERACTIONS.map(
      (b): InteractionType => ({
        code: b.code,
        builtin: true,
        mutual: b.mutual,
        label: i18nKey(b.code, 'name'),
        verb: i18nKey(b.code, 'verb'),
        inverse: b.mutual ? null : i18nKey(b.code, 'inverse'),
        iri: b.iri,
        en: b.en,
        offered: offered.has(b.code),
      }),
    ),
    ...(own?.items ?? []).map(
      (it): InteractionType => ({
        code: it.code,
        builtin: false,
        mutual: !!it.mutual,
        label: it.label,
        verb: it.label,
        inverse: it.mutual ? null : (it.inverse ?? null),
        iri: it.iri ?? null,
        en: 'i18n' in it.label ? it.code : it.label.tr?.en?.trim() || it.label.text,
        offered: !it.deprecated,
      }),
    ),
  ];
}

/** Which way a type may go: ↔ only for a both-ways type, → or ← for a one-way one. */
export const directionAllowed = (type: Pick<InteractionType, 'mutual'>, d: Direction) => (type.mutual ? d === 'mutual' : d !== 'mutual');

/** The stored ends of an interaction recorded from `from` with `partner`. */
export function storedEnds(from: number, partner: number, d: Direction): { subject: number; object: number; mutual: 0 | 1 } {
  return d === 'backward' ? { subject: partner, object: from, mutual: 0 } : { subject: from, object: partner, mutual: d === 'mutual' ? 1 : 0 };
}

/** An interaction as seen from one of its occurrences: which way, and who is on the other side. */
export function asSeenFrom(r: Pick<InteractionRow, 'subject_occurrence_id' | 'object_occurrence_id' | 'mutual'>, occurrenceId: number): { direction: Direction; partner: number } {
  const mine = r.subject_occurrence_id === occurrenceId;
  return { direction: r.mutual ? 'mutual' : mine ? 'forward' : 'backward', partner: mine ? r.object_occurrence_id : r.subject_occurrence_id };
}

export function getInteraction(ctx: { db: SurveyDb }, id: number): InteractionRow | null {
  return one<InteractionRow>(ctx, `SELECT * FROM fw_interactions WHERE id = ?`, [id]) ?? null;
}

/** Recorded in the blind phase, and that phase is closed: sealed, as the blind occurrences. */
export function interactionSealed(ctx: { db: SurveyDb }, r: Pick<InteractionRow, 'survey_id' | 'phase'>): boolean {
  return r.phase === 'blind' && getFwSurvey(ctx, r.survey_id)?.blind_closed_at != null;
}

export type InteractionListRow = InteractionRow & {
  subject_taxon_id: string;
  subject_verbatim: string | null;
  object_taxon_id: string;
  object_verbatim: string | null;
  photos: number;
};

/** A survey's interactions, oldest first; `occurrenceId`: only those it takes part in. */
export function listInteractions(ctx: { db: SurveyDb }, surveyId: number, opts: { occurrenceId?: number } = {}): InteractionListRow[] {
  const mine = opts.occurrenceId == null ? '' : 'AND (i.subject_occurrence_id = ? OR i.object_occurrence_id = ?)';
  return rows<InteractionListRow>(
    ctx,
    `SELECT i.*, s.taxon_id AS subject_taxon_id, s.verbatim_identification AS subject_verbatim,
            o.taxon_id AS object_taxon_id, o.verbatim_identification AS object_verbatim,
            (SELECT COUNT(*) FROM fw_media m WHERE m.interaction_id = i.id) AS photos
       FROM fw_interactions i
       JOIN fw_occurrences s ON s.id = i.subject_occurrence_id
       JOIN fw_occurrences o ON o.id = i.object_occurrence_id
      WHERE i.survey_id = ? ${mine}
      ORDER BY i.observed_at, i.id`,
    [surveyId, ...(opts.occurrenceId == null ? [] : [opts.occurrenceId, opts.occurrenceId])],
  );
}

/** B: another occurrence of the survey, or a taxon (with its label) recorded in A's unit for the purpose. */
export type Partner = { occurrenceId: number } | { taxonId: string; verbatim?: string | null; usedNameId?: number | null; usedScientificName?: string | null };

export type InteractionInput = {
  /** The occurrence the screen is on (A). */
  from: number;
  partner: Partner;
  type: string;
  direction: Direction;
  /** Only when the template asks for it; a whole number ≥ 1. */
  count?: number | null;
  notes?: string | null;
  recordedBy?: string | null;
};

type Checked = { a: OccurrenceRow; type: InteractionType; component: ComponentInstance };

function check(ctx: { db: SurveyDb }, input: InteractionInput, current: string | null): Checked {
  const a = getOccurrence(ctx, input.from);
  if (!a) throw new SurveyError('not_found', 'occurrence');
  const t = snapshotOf(surveyOf(ctx, a.survey_id));
  const component = interactionComponent(t);
  if (!component) throw new SurveyError('bad_component', 'no interaction component');
  // A type no longer offered still holds where it was recorded.
  const type = interactionTypes(t).find((x) => x.code === input.type && (x.offered || x.code === current));
  if (!type) throw new SurveyError('bad_value', `interaction type ${input.type}`);
  if (!directionAllowed(type, input.direction)) throw new SurveyError('bad_value', `${input.type} cannot go ${input.direction}`);
  const count = input.count ?? null;
  if (count != null && (component.params.count !== true || !Number.isInteger(count) || count < 1)) throw new SurveyError('bad_value', 'count');
  return { a, type, component };
}

/** B's occurrence: the one named, or the taxon's in A's unit (made, marked as an interaction's side, when there is none). */
function partnerOf(ctx: Ctx, a: OccurrenceRow, p: Partner): number {
  if ('occurrenceId' in p) {
    const b = getOccurrence(ctx, p.occurrenceId);
    if (!b || b.survey_id !== a.survey_id) throw new SurveyError('not_found', 'occurrence');
    if (b.id === a.id) throw new SurveyError('bad_value', 'an occurrence cannot interact with itself');
    return b.id;
  }
  if (!p.taxonId?.trim()) throw new SurveyError('not_found', 'taxon');
  const label = p.verbatim?.trim() || null;
  const here = one<{ id: number }>(
    ctx,
    `SELECT id FROM fw_occurrences WHERE survey_id = ? AND unit_id IS ? AND taxon_id = ? AND IFNULL(verbatim_identification, '') = ? AND id <> ?
      ORDER BY via_interaction, id LIMIT 1`,
    [a.survey_id, a.unit_id, p.taxonId, label ?? '', a.id],
  );
  if (here) return here.id;
  return addOccurrence(
    ctx,
    a.survey_id,
    {
      taxon_id: p.taxonId,
      unit_id: a.unit_id,
      verbatim_identification: label,
      ...(p.usedNameId !== undefined ? { used_name_id: p.usedNameId } : {}),
      ...(p.usedScientificName !== undefined ? { used_scientific_name: p.usedScientificName } : {}),
    },
    { via: true },
  );
}

export function addInteraction(ctx: Ctx, input: InteractionInput): number {
  const { a } = check(ctx, input, null);
  const b = partnerOf(ctx, a, input.partner);
  const ends = storedEnds(a.id, b, input.direction);
  const now = ctx.now();
  const res = run(
    ctx,
    `INSERT INTO fw_interactions (uuid, survey_id, unit_id, subject_occurrence_id, object_occurrence_id, type_code, mutual, count, observed_at, recorded_by, notes, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      a.survey_id,
      a.unit_id,
      ends.subject,
      ends.object,
      input.type,
      ends.mutual,
      input.count ?? null,
      now,
      input.recordedBy?.trim() || null,
      input.notes?.trim() || null,
      phaseNow(ctx, surveyOf(ctx, a.survey_id)),
      now,
      now,
    ],
  );
  run(ctx, `UPDATE fw_surveys SET updated_at = ? WHERE id = ?`, [now, a.survey_id]);
  return Number(res.insertId);
}

function unsealed(ctx: { db: SurveyDb }, id: number): InteractionRow {
  const r = getInteraction(ctx, id);
  if (!r) throw new SurveyError('not_found', 'interaction');
  if (interactionSealed(ctx, r)) throw new SurveyError('blind_sealed');
  return r;
}

/** Change one, as recorded again from `from` (one of its sides); a partner left behind goes if it was made only for it. */
export function updateInteraction(ctx: Ctx, id: number, input: InteractionInput): void {
  const r = unsealed(ctx, id);
  if (input.from !== r.subject_occurrence_id && input.from !== r.object_occurrence_id) throw new SurveyError('bad_value', 'not a side of this interaction');
  const { a } = check(ctx, input, r.type_code);
  const before = asSeenFrom(r, a.id).partner;
  const b = partnerOf(ctx, a, input.partner);
  const ends = storedEnds(a.id, b, input.direction);
  const now = ctx.now();
  run(
    ctx,
    `UPDATE fw_interactions SET subject_occurrence_id = ?, object_occurrence_id = ?, type_code = ?, mutual = ?, count = ?, notes = ?, recorded_by = ?, updated_at = ? WHERE id = ?`,
    [ends.subject, ends.object, input.type, ends.mutual, input.count ?? null, input.notes?.trim() || null, input.recordedBy?.trim() || r.recorded_by, now, id],
  );
  run(ctx, `UPDATE fw_surveys SET updated_at = ? WHERE id = ?`, [now, r.survey_id]);
  if (before !== b) pruneViaOccurrence(ctx, before);
}

export function deleteInteraction(ctx: Ctx, id: number): void {
  const r = unsealed(ctx, id);
  run(ctx, `DELETE FROM fw_media WHERE interaction_id = ?`, [id]);
  run(ctx, `DELETE FROM fw_interactions WHERE id = ?`, [id]);
  run(ctx, `UPDATE fw_surveys SET updated_at = ? WHERE id = ?`, [ctx.now(), r.survey_id]);
  pruneViaOccurrence(ctx, r.subject_occurrence_id);
  pruneViaOccurrence(ctx, r.object_occurrence_id);
}

// ── photos ──────────────────────────────────────────────────────────────────

export function listInteractionPhotos(ctx: { db: SurveyDb }, id: number): string[] {
  return rows<{ uri: string }>(ctx, `SELECT uri FROM fw_media WHERE interaction_id = ? ORDER BY id`, [id]).map((m) => m.uri);
}

/** Up to the template's limit (its Interaction component's `photos`). */
export function addInteractionPhoto(ctx: Ctx, id: number, uri: string): number {
  const r = unsealed(ctx, id);
  const c = interactionComponent(snapshotOf(surveyOf(ctx, r.survey_id)));
  const max = Number(c?.params.photos ?? 0);
  if (!c || listInteractionPhotos(ctx, id).length >= max) throw new SurveyError('bad_value', `at most ${max} photos`);
  const now = ctx.now();
  const res = run(ctx, `INSERT INTO fw_media (uuid, survey_id, interaction_id, component, kind, uri, created_at) VALUES (?, ?, ?, ?, 'photo', ?, ?)`, [
    ctx.uuid(),
    r.survey_id,
    id,
    c.key,
    uri,
    now,
  ]);
  run(ctx, `UPDATE fw_interactions SET updated_at = ? WHERE id = ?`, [now, id]);
  return Number(res.insertId);
}

export function removeInteractionPhoto(ctx: Ctx, id: number, uri: string): void {
  unsealed(ctx, id);
  run(ctx, `DELETE FROM fw_media WHERE interaction_id = ? AND uri = ?`, [id, uri]);
  run(ctx, `UPDATE fw_interactions SET updated_at = ? WHERE id = ?`, [ctx.now(), id]);
}
