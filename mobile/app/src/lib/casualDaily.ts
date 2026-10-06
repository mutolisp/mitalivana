/**
 * Casual mode's open record is the day's checklist. Recording an observation
 * or starting the track opens it; another open record (left from another
 * mode) is asked about first, as for any new checklist.
 */
import { todaysDailySession, todaysDailySessionId } from '~/db';
import { ensureNoConflictingActive } from '~/lib/recordCreate';
import { useActiveSession } from '~/stores/activeSession';

/** Today's checklist id, opened; null when the user kept the other record open. */
export async function openTodaysChecklist(): Promise<number | null> {
  useActiveSession.getState().refresh();
  const active = useActiveSession.getState().session;
  if (
    !(active && active.id === todaysDailySessionId()) &&
    !(await ensureNoConflictingActive('session'))
  )
    return null;
  const id = todaysDailySession();
  useActiveSession.getState().refresh();
  return id;
}
