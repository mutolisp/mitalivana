/**
 * Field worklists of a census (Modular_survey.md §8.4): the automatic
 * screening (problems, stems measured last census but not yet in this one)
 * and the extreme-growth list to re-measure (Condit 1998 p.86: both ends of
 * every dbh class; share and minimum from the plot). Both read the whole
 * census, so they are computed when this screen opens, not on the list.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LineTabs } from '~/components/form/Segmented';
import { BackHeaderLeft } from '~/lib/goBack';
import { issueText } from '~/survey/components/labels';
import { loadCensus } from '~/survey/db/stemmap';
import { extremeWorklist, screening, type WorkItem } from '~/survey/stemmap/review';
import { stemTagOf } from '~/survey/stemmap/treeForm';
import { loadCensusData } from '~/survey/useCensus';
import { Chevron } from '~/components/ui/Chevron';
import { useThemeColors } from '~/theme/colors';

type Tab = 'screen' | 'extreme';

export default function CensusChecksScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const surveyId = Number(useLocalSearchParams<{ id: string }>().id);
  const [tab, setTab] = useState<Tab>('screen');
  const [lists, setLists] = useState<{ screen: WorkItem[]; extreme: WorkItem[] } | null>(null);
  const [extremeOpts, setExtremeOpts] = useState<{ pct: number; min: number; quadratM: number } | null>(null);

  useEffect(() => {
    const d = loadCensusData(surveyId);
    if (!d) return;
    const trees = loadCensus(surveyId);
    const opts = { surveyId, firstCensus: d.firstCensus, thresholdCm: d.frame.dbh_min_cm, geometry: d.geometry };
    setExtremeOpts({ pct: d.frame.extreme_pct, min: d.frame.extreme_min, quadratM: d.frame.quadrat_m });
    setLists({
      screen: screening(trees, opts),
      extreme: d.firstCensus ? [] : extremeWorklist(trees, { pct: d.frame.extreme_pct, min: d.frame.extreme_min, geometry: d.geometry }),
    });
  }, [surveyId]);

  const items = lists ? lists[tab] : [];
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('survey.census.checks'), headerLeft: BackHeaderLeft }} />
      <View className="px-4 pb-2 pt-1">
        <LineTabs
          value={tab}
          options={[
            { value: 'screen', label: t('survey.checks.screening', { count: lists?.screen.length ?? 0 }) },
            { value: 'extreme', label: t('survey.checks.extreme', { count: lists?.extreme.length ?? 0 }) },
          ]}
          onChange={setTab}
        />
      </View>
      {lists == null ? (
        <ActivityIndicator className="mt-10" color={c.accent} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(w, i) => `${w.individualId}-${w.stemNo ?? 't'}-${w.code}-${i}`}
          contentContainerClassName="gap-2 px-4 pb-6"
          ListHeaderComponent={
            <Text className="mb-1 text-xs leading-4 text-ink-3 dark:text-gray-400">
              {tab === 'screen'
                ? t('survey.checks.screeningHint')
                : t('survey.checks.extremeHint', { pct: Math.round((extremeOpts?.pct ?? 0.05) * 1000) / 10, min: extremeOpts?.min ?? 3 })}
            </Text>
          }
          ListEmptyComponent={<Text className="py-10 text-center text-sm text-ink-3 dark:text-gray-400">{tab === 'screen' ? t('survey.checks.screeningEmpty') : t('survey.checks.extremeEmpty')}</Text>}
          renderItem={({ item: w }) => (
            <Pressable
              onPress={() => router.push(`/survey/${surveyId}/tree?ind=${w.individualId}&q=${w.quadratCode}` as Href)}
              accessibilityRole="button"
              className="flex-row items-center gap-3 rounded-2xl border border-line bg-card px-3 py-2.5 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
            >
              <Text className="w-20 font-mono text-sm font-bold text-ink dark:text-gray-100">{w.stemNo == null ? w.tag : stemTagOf(w.tag, w.stemNo)}</Text>
              <View className="flex-1">
                <Text className="text-sm text-ink dark:text-gray-100">{issueText(t, w.code)}</Text>
                <Text className="font-mono text-xs text-ink-3 dark:text-gray-400">{t('survey.census.quadrat', { q: w.quadratCode, m: extremeOpts?.quadratM ?? 20 })}</Text>
              </View>
              <Chevron />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
