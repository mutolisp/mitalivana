/**
 * The record header's ⋯ (checklist, plot survey, GLORIA, checklist / plot-style survey). Tapping it unfolds
 * the actions in place, to its left, instead of opening a sheet: 研究報告,
 * and 同步 once this device holds a team key. The ⋯ turns into a chevron that
 * folds them back; running an action or leaving the screen folds them too.
 * Folded, only ⋯ is drawn, so the header stays as narrow as before.
 *
 * 同步 is the only thing that sends: no background sync, per the field-use
 * rules (battery, no signal).
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, type View } from 'react-native';
import { MenuButton, showMenu, type MenuIcon, type MenuSection } from '~/components/OverflowMenu';
import type { RecordEditing } from '~/lib/useRecordEditing';
import type { MergeKind } from '~/lib/mergeDocs';
import { hasMergeLog } from '~/db/mergeLog';
import { isPreviewId } from '~/db/previewDb';
import { mergeSummary } from '~/lib/mergeSummaryText';
import { hasSecret, linkedTeams, listTeams, recordUuid, syncRecord, teamServerLabel } from '~/lib/teamSync';
import { pickSyncTeam } from '~/lib/teamPickPrompt';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { useToast } from '~/stores/toast';
import { modeSections } from '~/lib/modeMenu';
import type { Cap } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';

export function RecordMenuButton({
  kind,
  id,
  reportHref,
  onSynced,
  extra = [],
  last = [],
  edit,
  onEdited,
}: {
  kind: MergeKind;
  id: number;
  /** The record's research report; a kind without one (a checklist / plot-style survey, until Phase 2E) leaves it out. */
  reportHref?: Href;
  onSynced?: () => void;
  /** Screen-specific actions, listed after undo / redo and grouped by
   *  `section` (the checklist's 加入物種: batch and photo import). */
  extra?: { label: string; onPress: () => void; icon?: MenuIcon; section?: string; destructive?: boolean; cap?: Cap }[];
  /** After everything else, in a section of their own (deleting the record). */
  last?: { label: string; onPress: () => void; icon?: MenuIcon; destructive?: boolean }[];
  /** Given (and the record unlocked): undo / redo head the menu, and the
   *  screen passes `inMenu` to RecordEditButtons so the header drops them. */
  edit?: RecordEditing;
  /** Reload after an undo / redo from the menu. */
  onEdited?: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const mode = useUsageMode();
  const [hasTeam, setHasTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasLog, setHasLog] = useState(false);
  const openLog = () => {
    const uuid = recordUuid(kind, id);
    if (uuid) router.push({ pathname: '/merge-log', params: { kind, uuid } } as Href);
  };
  // Only teams this device holds the key for: a team restored from a backup
  // without its key cannot sync, so it must not bring up the button.
  // A builder preview's survey (previewDb.ts) has no versions, merge log or team to send to.
  const preview = kind === 'modular' && isPreviewId(id);
  useFocusEffect(
    useCallback(() => {
      if (preview) return;
      void Promise.all(listTeams().map((x) => hasSecret(x.team_id))).then((keys) => setHasTeam(keys.some(Boolean)));
      const uuid = recordUuid(kind, id);
      setHasLog(!!uuid && hasMergeLog(kind, uuid));
    }, [kind, id, preview]),
  );

  // With several teams the button always asks (src/lib/teamPickPrompt.ts).
  const pickTeam = async (): Promise<string | null> => {
    const uuid = recordUuid(kind, id);
    return pickSyncTeam(uuid ? linkedTeams(kind, uuid) : []);
  };

  const sync = async () => {
    const teamId = await pickTeam();
    if (!teamId) return;
    const dest = listTeams().find((x) => x.team_id === teamId);
    // Every result says where it went.
    const where = dest ? `\n${t('teamSync.sentTo', { name: dest.name, host: teamServerLabel(dest) })}` : '';
    setBusy(true);
    // Progress shows in the strip on every screen (SyncProgressHost).
    try {
      const r = await syncRecord(teamId, kind, id);
      useToast.getState().dismiss();
      if (r.queued) toast(t('teamSync.queuedToast') + where);
      else if (!r.review) {
        const who = r.mergedFrom.length
          ? t('teamSync.mergedFromToast', { names: [...new Set(r.mergedFrom)].join('、') })
          : r.merged
            ? t('teamSync.mergedToast', { count: r.merged })
            : null;
        const what = mergeSummary(t, r.changes);
        if (who) {
          setHasLog(true);
          // What was merged, with the full list one tap away (the record's merge log).
          toast((what ? t('teamSync.mergedWithSummary', { who, what }) : who) + where, { durationMs: 8000, action: { label: t('mergeLog.details'), onPress: openLog } });
        } else toast(t('teamSync.upToDate') + where, { durationMs: 5000 });
      }
      onSynced?.();
    } catch (e) {
      useToast.getState().dismiss();
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e) + where);
    } finally {
      setBusy(false);
    }
  };

  // The menu rebuilds itself after undo / redo (it stays open), so it reads
  // the latest props through a ref rather than this render's closure.
  // After each render, not during it (code review L23).
  const latest = useRef({ edit, extra, last, hasLog, hasTeam, busy });
  useLayoutEffect(() => {
    latest.current = { edit, extra, last, hasLog, hasTeam, busy };
  });

  const sections = (): MenuSection[] => {
    const { edit: e, extra: x, last: z, hasLog: log, hasTeam: team, busy: syncing } = latest.current;
    const out: MenuSection[] = [];
    if (e && !e.locked) {
      out.push({
        items: [
          {
            kind: 'stepper',
            id: 'history',
            undo: {
              label: t('recordLock.undo'),
              icon: 'arrow-undo-outline',
              count: e.undoCount,
              onPress: () => {
                e.undo();
                onEdited?.();
              },
            },
            redo: {
              label: t('recordLock.redo'),
              icon: 'arrow-redo-outline',
              count: e.redoCount,
              onPress: () => {
                e.redo();
                onEdited?.();
              },
            },
          },
        ],
      });
    }
    // Screen actions, one section per title, in the order given.
    const titles = [...new Set(x.map((a) => a.section ?? ''))];
    for (const title of titles) {
      out.push({
        title: title || undefined,
        items: x
          .map((a, i) => ({ a, i }))
          .filter(({ a }) => (a.section ?? '') === title)
          .map(({ a, i }) => ({ kind: 'action' as const, id: `extra-${i}`, label: a.label, icon: a.icon, destructive: a.destructive })),
      });
    }
    if (!preview) out.push({
      items: [
        ...(reportHref ? [{ kind: 'action' as const, id: 'report', label: t('report.navTitle'), icon: 'bar-chart-outline' as const }] : []),
        // Record versions (v73): snapshots, comparison, restore.
        { kind: 'action', id: 'versions', label: t('versions.title'), icon: 'time-outline' },
        ...(log ? [{ kind: 'action' as const, id: 'mergeLog', label: t('mergeLog.title'), icon: 'git-merge-outline' as const }] : []),
        ...(team && !syncing
          ? [{ kind: 'action' as const, id: 'sync', label: t('teamSync.sync'), icon: 'sync-outline' as const }]
          : []),
      ],
    });
    if (z.length) out.push({ items: z.map((a, i) => ({ kind: 'action' as const, id: `last-${i}`, label: a.label, icon: a.icon, destructive: a.destructive })) });
    const caps: Partial<Record<string, Cap>> = { report: 'analysisReport', versions: 'recordVersions', mergeLog: 'mergeLog' };
    x.forEach((a, i) => {
      if (a.cap) caps[`extra-${i}`] = a.cap;
    });
    return modeSections(mode, out, caps, t('mode.advanced'));
  };

  const open = async (anchor: RefObject<View | null>) => {
    const choice = await showMenu(anchor, sections);
    if (!choice) return;
    if (choice.startsWith('extra-')) latest.current.extra[Number(choice.slice('extra-'.length))]?.onPress();
    else if (choice.startsWith('last-')) latest.current.last[Number(choice.slice('last-'.length))]?.onPress();
    else if (choice === 'report' && reportHref) router.push(reportHref);
    else if (choice === 'versions')
      router.push({ pathname: '/record-versions', params: { kind, id: String(id) } } as Href);
    else if (choice === 'mergeLog') openLog();
    else if (choice === 'sync') void sync();
  };

  return <MenuButton onOpen={open} />;
}
