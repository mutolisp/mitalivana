/**
 * A team's invitation: the QR code a teammate scans with the phone's own
 * camera (it opens checklister://team/join), and the same code as text for
 * sending or typing. Both carry the team secret: whoever has them can read
 * and write the team's data, so the screen says so.
 */
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Share, Text, View, useWindowDimensions } from 'react-native';
import { QrCode } from '~/components/QrCode';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { inviteLink } from '~/lib/teamCrypto';
import { getTeam, inviteCodeFor, serverOf } from '~/lib/teamSync';

export default function TeamInviteScreen() {
  const { t } = useTranslation();
  const { team: teamId } = useLocalSearchParams<{ team: string }>();
  const team = teamId ? getTeam(teamId) : null;
  const [code, setCode] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  useEffect(() => {
    if (teamId) void inviteCodeFor(teamId).then(setCode);
  }, [teamId]);

  if (!team) return <SettingsPage title={t('teamSync.inviteTitle')}>{null}</SettingsPage>;
  const size = Math.min(width - 64, 320);
  return (
    <SettingsPage title={t('teamSync.inviteTitle')}>
      <ScrollView contentContainerClassName="items-center gap-4 p-4 pb-10">
        <Text className="text-lg font-semibold text-gray-900 dark:text-gray-100">{team.name}</Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{serverOf(team)}</Text>
        {code ? (
          <>
            <View className="rounded-xl bg-white p-2">
              <QrCode value={inviteLink(code)} size={size} />
            </View>
            <Text className="text-center text-sm text-gray-700 dark:text-gray-300">{t('teamSync.inviteHow')}</Text>
            <Text selectable className="w-full rounded-lg bg-gray-100 p-3 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
              {code}
            </Text>
            <Pressable
              onPress={() => void Share.share({ message: code })}
              accessibilityRole="button"
              className="rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-700"
            >
              <Text className="text-sm text-gray-800 dark:text-gray-200">{t('teamSync.shareCode')}</Text>
            </Pressable>
          </>
        ) : (
          <Text className="text-sm text-red-600 dark:text-red-400">{t('teamSync.err.noSecret')}</Text>
        )}
        <Text className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t('teamSync.inviteWarn')}</Text>
      </ScrollView>
    </SettingsPage>
  );
}
