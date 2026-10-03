/**
 * Row-by-row changes (added / changed with field: old → new / deleted), as
 * the merge engine describes them (describeMerge). Shared by the merge log
 * and record versions.
 */
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { fieldLabel, fmt, rowLabel } from '~/lib/mergeFormat';
import type { MergeChange } from '~/lib/mergeEngine';

const ACTION_TONE: Record<MergeChange['action'], string> = {
  added: 'text-emerald-700 dark:text-emerald-300',
  changed: 'text-accent-700 dark:text-accent-300',
  deleted: 'text-red-700 dark:text-red-300',
};

export function ChangeList({ changes }: { changes: MergeChange[] }) {
  const { t } = useTranslation();
  const actionLabel = (a: MergeChange['action']) =>
    a === 'added' ? t('mergeLog.actionAdded') : a === 'deleted' ? t('mergeLog.actionDeleted') : t('mergeLog.actionChanged');
  return (
    <>
      {changes.map((c, k) => (
        <View key={k} className="gap-0.5 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
          <Text className="text-sm text-gray-900 dark:text-gray-100">
            <Text className={`font-semibold ${ACTION_TONE[c.action]}`}>{actionLabel(c.action)}</Text>
            {'  '}
            {rowLabel(t, c.tbl, c.label)}
            <Text className="text-xs text-gray-500"> · {t(`teamMerge.table.${c.tbl}`)}</Text>
          </Text>
          {c.fields.map((f) => (
            <Text key={f.f} className="text-xs text-gray-600 dark:text-gray-300">
              {fieldLabel(t, f.f, c.tbl)}：{fmt(f.f, f.from, { t, tbl: c.tbl, key: c.label })} → {fmt(f.f, f.to, { t, tbl: c.tbl, key: c.label })}
            </Text>
          ))}
        </View>
      ))}
    </>
  );
}
