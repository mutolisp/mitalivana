/**
 * Review a measurement-point import for one survey before writing. The file
 * may hold many summits and cycles (a sheet 02_ download); only this summit's
 * rows count, and the user picks the cycle. Filling an empty value starts
 * ticked; overwriting a stored value or moving p5m starts unticked.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { applyPointImport, getGloriaSurvey, getSummit, listPoints } from '~/modules/gloria/db';
import { diffPoints, rowsBySummitCycle, type PointChange } from '~/modules/gloria/model/pointImport';
import { usePendingPointImport } from '~/modules/gloria/summitImportFile';
import { Btn, Card, Chip, Label } from '~/modules/gloria/components/ui';
import { useThemeColors } from '~/theme/colors';

const FIELD: Record<PointChange['field'], string> = {
  distance_m: 'gloria.pointImport.distance',
  compass_deg: 'gloria.pointImport.compass',
  comments: 'gloria.pointImport.comments',
};

export default function PointImportScreen() {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const pending = usePendingPointImport((s) => s.pending);
  const survey = getGloriaSurvey(id);
  const summit = survey ? getSummit(survey.summit_id) : null;
  const group = useMemo(
    () => (pending && summit && pending.surveyId === id ? rowsBySummitCycle(pending.rows, summit.full_code) : null),
    [pending, summit, id],
  );
  const [cycle, setCycle] = useState<number | null | undefined>(undefined);
  const chosenCycle =
    cycle !== undefined ? cycle : group ? (group.cycles.includes(survey!.mocy) ? survey!.mocy : (group.cycles[0] ?? null)) : null;
  const diff = useMemo(
    () => (group ? diffPoints(listPoints(id), group.of(chosenCycle)) : null),
    [group, id, chosenCycle],
  );
  // Ticks per cycle view: filling is safe, overwriting and moving p5m are the user's call.
  const [ticked, setTicked] = useState<Map<string, boolean>>(new Map());
  const isOn = (k: string, dflt: boolean) => ticked.get(`${chosenCycle}|${k}`) ?? dflt;
  const flip = (k: string, dflt: boolean) => setTicked(new Map(ticked).set(`${chosenCycle}|${k}`, !isOn(k, dflt)));

  if (!survey || !summit || !pending || !group || !diff) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.summitImport.nothing')}</Text>
      </SafeAreaView>
    );
  }
  const show = (v: unknown) => (v == null || v === '' ? '—' : String(v));
  const chosenPoints = diff.points.filter((p) => isOn(`pt:${p.key}`, p.fill));
  const chosenP5m = diff.p5m.filter((p) => isOn(`p5m:${p.direction}`, p.from == null));
  const problems = [...pending.problems, ...diff.problems];
  const box = (on: boolean) => <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? tc.accent : tc.ink3} />;
  const cycleLabel = (m: number | null) => (m == null ? t('gloria.pointImport.noMocy') : `mocy ${m}`);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {t('gloria.pointImport.fileSummary', { file: pending.fileName, code: summit.full_code, n: group.of(chosenCycle).length })}
          {group.other ? t('gloria.pointImport.otherSummits', { n: group.other }) : ''}
        </Text>
        {group.cycles.length > 1 ? (
          <View className="gap-1.5">
            <Label>{t('gloria.pointImport.cycle')}</Label>
            <View className="flex-row flex-wrap">
              {group.cycles.map((m) => (
                <Chip key={String(m)} label={cycleLabel(m)} on={m === chosenCycle} onPress={() => setCycle(m)} />
              ))}
            </View>
          </View>
        ) : null}
        {group.cycles.length === 0 ? <Text className="text-sm text-gray-600 dark:text-gray-300">{t('gloria.pointImport.noRows', { code: summit.full_code })}</Text> : null}

        {diff.p5m.length ? (
          <View className="gap-1.5">
            <Label>{t('gloria.pointImport.p5m')}</Label>
            <Card>
              {diff.p5m.map((p) => {
                const on = isOn(`p5m:${p.direction}`, p.from == null);
                return (
                  <Pressable key={p.direction} onPress={() => flip(`p5m:${p.direction}`, p.from == null)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} className="flex-row items-center border-b border-gray-100 px-3 py-2.5 dark:border-gray-800">
                    {box(on)}
                    <Text className="ml-2.5 flex-1 text-sm text-gray-900 dark:text-gray-100">
                      {`${p.direction}：${p.from ? `${p.direction}${p.from}` : '—'} → `}
                      <Text className="font-semibold">{`${p.direction}${p.to}`}</Text>
                    </Text>
                  </Pressable>
                );
              })}
            </Card>
          </View>
        ) : null}

        {diff.points.length ? (
          <View className="gap-1.5">
            <Label>{t('gloria.pointImport.points', { n: diff.points.length })}</Label>
            <Card>
              {diff.points.map((p) => {
                const on = isOn(`pt:${p.key}`, p.fill);
                return (
                  <Pressable key={p.key} onPress={() => flip(`pt:${p.key}`, p.fill)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} className="flex-row items-start border-b border-gray-100 px-3 py-2.5 dark:border-gray-800">
                    {box(on)}
                    <View className="ml-2.5 flex-1">
                      <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {p.key}
                        {p.fill ? '' : <Text className="text-xs font-normal text-amber-600 dark:text-amber-400">{`  ${t('gloria.pointImport.overwrites')}`}</Text>}
                      </Text>
                      {p.changes.map((c) => (
                        <Text key={c.field} className="text-xs text-gray-600 dark:text-gray-300">
                          {`${t(FIELD[c.field])}：${show(c.from)} → `}
                          <Text className="font-semibold text-gray-900 dark:text-gray-100">{show(c.to)}</Text>
                        </Text>
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </Card>
          </View>
        ) : group.cycles.length ? (
          <Text className="text-sm text-gray-600 dark:text-gray-300">{t('gloria.pointImport.nothingNew')}</Text>
        ) : null}

        {problems.length ? (
          <View className="gap-1.5">
            <Label>{t('gloria.summitImport.problems', { n: problems.length })}</Label>
            <Card className="p-3">
              {problems.map((p, i) => (
                <Text key={i} className="text-xs text-red-600 dark:text-red-400">
                  {t('gloria.summitImport.line', { line: p.line })}
                  {t(`gloria.pointImport.p_${p.message}`)}
                  {p.value ? `（${p.value}）` : ''}
                </Text>
              ))}
            </Card>
          </View>
        ) : null}
        <Text className="text-[11px] text-gray-400">{t('gloria.pointImport.hint')}</Text>
      </ScrollView>
      <View className="border-t border-gray-200 bg-card px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <Btn
          primary
          disabled={chosenPoints.length + chosenP5m.length === 0}
          label={t('gloria.pointImport.apply', { n: chosenPoints.length + chosenP5m.length })}
          onPress={() => {
            applyPointImport(
              id,
              chosenPoints.map((p) => ({ id: p.id, patch: Object.fromEntries(p.changes.map((c) => [c.field, c.to])) })),
              chosenP5m.map((p) => ({ direction: p.direction, corner: p.to })),
            );
            usePendingPointImport.getState().set(null);
            toast(t('gloria.pointImport.done', { n: chosenPoints.length, p: chosenP5m.length }));
            router.back();
          }}
        />
      </View>
    </SafeAreaView>
  );
}
