/**
 * One line for what a merge changed: 「新增 3 項、修改 5 項、刪除 1 項」 (only
 * the non-zero parts). Used by the sync toast and the merge log.
 */
import type { TFunction } from 'i18next';
import { countChanges, type MergeChange } from './mergeEngine';

export function mergeSummary(t: TFunction, changes: MergeChange[]): string {
  const c = countChanges(changes);
  return [
    c.added ? t('mergeLog.added', { count: c.added }) : null,
    c.changed ? t('mergeLog.changed', { count: c.changed }) : null,
    c.deleted ? t('mergeLog.deleted', { count: c.deleted }) : null,
  ]
    .filter(Boolean)
    .join(t('mergeLog.sep'));
}
