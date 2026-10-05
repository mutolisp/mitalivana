/**
 * Picking a taxon on a screen of its own (a 自訂欄位 of the taxon type,
 * 2026-10-04): the species search docked at the bottom of a full screen, as
 * the interaction screen has it (app/survey/pick-taxon.tsx). The caller waits
 * for the pick; leaving the screen without one gives null.
 */
import { router } from 'expo-router';
import { Keyboard } from 'react-native';

export type PickedTaxon = { taxonId: string; name: string; cname: string | null; rank: string; kingdom: string };

let pending: ((p: PickedTaxon | null) => void) | null = null;

/** How long the picker's screen takes to pop: a caller's sheet (an RN Modal) opened
 *  again during the pop may not present on iOS (code review V1). */
const POP_MS = 450;

/** Open the picker; resolves with the taxon, or null when the screen is left without one, once the screen has gone. */
export function pickTaxon(title?: string): Promise<PickedTaxon | null> {
  pending?.(null);
  return new Promise((resolve) => {
    pending = (p) => setTimeout(() => resolve(p), POP_MS);
    // A screen with a docked search must be entered with the keyboard closed (it latches otherwise).
    Keyboard.dismiss();
    router.push({ pathname: '/survey/pick-taxon', params: title ? { title } : {} });
  });
}

/** The picker's answer (null: left without one). The first one wins. */
export function settleTaxonPick(p: PickedTaxon | null): void {
  const resolve = pending;
  pending = null;
  resolve?.(p);
}
