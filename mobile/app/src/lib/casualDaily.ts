/**
 * Casual mode's open record is the day's checklist. Recording an observation
 * or starting the track opens it; another open record (left from another
 * mode) is asked about first, as for any new checklist.
 */
import { closeStaleDailySessions, todaysDailySession, todaysDailySessionId } from '~/db';
import { ensureNoConflictingActive } from '~/lib/recordCreate';
import { useActiveSession } from '~/stores/activeSession';

/**
 * Today's checklist id, opened; null when the user kept the other record open.
 * `observedAt` (today) is the observation going in, when there is one.
 */
export async function openTodaysChecklist(observedAt?: number): Promise<number | null> {
  // An app left running overnight has not met the startup sweep: yesterday's
  // checklist is ended here, at its last record, rather than offered as a
  // conflict and then ended now (code review M28).
  closeStaleDailySessions();
  useActiveSession.getState().refresh();
  const active = useActiveSession.getState().session;
  if (
    !(active && active.id === todaysDailySessionId()) &&
    !(await ensureNoConflictingActive('session'))
  )
    return null;
  const id = todaysDailySession(observedAt);
  useActiveSession.getState().refresh();
  return id;
}
