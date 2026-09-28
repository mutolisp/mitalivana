/**
 * GLORIA survey overview: base data (measurement points), summit schematic,
 * and the summit species table. Units open from the schematic or the list.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { BackHeaderLeft } from '~/lib/goBack';
import { RecordStepBar } from '~/components/RecordStepBar';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { endGloriaSurvey, reopenGloriaSurvey, updateGloriaSurvey } from '~/modules/gloria/db';
import { useActiveGloria } from '~/modules/gloria/store';
import { useSurvey, STATUS_COLOR } from '~/modules/gloria/useSurvey';
import { issueText } from '~/modules/gloria/issues';
import { QUADRAT_CODES, SAS_CODES, SQUARE_CODES, type Direction } from '~/modules/gloria/model/units';
import { FormScans } from '~/modules/gloria/components/FormScans';
import { PointsForm } from '~/modules/gloria/components/PointsForm';
import { SummitForm } from '~/modules/gloria/components/SummitForm';
import { SurveyDates } from '~/modules/gloria/components/SurveyDates';
import { SurveyResearchers } from '~/modules/gloria/components/SurveyResearchers';
import { TopoCarry } from '~/modules/gloria/components/TopoCarry';
import { LoggerVisitList } from '~/modules/gloria/components/LoggerVisitList';
import { startPointImport } from '~/modules/gloria/summitImportFile';
import { errText } from '~/lib/errText';
import { P5mDiagram, SummitSchematic } from '~/modules/gloria/components/SummitSchematic';
import { SpeciesMatrix } from '~/modules/gloria/components/SpeciesMatrix';
import { missingRequiredPhotos, PhotoChecklist } from '~/modules/gloria/components/PhotoChecklist';
import { Btn, Card, Label, NumAccessory, Seg } from '~/modules/gloria/components/ui';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { saveVersionSoon } from '~/db/recordVersions';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';

type Tab = 'points' | 'map' | 'species' | 'photos' | 'loggers';

export default function GloriaSurveyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  useVersionOnLeave('gloria', id);
  const { state, reload } = useSurvey(id);
  const [tab, setTab] = useState<Tab>(() => (state && state.points.every((p) => p.distance_m == null) ? 'points' : 'map'));
  const [help, setHelp] = useState<Direction | null>(null);
  // Off while two fingers zoom the overview drawing.
  const [scrollOn, setScrollOn] = useState(true);

  if (!state) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Stack.Screen options={{ title: t('nav.gloria'), headerLeft: BackHeaderLeft }} />
        <Text className="text-gray-500">{t('gloria.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { survey, summit } = state;
  const active = survey.status === 'active';
  const openUnit = (code: string) => router.push(`/gloria/${id}/${code}` as Href);
  const measure = (key: string) => {
    const p = state.points.find((x) => x.point_key === key);
    return { distance: p?.distance_m ?? null, compass: p?.compass_deg ?? null };
  };
  const refreshStores = () => {
    useActiveGloria.getState().refresh();
    useActivePlot.getState().refresh();
    useActiveSession.getState().refresh();
  };
  const toggleEnd = () => {
    if (!active) {
      reopenGloriaSurvey(id);
      refreshStores();
      reload();
      return;
    }
    const n = state.issues.length;
    const missing = missingRequiredPhotos(state);
    const msg = [n ? t('gloria.endWithIssues', { count: n }) : t('gloria.endMsg'), missing ? t('gloria.photoCheck.endMissing', { n: missing }) : '']
      .filter(Boolean)
      .join('\n\n');
    Alert.alert(t('gloria.endTitle'), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      ...(missing ? [{ text: t('gloria.photoCheck.goTake'), onPress: () => setTab('photos') }] : []),
      {
        text: t('session.end'),
        style: 'destructive',
        onPress: async () => {
          const chosen = await chooseEndTime(state.survey.stop_ts, { afterDialog: true });
          if (chosen === undefined) return;
          endGloriaSurvey(id, chosen);
          saveVersionSoon('gloria', id, 'done');
          refreshStores();
          reload();
        },
      },
    ]);
  };
  const done = state.units.filter((u) => state.statusOf(u.code) === 'done').length;

  // One row per direction, E N S W; obligatory methods get a red *.
  const unitList = (title: string, codes: readonly string[], kind: 'required' | 'optional') => (
    <View className="gap-1.5">
      <Label>
        {title}
        {kind === 'required' ? <Text className="text-red-600 dark:text-red-400"> *</Text> : null}
        {kind === 'optional' ? <Text className="normal-case tracking-normal">{` ${t('gloria.list.optional')}`}</Text> : null}
      </Label>
      {(['E', 'N', 'S', 'W'] as const).map((d) => (
        <View key={d} className="flex-row flex-wrap">
          {codes
            .filter((c) => c[0] === d)
            .map((c) => (
              <Pressable
                key={c}
                onPress={() => openUnit(c)}
                className="mb-1.5 mr-1.5 flex-row items-center rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900"
              >
                <View className="mr-1.5 h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: STATUS_COLOR[state.statusOf(c)] }} />
                <Text className="text-xs font-semibold text-gray-900 dark:text-gray-100">{c}</Text>
              </Pressable>
            ))}
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: `${summit.full_code} · mocy ${survey.mocy}`,
          headerTitle: () => <HeaderTitleText text={`${summit.full_code} · mocy ${survey.mocy}`} />,
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton kind="gloria" id={id} reportHref={`/report/gloria/${id}` as Href} onSynced={reload} />
              <HeaderIconButton
                icon={active ? 'stop-circle-outline' : 'refresh-outline'}
                tone={active ? 'danger' : 'default'}
                label={active ? t('session.end') : t('plot.reopen')}
                onPress={toggleEnd}
              />
            </View>
          ),
        }}
      />
      <View className="px-4 pt-3">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'points', label: t('gloria.tab.points') },
            { value: 'map', label: t('gloria.tab.map') },
            { value: 'species', label: t('gloria.tab.species') },
            { value: 'photos', label: t('gloria.tab.photos') },
            { value: 'loggers', label: t('gloria.tab.loggers') },
          ]}
        />
      </View>
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets scrollEnabled={scrollOn}>
        {tab === 'points' ? (
          <>
            <SummitForm state={state} reload={reload} />
            <SurveyResearchers state={state} reload={reload} />
            <SurveyDates state={state} reload={reload} />
            <TopoCarry state={state} reload={reload} />
            <Btn
              label={t('gloria.pointImport.button')}
              onPress={() =>
                void startPointImport(
                  id,
                  () => router.push(`/gloria/${id}/points-import` as Href),
                  (e) => Alert.alert(t('gloria.summitImport.readFail'), errText(e)),
                )
              }
            />
            <PointsForm state={state} reload={reload} onHelp={setHelp} />
            {/* Form 1 COMMENTS; exported as the comments column of sheet 01_. */}
            <Label>{t('gloria.notes.title')}</Label>
            <TextInput
              key={`notes-${state.survey.id}`}
              defaultValue={state.survey.notes ?? ''}
              onEndEditing={(e) => {
                const v = e.nativeEvent.text.trim() || null;
                if (v !== state.survey.notes) {
                  updateGloriaSurvey(id, { notes: v });
                  reload();
                }
              }}
              placeholder={t('gloria.notes.placeholder')}
              placeholderTextColor="#9ca3af"
              multiline
              accessibilityLabel={t('gloria.notes.title')}
              className="min-h-[96px] rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              style={{ textAlignVertical: 'top' }}
            />
            <FormScans state={state} reload={reload} form="1" />
          </>
        ) : null}

        {tab === 'map' ? (
          <>
            <View className="flex-row flex-wrap gap-1.5">
              {(['E', 'N', 'S', 'W'] as const).map((d) => (
                <Pressable key={d} onPress={() => setHelp(d)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 dark:border-gray-700 dark:bg-gray-900">
                  <Text className="text-xs text-gray-700 dark:text-gray-300">
                    p5m <Text className="font-bold text-[#00797b] dark:text-cyan-300">{state.p5m[d] ? d + state.p5m[d] : `${d}?`}</Text>
                  </Text>
                </Pressable>
              ))}
            </View>
            <Card className="p-2">
              <SummitSchematic
                p5m={state.p5m}
                statusOf={state.statusOf}
                onUnit={openUnit}
                onCluster={setHelp}
                onInteract={(active) => setScrollOn(!active)}
              />
              <Text className="mt-1 text-center text-[11px] text-gray-400">{t('gloria.zoom.hint')}</Text>
            </Card>
            <View className="flex-row flex-wrap gap-3">
              {(['none', 'progress', 'done', 'warn'] as const).map((k) => (
                <View key={k} className="flex-row items-center">
                  <View className="mr-1 h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: STATUS_COLOR[k] }} />
                  <Text className="text-[11px] text-gray-500 dark:text-gray-400">{t(`gloria.status.${k}`)}</Text>
                </View>
              ))}
              <Text className="text-[11px] text-gray-500 dark:text-gray-400">{t('gloria.unitsDone', { done, total: 28 })}</Text>
            </View>
            {state.issues.length > 0 ? (
              <Card>
                {state.issues.slice(0, 30).map((i, k) => (
                  <Pressable
                    key={k}
                    onPress={() => (i.kind === 'p5m' ? setTab('points') : openUnit(i.unit))}
                    className={`flex-row items-center px-3 py-2 active:bg-gray-50 dark:active:bg-gray-800 ${k ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
                  >
                    <Text className="w-12 text-xs font-bold text-red-600 dark:text-red-400">{i.unit}</Text>
                    <Text className="flex-1 text-xs text-gray-700 dark:text-gray-300">{issueText(t, i)}</Text>
                    <Ionicons name="chevron-forward" size={14} color="#9ca3af" />
                  </Pressable>
                ))}
              </Card>
            ) : null}
            {unitList(t('gloria.list.quadrats'), QUADRAT_CODES, 'required')}
            {unitList(t('gloria.list.sas'), SAS_CODES, 'required')}
            {unitList(t('gloria.list.squares'), SQUARE_CODES, 'optional')}
            <FormScans state={state} reload={reload} form="2" />
            <FormScans state={state} reload={reload} form="3" />
            <FormScans state={state} reload={reload} form="6S" />
          </>
        ) : null}

        {tab === 'species' ? <SpeciesMatrix state={state} onUnit={openUnit} /> : null}
        {tab === 'photos' ? <PhotoChecklist state={state} reload={reload} /> : null}
        {tab === 'loggers' ? (
          <LoggerVisitList
            summitId={state.summit.id}
            surveyId={state.survey.id}
            onlyMocy={state.survey.mocy}
            researchers={state.survey.recorded_by}
          />
        ) : null}
      </ScrollView>
      <RecordStepBar kind="gloria" id={id} />
      <NumAccessory />

      {help ? (
        // Anchored in the screen, not a Modal: nothing to type here, and a
        // Modal would sit above the app's toast host.
        <Pressable onPress={() => setHelp(null)} className="absolute inset-0 justify-end bg-black/35">
          <Pressable onPress={() => undefined} className="gap-2 rounded-t-2xl bg-white p-4 pb-8 dark:bg-gray-900">
            <View className="flex-row items-center">
              <Text className="flex-1 text-base font-bold text-gray-900 dark:text-gray-100">
                {t('gloria.p5m.title', { direction: help })}
              </Text>
              <Btn small label={t('common.close')} onPress={() => setHelp(null)} />
            </View>
            <P5mDiagram direction={help} corner={state.p5m[help] ?? '11'} measure={measure} />
            <Text className="text-xs text-gray-600 dark:text-gray-300">
              {state.p5m[help]
                ? t('gloria.p5m.explain', { point: help + state.p5m[help] })
                : t('gloria.p5m.notSet', { direction: help })}
            </Text>
          </Pressable>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}
