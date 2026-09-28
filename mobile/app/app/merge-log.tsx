/**
 * A record's merge log (migration v67, db/mergeLog.ts): every merge from a
 * teammate — team sync or an imported file — newest first, with what it
 * added, changed (field: old → new) and deleted. Kept on this device only.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { listMergeLog } from '~/db/mergeLog';
import { isoStamp } from '~/lib/datetime';
import { BackHeaderLeft } from '~/lib/goBack';
import type { MergeKind } from '~/lib/mergeDocs';
import { mergeSummary } from '~/lib/mergeSummaryText';
import { ChangeList } from '~/components/ChangeList';

export default function MergeLogScreen() {
  const { t } = useTranslation();
  const { kind, uuid } = useLocalSearchParams<{ kind: MergeKind; uuid: string }>();
  const entries = useMemo(() => listMergeLog(kind, uuid), [kind, uuid]);
  // The newest merge opens by itself: it is usually the one the toast pointed at.
  const [open, setOpen] = useState<Set<number>>(() => new Set(entries.slice(0, 1).map((e) => e.id)));

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('mergeLog.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('mergeLog.intro')}</Text>
        {entries.length === 0 ? <Text className="py-6 text-center text-sm text-gray-400">{t('mergeLog.none')}</Text> : null}
        {entries.map((e) => {
          const expanded = open.has(e.id);
          return (
            <View key={e.id} className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
              <Pressable
                onPress={() => setOpen((s) => new Set(s.has(e.id) ? [...s].filter((x) => x !== e.id) : [...s, e.id]))}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                className="flex-row items-center gap-2 px-3 py-2.5"
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {isoStamp(e.merged_at).slice(0, 16)} · {e.author || t('mergeLog.unsigned')}
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">{mergeSummary(t, e.changes)}</Text>
                </View>
                <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color="#9ca3af" />
              </Pressable>
              {expanded ? <ChangeList changes={e.changes} /> : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
