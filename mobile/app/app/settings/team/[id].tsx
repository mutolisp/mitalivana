/**
 * One team: who is in it, where its data lives, and what can be done with it.
 * Replaces the action sheet that had grown to nine items. Nothing here syncs
 * a single record; that is the record screen's ⋯ → cloud button. Pulling down syncs
 * every linked record of the team.
 */
import { mergeSummary } from '~/lib/mergeSummaryText';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { LinkRow, Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { afterPrompt, askMyName, pickServer, renameServer } from '~/components/teamSyncPrompts';
import { promptText } from '~/components/TextPromptModal';
import { isoStamp } from '~/lib/datetime';
import { formatBytes } from '~/lib/exportSize';
import {
  deleteTeamEverywhere,
  deleteTeamOn,
  flushQueue,
  getTeam,
  hasSecret,
  leaveTeam,
  listMembers,
  moveTeam,
  pullTeamRecords,
  queuedCount,
  sameNameTeams,
  localIdOf,
  teamServerLabel,
  hostOf,
  serverOf,
  setMemberName,
  syncTeam,
  teamUsage,
  type Team,
  type TeamMember,
  type TeamUsage,
} from '~/lib/teamSync';
import { adminTokenFor, setTeamLimits } from '~/lib/teamSyncAdmin';
import { pendingMediaCount, retryPendingMedia } from '~/lib/mediaSync';
import { retryCensusMedia } from '~/survey/censusSync';
import { syncFailuresText, teamSyncErrorText } from '~/lib/teamSyncText';
import { useToast } from '~/stores/toast';
import { AdvancedFold } from '~/components/AdvancedFold';
import { shows, vis } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';

const when = (ms: number | null | undefined) => (ms ? isoStamp(ms).slice(0, 16) : null);

export default function TeamScreen() {
  const { t } = useTranslation();
  // Inviting, moving, limits and deleting the cloud copy are the
  // coordinator's, in pro mode; volunteers sync and leave (Q6).
  const mode = useUsageMode();
  const admin = shows(mode, 'teamAdmin');
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [hasKey, setHasKey] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [queued, setQueued] = useState(0);
  const [usage, setUsage] = useState<TeamUsage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [twins, setTwins] = useState<ReturnType<typeof sameNameTeams>>([]);
  const [pendingFiles, setPendingFiles] = useState(0);

  const refresh = useCallback(() => {
    if (!id) return;
    const tm = getTeam(id);
    setTeam(tm);
    setTwins(sameNameTeams(id));
    setPendingFiles(pendingMediaCount(id));
    setMembers(listMembers(id));
    setQueued(queuedCount(id));
    void hasSecret(id).then(setHasKey);
    void (tm?.server ? adminTokenFor(tm.server) : Promise.resolve(null)).then((x) => setIsAdmin(x != null));
  }, [id]);
  useFocusEffect(refresh);

  if (!team) return <SettingsPage title={t('teamSync.title')}>{null}</SettingsPage>;
  const teamId = team.team_id;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const rename = async () => {
    const me = await askMyName(t, team.member_name);
    if (me === null) return;
    setMemberName(teamId, me);
    toast(t('teamSync.myNameDone'));
    refresh();
  };

  const loadUsage = () => run(t('teamSync.loading'), async () => setUsage(await teamUsage(teamId)));

  const pull = () =>
    run(t('teamSync.pulling'), async () => {
      const r = await pullTeamRecords(teamId);
      Alert.alert(t('teamSync.pullDoneTitle'), t('teamSync.pullDone', { imported: r.imported, linked: r.linked }));
    });

  // Pull down = sync the whole team: every linked record, then what is new.
  const refreshAll = async () => {
    if (!hasKey || busy) return;
    setRefreshing(true);
    try {
      const r = await syncTeam(teamId);
      if (r.queued) toast(t('teamSync.queuedToast'));
      else if (!r.review) {
        const parts = [
          r.sent ? t('teamSync.teamSynced', { count: r.sent }) : null,
          r.mergedFrom.length
            ? (() => {
                const who = t('teamSync.mergedFromToast', { names: [...new Set(r.mergedFrom)].join('、') });
                const what = mergeSummary(t, r.changes);
                return what ? t('teamSync.mergedWithSummary', { who, what }) : who;
              })()
            : null,
          r.imported ? t('teamSync.teamImported', { count: r.imported }) : null,
        ].filter(Boolean);
        toast(parts.length ? parts.join('；') : t('teamSync.teamNothing'));
      }
      const failed = syncFailuresText(r.failed);
      if (failed) Alert.alert(t('teamSync.failTitle'), failed);
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    } finally {
      setRefreshing(false);
      refresh();
    }
  };

  const flush = () =>
    run(t('teamSync.syncing'), async () => {
      const r = await flushQueue(teamId);
      if (r.queued) toast(t('teamSync.stillOffline'));
      else if (!r.review) toast(t('teamSync.flushDone', { count: r.sent }));
      const failed = syncFailuresText(r.failed);
      if (failed) Alert.alert(t('teamSync.failTitle'), failed);
    });

  const adjustLimits = async () => {
    // Start from the limits in force on this server: a self-hosted one is
    // 8 GB / 1,000 devices, not the default server's 200 MB / 20.
    let current = usage;
    if (!current) {
      setBusy(t('teamSync.loading'));
      try {
        current = await teamUsage(teamId);
        setUsage(current);
      } catch (e) {
        Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
        return;
      } finally {
        setBusy(null);
      }
    }
    const mbNow = String(Math.round(current.limits.maxTeamBytes / (1024 * 1024)));
    const mb = await promptText({ title: t('teamSync.limitsTitle'), message: t('teamSync.limitsBytesMsg'), keyboardType: 'numeric', defaultValue: mbNow });
    if (!mb) return;
    const devices = await promptText({
      title: t('teamSync.limitsTitle'),
      message: t('teamSync.limitsDevicesMsg'),
      keyboardType: 'numeric',
      defaultValue: String(current.limits.maxTeamDevices),
    });
    if (!devices) return;
    const bytes = Math.round(Number(mb) * 1024 * 1024);
    const n = Math.round(Number(devices));
    if (!(bytes > 0) || !(n > 0)) return;
    await run(t('teamSync.loading'), async () => {
      const l = await setTeamLimits(serverOf(team), teamId, { maxTeamBytes: bytes, maxTeamDevices: n });
      toast(t('teamSync.limitsDone', { bytes: formatBytes(l.maxTeamBytes), devices: l.maxTeamDevices }));
    });
  };

  const move = async () => {
    const target = await pickServer(t, t('teamSync.moveTitle'), serverOf(team));
    if (!target) return;
    await afterPrompt();
    Alert.alert(t('teamSync.moveTitle'), t('teamSync.moveConfirm', { name: team.name, server: target.replace(/^https:\/\//, '') }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('teamSync.moveGo'),
        onPress: () =>
          void run(t('teamSync.moving'), async () => {
            const r = await moveTeam(teamId, target);
            const showInvite = () => router.push(`/settings/team-invite?team=${teamId}` as Href);
            const msg = [t('teamSync.movedMsg', { count: r.sent }), r.queued ? t('teamSync.movedQueued') : '', r.review ? t('teamSync.movedReview') : '']
              .filter(Boolean)
              .join('\n');
            Alert.alert(t('teamSync.movedTitle'), msg, [
              { text: t('teamSync.keepOld'), style: 'cancel', onPress: showInvite },
              {
                text: t('teamSync.deleteOld'),
                style: 'destructive',
                onPress: () =>
                  void deleteTeamOn(teamId, r.oldServer)
                    .then(showInvite)
                    .catch((e) => Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e))),
              },
            ]);
          }),
      },
    ]);
  };

  const leave = () =>
    Alert.alert(t('teamSync.leave'), t('teamSync.leaveMsg', { name: team.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('teamSync.leave'),
        style: 'destructive',
        onPress: () => void run(t('teamSync.loading'), async () => {
          await leaveTeam(teamId);
          router.back();
        }),
      },
    ]);

  const deleteCloud = () =>
    Alert.alert(t('teamSync.deleteCloud'), t('teamSync.deleteCloudMsg', { name: team.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('storage.delete'),
        style: 'destructive',
        onPress: () => void run(t('teamSync.loading'), async () => {
          await deleteTeamEverywhere(teamId);
          router.back();
        }),
      },
    ]);

  const logRow = (
    <LinkRow label={t('teamSync.log.title')} description={t('teamSync.log.desc')} onPress={() => router.push(`/settings/team-log?team=${teamId}` as Href)} />
  );

  return (
    <SettingsPage title={team.name}>
      <ScrollView
        contentContainerClassName="pb-10"
        refreshControl={hasKey ? <RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} /> : undefined}
      >
        {busy ? (
          <View className="flex-row items-center gap-2 px-4 pt-3">
            <ActivityIndicator />
            <Text className="text-sm text-gray-600 dark:text-gray-300">{busy}</Text>
          </View>
        ) : null}
        {!hasKey ? (
          <Text className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{t('teamSync.err.noSecret')}</Text>
        ) : (
          <Text className="px-4 pt-3 text-xs text-gray-500 dark:text-gray-400">{t('teamSync.pullHint')}</Text>
        )}
        {/* A team of the same name elsewhere (re-created instead of moved): records stay with whichever they are linked to. */}
        {twins.length ? (
          <View className="mx-4 mt-3 gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
            <Text className="text-sm font-semibold text-amber-900 dark:text-amber-200">{t('teamSync.sameNameTitle', { name: team.name })}</Text>
            {twins.map((x) => (
              <Text key={x.team_id} className="text-xs text-amber-900 dark:text-amber-200">
                · {t('teamSync.sameNameLine', { host: teamServerLabel(x), n: x.linked })}
              </Text>
            ))}
            <Text className="text-xs leading-5 text-amber-900 dark:text-amber-200">{t('teamSync.sameNameHint')}</Text>
          </View>
        ) : null}

        <Section title={t('teamSync.sectionTeam')}>
          <LinkRow label={t('teamSync.myNameTitle')} value={team.member_name || t('teamSync.unnamed')} onPress={() => void rename()} />
          <LinkRow
            label={t('teamSync.serverLabel')}
            value={teamServerLabel(team)}
            description={teamServerLabel(team) !== hostOf(serverOf(team)) ? hostOf(serverOf(team)) : t('teamSync.aliasTap')}
            onPress={() => void renameServer(t, serverOf(team)).then((saved) => saved && refresh())}
          />
          <LinkRow
            label={t('teamSync.roleLabel')}
            value={team.is_owner ? t('teamSync.owner') : t('teamSync.memberRole')}
            chevron={false}
            onPress={() => undefined}
          />
          {team.last_sync_at ? (
            <LinkRow label={t('teamSync.lastSyncLabel')} value={when(team.last_sync_at) ?? ''} chevron={false} onPress={() => undefined} />
          ) : null}
          {admin ? (
            <LinkRow label={t('teamSync.showInvite')} onPress={() => router.push(`/settings/team-invite?team=${teamId}` as Href)} />
          ) : null}
        </Section>

        <Section title={t('teamSync.members')}>
          <LinkRow label={t('teamSync.membersMe', { name: team.member_name || t('teamSync.unnamed') })} chevron={false} onPress={() => undefined} />
          {members.length === 0 ? (
            <Text className="px-4 py-3 text-sm text-gray-400">{t('teamSync.membersNone')}</Text>
          ) : (
            members.map((m) => (
              <LinkRow
                key={m.dev}
                label={m.name}
                description={m.last_upload_at ? t('teamSync.lastUploadAt', { date: when(m.last_upload_at) }) : undefined}
                chevron={false}
                onPress={() => undefined}
              />
            ))
          )}
        </Section>

        <Section title={t('teamSync.sectionData')}>
          <LinkRow label={t('teamSync.pull')} description={t('teamSync.pullDesc')} onPress={() => void pull()} />
          {queued ? <LinkRow label={t('teamSync.flush', { count: queued })} onPress={() => void flush()} /> : null}
          <LinkRow
            label={t('teamSync.usage')}
            description={
              usage
                ? t('teamSync.usageLine', {
                    team: formatBytes(usage.bytes),
                    teamMax: formatBytes(usage.limits.maxTeamBytes),
                    mine: formatBytes(usage.mine),
                    devices: Object.keys(usage.devices).length,
                    devicesMax: usage.limits.maxTeamDevices,
                  }) +
                  (usage.limits.mediaEnabled
                    ? `\n${t('teamSync.usageFiles', { size: formatBytes(usage.mediaBytes ?? 0), max: formatBytes(usage.limits.maxMediaTeamBytes ?? 0) })}`
                    : '')
                : t('teamSync.usageTap')
            }
            chevron={false}
            onPress={() => void loadUsage()}
          />
          {vis(mode, 'teamLog') === 'show' ? logRow : null}
          {pendingFiles ? (
            <LinkRow
              label={t('teamSync.pendingFiles', { n: pendingFiles })}
              description={t('teamSync.pendingFilesDesc')}
              onPress={() =>
                void run(t('teamSync.loading'), async () => {
                  const a = await retryPendingMedia(teamId, localIdOf);
                  const b = await retryCensusMedia(teamId);
                  const r = { added: a.added + b.added, pending: a.pending + b.pending };
                  toast(r.pending ? t('teamSync.pendingLeft', { added: r.added, n: r.pending }) : t('teamSync.pendingDone', { added: r.added }));
                })
              }
            />
          ) : null}
          {isAdmin && admin ? <LinkRow label={t('teamSync.limitsTitle')} onPress={() => void adjustLimits()} /> : null}
          {/* Media_sync.md phase 0 test tool, development builds only. */}
          {__DEV__ ? (
            <LinkRow label={t('teamSync.mediaTest.title')} onPress={() => router.push(`/settings/team-media-test?id=${teamId}` as Href)} />
          ) : null}
        </Section>

        <Section title={t('teamSync.sectionManage')}>
          {team.is_owner && hasKey && admin ? <LinkRow label={t('teamSync.moveTitle')} description={t('teamSync.moveDesc')} onPress={() => void move()} /> : null}
          <LinkRow label={t('teamSync.leave')} destructive chevron={false} onPress={leave} />
          {team.is_owner && admin ? <LinkRow label={t('teamSync.deleteCloud')} destructive chevron={false} onPress={deleteCloud} /> : null}
        </Section>
        {vis(mode, 'teamLog') === 'adv' ? (
          <AdvancedFold className="mx-4 mt-6">
            {/* Section carries its own px-4 and top margin. */}
            <View className="-mx-4 -mt-6">
              <Section>{logRow}</Section>
            </View>
          </AdvancedFold>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
