/**
 * What the ＋ does, wherever it is drawn: in the tab bar, or first in the
 * folded tab bar's menu (TabBubble). With a default record type set, a tap
 * starts that record; otherwise, and on a long press, the create sheet opens
 * (the sheet is also where that default is changed). In casual mode ＋ is a
 * camera: both open 記一筆觀察.
 */
import { showCreateSheet } from '~/components/CreateRecordSheet';
import { showCaptureSheet } from '~/lib/captureSheet';
import { shows } from '~/lib/usageMode';
import { currentUsageMode } from '~/lib/useUsageMode';
import { createPlotOfType, createPlotPromptAndOpen, startCollectionAndOpen, startSessionAndOpen } from '~/lib/recordCreate';
import { useSettings } from '~/stores/settings';

const casual = () => shows(currentUsageMode(), 'casualObservations');

export function pressPlus(): void {
  if (casual()) return showCaptureSheet();
  const d = useSettings.getState().record_type_default;
  if (d === 'session') startSessionAndOpen();
  else if (d === 'plot') createPlotPromptAndOpen();
  else if (d === 'collection') startCollectionAndOpen();
  else if (d === 'transect' || d === 'point_count') void createPlotOfType(d);
  else void showCreateSheet();
}

export function longPressPlus(): void {
  if (casual()) return showCaptureSheet();
  void showCreateSheet();
}
