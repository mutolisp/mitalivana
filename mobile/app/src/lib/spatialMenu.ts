/**
 * The place chip's menu (快速名錄, and a checklist-style survey drawn with its
 * screen, 2G-c): a 地理樣區, a point site from the current fix, the start
 * point, the track, and clearing them — one list, so both screens offer the
 * same actions in the same order. The screen does the writing.
 */
import { showActionSheet } from '~/components/ActionSheet';
import i18n from '~/i18n';

export async function showSpatialMenu(o: {
  /** The assigned site's name; null when none is. */
  siteName: string | null;
  hasPoint: boolean;
  trackHasData: boolean;
  /** This record's track is being recorded now. */
  tracking: boolean;
  trackCount: number;
  onAssignSite: () => void;
  onCreatePointSite: () => void;
  onDropPoint: () => void;
  onStartTrack: () => void;
  onStopTrack: () => void;
  onClear: () => void;
}): Promise<void> {
  const t = i18n.t.bind(i18n);
  const hasSite = o.siteName !== null;
  const options: Array<{ label: string; action: () => void; destructive?: boolean }> = [
    {
      label: hasSite ? t('session.assignSiteCurrent', { name: o.siteName }) : t('session.assignOrCreateSite'),
      action: o.onAssignSite,
    },
    { label: t('session.createPointSiteFromGnss'), action: o.onCreatePointSite },
    { label: o.hasPoint ? t('session.relocateStart') : t('session.locateNoSite'), action: o.onDropPoint },
    o.tracking
      ? { label: t('session.stopTrack', { count: o.trackCount }), action: o.onStopTrack }
      : { label: o.trackHasData ? t('session.resumeTrack') : t('session.startTrack'), action: o.onStartTrack },
  ];
  if (o.hasPoint || hasSite || o.trackHasData) options.push({ label: t('session.clearSpatial'), action: o.onClear, destructive: true });
  const idx = await showActionSheet({
    title: t('session.spatialMenuTitle'),
    options: options.map((x) => ({ label: x.label, destructive: x.destructive })),
  });
  if (idx >= 0 && idx < options.length) options[idx].action();
}
