/**
 * Specimen collecting — default identifier, collection-number prefix, start
 * number and zero padding.
 *
 * Moved out of the preferences root: it was the longest inline block there, and
 * `nextRecordNumber()` is recomputed on every render so the hint reflects the
 * prefix just typed — that cost belongs on this screen, not on the root page.
 */
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, View } from 'react-native';
import { LinkRow, RowInput } from '~/components/settings/rows';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { promptText } from '~/components/TextPromptModal';
import { formatRecordNumber, maxRecordNumberSeq, nextRecordNumber } from '~/db';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';

export default function CollectionSettingsScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const identifiedBy = useSettings((s) => s.default_identified_by);
  const prefix = useSettings((s) => s.collection_number_prefix);
  const pad = useSettings((s) => s.collection_number_pad);
  const setSetting = useSettings((s) => s.set);

  // Recomputed on every render so the hint reflects the prefix/start just typed.
  const nextNumberPreview = nextRecordNumber().text;

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
          {/* Default identifier: filled in automatically on a new specimen, mirroring how
              the collector is inherited from the trip. Left empty it fills in
              nothing — better a label without this line than one crediting
              someone who never determined it. */}
          <RowInput
            label={t('settings.defaultDeterminer')}
            value={identifiedBy}
            placeholder={t('settings.defaultDeterminerPlaceholder')}
            onCommit={(v) => setSetting('default_identified_by', v.trim())}
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
          <View className="bg-white dark:bg-gray-900 px-4 pb-3">
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('settings.collectionNumberDesc', { next: nextNumberPreview })}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SettingsPage>
  );
}
