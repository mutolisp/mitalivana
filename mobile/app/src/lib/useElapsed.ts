import { useEffect, useState } from 'react';

/**
 * hh:mm since `since` (ms), re-rendered once a minute — the records tab's
 * ActiveRecordCard and the checklist header both show it.
 */
export function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
