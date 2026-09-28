/**
 * Team sync (docs/Team_sync.md): the teams this device belongs to, creating
 * and joining one, and where new teams live. A team's own actions are on its
 * page (app/settings/team/[id].tsx); syncing a record is done from the
 * record's own screen (RecordMenuButton: the header's ⋯ unfolds a sync button). Nothing here runs
 * by itself.
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, ScrollView, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { LinkRow, Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { askMyName, pickServer, renameServer } from '~/components/teamSyncPrompts';
import { promptText } from '~/components/TextPromptModal';
import { isoStamp } from '~/lib/datetime';
import {
  checkServer,
  createTeam,
  DEFAULT_SERVER,
  defaultServerForNewTeams,
  forgetServer,
  hasSecret,
  listServers,
  rememberServer,
  listTeams,
  queuedCount,
  serverLabel,
  teamServerLabel,
  hostOf,
  setDefaultServerForNewTeams,
  type KnownServer,
  type Team,
} from '~/lib/teamSync';
import { duplicateNames } from '~/lib/teamPick';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { isHttpsUrl } from '~/lib/teamCrypto';

type Row = Team & { hasKey: boolean; queued: number };

export default function TeamSyncScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [teams, setTeams] = useState<Row[]>([]);
  const [servers, setServers] = useState<{ def: string; known: KnownServer[] }>({ def: DEFAULT_SERVER, known: [] });
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setServers({ def: defaultServerForNewTeams(), known: listServers() });
    void (async () => {
      const list = listTeams();
      setTeams(await Promise.all(list.map(async (x) => ({ ...x, hasKey: await hasSecret(x.team_id), queued: queuedCount(x.team_id) }))));
    })();
  }, []);
  useFocusEffect(refresh);

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

  const create = async () => {
    // Server first, name second: a native sheet presented while a prompt's
    // Modal is still animating out is dismissed with it on iOS.
    const server = await pickServer(t, t('teamSync.serverTitle'));
    if (!server) return;
    const name = await promptText({ title: t('teamSync.createTitle'), message: t('teamSync.createMsg'), placeholder: t('teamSync.namePlaceholder') });
    if (!name?.trim()) return;
    const me = await askMyName(t, null);
    if (me === null) return;
    await run(t('teamSync.creating'), async () => {
      const teamId = await createTeam(name.trim(), server, me);
      router.push(`/settings/team-invite?team=${teamId}` as Href);
    });
  };

  const join = async () => {
    const code = await promptText({ title: t('teamSync.joinTitle'), message: t('teamSync.joinMsg'), placeholder: '1.…', autoCapitalize: 'none' });
    if (!code) return;
    router.push(`/team/join?c=${encodeURIComponent(code.trim())}` as Href);
  };

  /** Add a relay by its address; it is checked before it joins the list. */
  const addServer = async () => {
    const typed = await promptText({
      title: t('teamSync.addServer'),
      message: t('teamSync.serverUrlMsg'),
      placeholder: 'https://mitalivana-sync.example.workers.dev',
      autoCapitalize: 'none',
      keyboardType: 'email-address',
    });
    const url = typed?.trim().replace(/\/+$/, '');
    if (!url) return;
    if (!isHttpsUrl(url)) {
      Alert.alert(t('teamSync.failTitle'), t('teamSync.err.server'));
      return;
    }
    await run(t('teamSync.loading'), async () => {
      await checkServer(url);
      rememberServer(url);
    });
  };

  /** One server's actions: short name, default for new teams, forget (not the built-in one). */
  const serverMenu = async (url: string) => {
    const builtin = url === DEFAULT_SERVER;
    const actions: Array<{ label: string; destructive?: boolean; run: () => Promise<void> | void }> = [
      { label: t('teamSync.aliasTitle'), run: () => renameServer(t, url).then(() => refresh()) },
      ...(url !== servers.def ? [{ label: t('teamSync.makeDefault'), run: () => (setDefaultServerForNewTeams(url), refresh()) }] : []),
      ...(!builtin ? [{ label: t('teamSync.forgetOne'), destructive: true, run: () => (forgetServer(url), refresh()) }] : []),
    ];
    const idx = await showActionSheet({
      title: serverLabel(url),
      message: hostOf(url),
      cancelLabel: t('common.cancel'),
      options: actions.map((a) => ({ label: a.label, destructive: a.destructive })),
    });
    await actions[idx]?.run();
  };

  const dupNames = duplicateNames(teams);

  return (
    <SettingsPage>
      <ScrollView contentContainerClassName="pb-8">
        <Text className="px-4 pt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamSync.intro')}</Text>
        {busy ? (
          <View className="flex-row items-center gap-2 px-4 pt-3">
            <ActivityIndicator />
            <Text className="text-sm text-gray-600 dark:text-gray-300">{busy}</Text>
          </View>
        ) : null}
        <Section title={t('teamSync.teams')}>
          {teams.length === 0 ? (
            <Text className="px-4 py-3 text-sm text-gray-400">{t('teamSync.noTeams')}</Text>
          ) : (
            teams.map((x) => (
              <LinkRow
                key={x.team_id}
                label={x.name}
                description={[
                  // Same-named teams are told apart by their server.
                  dupNames.has(x.name.trim().toLowerCase()) ? teamServerLabel(x) : null,
                  x.member_name ? t('teamSync.iAm', { name: x.member_name }) : t('teamSync.noMyName'),
                  x.is_owner ? t('teamSync.owner') : null,
                  !x.hasKey ? t('teamSync.noKey') : null,
                  x.queued ? t('teamSync.queued', { count: x.queued }) : null,
                  x.last_sync_at ? t('teamSync.lastSync', { date: isoStamp(x.last_sync_at).slice(0, 16) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={() => router.push(`/settings/team/${x.team_id}` as Href)}
              />
            ))
          )}
        </Section>
        <Section title={t('teamSync.actions')}>
          <LinkRow label={t('teamSync.create')} onPress={() => void create()} />
          <LinkRow label={t('teamSync.join')} description={t('teamSync.joinDesc')} onPress={() => void join()} />
          <LinkRow label={t('teamSync.log.titleAll')} description={t('teamSync.log.desc')} onPress={() => router.push('/settings/team-log' as Href)} />
        </Section>
        {/* Every server once: its short name (v71) and address, what it is; tap for name / default / forget. */}
        <Section title={t('teamSync.sectionServers')}>
          {[DEFAULT_SERVER, ...servers.known.map((x) => x.url)].map((u) => {
            const named = serverLabel(u) !== hostOf(u);
            const tags = [
              u === DEFAULT_SERVER ? t('teamSync.aliasBuiltin') : null,
              servers.known.find((x) => x.url === u)?.is_own ? t('teamSync.aliasOwn') : null,
              u === servers.def ? t('teamSync.aliasDefault') : null,
            ].filter(Boolean);
            return (
              <LinkRow
                key={u}
                label={serverLabel(u)}
                description={[named ? hostOf(u) : null, ...tags].filter(Boolean).join(' · ')}
                onPress={() => void serverMenu(u)}
              />
            );
          })}
          <LinkRow label={t('teamSync.addServer')} description={t('teamSync.addServerDesc')} onPress={() => void addServer()} />
          <LinkRow
            label={t('teamSync.selfHost')}
            description={t('teamSync.selfHostDesc')}
            onPress={() => router.push('/settings/team-deploy' as Href)}
          />
        </Section>
        <Text className="px-4 pt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {t('teamSync.privacy', { server: DEFAULT_SERVER.replace(/^https:\/\//, '') })}
        </Text>
      </ScrollView>
    </SettingsPage>
  );
}
