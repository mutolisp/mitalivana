/**
 * 「用我自己的 Cloudflare」: deploy the sync relay to the user's own Cloudflare
 * account from the phone (src/lib/syncDeploy.ts; Worker source embedded as
 * src/lib/syncWorkerSource.ts).
 *
 * The Cloudflare API token is powerful. It is asked for at the moment of use,
 * kept only in this function's variables, and never stored or backed up; a
 * later update or removal asks for it again. The Worker's own admin token
 * (for per-team limits) is kept in the Keychain / Keystore.
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { promptText } from '~/components/TextPromptModal';
import { errText } from '~/lib/errText';
import {
  DEFAULT_SCRIPT,
  DeployError,
  deploySyncServer,
  isAccountId,
  isServerName,
  listAccounts,
  NO_SUBDOMAIN,
  PUBLIC_HOST,
  PUBLIC_SERVER,
  removeSyncServer,
  SELF_HOST_SCRIPT,
  SELF_HOST_VARS,
  serverNameOf,
  tokenTemplateUrl,
  type CfAccount,
  type DeployStep,
} from '~/lib/syncDeploy';
import { SYNC_WORKER_MODULES } from '~/lib/syncWorkerSource';
import { createTeam, listServers, randomHex, rememberServer, setDefaultServerForNewTeams } from '~/lib/teamSync';
import { teamSyncErrorText } from '~/lib/teamSyncText';
import { saveAdminToken } from '~/lib/teamSyncAdmin';
import { defaultSurveyorString } from '~/db/surveyors';
import { useThemeColors } from '~/theme/colors';
import { LinkChevron } from '~/components/ui/Chevron';

const STEPS: DeployStep[] = ['url', 'guard', 'bucket', 'lifecycle', 'script', 'subdomain', 'schedule', 'check'];

/** The name this phone deployed under last time (its workers.dev URL), else the default. */
function lastServerName(): string {
  for (const s of listServers()) {
    const n = s.is_own ? serverNameOf(s.url) : null;
    if (n) return n;
  }
  return DEFAULT_SCRIPT;
}

export default function TeamDeployScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const [step, setStep] = useState<DeployStep | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Worker name = bucket name. In the account that runs the public server,
  // the default name is taken by it, so the deploy offers SELF_HOST_SCRIPT.
  const [serverName, setServerName] = useState(lastServerName);

  const askToken = () =>
    promptText({
      title: t('teamDeploy.tokenTitle'),
      message: t('teamDeploy.tokenMsg'),
      placeholder: 'Cloudflare API token',
      secureTextEntry: true,
      autoCapitalize: 'none',
    });

  /** Asked when the token cannot list its accounts (an account API token may not be allowed to). */
  const askAccountId = async (): Promise<CfAccount | null> => {
    // The token prompt (a Modal) closed just now; wait for its exit.
    await new Promise((r) => setTimeout(r, 450));
    const id = await promptText({
      title: t('teamDeploy.accountIdTitle'),
      message: t('teamDeploy.accountIdMsg'),
      placeholder: 'Account ID',
      autoCapitalize: 'none',
    });
    if (!id) return null;
    if (!isAccountId(id)) throw new Error(t('teamDeploy.accountIdBad'));
    return { id: id.trim(), name: id.trim() };
  };

  /** Token → the account to use (asks when there are several). */
  const pickAccount = async (token: string) => {
    let accounts: CfAccount[];
    try {
      accounts = await listAccounts({ token, fetchImpl: (u, i) => fetch(u, i) });
    } catch (e) {
      // A refused listing is not a bad token by itself: the later steps tell.
      if (e instanceof DeployError && (e.status === 401 || e.status === 403)) return askAccountId();
      throw e;
    }
    if (accounts.length === 0) return askAccountId();
    if (accounts.length === 1) return accounts[0];
    // The token prompt (a Modal) closed just now; a native sheet presented
    // during its exit animation is dismissed with it on iOS.
    await new Promise((r) => setTimeout(r, 450));
    const idx = await showActionSheet({
      title: t('teamDeploy.pickAccount'),
      cancelLabel: t('common.cancel'),
      options: accounts.map((a) => ({ label: a.name, icon: 'cloud-outline' as const, description: a.id })),
    });
    return accounts[idx] ?? null;
  };

  /** Yes / no before switching away from the public server's Worker name. */
  const confirmAltName = () =>
    new Promise<boolean>((resolve) =>
      Alert.alert(t('teamDeploy.publicTitle'), t('teamDeploy.publicUseAlt', { host: PUBLIC_HOST, name: SELF_HOST_SCRIPT }), [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        // No name on the button: Android capitalises dialog buttons; the message names it.
        { text: t('teamDeploy.publicUseAltGo'), onPress: () => resolve(true) },
      ]),
    );

  const deploy = async () => {
    const wanted = serverName.trim();
    if (!isServerName(wanted)) {
      Alert.alert(t('teamDeploy.nameBadTitle'), t('teamDeploy.nameBad'));
      return;
    }
    const token = await askToken();
    if (!token) return;
    setBusy(true);
    setFailed(null);
    setDone(null);
    let used = wanted;
    try {
      const account = await pickAccount(token.trim());
      if (!account) return;
      const run = (script: string) =>
        deploySyncServer({
          token: token.trim(),
          accountId: account.id,
          modules: SYNC_WORKER_MODULES,
          fetchImpl: (u, i) => fetch(u, i),
          randomHex,
          script,
          // Your own server: only your own bill limits it (SELF_HOST_VARS).
          vars: SELF_HOST_VARS,
          selfHost: true,
          onStep: setStep,
        });
      let res;
      try {
        res = await run(wanted);
      } catch (e) {
        // The public server's account: nothing was created; offer the other name.
        if (!(e instanceof DeployError && e.detail === PUBLIC_SERVER && wanted === DEFAULT_SCRIPT)) throw e;
        setStep(null);
        if (!(await confirmAltName())) return;
        used = SELF_HOST_SCRIPT;
        setServerName(used);
        res = await run(used);
      }
      await saveAdminToken(res.url, res.adminToken);
      rememberServer(res.url, true);
      setDone(res.url);
      Alert.alert(t('teamDeploy.makeDefaultTitle'), t('teamDeploy.makeDefaultMsg'), [
        { text: t('teamDeploy.makeDefaultNo'), style: 'cancel' },
        { text: t('teamDeploy.makeDefaultYes'), onPress: () => setDefaultServerForNewTeams(res.url) },
      ]);
    } catch (e) {
      setFailed(
        e instanceof DeployError
          ? e.detail === NO_SUBDOMAIN
            ? t('teamDeploy.noSubdomain')
            : e.detail === PUBLIC_SERVER
              ? t('teamDeploy.publicRefused', { host: PUBLIC_HOST, name: used })
              : t('teamDeploy.failStep', { step: t(`teamDeploy.step.${e.step}`), detail: e.detail ?? e.status })
          : errText(e),
      );
    } finally {
      setStep(null);
      setBusy(false);
    }
  };

  const remove = async () => {
    const script = serverName.trim();
    if (!isServerName(script)) {
      Alert.alert(t('teamDeploy.nameBadTitle'), t('teamDeploy.nameBad'));
      return;
    }
    const token = await askToken();
    if (!token) return;
    setBusy(true);
    try {
      const account = await pickAccount(token.trim());
      if (!account) return;
      const r = await removeSyncServer({ token: token.trim(), accountId: account.id, fetchImpl: (u, i) => fetch(u, i), script });
      Alert.alert(t('teamDeploy.removedTitle'), r.bucketDeleted ? t('teamDeploy.removed') : t('teamDeploy.removedKeepBucket'));
    } catch (e) {
      Alert.alert(
        t('teamSync.failTitle'),
        e instanceof DeployError
          ? e.detail === PUBLIC_SERVER
            ? t('teamDeploy.publicRemoveRefused', { host: PUBLIC_HOST, name: script })
            : `${t(`teamDeploy.step.${e.step}`)}：${e.detail ?? e.status}`
          : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const createHere = async () => {
    if (!done) return;
    const name = await promptText({ title: t('teamSync.createTitle'), message: t('teamSync.createMsg'), placeholder: t('teamSync.namePlaceholder') });
    if (!name?.trim()) return;
    const me = await promptText({
      title: t('teamSync.myNameTitle'),
      message: t('teamSync.myNameMsg'),
      defaultValue: defaultSurveyorString() ?? '',
      placeholder: t('teamSync.myNamePlaceholder'),
    });
    if (me === null) return;
    try {
      const teamId = await createTeam(name.trim(), done, me);
      router.replace(`/settings/team-invite?team=${teamId}` as Href);
    } catch (e) {
      Alert.alert(t('teamSync.failTitle'), teamSyncErrorText(e));
    }
  };

  const stepIndex = step ? STEPS.indexOf(step) : -1;
  return (
    <SettingsPage title={t('teamDeploy.title')}>
      <ScrollView contentContainerClassName="gap-4 p-4 pb-10" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Text className="text-sm leading-6 text-gray-700 dark:text-gray-300">{t('teamDeploy.intro')}</Text>
        <View className="gap-1 rounded-xl border border-gray-200 bg-card p-3 dark:border-gray-800 dark:bg-gray-900">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('teamDeploy.permsTitle')}</Text>
          {['Workers Scripts：Edit', 'Workers R2 Storage：Edit', 'Account Settings：Read'].map((p) => (
            <Text key={p} selectable className="font-mono text-xs text-gray-700 dark:text-gray-300">
              · {p}
            </Text>
          ))}
          <Text className="pt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamDeploy.permsNote')}</Text>
          <Pressable onPress={() => void Linking.openURL(tokenTemplateUrl('account'))} accessibilityRole="link" className="flex-row items-center pt-1">
            <Text className="mr-0.5 text-sm font-semibold text-accent-600 dark:text-accent-400">{t('teamDeploy.openAccountTokens')}</Text>
            <LinkChevron />
          </Pressable>
          <Pressable onPress={() => void Linking.openURL(tokenTemplateUrl('user'))} accessibilityRole="link" className="flex-row items-center">
            <Text className="mr-0.5 text-sm font-semibold text-accent-600 dark:text-accent-400">{t('teamDeploy.openUserTokens')}</Text>
            <LinkChevron />
          </Pressable>
        </View>

        <View className="gap-1 rounded-xl border border-gray-200 bg-card p-3 dark:border-gray-800 dark:bg-gray-900">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('teamDeploy.nameLabel')}</Text>
          <TextInput
            value={serverName}
            onChangeText={(v) => setServerName(v.toLowerCase())}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={DEFAULT_SCRIPT}
            placeholderTextColor={c.ink3}
            accessibilityLabel={t('teamDeploy.nameLabel')}
            className="rounded-md border border-gray-300 bg-card px-2 py-1.5 font-mono text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">
            {t('teamDeploy.nameHint', { host: PUBLIC_HOST, alt: SELF_HOST_SCRIPT })}
          </Text>
        </View>

        {busy && step ? (
          <View className="gap-1.5">
            {STEPS.map((s, i) => (
              <View key={s} className="flex-row items-center gap-2">
                {i < stepIndex ? (
                  <Text className="w-5 text-center text-emerald-600">✓</Text>
                ) : i === stepIndex ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="w-5 text-center text-gray-400">·</Text>
                )}
                <Text className={`text-sm ${i <= stepIndex ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>{t(`teamDeploy.step.${s}`)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {failed ? <Text className="text-sm text-red-600 dark:text-red-400">{failed}</Text> : null}
        {done ? (
          <View className="gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/40">
            <Text className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">{t('teamDeploy.doneTitle')}</Text>
            <Text selectable className="font-mono text-xs text-gray-800 dark:text-gray-200">
              {done}
            </Text>
            <Pressable onPress={() => void createHere()} accessibilityRole="button" className="items-center rounded-lg bg-accent-600 py-2 active:bg-accent-700">
              <Text className="text-sm font-semibold text-white">{t('teamDeploy.createTeamHere')}</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable
          onPress={() => void deploy()}
          disabled={busy}
          accessibilityRole="button"
          className={`items-center rounded-xl py-3 ${busy ? 'bg-gray-400' : 'bg-accent-600 active:bg-accent-700'}`}
        >
          <Text className="text-base font-semibold text-white">{t('teamDeploy.deploy')}</Text>
        </Pressable>
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamDeploy.tokenPolicy')}</Text>
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamDeploy.billingNote')}</Text>
        <Pressable onPress={() => void remove()} disabled={busy} accessibilityRole="button" className="items-center py-2">
          <Text className="text-sm text-red-600 dark:text-red-400">{t('teamDeploy.remove')}</Text>
        </Pressable>
      </ScrollView>
    </SettingsPage>
  );
}

