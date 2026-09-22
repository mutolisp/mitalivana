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
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { Section } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { copyToClipboard } from '~/lib/clipboard';
import { errText } from '~/lib/errText';
import { normalizeOrcid, orcidProfileUrl, publicKeyLabel } from '~/lib/signing';
import { deleteKey, ensureKey, readPublicKey } from '~/lib/signingKey';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';

export default function ProvenanceSettingsScreen() {
  const { t } = useTranslation();
  const signEnabled = useSettings((s) => s.sign_exports);
  const storedOrcid = useSettings((s) => s.signer_orcid);
  const signerName = useSettings((s) => s.signer_name);
  const setSetting = useSettings((s) => s.set);

  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [orcidDraft, setOrcidDraft] = useState(storedOrcid);
  const [nameDraft, setNameDraft] = useState(signerName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readPublicKey().then(setPublicKey);
  }, []);
  useEffect(() => setOrcidDraft(storedOrcid), [storedOrcid]);
  useEffect(() => setNameDraft(signerName), [signerName]);

  const orcidValid = normalizeOrcid(orcidDraft) !== null;
  const ready = publicKey !== null && normalizeOrcid(storedOrcid) !== null;

  const commitOrcid = () => {
    const trimmed = orcidDraft.trim();
    if (trimmed === '') {
      setSetting('signer_orcid', '');
      return;
    }
    const canonical = normalizeOrcid(trimmed);
    if (!canonical) {
      // Rejected on the check digit, not just the shape: a typo'd ORCID does
      // not fail later, it silently attributes the data to nobody.
      Alert.alert(t('provenance.orcidBadTitle'), t('provenance.orcidBadMsg'));
      setOrcidDraft(storedOrcid);
      return;
    }
    setSetting('signer_orcid', canonical);
    setOrcidDraft(canonical);
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
          <TextInput
            value={orcidDraft}
            onChangeText={setOrcidDraft}
            onBlur={commitOrcid}
            placeholder="0000-0000-0000-0000"
            placeholderTextColor="#9ca3af"
            autoCapitalize="characters"
            autoCorrect={false}
            className={`rounded-lg border px-3 py-2 font-mono text-base text-gray-900 dark:text-gray-100 ${
              orcidDraft && !orcidValid
                ? 'border-red-400 dark:border-red-600'
                : 'border-gray-300 dark:border-gray-600'
            }`}
          />
          {orcidDraft && !orcidValid ? (
            <Text className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t('provenance.orcidBadMsg')}
            </Text>
          ) : null}

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
        {publicKey && normalizeOrcid(storedOrcid) ? (
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
    </SettingsPage>
  );
}
