/**
 * Survey start / end dates (base data; sheet 01_) and the units' dates, both
 * ways. Pure (no RN / DB), local time, so check:gloria can test it.
 *
 *   - units → survey: the earliest and latest time recorded on any unit
 *     (cover, frequency, point-framing, start or end) give the survey's
 *     start and end DATES; the survey keeps its own clock times.
 *   - survey → units: every unit with no start gets the survey's start date
 *     (the user's choice when the survey spans days: fix the others by hand)
 *     as a date without a time (`date_only`); a unit that already has a start
 *     is never overwritten, and one on another day is reported.
 */
import { onDay } from './quadratTimes';

export type UnitTimes = {
  code: string;
  start_ts: number | null;
  stop_ts: number | null;
  freq_start_ts?: number | null;
  freq_stop_ts?: number | null;
  pf_start_ts?: number | null;
  pf_stop_ts?: number | null;
};

/** Earliest and latest time on any unit; null when no unit has one. */
export function unitTimeSpan(units: ReadonlyArray<UnitTimes>): { first: number; last: number } | null {
  const all: number[] = [];
  for (const u of units)
    for (const v of [u.start_ts, u.stop_ts, u.freq_start_ts, u.freq_stop_ts, u.pf_start_ts, u.pf_stop_ts])
      if (v != null) all.push(v);
  return all.length ? { first: Math.min(...all), last: Math.max(...all) } : null;
}

/**
 * The survey's new start / end for the units' span: the dates move, the clock
 * times stay. An empty end takes the last unit time as it is.
 */
export function surveyDatesFromUnits(
  survey: { start_ts: number; stop_ts: number | null },
  span: { first: number; last: number },
): { start_ts: number; stop_ts: number } {
  return {
    start_ts: onDay(survey.start_ts, span.first),
    stop_ts: survey.stop_ts != null ? onDay(survey.stop_ts, span.last) : span.last,
  };
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Local midnight of `ts`'s day: what a date-only unit start stores. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Filling the units from the survey's start date: which units get it, and
 * which keep a start on another day (warned about, never changed).
 */
export function planUnitDates(
  units: ReadonlyArray<UnitTimes>,
  day: number,
): { fill: string[]; value: number; otherDay: Array<{ code: string; start_ts: number }> } {
  return {
    fill: units.filter((u) => u.start_ts == null).map((u) => u.code),
    value: startOfDay(day),
    otherDay: units
      .filter((u) => u.start_ts != null && !sameDay(u.start_ts, day))
      .map((u) => ({ code: u.code, start_ts: u.start_ts as number })),
  };
}

/**
 * Whether recording now should replace a date-only start with the real time:
 * only on that very day. A date typed from an old sheet stays when the data
 * is digitised later.
 */
export function takesRealStart(dateOnlyStart: number, now: number): boolean {
  return sameDay(dateOnlyStart, now);
}
