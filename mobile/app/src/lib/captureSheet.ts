/**
 * State and imperative API of casual mode's 記一筆觀察 sheet (design 18d;
 * src/components/casual/CaptureSheet.tsx, whose host is mounted in
 * app/_layout.tsx). Apart from the component, so plusAction.ts can open it.
 */
import { create } from 'zustand';

type State = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const useCaptureSheet = create<State>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function showCaptureSheet(): void {
  useCaptureSheet.getState().setOpen(true);
}
