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
import { askMyName, pickServer } from '~/components/teamSyncPrompts';
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
  listTeams,
  queuedCount,
  setDefaultServerForNewTeams,
  type KnownServer,
  type Team,
} from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';

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

  const chooseDefault = async () => {
    const url = await pickServer(t, t('teamSync.defaultServerTitle'));
    if (!url) return;
    await run(t('teamSync.loading'), async () => {
      // A typed URL is checked before it becomes the default for new teams.
      if (url !== DEFAULT_SERVER) await checkServer(url);
      setDefaultServerForNewTeams(url);
    });
  };

  const forget = async () => {
    const known = listServers();
    if (!known.length) return;
    const idx = await showActionSheet({
      title: t('teamSync.forgetTitle'),
      message: t('teamSync.forgetMsg'),
      cancelLabel: t('common.cancel'),
      options: known.map((x) => ({ label: x.url.replace(/^https:\/\//, ''), destructive: true })),
    });
    if (!known[idx]) return;
    forgetServer(known[idx].url);
    refresh();
  };

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
        </Section>
        <Section title={t('teamSync.sectionServers')}>
          <LinkRow
            label={t('teamSync.defaultServerTitle')}
            description={servers.def.replace(/^https:\/\//, '')}
            onPress={() => void chooseDefault()}
          />
          <LinkRow
            label={t('teamSync.selfHost')}
            description={t('teamSync.selfHostDesc')}
            onPress={() => router.push('/settings/team-deploy' as Href)}
          />
          {servers.known.length ? <LinkRow label={t('teamSync.forgetTitle')} onPress={() => void forget()} /> : null}
        </Section>
        <Text className="px-4 pt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {t('teamSync.privacy', { server: DEFAULT_SERVER.replace(/^https:\/\//, '') })}
        </Text>
      </ScrollView>
    </SettingsPage>
  );
}
