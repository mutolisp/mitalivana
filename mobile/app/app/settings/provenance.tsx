/**
 * Provenance signing: the ORCID this device signs as, and the public key to
 * publish alongside it.
 *
 * The app deliberately does NOT write to the researcher's ORCID profile. Doing
 * so needs the ORCID member API and an institutional agreement, and it would
 * mean holding a token that can edit their record. Showing the one line to
 * paste is the whole integration, and it keeps the trust chain something the
 * researcher performed themselves rather than something an app did on their
 * behalf.
 *
 * Order on screen follows the order the steps have to happen in — key, ORCID,
 * publish, then the switch — because the switch is the only one that does
 * nothing on its own.
 *
 * The ORCID is set by signing in to ORCID (OrcidSignInModal), not typed: a
 * typed iD proved only that someone knew the number. Sign-in reads who the
 * user is and nothing else — it still never writes to the profile.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';
import { Alert, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { OrcidSignInModal, type OrcidSignInResult } from '~/components/OrcidSignInModal';
import { Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { copyToClipboard } from '~/lib/clipboard';
import { errText } from '~/lib/errText';
import { isoDateTime } from '~/lib/datetime';
import { ORCID_PRODUCTION } from '~/lib/orcidAuth';
import { normalizeOrcid, orcidProfileUrl, publicKeyLabel } from '~/lib/signing';
import { deleteKey, ensureKey, readPublicKey } from '~/lib/signingKey';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';

/** The ORCID Public API client, from `extra.orcid` (app.config.ts). Empty
 *  client id or redirect URI = not configured on this build. */
function orcidConfig(): { base: string; clientId: string; redirectUri: string } | null {
  const extra = Constants.expoConfig?.extra as
    | { orcid?: { base?: string; clientId?: string; redirectUri?: string } }
    | undefined;
  const o = extra?.orcid ?? {};
  if (!o.clientId || !o.redirectUri) return null;
  return { base: (o.base || ORCID_PRODUCTION).replace(/\/+$/, ''), clientId: o.clientId, redirectUri: o.redirectUri };
}

export default function ProvenanceSettingsScreen() {
  const { t } = useTranslation();
  const signEnabled = useSettings((s) => s.sign_exports);
  const storedOrcid = useSettings((s) => s.signer_orcid);
  const authAt = useSettings((s) => s.signer_orcid_auth_at);
  const signerName = useSettings((s) => s.signer_name);
  const setSetting = useSettings((s) => s.set);

  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(signerName);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const config = orcidConfig();

  useEffect(() => {
    void readPublicKey().then(setPublicKey);
  }, []);
  useEffect(() => setNameDraft(signerName), [signerName]);

  const verified = normalizeOrcid(storedOrcid) !== null && authAt > 0;
  // An iD left over from typing it in (before sign-in existed): shown so the
  // user knows why signing stopped, never used to sign.
  const unverifiedLegacy = normalizeOrcid(storedOrcid) !== null && authAt === 0;
  const ready = publicKey !== null && verified;

  const onSignInDone = (r: OrcidSignInResult) => {
    setSigningIn(false);
    if (r.kind === 'ok') {
      setSetting('signer_orcid', r.identity.orcid);
      setSetting('signer_orcid_auth_at', Date.now());
      // Prefill the display name from ORCID, but never overwrite one the user
      // chose (it is display-only).
      if (!signerName.trim() && r.identity.name) setSetting('signer_name', r.identity.name);
      useToast.getState().show(t('provenance.orcidSignedIn', { orcid: r.identity.orcid }));
    } else if (r.kind === 'denied') {
      Alert.alert(t('provenance.orcidSignInTitle'), t('provenance.orcidDenied'));
    } else if (r.kind === 'failed') {
      Alert.alert(t('provenance.orcidSignInTitle'), t('provenance.orcidFailed'));
    }
  };

  const signOut = () => {
    Alert.alert(t('provenance.orcidSignOutTitle'), t('provenance.orcidSignOutMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('provenance.orcidSignOut'),
        style: 'destructive',
        onPress: () => {
          setSetting('signer_orcid', '');
          setSetting('signer_orcid_auth_at', 0);
          setSetting('sign_exports', false);
        },
      },
    ]);
  };

  const makeKey = async () => {
    setBusy(true);
    try {
      setPublicKey(await ensureKey());
      useToast.getState().show(t('provenance.keyCreated'));
    } catch (e) {
      Alert.alert(t('provenance.keyFailTitle'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteKey = () => {
    Alert.alert(t('provenance.deleteTitle'), t('provenance.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('provenance.deleteConfirm'),
        style: 'destructive',
        onPress: async () => {
          await deleteKey();
          setPublicKey(null);
          setSetting('sign_exports', false);
          useToast.getState().show(t('provenance.keyDeleted'));
        },
      },
    ]);
  };

  return (
    <SettingsPage>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <Text className="text-sm text-gray-600 dark:text-gray-400">
          {t('provenance.intro')}
        </Text>

        {/* ── 1. the key ─────────────────────────────────────────────── */}
        <Section title={t('provenance.keySection')}>
          {publicKey ? (
            <View className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
              <Text selectable className="font-mono text-xs text-gray-900 dark:text-gray-100">
                {publicKeyLabel(publicKey)}
              </Text>
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  className="rounded-lg bg-blue-600 px-3 py-2"
                  onPress={() => void copyToClipboard(publicKeyLabel(publicKey), t('provenance.keyLabel'))}
                >
                  <Text className="text-sm font-medium text-white">{t('provenance.copyKey')}</Text>
                </Pressable>
                <Pressable className="rounded-lg border border-red-300 dark:border-red-700 px-3 py-2" onPress={confirmDeleteKey}>
                  <Text className="text-sm font-medium text-red-600 dark:text-red-400">
                    {t('provenance.deleteKey')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              disabled={busy}
              className={`rounded-lg px-4 py-3 ${busy ? 'bg-gray-400' : 'bg-blue-600'}`}
              onPress={makeKey}
            >
              <Text className="text-center text-sm font-medium text-white">
                {t('provenance.createKey')}
              </Text>
            </Pressable>
          )}
          <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('provenance.keyHint')}
          </Text>
        </Section>

        {/* ── 2. who it signs as ─────────────────────────────────────── */}
        <Section title={t('provenance.identitySection')}>
          <Text className="mb-1 text-xs text-gray-500 dark:text-gray-400">ORCID iD</Text>
          {verified ? (
            <View className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
              <Text selectable className="font-mono text-base text-gray-900 dark:text-gray-100">
                {storedOrcid}
              </Text>
              <Text className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                {t('provenance.orcidVerifiedAt', { when: isoDateTime(authAt) })}
              </Text>
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  disabled={!config}
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600"
                  onPress={() => setSigningIn(true)}
                >
                  <Text className="text-sm font-medium text-blue-600 dark:text-blue-400">
                    {t('provenance.orcidSignInAgain')}
                  </Text>
                </Pressable>
                <Pressable
                  className="rounded-lg border border-red-300 px-3 py-2 dark:border-red-700"
                  onPress={signOut}
                >
                  <Text className="text-sm font-medium text-red-600 dark:text-red-400">
                    {t('provenance.orcidSignOut')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              {unverifiedLegacy ? (
                <Text className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('provenance.orcidLegacy', { orcid: storedOrcid })}
                </Text>
              ) : null}
              <Pressable
                disabled={!config}
                className={`rounded-lg px-4 py-3 ${config ? 'bg-[#A6CE39]' : 'bg-gray-300 dark:bg-gray-700'}`}
                onPress={() => setSigningIn(true)}
              >
                <Text className="text-center text-sm font-semibold text-white">
                  {t('provenance.orcidSignIn')}
                </Text>
              </Pressable>
              <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {config ? t('provenance.orcidSignInHint') : t('provenance.orcidNotConfigured')}
              </Text>
            </>
          )}

          <Text className="mb-1 mt-4 text-xs text-gray-500 dark:text-gray-400">
            {t('provenance.nameLabel')}
          </Text>
          <TextInput
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={() => setSetting('signer_name', nameDraft.trim())}
            placeholder={t('provenance.namePlaceholder')}
            placeholderTextColor="#9ca3af"
            autoCorrect={false}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-base text-gray-900 dark:text-gray-100"
          />
        </Section>

        {/* ── 3. publish it ──────────────────────────────────────────── */}
        {publicKey && verified ? (
          <Section title={t('provenance.publishSection')}>
            <Text className="text-sm text-gray-600 dark:text-gray-400">
              {t('provenance.publishHint')}
            </Text>
            <Pressable
              className="mt-3 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-3"
              onPress={() => void Linking.openURL(`${orcidProfileUrl(storedOrcid)}`)}
            >
              <Text className="text-center text-sm font-medium text-blue-600 dark:text-blue-400">
                {t('provenance.openProfile')}
              </Text>
            </Pressable>
          </Section>
        ) : null}

        {/* ── 4. the switch, last, because it needs the three above ──── */}
        <Section title={t('provenance.signSection')}>
          <View className="flex-row items-center justify-between py-2">
            <View className="flex-1 pr-3">
              <Text className="text-base text-gray-900 dark:text-gray-100">
                {t('provenance.signToggle')}
              </Text>
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {ready ? t('provenance.signHint') : t('provenance.signBlocked')}
              </Text>
            </View>
            <Switch
              value={signEnabled && ready}
              disabled={!ready}
              onValueChange={(v) => setSetting('sign_exports', v)}
            />
          </View>
        </Section>

        <Text className="mt-6 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {t('provenance.caveat')}
        </Text>
      </ScrollView>
      {signingIn && config ? <OrcidSignInModal config={config} onDone={onSignInDone} /> : null}
    </SettingsPage>
  );
}
