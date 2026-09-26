/**
 * Joining a team: opened by the system camera scanning an invitation
 * (checklister://team/join?c=…) or from 「加入隊伍」 with a typed code. Shows
 * what is being joined and asks before contacting the server.
 */
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { DEFAULT_SERVER, getTeam, joinTeam, parseInvite, pullTeamRecords } from '~/lib/teamSync';
import { deriveTeamKeys } from '~/lib/teamCrypto';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { defaultSurveyorString } from '~/db/surveyors';

export default function TeamJoinScreen() {
  const { t } = useTranslation();
  const { c } = useLocalSearchParams<{ c?: string }>();
  const [busy, setBusy] = useState(false);
  const inv = useMemo(() => (c ? parseInvite(c) : 'format'), [c]);
  // How teammates will see this device's uploads; starts from the default surveyor.
  const [myName, setMyName] = useState(() => defaultSurveyorString() ?? '');

  if (typeof inv === 'string') {
    return (
      <SettingsPage title={t('teamSync.joinTitle')}>
        <Text className="p-4 text-sm text-red-600 dark:text-red-400">{t(`teamSync.invite.${inv}`)}</Text>
      </SettingsPage>
    );
  }
  const already = getTeam(deriveTeamKeys(inv.secret).teamId);

  const join = async () => {
    setBusy(true);
    try {
      const teamId = await joinTeam(inv, myName);
      Alert.alert(t('teamSync.joinedTitle'), t('teamSync.joinedMsg', { name: inv.name }), [
        { text: t('teamSync.later'), style: 'cancel', onPress: () => router.replace('/settings/team-sync' as Href) },
        {
          text: t('teamSync.pull'),
          onPress: () =>
            void pullTeamRecords(teamId)
              .then((r) => Alert.alert(t('teamSync.pullDoneTitle'), t('teamSync.pullDone', { imported: r.imported, linked: r.linked })))
              .catch((e) => Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e)))
              .finally(() => router.replace('/settings/team-sync' as Href)),
        },
      ]);
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title={t('teamSync.joinTitle')}>
      <View className="gap-3 p-4">
        <Text className="text-lg font-semibold text-gray-900 dark:text-gray-100">{inv.name}</Text>
        <Text className="text-sm text-gray-600 dark:text-gray-300">
          {t('teamSync.joinServer', { server: inv.server ?? DEFAULT_SERVER })}
        </Text>
        {inv.server ? <Text className="text-xs text-amber-700 dark:text-amber-400">{t('teamSync.customServerNote')}</Text> : null}
        {already ? (
          <Text className={`text-xs ${(already.server ?? null) !== (inv.server ?? null) ? 'text-[#00797b] dark:text-cyan-300' : 'text-gray-500'}`}>
            {(already.server ?? null) !== (inv.server ?? null) ? t('teamSync.movedJoin') : t('teamSync.alreadyMember')}
          </Text>
        ) : null}
        <View className="gap-1">
          <Text className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('teamSync.myNameTitle')}</Text>
          <TextInput
            value={myName}
            onChangeText={setMyName}
            placeholder={t('teamSync.myNamePlaceholder')}
            placeholderTextColor="#9ca3af"
            maxLength={60}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          <Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamSync.myNameMsg')}</Text>
        </View>
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamSync.joinExplain')}</Text>
        <Pressable
          onPress={() => void join()}
          disabled={busy}
          accessibilityRole="button"
          className={`items-center rounded-xl py-3 ${busy ? 'bg-gray-400' : 'bg-[#00A2A5] active:bg-[#008284]'}`}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text className="text-base font-semibold text-white">{t('teamSync.join')}</Text>}
        </Pressable>
      </View>
    </SettingsPage>
  );
}
