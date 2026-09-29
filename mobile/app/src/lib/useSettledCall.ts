/**
 * Run a call once input has paused, instead of after every event.
 *
 * Painting a frequency grid writes one row per stroke; reloading the screen
 * and taking the undo snapshot after each one cost ~100 ms of JS on an
 * emulator (more on a phone), long enough for the next tap to queue behind
 * it. The write stays immediate; the reload waits until the strokes stop.
 * A pending call still runs when the screen loses focus or unmounts, so
 * nothing is left out of the undo history.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

export function useSettledCall(fn: () => void, ms = 500): { schedule: () => void; flush: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    fnRef.current();
  }, []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  }, [ms]);
  useEffect(() => flush, [flush]);
  useFocusEffect(useCallback(() => flush, [flush]));
  return { schedule, flush };
}
