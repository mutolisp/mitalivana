/**
 * Tracks the active MIREN survey, mirroring `useActiveGloria`.
 */
import { create } from 'zustand';
import { getActiveMirenSurvey, type MirenSurvey } from './db';

type ActiveMirenState = {
  survey: MirenSurvey | null;
  refresh: () => void;
};

export const useActiveMiren = create<ActiveMirenState>((set) => ({
  survey: null,
  refresh: () => {
    set({ survey: getActiveMirenSurvey() });
  },
}));
