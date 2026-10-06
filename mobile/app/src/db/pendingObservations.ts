/**
 * Casual mode's data on the app's database: pending observations (待鑑定)
 * and the daily checklists, bound from src/db/pendingCore.ts (where the rules
 * and their reasons are, tested by scripts/check-pending.mjs).
 */
import i18n from '~/i18n';
import { getUserDb } from './init';
import * as core from './pendingCore';
import { addRecord } from './records';
import { defaultSurveyorString } from './surveyors';
import type { AdoptionInput } from './taxonLookup';
import { generateUuid } from './uuid';

export type { PendingInput, PendingKingdom, PendingObservation, PendingPatch } from './pendingCore';
export { PENDING_KINGDOMS, dayKey } from './pendingCore';

const ctx = (): core.PendingCtx => ({ db: getUserDb(), now: Date.now, uuid: generateUuid });

/** A daily checklist's name, e.g. 「10月5日 觀察」 (no Intl: numbers in every language). */
export function dailyChecklistName(ts: number): string {
  const d = new Date(ts);
  return i18n.t('casual.dailyName', { month: d.getMonth() + 1, day: d.getDate(), date: core.dayKey(ts) });
}

export function createPending(input: core.PendingInput): number {
  return core.createPending(ctx(), input);
}

export function updatePending(id: number, patch: core.PendingPatch): void {
  core.updatePending(ctx(), id, patch);
}

export function getPending(id: number): core.PendingObservation | null {
  return core.getPending(ctx(), id);
}

export function listPending(): core.PendingObservation[] {
  return core.listPending(ctx());
}

export function deletePending(id: number): void {
  core.deletePending(ctx(), id);
}

/**
 * Today's daily checklist as the active record, for recording a new
 * observation. The caller asks first when another record is open
 * (ensureNoConflictingActive), as for any new checklist.
 */
export function todaysDailySession(): number {
  const now = Date.now();
  return core.dailySessionFor(ctx(), now, { name: dailyChecklistName(now), recordedBy: defaultSurveyorString(), activate: true });
}

/** End earlier days' daily checklists left open (app start). */
export function closeStaleDailySessions(): number[] {
  return core.closeStaleDailySessions(ctx());
}

/** Whether `sessionId` is one of casual mode's daily checklists (the stale prompt skips them). */
export function isDailySession(sessionId: number): boolean {
  return core.isDailySession(ctx(), sessionId);
}

/**
 * Name pending observation `id`: a record in the daily checklist of the day
 * it was observed; the pending row is deleted.
 */
export function identifyPending(id: number, taxonId: string, adopted?: AdoptionInput | null): { sessionId: number; recordId: number } {
  return core.identifyPending(ctx(), id, taxonId, {
    insertRecord: (r) => addRecord(r),
    dailyName: dailyChecklistName,
    recordedBy: defaultSurveyorString(),
    adopted: adopted ?? null,
  });
}
