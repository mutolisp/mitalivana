/**
 * The record header's ⋯ (checklist, plot survey, GLORIA). Tapping it unfolds
 * the actions in place, to its left, instead of opening a sheet: 研究報告,
 * and 同步 once this device holds a team key. The ⋯ turns into a chevron that
 * folds them back; running an action or leaving the screen folds them too.
 * Folded, only ⋯ is drawn, so the header stays as narrow as before.
 *
 * 同步 is the only thing that sends: no background sync, per the field-use
 * rules (battery, no signal).
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import type { MergeKind } from '~/lib/mergeDocs';
import { hasSecret, linkedTeams, listTeams, recordUuid, syncRecord } from '~/lib/teamSync';
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
  const [open, setOpen] = useState(false);
  // Only teams this device holds the key for: a team restored from a backup
  // without its key cannot sync, so it must not bring up the button.
  useFocusEffect(
    useCallback(() => {
      void Promise.all(listTeams().map((x) => hasSecret(x.team_id))).then((keys) => setHasTeam(keys.some(Boolean)));
      return () => setOpen(false);
    }, []),
  );

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

  return (
    <>
      {open ? (
        <>
          <HeaderIconButton
            icon="document-text-outline"
            onPress={() => {
              setOpen(false);
              router.push(reportHref);
            }}
            label={t('report.navTitle')}
          />
          {hasTeam ? (
            <HeaderIconButton
              icon="cloud-outline"
              onPress={() => {
                setOpen(false);
                void sync();
              }}
              disabled={busy}
              label={t('teamSync.sync')}
            />
          ) : null}
        </>
      ) : null}
      <HeaderIconButton
        icon={open ? 'chevron-forward' : 'ellipsis-horizontal'}
        onPress={() => setOpen((v) => !v)}
        label={open ? t('record.lessActions') : t('record.moreActions')}
      />
    </>
  );
}
