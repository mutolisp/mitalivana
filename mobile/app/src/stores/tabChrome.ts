/**
 * Whether the folded tab bar's button (TabBubble) is on screen right now: the
 * tabs are the focused screen, the bar is folded and no keyboard is up. The
 * team-sync button folds into its ring then (SyncProgressHost), which sits
 * outside the tab navigator and cannot see that for itself.
 */
import { create } from 'zustand';

export const useTabChrome = create<{ bubbleShown: boolean }>(() => ({ bubbleShown: false }));
