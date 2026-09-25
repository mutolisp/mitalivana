/**
 * A 1×1 m quadrat's frequency follows its cover estimate (優勢度估測) in time:
 * the same day, starting the minute after the cover estimate ends. When the
 * cover times are set — typed in from an old sheet, or by 完成 — the
 * frequency times are brought along:
 *
 *   - the frequency's start / end move to the cover estimate's day (clock
 *     times kept);
 *   - with the cover end set and no frequency start yet, or a start that was
 *     only ever the one derived from the previous cover end, the frequency
 *     starts at the next whole minute after the cover end.
 *
 * Pure (no RN / DB) so check:gloria can test it; local time, like the fields.
 */
export type QuadratTimes = {
  start_ts: number | null;
  stop_ts: number | null;
  freq_start_ts: number | null;
  freq_stop_ts: number | null;
};

/** The next whole minute after `ts` (10:05:51 → 10:06:00; 10:05:00 → 10:06:00). */
export function nextMinute(ts: number): number {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  return d.getTime() + 60_000;
}

/** `ts` moved to the calendar day of `day`, clock time kept. */
export function onDay(ts: number, day: number): number {
  const d = new Date(ts);
  const dd = new Date(day);
  d.setFullYear(dd.getFullYear(), dd.getMonth(), dd.getDate());
  return d.getTime();
}

/** Frequency columns to write along with a new cover start / end (empty = none). */
export function followCoverTimes(
  u: QuadratTimes,
  col: 'start_ts' | 'stop_ts',
  ts: number | null,
): Partial<Pick<QuadratTimes, 'freq_start_ts' | 'freq_stop_ts'>> {
  if (ts == null) return {};
  const out: Partial<Pick<QuadratTimes, 'freq_start_ts' | 'freq_stop_ts'>> = {};
  let freqStart = u.freq_start_ts;
  const derived = u.stop_ts != null && freqStart === nextMinute(u.stop_ts);
  if (col === 'stop_ts' && (freqStart == null || derived)) {
    // Straight from the new end: a cover end at 23:59 starts frequency at
    // 00:00 the next day, which moving it back onto `ts`'s day would break.
    freqStart = nextMinute(ts);
  } else if (freqStart != null) {
    freqStart = onDay(freqStart, ts);
  }
  if (freqStart !== u.freq_start_ts) out.freq_start_ts = freqStart;
  if (u.freq_stop_ts != null) {
    const stop = onDay(u.freq_stop_ts, ts);
    if (stop !== u.freq_stop_ts) out.freq_stop_ts = stop;
  }
  return out;
}
