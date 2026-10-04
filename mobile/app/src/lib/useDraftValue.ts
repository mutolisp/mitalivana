/**
 * A typed value written once typing pauses (LabeledField's TYPING_SAVE_MS),
 * when the field is left (`flush`), or when the editor goes away — not on
 * every keystroke: each write is a database write, a reload and an undo step
 * (2G-e; a comment or an abundance used to be written letter by letter).
 * Shows what is being typed while a write is pending, the stored value
 * otherwise (an undo or another screen's change shows at once).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { TYPING_SAVE_MS } from '~/components/form/LabeledField';

export function useDraftValue(stored: string, save: (v: string) => void): { value: string; change: (v: string) => void; flush: () => void } {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current == null) return;
    const v = pending.current;
    pending.current = null;
    saveRef.current(v);
    setDraft(null);
  }, []);
  const change = useCallback(
    (v: string) => {
      setDraft(v);
      pending.current = v;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, TYPING_SAVE_MS);
    },
    [flush],
  );
  // Leaving the screen mid-word still keeps what was typed.
  useEffect(() => () => flush(), [flush]);
  return { value: draft ?? stored, change, flush };
}
