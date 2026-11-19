/**
 * Web stand-in for mobile/app/src/components/RecordMenuButton.tsx (the
 * record header's ⋯). Same props and the same menu (OverflowMenu): record
 * info, undo / redo, layout, the screen's actions, the research report, the
 * screen's last actions. Team sync, merge log and record versions are not on
 * the web yet; in their place, a GLORIA survey can be exported here — the
 * same zip the phone writes (modules/gloria/export/bundle.ts).
 */
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { router, type Href } from 'expo-router';
import { MenuButton, showMenu, type MenuIcon, type MenuSection } from '~/components/OverflowMenu';
import { showActionSheet } from '~/components/ActionSheet';
import type { RecordsLayout } from '~/stores/settings';
import type { RecordEditing } from '~/lib/useRecordEditing';
import type { MergeKind } from '~/lib/mergeDocs';
import { modeSections } from '~/lib/modeMenu';
import type { Cap } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';
import { useToast } from '~/stores/toast';
import { errText } from '~/lib/errText';
import { buildSurveyZip } from '../export/exportSurvey';
import { deliver } from './sharing';

type Props = {
  kind: MergeKind;
  id: number;
  reportHref?: Href;
  onSynced?: () => void;
  info?: { label: string; detail: string; onPress: () => void; icon?: MenuIcon; attention?: boolean }[];
  badge?: boolean;
  extra?: { label: string; onPress: () => void; icon?: MenuIcon; section?: string; destructive?: boolean; cap?: Cap }[];
  last?: { label: string; onPress: () => void; icon?: MenuIcon; destructive?: boolean }[];
  edit?: RecordEditing;
  onEdited?: () => void;
  layout?: { value: RecordsLayout; onChange: (v: RecordsLayout) => void };
};

export function RecordMenuButton({ kind, id, reportHref, info = [], badge = false, extra = [], last = [], edit, onEdited, layout }: Props) {
  const { t } = useTranslation();
  const mode = useUsageMode();
  const latest = useRef({ info, edit, extra, last, layout });
  useLayoutEffect(() => {
    latest.current = { info, edit, extra, last, layout };
  });

  const exportZip = async () => {
    const idx = await showActionSheet({
      title: t('common.export'),
      cancelLabel: t('common.cancel'),
      options: [
        { label: t('web.export.withoutPhotos'), icon: 'document-outline' },
        { label: t('web.export.withPhotos'), icon: 'images-outline' },
      ],
    });
    if (idx < 0) return;
    const toast = useToast.getState();
    toast.show(t('export.exporting'), { durationMs: 60_000 });
    try {
      const zip = await buildSurveyZip(id, { includePhotos: idx === 1 });
      toast.dismiss();
      await deliver(zip.bytes, zip.filename, 'application/zip');
      toast.show(t('export.done', { filename: zip.filename }));
    } catch (e) {
      toast.dismiss();
      Alert.alert(t('export.failed'), errText(e));
    }
  };

  const sections = (): MenuSection[] => {
    const { info: inf, edit: e, extra: x, last: z, layout: lay } = latest.current;
    const out: MenuSection[] = [];
    if (inf.length) {
      out.push({
        title: t('menu.recordInfo'),
        items: inf.map((a, i) => ({ kind: 'action' as const, id: `info-${i}`, label: a.label, icon: a.icon, detail: a.detail, attention: a.attention })),
      });
    }
    if (e && !e.locked) {
      out.push({
        items: [
          {
            kind: 'stepper',
            id: 'history',
            undo: { label: t('recordLock.undo'), icon: 'arrow-undo-outline', count: e.undoCount, onPress: () => (e.undo(), onEdited?.()) },
            redo: { label: t('recordLock.redo'), icon: 'arrow-redo-outline', count: e.redoCount, onPress: () => (e.redo(), onEdited?.()) },
          },
        ],
      });
    }
    if (lay) {
      out.push({
        items: [
          {
            kind: 'segmented',
            id: 'layout',
            label: t('menu.layout'),
            value: lay.value,
            options: [
              { value: 'list', icon: 'list', label: t('records.layoutToList') },
              { value: 'card', icon: 'grid-outline', label: t('records.layoutToCard') },
            ],
            onChange: (v) => lay.onChange(v as RecordsLayout),
          },
        ],
      });
    }
    for (const title of [...new Set(x.map((a) => a.section ?? ''))]) {
      out.push({
        title: title || undefined,
        items: x
          .map((a, i) => ({ a, i }))
          .filter(({ a }) => (a.section ?? '') === title)
          .map(({ a, i }) => ({ kind: 'action' as const, id: `extra-${i}`, label: a.label, icon: a.icon, destructive: a.destructive })),
      });
    }
    out.push({
      items: [
        ...(kind === 'gloria' ? [{ kind: 'action' as const, id: 'export', label: t('common.export'), icon: 'share-outline' as const }] : []),
        ...(reportHref ? [{ kind: 'action' as const, id: 'report', label: t('report.navTitle'), icon: 'bar-chart-outline' as const }] : []),
      ],
    });
    if (z.length) out.push({ items: z.map((a, i) => ({ kind: 'action' as const, id: `last-${i}`, label: a.label, icon: a.icon, destructive: a.destructive })) });
    const caps: Partial<Record<string, Cap>> = { report: 'analysisReport' };
    x.forEach((a, i) => {
      if (a.cap) caps[`extra-${i}`] = a.cap;
    });
    return modeSections(mode, out, caps, t('mode.advanced'));
  };

  const open = async (anchor: Parameters<typeof showMenu>[0]) => {
    const choice = await showMenu(anchor, sections);
    if (!choice) return;
    if (choice.startsWith('info-')) latest.current.info[Number(choice.slice(5))]?.onPress();
    else if (choice.startsWith('extra-')) latest.current.extra[Number(choice.slice(6))]?.onPress();
    else if (choice.startsWith('last-')) latest.current.last[Number(choice.slice(5))]?.onPress();
    else if (choice === 'export') void exportZip();
    else if (choice === 'report' && reportHref) router.push(reportHref);
  };

  return <MenuButton onOpen={open} badge={badge} />;
}
