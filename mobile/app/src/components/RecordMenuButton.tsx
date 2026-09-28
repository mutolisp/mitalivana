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
import { hasMergeLog } from '~/db/mergeLog';
import { mergeSummary } from '~/lib/mergeSummaryText';
import { hasSecret, linkedTeams, listTeams, recordUuid, syncRecord, teamServerLabel } from '~/lib/teamSync';
import { confirmSwitch, planTeamPick } from '~/lib/teamPick';
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
  const [hasLog, setHasLog] = useState(false);
  const openLog = () => {
    const uuid = recordUuid(kind, id);
    if (uuid) router.push({ pathname: '/merge-log', params: { kind, uuid } } as Href);
  };
  // Only teams this device holds the key for: a team restored from a backup
  // without its key cannot sync, so it must not bring up the button.
  useFocusEffect(
    useCallback(() => {
      void Promise.all(listTeams().map((x) => hasSecret(x.team_id))).then((keys) => setHasTeam(keys.some(Boolean)));
      const uuid = recordUuid(kind, id);
      setHasLog(!!uuid && hasMergeLog(kind, uuid));
      return () => setOpen(false);
    }, [kind, id]),
  );

  // With several teams the button always asks, each with its server, and
  // switching between same-named ones asks again (src/lib/teamPick.ts): a
  // record must not silently keep going to an old server.
  const pickTeam = async (): Promise<string | null> => {
    const teams = listTeams().map((x) => ({ team_id: x.team_id, name: x.name, host: teamServerLabel(x) }));
    const uuid = recordUuid(kind, id);
    const linked = uuid ? linkedTeams(kind, uuid) : [];
    const plan = planTeamPick(teams, linked);
    let chosen: string | null;
    if (plan.kind === 'use') chosen = plan.teamId;
    else {
      const idx = await showActionSheet({
        title: t('teamSync.pickTeam'),
        cancelLabel: t('common.cancel'),
        options: plan.options.map((o) => ({
          label: [o.name, o.host ? `（${o.host}）` : '', o.linked ? ` · ${t('teamSync.pickLinked')}` : ''].join(''),
        })),
      });
      chosen = plan.options[idx]?.teamId ?? null;
    }
    if (!chosen) return null;
    const from = confirmSwitch(teams, linked, chosen);
    if (!from) return chosen;
    const to = teams.find((x) => x.team_id === chosen)!;
    const ok = await new Promise<boolean>((resolve) =>
      Alert.alert(t('teamSync.switchTitle'), t('teamSync.switchMsg', { name: to.name, from: from.host, to: to.host }), [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        // No host on the button: Android capitalises dialog buttons; the message names it.
        { text: t('teamSync.switchGo'), onPress: () => resolve(true) },
      ]),
    );
    return ok ? chosen : null;
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
          {/* Record versions (v73): snapshots, comparison, restore. */}
          <HeaderIconButton
            icon="layers-outline"
            onPress={() => {
              setOpen(false);
              router.push({ pathname: '/record-versions', params: { kind, id: String(id) } } as Href);
            }}
            label={t('versions.title')}
          />
          {hasLog ? (
            <HeaderIconButton
              icon="time-outline"
              onPress={() => {
                setOpen(false);
                openLog();
              }}
              label={t('mergeLog.title')}
            />
          ) : null}
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
