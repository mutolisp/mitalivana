/**
 * Team merge review: what another surveyor's file would change here, and the
 * reviewer's decisions (src/lib/mergeEngine.ts, src/lib/teamMergeFlow.ts).
 * The list is src/components/merge/MergeReview.tsx (shared with a census
 * block's review, app/survey/merge.tsx).
 *
 * Two groups:
 *   - 需要決定: conflicts, possible duplicates, deletions — each needs a tap to
 *     move off "keep mine";
 *   - 自動套用: rows only the sender added or changed, applied unless unticked.
 * Nothing is written until 套用, and the record is saved to
 * Documents/merge-backups first.
 */
import { router, Stack, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MergeItemList } from '~/components/merge/MergeReview';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import { defaultDecision, needsReview, summarizeItems, type Decision } from '~/lib/mergeEngine';
import { applyPendingMerge, usePendingMerge, type PendingMerge } from '~/lib/teamMergeFlow';
import { useToast } from '~/stores/toast';

const ROUTE_OF: Record<PendingMerge['kind'], string> = { session: '/session', plot: '/plot', gloria: '/gloria' };

function hrefOf(p: PendingMerge): Href {
  return `${ROUTE_OF[p.kind]}/${p.localId}` as Href;
}

export default function MergeReviewScreen() {
  const { t } = useTranslation();
  const pending = usePendingMerge((s) => s.pending);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [busy, setBusy] = useState(false);
  const toast = useToast((s) => s.show);

  const review = useMemo(() => (pending?.items ?? []).filter(needsReview), [pending]);
  const counts = useMemo(() => summarizeItems(pending?.items ?? []), [pending]);

  if (!pending) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
        <Text className="text-sm text-gray-500">{t('teamMerge.none')}</Text>
      </SafeAreaView>
    );
  }
  const gloria = pending.kind === 'gloria';
  const dec = (it: (typeof review)[number]) => decisions.get(it.id) ?? defaultDecision(it);

  const run = async (backup: boolean) => {
    setBusy(true);
    try {
      const res = await applyPendingMerge(pending, decisions, { backup });
      usePendingMerge.getState().set(null);
      const lines = [t('teamMerge.doneMsg', { count: res.ops })];
      if (res.backup) lines.push(t('teamMerge.doneBackup', { name: res.backup.name }));
      if (res.skippedPhotos > 0) lines.push(t('recordImport.donePhotosSkipped', { count: res.skippedPhotos }));
      Alert.alert(t('teamMerge.doneTitle'), lines.join('\n'));
      router.replace(hrefOf(pending));
    } catch (e) {
      setBusy(false);
      if (backup) {
        // The backup (an export) failed before anything was written.
        Alert.alert(t('teamMerge.backupFailTitle'), t('teamMerge.backupFailMsg', { error: errText(e) }), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('teamMerge.continueWithout'), style: 'destructive', onPress: () => void run(false) },
        ]);
      } else {
        toast(errText(e));
      }
    }
  };
  const apply = () => {
    const deletes = review.filter((it) => dec(it).pick === 'remote' && (it.remote == null)).length;
    Alert.alert(
      t('teamMerge.applyTitle'),
      [t('teamMerge.applyMsg', { name: pending.label }), deletes ? t('teamMerge.applyDeletes', { count: deletes }) : '']
        .filter(Boolean)
        .join('\n'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('teamMerge.apply'), onPress: () => void run(true) },
      ],
    );
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('teamMerge.title'), headerLeft: BackHeaderLeft }} />
      <MergeItemList
        items={pending.items}
        decisions={decisions}
        onDecisions={setDecisions}
        // One row per taxon and unit is a GLORIA rule (UNIQUE in the schema).
        noBoth={gloria}
        header={
          <View className="mb-3 gap-1">
            <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{pending.label}</Text>
            {pending.from ? (
              <Text className="text-sm text-accent-700 dark:text-accent-300">
                {pending.fromAt
                  ? t('teamMerge.fromAt', { name: pending.from, date: isoStamp(pending.fromAt).slice(0, 16) })
                  : t('teamMerge.from', { name: pending.from })}
              </Text>
            ) : null}
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              {t('teamMerge.summary', {
                added: counts.added,
                auto: counts.auto,
                review: review.length,
              })}
            </Text>
            {gloria ? <Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamMerge.gloriaMediaNote')}</Text> : null}
          </View>
        }
        footer={<Text className="text-xs text-gray-500 dark:text-gray-400">{t('teamMerge.backupNote')}</Text>}
      />
      <View className="border-t border-gray-200 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Pressable
          onPress={apply}
          disabled={busy}
          accessibilityRole="button"
          className={`items-center rounded-xl py-3 ${busy ? 'bg-gray-400' : 'bg-accent-600 active:bg-accent-700'}`}
        >
          <Text className="text-base font-semibold text-white">{busy ? t('teamMerge.applying') : t('teamMerge.apply')}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
