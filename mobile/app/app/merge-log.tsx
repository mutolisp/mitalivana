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
import type { MergeChange } from '~/lib/mergeEngine';
import { fieldLabel, fmt } from '~/lib/mergeFormat';
import { mergeSummary } from '~/lib/mergeSummaryText';

const ACTION_TONE: Record<MergeChange['action'], string> = {
  added: 'text-emerald-700 dark:text-emerald-300',
  changed: 'text-[#00797b] dark:text-cyan-300',
  deleted: 'text-red-700 dark:text-red-300',
};

export default function MergeLogScreen() {
  const { t } = useTranslation();
  const { kind, uuid } = useLocalSearchParams<{ kind: MergeKind; uuid: string }>();
  const entries = useMemo(() => listMergeLog(kind, uuid), [kind, uuid]);
  // The newest merge opens by itself: it is usually the one the toast pointed at.
  const [open, setOpen] = useState<Set<number>>(() => new Set(entries.slice(0, 1).map((e) => e.id)));
  const actionLabel = (a: MergeChange['action']) =>
    a === 'added' ? t('mergeLog.actionAdded') : a === 'deleted' ? t('mergeLog.actionDeleted') : t('mergeLog.actionChanged');

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
              {expanded
                ? e.changes.map((c, k) => (
                    <View key={k} className="gap-0.5 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                      <Text className="text-sm text-gray-900 dark:text-gray-100">
                        <Text className={`font-semibold ${ACTION_TONE[c.action]}`}>{actionLabel(c.action)}</Text>
                        {'  '}
                        {c.label}
                        <Text className="text-xs text-gray-500"> · {t(`teamMerge.table.${c.tbl}`)}</Text>
                      </Text>
                      {c.fields.map((f) => (
                        <Text key={f.f} className="text-xs text-gray-600 dark:text-gray-300">
                          {fieldLabel(t, f.f)}：{fmt(f.f, f.from)} → {fmt(f.f, f.to)}
                        </Text>
                      ))}
                    </View>
                  ))
                : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
