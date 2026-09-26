/**
 * Adding a relay by link (checklister://team/server?url=…), printed as a QR
 * code by mobile/sync-worker/scripts/deploy.mjs after deploying from a
 * computer — so the Worker URL is never typed by hand. Checks that it is a
 * compatible relay, remembers it, and offers it as the server for new teams.
 */
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { isHttpsUrl } from '~/lib/teamCrypto';
import { checkServer, rememberServer, setDefaultServerForNewTeams } from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';

export default function TeamServerScreen() {
  const { t } = useTranslation();
  const { url: raw } = useLocalSearchParams<{ url?: string }>();
  const url = (raw ?? '').trim().replace(/\/+$/, '');
  const [busy, setBusy] = useState(false);

  if (!isHttpsUrl(url)) {
    return (
      <SettingsPage title={t('teamSync.addServerTitle')}>
        <Text className="p-4 text-sm text-red-600 dark:text-red-400">{t('teamSync.err.server')}</Text>
      </SettingsPage>
    );
  }

  const add = async (makeDefault: boolean) => {
    setBusy(true);
    try {
      await checkServer(url);
      rememberServer(url, true);
      if (makeDefault) setDefaultServerForNewTeams(url);
      router.replace('/settings/team-sync' as Href);
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title={t('teamSync.addServerTitle')}>
      <View className="gap-3 p-4">
        <Text selectable className="font-mono text-sm text-gray-900 dark:text-gray-100">
          {url}
        </Text>
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamSync.addServerMsg')}</Text>
        {busy ? (
          <ActivityIndicator />
        ) : (
          <>
            <Pressable
              onPress={() => void add(true)}
              accessibilityRole="button"
              className="items-center rounded-xl bg-[#00A2A5] py-3 active:bg-[#008284]"
            >
              <Text className="text-base font-semibold text-white">{t('teamSync.addServerDefault')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void add(false)}
              accessibilityRole="button"
              className="items-center rounded-xl border border-gray-300 py-3 dark:border-gray-700"
            >
              <Text className="text-base text-gray-800 dark:text-gray-200">{t('teamSync.addServerOnly')}</Text>
            </Pressable>
          </>
        )}
      </View>
    </SettingsPage>
  );
}
