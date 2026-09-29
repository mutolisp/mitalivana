/**
 * Header buttons for a record's lock and history (src/lib/useRecordEditing):
 * undo and redo while it can be edited, and on an ended record the lock that
 * opens it for edits here (and closes it again).
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useThemeColors } from '~/theme/colors';

export function RecordEditButtons({
  edit,
  ended,
  onChanged,
  inMenu = false,
}: {
  edit: RecordEditing;
  ended: boolean;
  /** Reload the screen after an undo / redo restored the record. */
  onChanged: () => void;
  /** Undo / redo live in the screen's ⋯ menu (RecordMenuButton `edit`);
   *  only the lock is drawn here. */
  inMenu?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {!edit.locked && !inMenu ? (
        <HeaderIconButton
          icon="arrow-undo-outline"
          label={t('recordLock.undo')}
          disabled={edit.undoCount === 0}
          onPress={() => {
            edit.undo();
            onChanged();
          }}
        />
      ) : null}
      {!edit.locked && !inMenu ? (
        <HeaderIconButton
          icon="arrow-redo-outline"
          label={t('recordLock.redo')}
          disabled={edit.redoCount === 0}
          onPress={() => {
            edit.redo();
            onChanged();
          }}
        />
      ) : null}
      {ended ? (
        <HeaderIconButton
          icon={edit.locked ? 'lock-closed' : 'lock-open-outline'}
          label={edit.locked ? t('recordLock.unlock') : t('recordLock.relock')}
          onPress={() => edit.setUnlocked(edit.locked)}
        />
      ) : null}
    </>
  );
}

/** Shown above a locked record's fields, which then take no touches. */
export function LockedBanner() {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="mx-4 mt-3 flex-row items-center rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
      <Ionicons name="lock-closed" size={14} color={c.ink2} />
      <Text className="ml-2 flex-1 text-xs text-gray-600 dark:text-gray-300">
        {t('recordLock.banner')}
      </Text>
    </View>
  );
}
