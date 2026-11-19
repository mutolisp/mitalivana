/** What start-up produced, for screens that show it (diagnostics, home). */
import { create } from 'zustand';
import type { Flusher } from '../host/persist';
import type { BootTimings } from '../diag/Diagnostics';

export type BootInfo = { flusher: Flusher; timings: BootTimings; speciesVersion: string | null; recoveredFromPrev: boolean };

const store = create<{ boot: BootInfo | null }>(() => ({ boot: null }));

export const setBoot = (boot: BootInfo) => store.setState({ boot });
export const useBoot = () => store((s) => s.boot);
export const setSpeciesVersion = (v: string) => store.setState((s) => (s.boot ? { boot: { ...s.boot, speciesVersion: v } } : s));
