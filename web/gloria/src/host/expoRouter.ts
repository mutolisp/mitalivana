/**
 * The only expo-router API reused mobile modules call is `useFocusEffect`
 * (modules/gloria/useSurvey.ts). On the web a screen is "focused" while it is
 * mounted; it is re-run when the page becomes visible again, so a survey
 * edited in another window is reloaded on return.
 */
import { useEffect } from 'react';

export function useFocusEffect(effect: () => void | (() => void)): void {
  useEffect(() => {
    let cleanup = effect();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof cleanup === 'function') cleanup();
      cleanup = effect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (typeof cleanup === 'function') cleanup();
    };
  }, [effect]);
}
