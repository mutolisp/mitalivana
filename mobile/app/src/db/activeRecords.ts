/**
 * The app-wide single-active invariant, in one place.
 *
 * At most one record is open at any time across sessions, plot surveys,
 * GLORIA surveys and MIREN surveys (collection trips are exempt, see migration v19). Every
 * create / reopen / duplicate-and-activate path used to repeat one UPDATE per
 * kind; with a third kind that became nine places to forget one. They all
 * call `closeActiveRecords` now.
 *
 * Plain SQL on our own table names — no imports from feature modules, so
 * sessions.ts / plots.ts / cleanup.ts can use it without cycles.
 */

import type { DB as Db } from '@op-engineering/op-sqlite';

export type ActiveKind = 'session' | 'plot' | 'gloria' | 'miren';

/** End every open record except `keep` (the one about to be opened or reopened). */
export function closeActiveRecords(db: Db, now: number, keep?: { kind: ActiveKind; id: number }): void {
  const except = (kind: ActiveKind) => (keep?.kind === kind ? keep.id : -1);
  db.executeSync(
    `UPDATE sessions SET status = 'done', ended_at = COALESCE(ended_at, ?) WHERE status = 'active' AND id != ?`,
    [now, except('session')],
  );
  db.executeSync(
    `UPDATE plot_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ?
      WHERE status = 'active' AND id != ?`,
    [now, now, except('plot')],
  );
  db.executeSync(
    `UPDATE gloria_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ?
      WHERE status = 'active' AND id != ?`,
    [now, now, except('gloria')],
  );
  db.executeSync(
    `UPDATE miren_surveys SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ?
      WHERE status = 'active' AND id != ?`,
    [now, now, except('miren')],
  );
}

/** Tables of the kinds that end by `stop_ts` (a session ends by `ended_at`). */
const SURVEY_TABLE: Record<Exclude<ActiveKind, 'session'>, string> = {
  plot: 'plot_surveys',
  gloria: 'gloria_surveys',
  miren: 'miren_surveys',
};

/** End one record of any kind. */
export function endActiveRecord(db: Db, now: number, kind: ActiveKind, id: number): void {
  if (kind === 'session') {
    db.executeSync(`UPDATE sessions SET status = 'done', ended_at = COALESCE(ended_at, ?) WHERE id = ?`, [now, id]);
  } else {
    const table = SURVEY_TABLE[kind];
    db.executeSync(
      `UPDATE ${table} SET status = 'done', stop_ts = COALESCE(stop_ts, ?), updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }
}
