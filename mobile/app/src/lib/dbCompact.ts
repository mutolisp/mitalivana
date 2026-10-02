/**
 * Compacting user.db (VACUUM). SQLite keeps the pages a delete frees inside
 * the file for later rows, so deleting a large census leaves the file as large
 * as before (125 MB after deleting 50 000 trees, 1E). Offered after a delete
 * that freed much and on the storage page (decided 2026-10-02). Backups never
 * needed it: VACUUM INTO writes a compact copy.
 */
import { Paths } from 'expo-file-system';
import { Alert } from 'react-native';
import { getUserDb } from '~/db/init';
import i18n from '~/i18n';
import { errText } from '~/lib/errText';
import { runTask } from '~/stores/taskProgress';
import { useToast } from '~/stores/toast';
import { formatBytes } from './exportSize';

/** After a delete, asked only from this much free space in the file. */
export const COMPACT_ASK_BYTES = 20 * 1024 * 1024;

const num = (sql: string): number => Number((getUserDb().executeSync(sql).rows?.[0] as { n?: number } | undefined)?.n ?? 0);

/** What compacting would give back. */
export function reclaimableBytes(): number {
  return num('SELECT f.freelist_count * s.page_size AS n FROM pragma_freelist_count() f, pragma_page_size() s');
}

const fileBytes = () => num('SELECT p.page_count * s.page_size AS n FROM pragma_page_count() p, pragma_page_size() s');

/** VACUUM on the progress panel; the bytes it freed. */
async function compact(): Promise<number> {
  const before = fileBytes();
  // VACUUM builds a compact copy, then writes it over the file through the
  // rollback journal: about twice the compacted size on the way.
  const need = 2 * (before - reclaimableBytes()) + 10 * 1024 * 1024;
  if (Paths.availableDiskSpace < need) throw new Error(i18n.t('compact.noSpace', { size: formatBytes(need) }));
  await runTask(async (r) => {
    await r.step('task.compacting');
    getUserDb().executeSync('VACUUM;');
  });
  return Math.max(0, before - fileBytes());
}

/** Ask, then compact. `afterDelete`: only when the delete freed at least COMPACT_ASK_BYTES. */
export async function offerCompact(opts: { afterDelete: boolean }): Promise<void> {
  const free = reclaimableBytes();
  if (free <= 0 || (opts.afterDelete && free < COMPACT_ASK_BYTES)) return;
  const go = await new Promise<boolean>((resolve) =>
    Alert.alert(i18n.t('compact.title'), i18n.t('compact.msg', { size: formatBytes(free) }), [
      { text: i18n.t(opts.afterDelete ? 'compact.later' : 'common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: i18n.t('compact.go'), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
  if (!go) return;
  try {
    const freed = await compact();
    useToast.getState().show(i18n.t('compact.done', { size: formatBytes(freed) }));
  } catch (e) {
    Alert.alert(i18n.t('compact.failed'), errText(e));
  }
}
