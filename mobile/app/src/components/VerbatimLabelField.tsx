/**
 * The verbatim field determination — `sp1` / `sp2` under the family or genus
 * the identification actually reached (DwC `verbatimIdentification`).
 *
 * Shown only where the identification stopped ABOVE species: on a record
 * already determined to species, subspecies, variety or form there is nothing
 * left for a morphospecies label to say. An existing label stays reachable
 * whatever the rank, so a record tagged `sp1` and later re-identified to a real
 * species does not keep a label the user can no longer see or clear while it
 * still goes out in the export.
 *
 * Inline, NOT `promptText`. All three call sites sit inside an RN `<Modal>`,
 * and `TextPromptHost` is another `<Modal>` at the navigation root — iOS
 * refuses to present one on top of the other ("... which is already presenting
 * <RCTFabricModalHostViewController>") and the app dies. Same constraint
 * RecordLocationMap's coordinate entry documents.
 *
 * Holds its own open/draft state, so callers remount it per record with
 * `key={record.id}` instead of threading a reset through.
 *
 * `onCommit` says nothing about when the value reaches the database: the
 * session and specimen sheets write immediately, the plot modal folds it into
 * the draft its own Save button persists. Hence the confirm button reads "OK"
 * rather than "Save".
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, TextInput, View } from 'react-native';
import { isSpeciesLevelRank } from '~/lib/dataQuality';

type Props = {
  /** The taxon's rank, in either English (TaiCOL) or Chinese (YList) — the
   *  predicate normalises. */
  rank: string | null | undefined;
  value: string | null;
  onCommit: (next: string | null) => void;
};

export function VerbatimLabelField({ rank, value, onCommit }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  if (isSpeciesLevelRank(rank) && value == null) return null;

  const submit = () => {
    setOpen(false);
    onCommit(text.trim() || null);
  };

  return (
    <>
      <Pressable
        onPress={() => {
          setText(value ?? '');
          setOpen(true);
        }}
        hitSlop={6}
        className="mt-1 flex-row items-center self-start active:opacity-70"
      >
        <Ionicons name="pricetag-outline" size={13} color="#6b7280" />
        <Text className="ml-1 text-xs text-gray-600 dark:text-gray-400">
          {value || t('species.verbatimAdd')}
        </Text>
      </Pressable>
      {open ? (
        <View className="mt-1 self-stretch rounded-lg border border-gray-300 p-2 dark:border-gray-600">
          <Text className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">
            {t('species.verbatimTitle')}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('species.verbatimPlaceholder')}
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
            className="rounded-md bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100"
          />
          <View className="mt-2 flex-row justify-end gap-4">
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
              <Text className="text-sm text-gray-500 dark:text-gray-400">{t('common.cancel')}</Text>
            </Pressable>
            <Pressable onPress={submit} hitSlop={8}>
              <Text className="text-sm font-medium text-blue-600 dark:text-blue-400">
                {t('common.ok')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </>
  );
}
