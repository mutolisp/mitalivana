/**
 * What the ＋ does, wherever it is drawn: in the tab bar, or first in the
 * folded tab bar's menu (TabBubble). With a default record type set, a tap
 * starts that record; otherwise, and on a long press, the create sheet opens
 * (the sheet is also where that default is changed).
 */
import { showCreateSheet } from '~/components/CreateRecordSheet';
import { createPlotOfType, createPlotPromptAndOpen, startCollectionAndOpen, startSessionAndOpen } from '~/lib/recordCreate';
import { useSettings } from '~/stores/settings';

export function pressPlus(): void {
  const d = useSettings.getState().record_type_default;
  if (d === 'session') startSessionAndOpen();
  else if (d === 'plot') createPlotPromptAndOpen();
  else if (d === 'collection') startCollectionAndOpen();
  else if (d === 'transect' || d === 'point_count') void createPlotOfType(d);
  else void showCreateSheet();
}

export function longPressPlus(): void {
  void showCreateSheet();
}
