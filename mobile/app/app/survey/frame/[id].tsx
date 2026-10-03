/**
 * One permanent plot: its geometry, its censuses, and where the next census
 * starts. A new census carries every tree's position; measurements start
 * blank and the previous census's values are shown beside them.
 *
 * Below the censuses, the plot as plot-style surveys use it (Phase 2C-a): its
 * unit layout, its morphospecies list and those surveys. Starting one is
 * offered only with the test templates (development builds) until the
 * builder (2D); the section shows whenever the plot already has any of it.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { Button } from '~/components/ui/Button';
import { defaultSurveyorString } from '~/db/surveyors';
import { isoDate } from '~/lib/datetime';
import { BackHeaderLeft } from '~/lib/goBack';
import { FormCard } from '~/survey/components/FormBits';
import { deleteFrame, getFrame, listCensuses, startCensus, type CensusListRow, type FrameRow } from '~/survey/db/stemmap';
import { fgQuadratCounts } from '~/survey/stemmap/coords';
import { STEMMAP_TEMPLATE } from '~/survey/templates/stemmap';
import { Chevron } from '~/components/ui/Chevron';
import { startModularSurveyAndOpen } from '~/lib/recordCreate';
import { listFrameLabels, listFrameUnits, listSurveys } from '~/survey/db/surveys';
import type { SurveyListRow } from '~/survey/db/surveyCore';
import { SAMPLE_PLOT_TEMPLATE, SAMPLE_TEMPLATES_OFFERED } from '~/survey/templates/samples';

export default function SurveyFrameScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [frame, setFrame] = useState<FrameRow | null>(() => getFrame(id));
  const [censuses, setCensuses] = useState<CensusListRow[]>(() => listCensuses(id));
  const [plotSurveys, setPlotSurveys] = useState<SurveyListRow[]>(() => listSurveys({ frameId: id }));
  const [layout, setLayout] = useState(() => ({ units: listFrameUnits(id).length, labels: listFrameLabels(id).length }));
  useFocusEffect(
    useCallback(() => {
      setFrame(getFrame(id));
      setCensuses(listCensuses(id));
      setPlotSurveys(listSurveys({ frameId: id }));
      setLayout({ units: listFrameUnits(id).length, labels: listFrameLabels(id).length });
    }, [id]),
  );

  if (!frame) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
      </SafeAreaView>
    );
  }

  const latest = censuses[0] ?? null;
  const q = fgQuadratCounts({ sizeXM: frame.size_x_m, sizeYM: frame.size_y_m, quadratM: frame.quadrat_m, subquadratM: frame.subquadrat_m, originLat: null, originLng: null, bearingDeg: 0, bearingRef: 'true', declinationDeg: 0 });

  const start = () => {
    const surveyId = startCensus({ frameId: frame.id, template: STEMMAP_TEMPLATE, investigators: defaultSurveyorString() });
    router.push(`/survey/${surveyId}` as Href);
  };
  const onPrimary = () => {
    if (latest?.status === 'active') {
      router.push(`/survey/${latest.id}` as Href);
      return;
    }
    Alert.alert(t('survey.frame.startTitle', { n: (latest?.census_no ?? 0) + 1 }), latest ? t('survey.frame.startRecensusMsg') : t('survey.frame.startFirstMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.frame.start'), onPress: start },
    ]);
  };
  const more = async () => {
    const idx = await showActionSheet({
      options: [{ label: t('survey.frame.edit') }, { label: t('survey.frame.delete'), destructive: true }],
      cancelLabel: t('common.cancel'),
    });
    if (idx === 0) router.push(`/survey/frame/edit?id=${frame.id}` as Href);
    if (idx === 1) {
      if (censuses.length > 0 || plotSurveys.length > 0) {
        Alert.alert(t('survey.frame.delete'), t('survey.frame.deleteHasCensus'));
        return;
      }
      Alert.alert(t('survey.frame.delete'), t('survey.frame.deleteMsg', { code: frame.code }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteFrame(frame.id);
            router.back();
          },
        },
      ]);
    }
  };

  const facts: [string, string][] = [
    [t('survey.frame.size'), t('survey.frame.sizeValue', { x: frame.size_x_m, y: frame.size_y_m, cols: q.cols, rows: q.rows })],
    [t('survey.frame.grid'), t('survey.frame.quadratValue', { q: frame.quadrat_m, s: frame.subquadrat_m })],
    [t('survey.frame.dbhMin'), t('survey.frame.dbhMinOption', { cm: frame.dbh_min_cm })],
    [t('survey.frame.tagBlock'), t('survey.frame.tagBlockValue', { q: frame.tag_block_quadrats, size: frame.tag_block_size })],
    [
      t('survey.frame.origin'),
      frame.origin_lat == null || frame.origin_lng == null
        ? t('survey.frame.originNone')
        : `${frame.origin_lat.toFixed(6)}, ${frame.origin_lng.toFixed(6)}${frame.origin_accuracy_m != null ? ` ±${frame.origin_accuracy_m} m` : ''}`,
    ],
    [
      t('survey.frame.bearing'),
      frame.bearing_ref === 'true'
        ? t('survey.frame.bearingTrue', { deg: frame.bearing_deg, decl: frame.declination_deg })
        : t('survey.frame.bearingMagnetic', { deg: frame.bearing_deg, decl: frame.declination_deg }),
    ],
  ];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: frame.code,
          headerLeft: BackHeaderLeft,
          headerRight: () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} />,
        }}
      />
      <FlatList
        data={censuses}
        keyExtractor={(x) => String(x.id)}
        contentContainerClassName="gap-2 p-4"
        ListHeaderComponent={
          <View className="mb-2 gap-3">
            <FormCard title={frame.name ?? frame.code}>
              {facts.map(([k, v]) => (
                <View key={k} className="flex-row">
                  <Text className="w-36 text-sm text-ink-3 dark:text-gray-400">{k}</Text>
                  <Text className="flex-1 text-sm text-ink dark:text-gray-100">{v}</Text>
                </View>
              ))}
              {frame.notes ? <Text className="text-sm text-ink-2 dark:text-gray-300">{frame.notes}</Text> : null}
            </FormCard>
            <Button
              size="lg"
              fullWidth
              icon={latest?.status === 'active' ? 'arrow-forward' : 'add'}
              label={
                latest?.status === 'active'
                  ? t('survey.frame.continue', { n: latest.census_no })
                  : t('survey.frame.startTitle', { n: (latest?.census_no ?? 0) + 1 })
              }
              onPress={onPrimary}
            />
            {censuses.length ? <Text className="mt-2 text-xs font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{t('survey.frame.censuses')}</Text> : null}
          </View>
        }
        ListFooterComponent={
          SAMPLE_TEMPLATES_OFFERED || plotSurveys.length || layout.units || layout.labels ? (
            <View className="mt-4 gap-2">
              <Text className="text-xs font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{t('surveyForm.frame.section')}</Text>
              <FormCard>
                <Pressable onPress={() => router.push(`/survey/frame/units?id=${frame.id}` as Href)} accessibilityRole="button" className="min-h-11 flex-row items-center">
                  <Text className="flex-1 text-base text-ink dark:text-gray-100">{t('surveyForm.frame.units')}</Text>
                  <Text className="mr-2 text-sm text-ink-3 dark:text-gray-400">{layout.units}</Text>
                  <Chevron />
                </Pressable>
                <Pressable onPress={() => router.push(`/survey/frame/labels?id=${frame.id}` as Href)} accessibilityRole="button" className="min-h-11 flex-row items-center">
                  <Text className="flex-1 text-base text-ink dark:text-gray-100">{t('surveyForm.frame.labels')}</Text>
                  <Text className="mr-2 text-sm text-ink-3 dark:text-gray-400">{layout.labels}</Text>
                  <Chevron />
                </Pressable>
              </FormCard>
              {SAMPLE_TEMPLATES_OFFERED ? (
                <Button
                  label={t('surveyForm.frame.start')}
                  icon="add"
                  variant="secondary"
                  onPress={() => {
                    const open = plotSurveys.find((x) => x.status === 'active');
                    if (open) router.push(`/survey/form/${open.id}` as Href);
                    else void startModularSurveyAndOpen(SAMPLE_PLOT_TEMPLATE, frame.id);
                  }}
                />
              ) : null}
              {plotSurveys.map((x) => (
                <Pressable
                  key={x.id}
                  onPress={() => router.push(`/survey/form/${x.id}` as Href)}
                  accessibilityRole="button"
                  className="flex-row items-center rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
                >
                  <View className="flex-1">
                    <Text className="text-base font-bold text-ink dark:text-gray-100">{t('surveyForm.frame.surveyNo', { n: x.census_no ?? 1, name: x.name ?? '' })}</Text>
                    <Text className="mt-0.5 text-sm text-ink-2 dark:text-gray-400">
                      {[isoDate(x.start_ts), x.status === 'active' ? t('records.inProgress') : null, t('surveyForm.speciesCount', { count: x.species_count })]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Chevron />
                </Pressable>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/survey/${item.id}` as Href)}
            accessibilityRole="button"
            className="flex-row items-center rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
          >
            <View className="flex-1">
              <Text className="text-base font-bold text-ink dark:text-gray-100">{t('survey.census.no', { n: item.census_no })}</Text>
              <Text className="mt-0.5 text-sm text-ink-2 dark:text-gray-400">
                {[
                  item.stop_ts ? `${isoDate(item.start_ts)} – ${isoDate(item.stop_ts)}` : isoDate(item.start_ts),
                  item.status === 'active' ? t('records.inProgress') : null,
                  t('survey.census.treeCount', { count: item.tree_count }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Chevron />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
