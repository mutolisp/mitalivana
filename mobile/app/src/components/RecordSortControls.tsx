/**
 * 快速名錄's sort at the end of the filter row: one 44 pt ⇅ button (asked
 * 2026-10-07: the order's name and a separate direction button took a third
 * of the row). It opens a sheet of the orders, each with its direction; the
 * current one is ticked and picking it again flips it. The icon turns accent
 * while the order is not the default (加入順序, newest first). Kept in
 * settings, so a checklist-style survey drawn with the same screen (2G-c)
 * sorts the same way.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { useSettings, type RecordSort, type SortDirection } from '~/stores/settings';
import { useThemeColors } from '~/theme/colors';

const ORDERS: RecordSort[] = ['observed', 'cname', 'name', 'family'];
/** Where an order starts when picked: observed newest first, names A→Z. */
const defaultDir = (o: RecordSort): SortDirection => (o === 'observed' ? 'desc' : 'asc');

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
  const dirLabel = (o: RecordSort, d: SortDirection) =>
    o === 'observed'
      ? t(d === 'desc' ? 'session.sortNewFirst' : 'session.sortOldFirst')
      : t(d === 'asc' ? 'session.sortAsc' : 'session.sortDesc');

  const handlePickSort = async () => {
    const idx = await showActionSheet({
      title: t('session.sortTitle'),
      options: ORDERS.map((o) => ({
        label: sortLabel[o],
        description:
          o === sortOrder ? t('session.sortFlipHint', { dir: dirLabel(o, sortDir) }) : dirLabel(o, defaultDir(o)),
        selected: o === sortOrder,
      })),
    });
    if (idx < 0 || idx >= ORDERS.length) return;
    const picked = ORDERS[idx];
    if (picked === sortOrder) {
      // The current order again → flip direction.
      setSetting('last_record_sort_dir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSetting('last_record_sort', picked);
      setSetting('last_record_sort_dir', defaultDir(picked));
    }
  };

  const isDefault = sortOrder === 'observed' && sortDir === 'desc';
  return (
    <Pressable
      onPress={handlePickSort}
      accessibilityRole="button"
      accessibilityLabel={`${t('session.sortTitle')}: ${sortLabel[sortOrder]}, ${dirLabel(sortOrder, sortDir)}`}
      className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
    >
      <Ionicons name="swap-vertical" size={20} color={isDefault ? c.ink2 : c.accent} />
    </Pressable>
  );
}
