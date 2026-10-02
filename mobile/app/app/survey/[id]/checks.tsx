/**
 * Field worklists of a census (Modular_survey.md §8.4): the automatic
 * screening (problems, stems measured last census but not yet in this one)
 * and the extreme-growth list to re-measure (Condit 1998 p.86: both ends of
 * every dbh class; share and minimum from the plot). Both read the whole
 * census, so they are computed when this screen opens, not on the list: 25
 * quadrats at a time, with a bar, since a 20 000-tree census takes seconds
 * (1E). Going back stops the reading.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LineTabs } from '~/components/form/Segmented';
import { BackHeaderLeft } from '~/lib/goBack';
import { issueText } from '~/survey/components/labels';
import { frameGeometry, getFrame, getSurvey, loadCensusQuadrats, previousCensusId, TAG_ORDER, treeQuadratCodes, type TreeView } from '~/survey/db/stemmap';
import { extremeWorklist, screening, type WorkItem } from '~/survey/stemmap/review';
import { stemTagOf } from '~/survey/stemmap/treeForm';
import { yieldToUi } from '~/stores/taskProgress';
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
  const [read, setRead] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      const survey = getSurvey(surveyId);
      const frame = survey ? getFrame(survey.frame_id) : null;
      if (!survey || !frame) return;
      const geometry = frameGeometry(frame);
      const firstCensus = previousCensusId(surveyId) == null;
      setExtremeOpts({ pct: frame.extreme_pct, min: frame.extreme_min, quadratM: frame.quadrat_m });
      const codes = treeQuadratCodes(surveyId);
      const trees: TreeView[] = [];
      for (let i = 0; i < codes.length; i += 25) {
        setRead({ done: i, total: codes.length });
        await yieldToUi();
        if (gone) return;
        trees.push(...loadCensusQuadrats(surveyId, codes.slice(i, i + 25)));
      }
      trees.sort(TAG_ORDER);
      setRead({ done: codes.length, total: codes.length });
      await yieldToUi();
      if (gone) return;
      setLists({
        screen: screening(trees, { surveyId, firstCensus, thresholdCm: frame.dbh_min_cm, geometry }),
        extreme: firstCensus ? [] : extremeWorklist(trees, { pct: frame.extreme_pct, min: frame.extreme_min, geometry }),
      });
    })();
    return () => {
      gone = true;
    };
  }, [surveyId]);

  const items = lists ? lists[tab] : [];
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('survey.census.checks'), headerLeft: BackHeaderLeft }} />
      {/* Counts only once read: "0" while reading would look like a result. */}
      {lists ? (
        <View className="px-4 pb-2 pt-1">
          <LineTabs
            value={tab}
            options={[
              { value: 'screen', label: t('survey.checks.screening', { count: lists.screen.length }) },
              { value: 'extreme', label: t('survey.checks.extreme', { count: lists.extreme.length }) },
            ]}
            onChange={setTab}
          />
        </View>
      ) : null}
      {lists == null ? (
        <View className="mt-10 items-center gap-3 px-10">
          <ActivityIndicator color={c.accent} />
          {read && read.total > 0 ? (
            <>
              <View className="h-1.5 w-full overflow-hidden rounded-full bg-line dark:bg-line-dark">
                <View className="h-1.5 rounded-full bg-accent-600 dark:bg-accent-400" style={{ width: `${Math.round((read.done / read.total) * 100)}%` }} />
              </View>
              <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-3 dark:text-gray-400">
                {read.done < read.total ? t('survey.checks.reading', { done: read.done, total: read.total }) : t('survey.checks.computing')}
              </Text>
            </>
          ) : null}
        </View>
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
                <Text style={{ fontVariant: ['tabular-nums'] }} className="text-xs text-ink-3 dark:text-gray-400">{t('survey.census.quadrat', { q: w.quadratCode, m: extremeOpts?.quadratM ?? 20 })}</Text>
              </View>
              <Chevron />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
