/**
 * The record header's ⋯ menu (checklist, plot survey, GLORIA): 研究報告, and
 * 同步 once this device has joined a team. One button instead of two keeps
 * the header from pushing the end / reopen button off screen (GLORIA) or
 * squeezing the title to nothing (checklist, plot).
 *
 * 同步 is the only thing that sends: no background sync, per the field-use
 * rules (battery, no signal).
 */
import { isoStamp } from '~/lib/datetime';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import type { MergeKind } from '~/lib/mergeDocs';
import { lastSyncedAt, linkedTeams, listTeams, recordUuid, syncRecord } from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { useToast } from '~/stores/toast';
import { HeaderIconButton } from './HeaderIconButton';

export function RecordMenuButton({
  kind,
  id,
  reportHref,
  onSynced,
}: {
  kind: MergeKind;
  id: number;
  reportHref: Href;
  onSynced?: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [hasTeam, setHasTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  useFocusEffect(useCallback(() => setHasTeam(listTeams().length > 0), []));

  const pickTeam = async (): Promise<string | null> => {
    const teams = listTeams();
    const uuid = recordUuid(kind, id);
    const linked = uuid ? linkedTeams(kind, uuid) : [];
    if (linked.length === 1) return linked[0];
    if (teams.length === 1) return teams[0].team_id;
    const idx = await showActionSheet({
      title: t('teamSync.pickTeam'),
      cancelLabel: t('common.cancel'),
      options: teams.map((x) => ({ label: x.name })),
    });
    return teams[idx]?.team_id ?? null;
  };

  const sync = async () => {
    const teamId = await pickTeam();
    if (!teamId) return;
    setBusy(true);
    toast(t('teamSync.syncing'), { durationMs: 30000 });
    try {
      const r = await syncRecord(teamId, kind, id);
      useToast.getState().dismiss();
      if (r.queued) toast(t('teamSync.queuedToast'));
      else if (!r.review)
        toast(
          r.mergedFrom.length
            ? t('teamSync.mergedFromToast', { names: [...new Set(r.mergedFrom)].join('、') })
            : r.merged
              ? t('teamSync.mergedToast', { count: r.merged })
              : t('teamSync.upToDate'),
        );
      onSynced?.();
    } catch (e) {
      useToast.getState().dismiss();
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    const uuid = recordUuid(kind, id);
    const last = uuid ? lastSyncedAt(kind, uuid) : null;
    const opts = [
      { key: 'report', label: t('report.navTitle') },
      ...(hasTeam ? [{ key: 'sync', label: t('teamSync.sync') }] : []),
    ];
    const idx = await showActionSheet({
      title: hasTeam && last ? t('teamSync.lastSync', { date: isoStamp(last).slice(0, 16) }) : undefined,
      cancelLabel: t('common.cancel'),
      options: opts.map((o) => ({ label: o.label })),
    });
    const key = opts[idx]?.key;
    if (key === 'report') router.push(reportHref);
    // A second native sheet (the team picker) right after this one closes
    // needs this sheet gone first on iOS.
    else if (key === 'sync') setTimeout(() => void sync(), 450);
  };

  return (
    <HeaderIconButton
      icon={hasTeam ? 'ellipsis-horizontal-circle-outline' : 'ellipsis-horizontal'}
      onPress={() => void open()}
      disabled={busy}
      label={t('record.moreActions')}
    />
  );
}
