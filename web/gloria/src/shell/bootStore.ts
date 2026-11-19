/** What start-up produced, for screens that show it (diagnostics, home). */
import { create } from 'zustand';
import type { Flusher } from '../host/persist';
import type { BootTimings } from '../diag/Diagnostics';
import type { InstalledSpecies, WebDatasetId } from '../host/speciesInstall';

/** `species`: the installed checklist modules (id → version); empty when none. */
export type BootInfo = { flusher: Flusher; timings: BootTimings; species: InstalledSpecies; recoveredFromPrev: boolean };

const store = create<{ boot: BootInfo | null }>(() => ({ boot: null }));

export const setBoot = (boot: BootInfo) => store.setState({ boot });
export const useBoot = () => store((s) => s.boot);
export const setSpeciesInstalled = (id: WebDatasetId, version: string) =>
  store.setState((s) => (s.boot ? { boot: { ...s.boot, species: { ...s.boot.species, [id]: version } } } : s));
/** Whether any checklist module is installed. */
export const hasSpecies = (b: BootInfo | null) => !!b && Object.keys(b.species).length > 0;
