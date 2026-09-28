/**
 * Team sync log (migration v70, listSyncLog in lib/teamSync.ts): what this
 * device uploaded, skipped as unchanged, merged, imported, queued or failed,
 * record by record, with the server it went to. One team (`?team=`) or all.
 * Kept on this device only; the newest 500 per team are kept.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { isoStamp } from '~/lib/datetime';
import { formatBytes } from '~/lib/exportSize';
import { listSyncLog, listTeams, localIdOf, serverLabel, syncedRecordHref, type SyncLogAction, type SyncLogEntry } from '~/lib/teamSync';

const TONE: Record<SyncLogAction, string> = {
  upload: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  skip: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  merge: 'bg-accent-100 text-accent-700 dark:bg-accent-950 dark:text-accent-300',
  import: 'bg-accent-100 text-accent-700 dark:bg-accent-950 dark:text-accent-300',
  link: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  queued: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  fail: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

/** The record's local id when it is still here, to open it. */
const localId = (e: SyncLogEntry) => (e.record_kind && e.record_uuid ? localIdOf(e.record_kind, e.record_uuid) : null);

export default function TeamLogScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const team = useLocalSearchParams<{ team?: string }>().team ?? null;
  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useFocusEffect(
    useCallback(() => {
      setEntries(listSyncLog(team));
      setNames(new Map(listTeams().map((x) => [x.team_id, x.name])));
    }, [team]),
  );

  const detailText = (e: SyncLogEntry) => {
    if (!e.detail) return null;
    if (e.action === 'fail') return t(`teamSync.err.${e.detail}`, { defaultValue: e.detail, limit: '', detail: '' });
    // Files sent with an upload, or added from a teammate's copy.
    const files = /^files:(\d+)$/.exec(e.detail);
    if (files) return t('teamSync.log.files', { n: Number(files[1]) });
    if (e.action === 'merge' || e.action === 'import' || e.action === 'link') return t('teamSync.log.from', { name: e.detail });
    return e.detail;
  };

  let day = '';
  return (
    <SettingsPage title={t('teamSync.log.title')}>
      <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('teamSync.log.intro')}</Text>
        {entries.length === 0 ? <Text className="py-6 text-center text-sm text-gray-400">{t('teamSync.log.empty')}</Text> : null}
        {entries.map((e) => {
          const stamp = isoStamp(e.at);
          const header = stamp.slice(0, 10) !== day ? (day = stamp.slice(0, 10)) : null;
          const id = localId(e);
          const meta = [
            !team ? names.get(e.team_id) : null,
            e.server ? serverLabel(e.server) : null,
            e.bytes != null ? formatBytes(e.bytes) : null,
            detailText(e),
          ].filter(Boolean);
          return (
            <View key={e.id} className="gap-2">
              {header ? <Text className="pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{header}</Text> : null}
              <Pressable
                disabled={id == null}
                onPress={() => id != null && e.record_kind && router.push(syncedRecordHref(e.record_kind, id))}
                accessibilityRole={id != null ? 'button' : undefined}
                className="flex-row items-start gap-2 rounded-lg border border-gray-200 bg-card px-3 py-2 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900"
              >
                <Text className="w-11 pt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">{stamp.slice(11, 16)}</Text>
                <Text className={`overflow-hidden rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE[e.action]}`}>{t(`teamSync.log.action.${e.action}`)}</Text>
                <View className="flex-1">
                  <Text className="text-sm text-gray-900 dark:text-gray-100" numberOfLines={2}>
                    {e.label ?? t('teamSync.log.unnamed')}
                    {id == null && e.record_uuid ? <Text className="text-xs text-gray-400">{` ${t('teamSync.log.deleted')}`}</Text> : null}
                  </Text>
                  {meta.length ? <Text className="text-xs text-gray-500 dark:text-gray-400">{meta.join(' · ')}</Text> : null}
                </View>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </SettingsPage>
  );
}
