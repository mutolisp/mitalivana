/**
 * Tracks the active GLORIA survey, mirroring `useActivePlot`.
 */
import { create } from 'zustand';
import { getActiveGloriaSurvey, type GloriaSurvey } from './db';

type ActiveGloriaState = {
  survey: GloriaSurvey | null;
  refresh: () => void;
};

export const useActiveGloria = create<ActiveGloriaState>((set) => ({
  survey: null,
  refresh: () => {
    set({ survey: getActiveGloriaSurvey() });
  },
}));

/**
 * The summit just saved on /gloria/summit-new, handed back to /gloria/new:
 * that screen takes it on focus, selects it and scrolls it into view. Taken
 * once, so a later focus does not re-select it over the user's own pick.
 */
type SummitPickState = {
  id: number | null;
  set: (id: number) => void;
  take: () => number | null;
};

export const useSummitPick = create<SummitPickState>((set, get) => ({
  id: null,
  set: (id) => set({ id }),
  take: () => {
    const id = get().id;
    if (id != null) set({ id: null });
    return id;
  },
}));
