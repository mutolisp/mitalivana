/**
 * 快速名錄's sort controls at the end of the filter row: the order (a sheet;
 * picking the active one again flips it) and its direction, each a real 44 pt
 * target. Kept in settings, so a checklist-style survey drawn with the same
 * screen (2G-c) sorts the same way.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { useSettings, type RecordSort } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

export function RecordSortControls() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const sortOrder = useSettings((s) => s.last_record_sort);
  const sortDir = useSettings((s) => s.last_record_sort_dir);
  const setSetting = useSettings((s) => s.set);
  const sortLabel: Record<RecordSort, string> = {
    observed: t('session.sortObserved'),
    cname: t('session.sortCname'),
    name: t('session.sortName'),
    family: t('session.sortFamily'),
  };

  const handlePickSort = async () => {
    const orders: RecordSort[] = ['observed', 'cname', 'name', 'family'];
    const idx = await showActionSheet({
      title: t('session.sortTitle'),
      options: orders.map((o) => ({
        label:
          o === sortOrder ? t('session.sortActiveHint', { label: sortLabel[o] }) : sortLabel[o],
      })),
    });
    if (idx < 0 || idx >= orders.length) return;
    const picked = orders[idx];
    if (picked === sortOrder) {
      // Tap the active sort again → flip direction.
      setSetting('last_record_sort_dir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSetting('last_record_sort', picked);
      // Reset direction to that sort's natural default — observed goes
      // newest-first; everything else goes A→Z.
      setSetting('last_record_sort_dir', picked === 'observed' ? 'desc' : 'asc');
    }
  };

  const handleToggleSortDir = () => {
    setSetting('last_record_sort_dir', sortDir === 'asc' ? 'desc' : 'asc');
  };

  return (
    <View className="flex-row items-center pr-1">
      <Pressable
        onPress={handlePickSort}
        accessibilityRole="button"
        accessibilityLabel={`${t('session.sortTitle')}: ${sortLabel[sortOrder]}`}
        className="flex-row items-center rounded-full px-2 active:bg-gray-100 dark:active:bg-gray-800"
        style={{ minHeight: 44 }}
      >
        <Ionicons name="swap-vertical" size={18} color={c.ink2} />
        <Text className="ml-0.5 text-xs text-gray-600 dark:text-gray-400">
          {sortLabel[sortOrder]}
        </Text>
      </Pressable>
      <Pressable
        onPress={handleToggleSortDir}
        accessibilityRole="button"
        accessibilityLabel={t('session.sortActiveHint', { label: sortLabel[sortOrder] })}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
      >
        <Ionicons
          name={sortDir === 'desc' ? 'arrow-down' : 'arrow-up'}
          size={16}
          color={c.ink2}
        />
      </Pressable>
    </View>
  );
}
