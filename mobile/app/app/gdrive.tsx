/**
 * Google Drive — link / unlink the Drive account used for backups.
 *
 * It runs the device flow (GoogleDeviceCodeHost shows the code); after
 * that the refresh token renews silently and this screen only reports which
 * account is linked. Uploading and restoring live on the backup screen, not
 * here — there is one place to restore from, and this is not it.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { apiErrorMessage } from '~/lib/apiErrorMessage';
import { ACTION_FILL } from '~/lib/colors';
import {
  GoogleAuthCancelled,
  GoogleCodeExpired,
  GoogleNotConfigured,
  getGoogleStatus,
  isGoogleConfigured,
  linkGoogleDrive,
  unlinkGoogleDrive,
  type GoogleStatus,
} from '~/lib/googleAuth';
import { useToast } from '~/stores/toast';

export default function GoogleDriveScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = isGoogleConfigured();

  const reload = useCallback(() => {
    void getGoogleStatus().then(setStatus);
  }, []);

  useFocusEffect(reload);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      // Cancelling is a decision, not a failure — say nothing.
      if (e instanceof GoogleAuthCancelled) return;
      if (e instanceof GoogleCodeExpired) toast(t('gdrive.codeExpired'));
      else if (e instanceof GoogleNotConfigured) toast(t('gdrive.notConfigured'));
      else toast(t('gdrive.linkFailed', { msg: await apiErrorMessage(e) }));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const handleConnect = () =>
    run(async () => {
      if ((await linkGoogleDrive()) === 'ok') toast(t('gdrive.linked'));
    });

  const handleDisconnect = () => {
    Alert.alert(t('gdrive.disconnectConfirmTitle'), t('gdrive.disconnectConfirmMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('gdrive.disconnect'),
        style: 'destructive',
        onPress: () =>
          run(async () => {
            await unlinkGoogleDrive();
            toast(t('gdrive.disconnected'));
          }),
      },
    ]);
  };

  return (
    <SettingsPage>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gdrive.intro')}</Text>

        <View className="mt-4 rounded-xl bg-card px-4 py-3 dark:bg-gray-900">
          {!configured ? (
            // A build without the OAuth client would show a button that does
            // nothing; say what is actually wrong instead.
            <>
              <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('gdrive.notConfigured')}
              </Text>
              <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('gdrive.notConfiguredHint')}
              </Text>
            </>
          ) : status ? (
            <>
              <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {status.account
                  ? t('gdrive.connectedAs', { email: status.account })
                  : t('gdrive.connected')}
              </Text>
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  onPress={handleDisconnect}
                  disabled={busy}
                  className="flex-1 items-center rounded-lg border border-red-400 py-2 active:bg-red-50 dark:active:bg-red-900/30"
                >
                  <Text className="text-sm font-semibold text-red-600 dark:text-red-400">
                    {t('gdrive.disconnect')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('gdrive.notConnected')}
              </Text>
              <Pressable
                onPress={handleConnect}
                disabled={busy}
                className={`mt-3 items-center rounded-xl py-3 ${ACTION_FILL}`}
              >
                <Text className="text-base font-semibold text-white">{t('gdrive.connect')}</Text>
              </Pressable>
            </>
          )}
        </View>

        <Text className="mt-3 px-1 text-xs text-gray-500 dark:text-gray-400">
          {t('gdrive.scopeNote')}
        </Text>
      </ScrollView>
    </SettingsPage>
  );
}
