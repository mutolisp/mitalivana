/**
 * The header's 「結束」 capsule (03-screens-flow.md §3, §4e). A word, not a
 * stop glyph: ending is the one header action that changes the record's
 * state, so it should read as one.
 */
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

export function EndRecordButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={t('session.end')}
      className="flex-row items-center rounded-full border-[1.5px] border-alert px-3 active:bg-alert-tint dark:border-alert-dark dark:active:bg-alert-dark-tint"
      style={{ minHeight: 36 }}
    >
      <View className="mr-1.5 h-2.5 w-2.5 rounded-sm bg-alert dark:bg-alert-dark" />
      <Text className="text-sm font-bold text-alert dark:text-alert-dark">{t('session.end')}</Text>
    </Pressable>
  );
}
