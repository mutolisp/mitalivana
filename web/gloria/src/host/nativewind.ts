/** `useColorScheme` from nativewind, read from the browser's preference. */
import { useSyncExternalStore } from 'react';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

export function useColorScheme(): { colorScheme: 'light' | 'dark'; setColorScheme: (s: string) => void } {
  const dark = useSyncExternalStore(
    (cb) => {
      const q = query();
      q.addEventListener('change', cb);
      return () => q.removeEventListener('change', cb);
    },
    () => query().matches,
    () => false,
  );
  return { colorScheme: dark ? 'dark' : 'light', setColorScheme: () => {} };
}
