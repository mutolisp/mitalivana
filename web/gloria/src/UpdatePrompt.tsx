/**
 * "New version available" banner. The service worker never swaps itself in:
 * the user presses update, the database snapshot is flushed, then the page
 * reloads on the new version.
 */
import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useBoot } from './shell/bootStore';

export function UpdatePrompt() {
  const flusher = useBoot()?.flusher;
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  // An informational hint: shown once, gone by itself after a few seconds.
  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setOfflineReady(false), 4000);
    return () => clearTimeout(t);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh && !offlineReady) return null;
  return (
    <div className="fixed inset-x-2 bottom-2 z-50 rounded-lg bg-stone-800 p-3 text-sm text-white shadow-lg">
      {needRefresh ? (
        <div className="flex items-center gap-3">
          <span className="flex-1">有新版本。</span>
          <button
            className="rounded bg-white px-3 py-1 text-stone-900"
            onClick={async () => {
              await flusher?.flushNow();
              await updateServiceWorker(true);
            }}
          >
            更新
          </button>
          <button className="px-2" onClick={() => setNeedRefresh(false)}>
            稍後
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="flex-1">已可離線使用。</span>
          <button className="px-2" onClick={() => setOfflineReady(false)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
