/**
 * Height of the app-wide chrome above the navigator: the ActiveSessionBar
 * while a record runs, else the status-bar spacer (0 on full-bleed screens).
 * Measured in app/_layout.tsx. The docked search box needs it to know where
 * a screen's content starts — the navigation header's height alone left the
 * first suggestions under the header, most visibly during a survey.
 */
import { create } from 'zustand';

export const useTopChrome = create<{ height: number; setHeight: (h: number) => void }>((set) => ({
  height: 0,
  setHeight: (h) => set((s) => (s.height === h ? s : { height: h })),
}));
