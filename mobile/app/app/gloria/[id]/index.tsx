/**
 * GLORIA survey overview: base data (measurement points), summit schematic,
 * and the summit species table. Units open from the schematic or the list.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { BackHeaderLeft } from '~/lib/goBack';
import { RecordStepBar } from '~/components/RecordStepBar';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { endGloriaSurvey, reopenGloriaSurvey } from '~/modules/gloria/db';
import { useActiveGloria } from '~/modules/gloria/store';
import { useSurvey, STATUS_COLOR } from '~/modules/gloria/useSurvey';
import { issueText } from '~/modules/gloria/issues';
import { DIRECTIONS, QUADRAT_CODES, SAS_CODES, SQUARE_CODES, type Direction } from '~/modules/gloria/model/units';
import { PointsForm } from '~/modules/gloria/components/PointsForm';
import { SummitForm } from '~/modules/gloria/components/SummitForm';
import { P5mDiagram, SummitSchematic } from '~/modules/gloria/components/SummitSchematic';
import { SpeciesMatrix } from '~/modules/gloria/components/SpeciesMatrix';
import { Btn, Card, Label, NumAccessory, Seg } from '~/modules/gloria/components/ui';

type Tab = 'points' | 'map' | 'species';

export default function GloriaSurveyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const { state, reload } = useSurvey(id);
  const [tab, setTab] = useState<Tab>(() => (state && state.points.every((p) => p.distance_m == null) ? 'points' : 'map'));
  const [help, setHelp] = useState<Direction | null>(null);

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
    Alert.alert(t('gloria.endTitle'), n ? t('gloria.endWithIssues', { count: n }) : t('gloria.endMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('session.end'),
        style: 'destructive',
        onPress: () => {
          endGloriaSurvey(id);
          refreshStores();
          reload();
        },
      },
    ]);
  };
  const done = state.units.filter((u) => state.statusOf(u.code) === 'done').length;

  const unitList = (title: string, codes: readonly string[]) => (
    <View className="gap-1.5">
      <Label>{title}</Label>
      <View className="flex-row flex-wrap">
        {codes.map((c) => (
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
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: `${summit.full_code} · mocy ${survey.mocy}`,
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <HeaderIconButton
              icon={active ? 'stop-circle-outline' : 'refresh-outline'}
              tone={active ? 'danger' : 'default'}
              label={active ? t('session.end') : t('plot.reopen')}
              onPress={toggleEnd}
            />
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
          ]}
        />
      </View>
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {tab === 'points' ? (
          <>
            <SummitForm state={state} reload={reload} />
            <PointsForm state={state} reload={reload} onHelp={setHelp} />
          </>
        ) : null}

        {tab === 'map' ? (
          <>
            <View className="flex-row flex-wrap gap-1.5">
              {DIRECTIONS.map((d) => (
                <Pressable key={d} onPress={() => setHelp(d)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 dark:border-gray-700 dark:bg-gray-900">
                  <Text className="text-xs text-gray-700 dark:text-gray-300">
                    p5m <Text className="font-bold text-[#00797b] dark:text-cyan-300">{state.p5m[d] ? d + state.p5m[d] : `${d}?`}</Text>
                  </Text>
                </Pressable>
              ))}
            </View>
            <Card className="p-2">
              <SummitSchematic p5m={state.p5m} statusOf={state.statusOf} onUnit={openUnit} onCluster={setHelp} />
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
            {unitList(t('gloria.list.quadrats'), QUADRAT_CODES)}
            {unitList(t('gloria.list.sas'), SAS_CODES)}
            {unitList(t('gloria.list.squares'), SQUARE_CODES)}
          </>
        ) : null}

        {tab === 'species' ? <SpeciesMatrix state={state} onUnit={openUnit} /> : null}
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
