/**
 * The bar that replaces a list's own controls while rows are being selected:
 * count on the left; 全選 · actions · 取消 on the right. Same look as the
 * collection and sites screens' select bars.
 */
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

export type SelectionAction = {
  label: string;
  onPress: () => void;
  /** Destructive actions are red. */
  destructive?: boolean;
};

type Props = {
  count: number;
  /** Whether every visible row is already picked (the 全選 label flips). */
  allPicked?: boolean;
  /** Omit to hide 全選 — the taxonomy tree has no meaningful "all". */
  onToggleAll?: () => void;
  actions: SelectionAction[];
  onCancel: () => void;
};

export function SelectionToolbar({ count, allPicked, onToggleAll, actions, onCancel }: Props) {
  const { t } = useTranslation();
  const none = count === 0;
  return (
    <View className="flex-row items-center justify-between border-b border-gray-200 bg-card px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
      <Text className="text-sm text-gray-500 dark:text-gray-400">
        {t('favorites.selectedCount', { count })}
      </Text>
      <View className="flex-row items-center gap-3">
        {onToggleAll ? (
          <Pressable onPress={onToggleAll} hitSlop={8}>
            <Text className="text-sm text-accent-600 dark:text-accent-400">
              {allPicked ? t('favorites.deselectAll') : t('favorites.selectAll')}
            </Text>
          </Pressable>
        ) : null}
        {actions.map((a) => (
          <Pressable key={a.label} onPress={a.onPress} disabled={none} hitSlop={8}>
            <Text
              className={`text-sm font-medium ${
                none
                  ? 'text-gray-300 dark:text-gray-600'
                  : a.destructive
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-accent-600 dark:text-accent-400'
              }`}
            >
              {a.label}
            </Text>
          </Pressable>
        ))}
        <Pressable onPress={onCancel} hitSlop={8}>
          <Text className="text-sm text-gray-500 dark:text-gray-400">{t('common.cancel')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
