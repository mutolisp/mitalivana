/**
 * Review a summit import before anything is written: each summit of the file
 * is new, changed (old → new per field) or the same, and rows that could not
 * be read are listed with their line. New summits start ticked, changed ones
 * unticked — overwriting stored values is the user's call.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { applySummitImport, listSummits } from '~/modules/gloria/db';
import { diffSummits, type Compared, type StoredSummit, type SummitDiff } from '~/modules/gloria/model/summitImport';
import { usePendingSummitImport } from '~/modules/gloria/summitImportFile';
import { Btn, Card, Label } from '~/modules/gloria/components/ui';

const FIELD_LABEL: Record<Compared, string> = {
  name: 'gloria.summit.name',
  decimal_latitude: 'gloria.summit.lat',
  decimal_longitude: 'gloria.summit.lon',
  elevation_m: 'gloria.summit.elevation',
  veg_zone: 'gloria.summit.zone',
};

export default function SummitImportScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const pending = usePendingSummitImport((s) => s.pending);
  const diffs = useMemo(
    () => (pending ? diffSummits(listSummits() as unknown as StoredSummit[], pending.parsed.items) : []),
    [pending],
  );
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(diffs.filter((d) => d.kind === 'new').map((d) => d.item.full_code)),
  );
  if (!pending) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.summitImport.nothing')}</Text>
      </SafeAreaView>
    );
  }
  const added = diffs.filter((d) => d.kind === 'new');
  const changed = diffs.filter((d) => d.kind === 'changed');
  const same = diffs.filter((d) => d.kind === 'same');
  const problems = pending.parsed.problems;
  const chosen = diffs.filter((d) => d.kind !== 'same' && ticked.has(d.item.full_code));
  const toggle = (code: string) => {
    const next = new Set(ticked);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setTicked(next);
  };
  const setAll = (list: SummitDiff[], on: boolean) => {
    const next = new Set(ticked);
    for (const d of list) {
      if (on) next.add(d.item.full_code);
      else next.delete(d.item.full_code);
    }
    setTicked(next);
  };
  const show = (v: unknown) => (v == null || v === '' ? '—' : String(v));
  const summary = (d: SummitDiff) =>
    [d.item.name, d.item.elevation_m != null ? `${d.item.elevation_m} m` : null, d.item.veg_zone].filter(Boolean).join(' · ') ||
    t('gloria.summitImport.noDetails');

  const row = (d: SummitDiff) => {
    const on = ticked.has(d.item.full_code);
    return (
      <Pressable
        key={d.item.full_code}
        onPress={() => toggle(d.item.full_code)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        className="flex-row items-start border-b border-gray-100 px-3 py-2.5 dark:border-gray-800"
      >
        <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? '#00A2A5' : '#9ca3af'} />
        <View className="ml-2.5 flex-1">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{d.item.full_code}</Text>
          {d.kind === 'changed' ? (
            d.changes.map((c) => (
              <Text key={c.field} className="text-xs text-gray-600 dark:text-gray-300">
                {`${t(FIELD_LABEL[c.field])}：${show(c.from)} → `}
                <Text className="font-semibold text-gray-900 dark:text-gray-100">{show(c.to)}</Text>
              </Text>
            ))
          ) : (
            <Text className="text-xs text-gray-500 dark:text-gray-400">{summary(d)}</Text>
          )}
        </View>
      </Pressable>
    );
  };
  const section = (title: string, list: SummitDiff[]) =>
    list.length ? (
      <View className="gap-1.5">
        <View className="flex-row items-center">
          <View className="flex-1">
            <Label>{title}</Label>
          </View>
          <Pressable onPress={() => setAll(list, !list.every((d) => ticked.has(d.item.full_code)))} hitSlop={6}>
            <Text className="text-xs font-semibold text-[#00797b] dark:text-cyan-300">
              {list.every((d) => ticked.has(d.item.full_code)) ? t('gloria.summitImport.none') : t('gloria.summitImport.all')}
            </Text>
          </Pressable>
        </View>
        <Card>{list.map(row)}</Card>
      </View>
    ) : null;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {t('gloria.summitImport.fileSummary', { file: pending.fileName, n: pending.parsed.items.length })}
        </Text>
        {section(t('gloria.summitImport.new', { n: added.length }), added)}
        {section(t('gloria.summitImport.changed', { n: changed.length }), changed)}
        {same.length ? <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.summitImport.same', { n: same.length })}</Text> : null}
        {problems.length ? (
          <View className="gap-1.5">
            <Label>{t('gloria.summitImport.problems', { n: problems.length })}</Label>
            <Card className="p-3">
              {problems.map((p, i) => (
                <Text key={i} className="text-xs text-red-600 dark:text-red-400">
                  {t('gloria.summitImport.line', { line: p.line })}
                  {t(`gloria.summitImport.p_${p.message}`)}
                  {p.value ? `（${p.value}）` : ''}
                </Text>
              ))}
            </Card>
          </View>
        ) : null}
        <Text className="text-[11px] text-gray-400">{t('gloria.summitImport.hint')}</Text>
      </ScrollView>
      <View className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Btn
          primary
          disabled={chosen.length === 0}
          label={t('gloria.summitImport.apply', { n: chosen.length })}
          onPress={() => {
            const r = applySummitImport(chosen);
            usePendingSummitImport.getState().set(null);
            toast(t('gloria.summitImport.done', { added: r.added, updated: r.updated }));
            router.back();
          }}
        />
      </View>
    </SafeAreaView>
  );
}
