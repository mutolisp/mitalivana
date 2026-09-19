/**
 * The sheet that shows the Google device code while `googleAuth.ts` polls.
 *
 * Mounted once at the navigation root. Purely presentational: the flow itself
 * (request code → poll → store tokens) lives in `googleAuth.ts`, and this
 * shows whatever code is pending and offers a way out. Closing it flips the
 * driver's `cancel` flag, which the polling loop notices on its next tick.
 *
 * Unlike InatTokenHost there is no WebView and no hidden mode — Google refuses
 * OAuth inside an embedded browser, and the silent path (refresh token) needs
 * no UI at all, so this appears only for the first link on a device.
 *
 * Feedback for 「已複製」 is inline rather than a toast: ToastHost is an
 * absolutely-positioned View at the root, and a Modal paints above it, so a
 * toast fired from in here would be invisible.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ACTION_FILL } from '~/lib/colors';
import { useGoogleDeviceFlow } from '~/lib/googleAuth';

export function GoogleDeviceCodeHost() {
  const pending = useGoogleDeviceFlow((s) => s.pending);
  if (!pending) return null;
  return <DeviceCodeSheet />;
}

function remainingLabel(expiresAtMs: number): string {
  const left = Math.max(0, expiresAtMs - Date.now());
  const total = Math.round(left / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function DeviceCodeSheet() {
  const pending = useGoogleDeviceFlow((s) => s.pending);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(() => (pending ? remainingLabel(pending.code.expiresAtMs) : ''));

  const expiresAtMs = pending?.code.expiresAtMs;
  useEffect(() => {
    if (expiresAtMs == null) return;
    const id = setInterval(() => setLeft(remainingLabel(expiresAtMs)), 1000);
    return () => clearInterval(id);
  }, [expiresAtMs]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  if (!pending) return null;
  const { code, cancel } = pending;

  return (
    <Modal visible animationType="slide" onRequestClose={cancel}>
      <View style={{ flex: 1, paddingTop: insets.top }} className="bg-white dark:bg-gray-900">
        <View className="flex-row items-center border-b border-gray-200 px-2 py-2 dark:border-gray-800">
          <Pressable onPress={cancel} hitSlop={10} className="p-2" accessibilityLabel={t('common.cancel')}>
            <Ionicons name="close" size={24} color="#6b7280" />
          </Pressable>
          <Text className="ml-1 flex-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('gdrive.codeTitle')}
          </Text>
        </View>

        <View className="px-6 pt-6">
          <Text className="text-sm text-gray-600 dark:text-gray-300">{t('gdrive.codeHint')}</Text>

          <Text className="mt-6 text-center text-xs uppercase text-gray-500 dark:text-gray-400">
            {code.verificationUrl.replace(/^https?:\/\//, '')}
          </Text>

          <View className="mt-3 items-center rounded-xl border border-gray-200 bg-gray-50 py-5 dark:border-gray-700 dark:bg-gray-800">
            <Text
              selectable
              className="text-3xl font-bold tracking-[4px] text-gray-900 dark:text-gray-100"
            >
              {code.userCode}
            </Text>
          </View>

          <View className="mt-3 flex-row gap-2">
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(code.userCode);
                setCopied(true);
              }}
              className="flex-1 flex-row items-center justify-center rounded-lg border border-blue-500 py-2.5 active:bg-blue-50 dark:active:bg-blue-900/40"
            >
              <Ionicons name="copy-outline" size={16} color="#2563eb" />
              <Text className="ml-1.5 text-sm font-semibold text-blue-600 dark:text-blue-400">
                {t('gdrive.copyCode')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void Linking.openURL(code.verificationUrl)}
              className={`flex-1 flex-row items-center justify-center rounded-lg py-2.5 ${ACTION_FILL}`}
            >
              <Ionicons name="open-outline" size={16} color="#ffffff" />
              <Text className="ml-1.5 text-sm font-semibold text-white">
                {t('gdrive.openBrowser')}
              </Text>
            </Pressable>
          </View>

          {/* Reserves its own line so the layout does not jump when it appears. */}
          <Text className="mt-2 h-4 text-center text-xs text-green-600 dark:text-green-400">
            {copied ? t('gdrive.codeCopied') : ''}
          </Text>

          <View className="mt-8 flex-row items-center justify-center">
            <ActivityIndicator />
            <Text className="ml-2 text-sm text-gray-600 dark:text-gray-300">
              {t('gdrive.waiting')}
            </Text>
          </View>
          <Text className="mt-1 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('gdrive.codeExpiresIn', { time: left })}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
