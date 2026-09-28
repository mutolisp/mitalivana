/**
 * Specimen collecting — default collector and identifier, collection-number
 * prefix, start number and zero padding.
 *
 * Moved out of the preferences root: it was the longest inline block there, and
 * `nextRecordNumber()` is recomputed on every render so the hint reflects the
 * prefix just typed — that cost belongs on this screen, not on the root page.
 */
import { useTranslation } from 'react-i18next';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { LinkRow, RowInput } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { promptText } from '~/components/TextPromptModal';
import { formatRecordNumber, getDefaultNames, maxRecordNumberSeq, nextRecordNumber } from '~/db';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';

export default function CollectionSettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const prefix = useSettings((s) => s.collection_number_prefix);
  const pad = useSettings((s) => s.collection_number_pad);
  const setSetting = useSettings((s) => s.set);

  // Recomputed on every render so the hint reflects the prefix/start just typed.
  const nextNumberPreview = nextRecordNumber().text;

  // Both defaults live in their own tables, edited on their own screens, so they
  // are re-read on focus rather than held in the settings store.
  const [defaults, setDefaults] = useState<{ collector: string; determiner: string }>({
    collector: '',
    determiner: '',
  });
  useFocusEffect(
    useCallback(() => {
      setDefaults({
        collector: getDefaultNames('surveyor').join(', '),
        determiner: getDefaultNames('identifier').join(', '),
      });
    }, []),
  );

  /**
   * Force the next collection number.
   *
   * Underneath this is still collection_number_start (nextRecordNumber takes
   * max(highest number in the database + 1, start)), so it can only jump
   * forward, never back. A value no greater than the current maximum has no
   * effect once set — and that case has to be stated, not swallowed silently.
   */
  const handleSetNextNumber = async () => {
    const maxSeq = maxRecordNumberSeq();
    const current = nextRecordNumber();
    const input = await promptText({
      title: t('settings.setNextNumberTitle'),
      message:
        maxSeq > 0
          ? t('settings.setNextNumberMsg', { max: formatRecordNumber(maxSeq), next: current.text })
          : t('settings.setNextNumberMsgEmpty', { next: current.text }),
      keyboardType: 'numeric',
      defaultValue: String(current.seq),
    });
    if (input == null) return;

    const seq = Math.floor(Number(input.trim()));
    if (!Number.isFinite(seq) || seq < 1) {
      toast(t('settings.setNextNumberInvalid'));
      return;
    }
    if (seq <= maxSeq) {
      // Collection numbers only move forward: the database already holds a higher
      // one, so setting this would have no effect.
      Alert.alert(
        t('settings.setNextNumberTooLowTitle'),
        t('settings.setNextNumberTooLowMsg', {
          value: formatRecordNumber(seq),
          max: formatRecordNumber(maxSeq),
          next: formatRecordNumber(maxSeq + 1),
        }),
        [{ text: t('common.ok') }],
      );
      return;
    }

    Alert.alert(
      t('settings.setNextNumberConfirmTitle'),
      t('settings.setNextNumberConfirmMsg', { value: formatRecordNumber(seq) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.confirm'),
          onPress: () => {
            setSetting('collection_number_start', seq);
            toast(t('settings.setNextNumberDone', { value: formatRecordNumber(seq) }));
          },
        },
      ],
    );
  };

  return (
    <SettingsPage>
      <ScrollView>
        <View className="mt-6">
          {/* Both rows show the starred names and open the list they come from.
              The collector's list is the surveyors — a specimen IS a record of
              who was there — while the determiner has its own, because whoever
              named the specimen is often not whoever collected it.

              Neither default is required. Left unstarred nothing is filled in,
              which is better than a label crediting someone who was not
              involved. */}
          <LinkRow
            label={t('settings.defaultCollector')}
            description={t('settings.defaultCollectorDesc')}
            value={defaults.collector || t('settings.noDefaultPerson')}
            onPress={() => router.push('/surveyors' as Href)}
          />
          <LinkRow
            label={t('settings.defaultDeterminer')}
            description={t('settings.defaultDeterminerDesc')}
            value={defaults.determiner || t('settings.noDefaultPerson')}
            onPress={() => router.push('/identifiers' as Href)}
          />
          <RowInput
            label={t('collection.numberPrefix')}
            value={prefix}
            placeholder={t('settings.numberPrefixPlaceholder')}
            autoCapitalize="characters"
            onCommit={(v) => setSetting('collection_number_prefix', v.trim())}
          />
          {/* Replaces the old start-number field that wrote silently on blur: changing
              the number affects physical specimen labels, so the user has to see
              the current state and confirm. Same setting underneath. */}
          <LinkRow
            label={t('collection.numberStart')}
            value={nextNumberPreview}
            onPress={handleSetNextNumber}
          />
          <RowInput
            label={t('collection.numberPad')}
            value={String(pad)}
            placeholder="4"
            keyboardType="number-pad"
            onCommit={(v) => {
              // 0 = no padding; the cap of 10 stops a typo producing an absurdly long number.
              const n = Math.floor(Number(v));
              const clamped = Number.isFinite(n) ? Math.min(Math.max(n, 0), 10) : 4;
              setSetting('collection_number_pad', clamped);
            }}
          />
          <View className="bg-card dark:bg-gray-900 px-4 pb-3">
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('settings.collectionNumberDesc', { next: nextNumberPreview })}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SettingsPage>
  );
}
