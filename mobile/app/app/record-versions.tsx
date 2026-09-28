/**
 * A record's versions (v73, db/recordVersions.ts): when each was taken and
 * why, what differs from now or from the version before, and restore. A
 * manual version (with an optional note) can be taken here. Restoring saves
 * the current state first, so it can be undone the same way.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChangeList } from '~/components/ChangeList';
import { promptText } from '~/components/TextPromptModal';
import { diffVersions, listVersions, onVersionSaved, restoreVersion, saveVersion, uuidAndLabel, type RecordVersion } from '~/db/recordVersions';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { formatBytes } from '~/lib/exportSize';
import { BackHeaderLeft } from '~/lib/goBack';
import type { MergeKind } from '~/lib/mergeDocs';
import { Btn, Seg } from '~/modules/gloria/components/ui';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';

const REASON_TONE: Record<string, string> = {
  manual: 'bg-accent-100 text-accent-700 dark:bg-accent-950 dark:text-accent-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  before_restore: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
};
const TONE_DEFAULT = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';

export default function RecordVersionsScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ kind: MergeKind; id: string }>();
  const kind = params.kind;
  const id = Number(params.id);
  const who = useMemo(() => uuidAndLabel(kind, id), [kind, id]);
  const [versions, setVersions] = useState<RecordVersion[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [against, setAgainst] = useState<'now' | 'prev'>('now');
  const reload = useCallback(() => setVersions(who ? listVersions(kind, who.uuid) : []), [kind, who]);
  useFocusEffect(reload);
  // Opening this screen blurred the record, which queued a "leave" snapshot that lands a moment later.
  useEffect(() => onVersionSaved((k, rid) => k === kind && rid === id && reload()), [kind, id, reload]);

  const changes = useMemo(() => {
    if (open == null) return null;
    const i = versions.findIndex((v) => v.id === open);
    if (against === 'now') return diffVersions(kind, id, open, 'now');
    const prev = versions[i + 1];
    return prev ? diffVersions(kind, id, prev.id, open) : null;
  }, [open, against, versions, kind, id]);

  const createManual = async () => {
    const note = await promptText({ title: t('versions.createTitle'), message: t('versions.createMsg'), placeholder: t('versions.notePlaceholder') });
    if (note === null) return;
    saveVersion(kind, id, 'manual', note);
    reload();
    toast(t('versions.created'));
  };

  const restore = (v: RecordVersion) =>
    Alert.alert(t('versions.restoreTitle'), t('versions.restoreMsg', { when: isoStamp(v.created_at).slice(0, 16) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('versions.restoreGo'),
        style: 'destructive',
        onPress: () => {
          try {
            const n = restoreVersion(kind, id, v.id);
            useActiveSession.getState().refresh();
            useActivePlot.getState().refresh();
            useActiveGloria.getState().refresh();
            reload();
            setOpen(null);
            toast(t('versions.restored', { n }));
          } catch (e) {
            Alert.alert(t('versions.restoreFail'), errText(e));
          }
        },
      },
    ]);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('versions.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
        {who ? <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{who.label}</Text> : null}
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('versions.intro')}</Text>
        <Btn label={t('versions.create')} onPress={() => void createManual()} />
        {versions.length === 0 ? <Text className="py-6 text-center text-sm text-gray-400">{t('versions.none')}</Text> : null}
        {versions.map((v, i) => {
          const expanded = open === v.id;
          return (
            <View key={v.id} className="rounded-xl border border-gray-200 bg-card dark:border-gray-800 dark:bg-gray-900">
              <Pressable
                onPress={() => {
                  setOpen(expanded ? null : v.id);
                  setAgainst('now');
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                className="flex-row items-center gap-2 px-3 py-2.5"
              >
                <View className="flex-1 gap-0.5">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="font-mono text-sm text-gray-900 dark:text-gray-100">{isoStamp(v.updated_at).slice(0, 16)}</Text>
                    <Text className={`overflow-hidden rounded px-1.5 py-0.5 text-[11px] font-semibold ${REASON_TONE[v.reason] ?? TONE_DEFAULT}`}>
                      {t(`versions.reason.${v.reason}`)}
                    </Text>
                    {i === 0 ? <Text className="text-[11px] text-gray-400">{t('versions.latest')}</Text> : null}
                  </View>
                  {v.note ? <Text className="text-sm text-gray-700 dark:text-gray-300">{v.note}</Text> : null}
                  <Text className="text-[11px] text-gray-400">{formatBytes(v.size)}</Text>
                </View>
                <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={c.ink3} />
              </Pressable>
              {expanded ? (
                <View className="gap-2 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                  <Seg
                    value={against}
                    onChange={setAgainst}
                    options={[
                      { value: 'now', label: t('versions.vsNow') },
                      { value: 'prev', label: t('versions.vsPrev') },
                    ]}
                  />
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {against === 'now' ? t('versions.vsNowHint') : t('versions.vsPrevHint')}
                  </Text>
                  {changes == null ? (
                    <Text className="text-xs text-gray-400">{against === 'prev' ? t('versions.noPrev') : t('versions.unreadable')}</Text>
                  ) : changes.length === 0 ? (
                    <Text className="text-xs text-gray-400">{t('versions.noDiff')}</Text>
                  ) : (
                    <View className="-mx-3">
                      <ChangeList changes={changes} />
                    </View>
                  )}
                  <Btn label={t('versions.restore')} onPress={() => restore(v)} />
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
