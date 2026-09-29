/**
 * While a list is in select mode, the header back leaves select mode instead
 * of the screen (05-controls.md §2.1). `useListSelection` registers its exit
 * here while selecting and focused; `BackHeaderLeft` reads it. This reaches
 * lists that live inside another screen's header (the plot's species tab)
 * without threading the selection up to that screen.
 */
import { create } from 'zustand';

type SelectBack = {
  exit: (() => void) | null;
  set: (exit: (() => void) | null) => void;
};

export const useSelectBack = create<SelectBack>((set) => ({
  exit: null,
  set: (exit) => set({ exit }),
}));
