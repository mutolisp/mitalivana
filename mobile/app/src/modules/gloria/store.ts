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
