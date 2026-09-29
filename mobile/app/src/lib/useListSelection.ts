/**
 * Long-press multi-select for a list screen.
 *
 * The app-wide rule for list rows: a long-press enters select mode with that
 * row picked (with a haptic), taps then toggle rows, and Android's hardware
 * back leaves select mode before it leaves the screen. The records tab,
 * favorites, sites and the collection screen each grew their own copy of this;
 * the checklist, plot and taxonomy screens share this one.
 */
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BackHandler } from 'react-native';
import { useSelectBack } from '~/lib/selectBack';

export function useListSelection<K>() {
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<K>>(new Set());

  const exit = useCallback(() => {
    setSelectMode(false);
    setPicked(new Set());
  }, []);

  /** Long-press handler: enter select mode with `key` picked. No-op while
   *  already selecting, so a long-press never clears a selection. */
  const enter = (key: K) => {
    if (selectMode) return;
    // A light tick, the same on every list (05-controls.md §2.1).
    void Haptics.selectionAsync();
    setSelectMode(true);
    setPicked(new Set([key]));
  };

  const toggle = (key: K) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Select every key in `visible`, or clear them all if they already are. */
  const toggleAll = (visible: K[]) =>
    setPicked((prev) =>
      visible.length > 0 && visible.every((k) => prev.has(k)) ? new Set() : new Set(visible),
    );

  // Registered only while selecting, so it never swallows an ordinary back.
  // (Not a ref read at press time: writing a ref during render makes React
  // Compiler skip the whole hook.)
  useFocusEffect(
    useCallback(() => {
      if (!selectMode) return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        exit();
        return true;
      });
      // The header back does the same (BackHeaderLeft reads this).
      useSelectBack.getState().set(exit);
      return () => {
        sub.remove();
        if (useSelectBack.getState().exit === exit) useSelectBack.getState().set(null);
      };
    }, [selectMode, exit]),
  );

  return { selectMode, picked, enter, toggle, toggleAll, exit };
}
