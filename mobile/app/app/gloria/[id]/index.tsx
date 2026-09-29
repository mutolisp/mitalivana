/**
 * GLORIA survey overview: base data (measurement points), summit schematic,
 * and the summit species table. Units open from the schematic or the list.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { BackHeaderLeft } from '~/lib/goBack';
import { RecordStepBar } from '~/components/RecordStepBar';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { endGloriaSurvey, reopenGloriaSurvey } from '~/modules/gloria/db';
import { useActiveGloria } from '~/modules/gloria/store';
import { useSurvey, type SurveyState } from '~/modules/gloria/useSurvey';
import { statusLook } from '~/modules/gloria/statusColors';
import { EndRecordButton } from '~/components/EndRecordButton';
import { issueText } from '~/modules/gloria/issues';
import { QUADRAT_CODES, SAS_CODES, SQUARE_CODES, type Direction } from '~/modules/gloria/model/units';
import { LoggerVisitList } from '~/modules/gloria/components/LoggerVisitList';
import { BaseDataTab } from '~/modules/gloria/components/BaseDataTab';
import { startPointImport } from '~/modules/gloria/summitImportFile';
import { errText } from '~/lib/errText';
import { P5mDiagram, SummitSchematic } from '~/modules/gloria/components/SummitSchematic';
import { SpeciesMatrix } from '~/modules/gloria/components/SpeciesMatrix';
import { missingRequiredPhotos, PhotoChecklist } from '~/modules/gloria/components/PhotoChecklist';
import { Btn, Card, Label, LineTabs, NumAccessory } from '~/modules/gloria/components/ui';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { saveVersionSoon } from '~/db/recordVersions';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useThemeColors } from '~/theme/colors';

type Tab = 'points' | 'map' | 'species' | 'photos' | 'loggers';

/** E N S W: the Taiwan sheet's order, used on the whole page. */
const DIRS: readonly Direction[] = ['E', 'N', 'S', 'W'];
/** One direction's units: four 1×1 m quadrats, two SAS sections, one 10×10 m square. */
const unitsOf = (d: Direction) => [...QUADRAT_CODES, ...SAS_CODES, ...SQUARE_CODES].filter((c) => c[0] === d);

export default function GloriaSurveyScreen() {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  useVersionOnLeave('gloria', id);
  const { state, reload } = useSurvey(id);
  const [tab, setTab] = useState<Tab>(() => (state && state.points.every((p) => p.distance_m == null) ? 'points' : 'map'));
  const [help, setHelp] = useState<Direction | null>(null);
  // The direction the unit list shows: start where work is left.
  const [dir, setDir] = useState<Direction>(() =>
    state ? (DIRS.find((d) => unitsOf(d).some((c) => state.statusOf(c) !== 'done')) ?? 'E') : 'E',
  );
  const [allIssues, setAllIssues] = useState(false);
  const insets = useSafeAreaInsets();
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
  const openCluster = (d: Direction) => {
    setDir(d);
    setHelp(d);
  };
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

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: `${summit.full_code} · mocy ${survey.mocy}`,
          headerTitle: () => (
            <HeaderTitleText
              mono
              text={`${summit.full_code} · mocy ${survey.mocy}`}
              subtitle={
                <View className="flex-row items-center">
                  <View className={`mr-1.5 h-2 w-2 rounded-full ${active ? 'bg-accent-600 dark:bg-accent-400' : 'bg-gray-400'}`} />
                  <Text
                    numberOfLines={1}
                    className={`text-xs font-medium ${active ? 'text-accent-600 dark:text-accent-400' : 'text-gray-500 dark:text-gray-400'}`}
                    style={{ fontVariant: ['tabular-nums'] }}
                  >
                    {active ? t('gloria.statusActive', { done, total: 28 }) : t('session.ended')}
                  </Text>
                </View>
              }
            />
          ),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton kind="gloria" id={id} reportHref={`/report/gloria/${id}` as Href} onSynced={reload} />
              {active ? (
                <EndRecordButton onPress={toggleEnd} />
              ) : (
                <HeaderIconButton icon="refresh-outline" label={t('session.continueEdit')} onPress={toggleEnd} />
              )}
            </View>
          ),
        }}
      />
      <ProgressStrip state={state} />
      <LineTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'map', label: t('gloria.tab.map') },
          { value: 'points', label: t('gloria.tab.points') },
          { value: 'species', label: t('gloria.tab.species') },
          { value: 'photos', label: t('gloria.tab.photos') },
          { value: 'loggers', label: t('gloria.tab.loggers') },
        ]}
      />
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets scrollEnabled={scrollOn}>
        {tab === 'points' ? (
          <BaseDataTab
            state={state}
            reload={reload}
            onHelp={setHelp}
            onPointImport={() =>
              void startPointImport(
                id,
                () => router.push(`/gloria/${id}/points-import` as Href),
                (e) => Alert.alert(t('gloria.summitImport.readFail'), errText(e)),
              )
            }
          />
        ) : null}

        {tab === 'map' ? (
          <>
            {/* p5m per direction, E N S W as on the Taiwan sheet. A set one
                opens its 3×3 m panel; a missing one is red and goes to the
                base-data tab where it is chosen. */}
            <View className="flex-row flex-wrap gap-1.5">
              {DIRS.map((d) =>
                state.p5m[d] ? (
                  <Pressable
                    key={d}
                    onPress={() => openCluster(d)}
                    accessibilityRole="button"
                    className="rounded-lg border border-line bg-card px-2.5 py-1.5 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
                  >
                    <Text className="text-xs text-gray-700 dark:text-gray-300">
                      p5m <Text className="font-bold text-accent-700 dark:text-accent-300">{d + state.p5m[d]}</Text>
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    key={d}
                    onPress={() => setTab('points')}
                    accessibilityRole="button"
                    accessibilityLabel={t('gloria.p5m.notSet', { direction: d })}
                    className="rounded-lg border-[1.5px] border-dashed border-alert px-2.5 py-1.5 dark:border-alert-dark"
                  >
                    <Text className="text-xs font-bold text-alert dark:text-alert-dark">{`${d} ?`}</Text>
                  </Pressable>
                ),
              )}
            </View>
            <Card className="p-2">
              <SummitSchematic
                p5m={state.p5m}
                statusOf={state.statusOf}
                selected={dir}
                onDirection={setDir}
                onCluster={openCluster}
                onInteract={(active) => setScrollOn(!active)}
              />
              <Text className="mt-1 text-center text-[11px] text-gray-500 dark:text-gray-400">{t('gloria.zoom.hint')}</Text>
              <View className="mt-1.5 flex-row flex-wrap justify-center gap-x-3 gap-y-1">
                {(['none', 'progress', 'done', 'warn'] as const).map((k) => (
                  <View key={k} className="flex-row items-center">
                    <StatusSwatch status={k} />
                    <Text className="text-[11px] text-gray-600 dark:text-gray-400">{t(`gloria.status.${k}`)}</Text>
                  </View>
                ))}
                <View className="flex-row items-center">
                  <View className="mr-1.5 h-2 w-2 rounded-full bg-ink dark:bg-gray-100" />
                  <Text className="text-[11px] text-gray-600 dark:text-gray-400">p5m</Text>
                </View>
              </View>
            </Card>

            {state.issues.length > 0 ? (
              <Card>
                <Text className="px-3 pb-1 pt-2.5 text-xs font-bold text-alert dark:text-alert-dark">
                  {t('gloria.pending', { count: state.issues.length })}
                </Text>
                {(allIssues ? state.issues : state.issues.slice(0, 5)).map((i, k) => (
                  <Pressable
                    key={k}
                    onPress={() => (i.kind === 'p5m' ? setTab('points') : openUnit(i.unit))}
                    className="flex-row items-center border-t border-line px-3 py-2 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
                  >
                    <View className="mr-2.5 rounded bg-alert px-1.5 py-0.5 dark:bg-alert-dark">
                      <Text className="text-xs font-bold text-white dark:text-gray-950">{i.unit}</Text>
                    </View>
                    <Text className="flex-1 text-xs text-gray-700 dark:text-gray-300">{issueText(t, i)}</Text>
                    <Ionicons name="chevron-forward" size={14} color={tc.ink3} />
                  </Pressable>
                ))}
                {!allIssues && state.issues.length > 5 ? (
                  <Pressable
                    onPress={() => setAllIssues(true)}
                    accessibilityRole="button"
                    className="items-center border-t border-line py-2.5 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
                  >
                    <Text className="text-sm font-medium text-accent-600 dark:text-accent-400">
                      {t('gloria.pendingAll', { count: state.issues.length })}
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            ) : null}

            {/* Round the summit one direction at a time: the list shows only
                this direction's units, all three types together. */}
            <View className="flex-row rounded-xl border border-line bg-card p-1 dark:border-line-dark dark:bg-card-dark">
              {DIRS.map((d) => {
                const codes = unitsOf(d);
                const doneN = codes.filter((c) => state.statusOf(c) === 'done').length;
                const warn = codes.some((c) => state.statusOf(c) === 'warn');
                const on = d === dir;
                return (
                  <Pressable
                    key={d}
                    onPress={() => setDir(d)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    className={`flex-1 items-center rounded-lg py-1.5 ${on ? 'bg-accent-600 dark:bg-accent-400' : ''}`}
                    style={{ minHeight: 44 }}
                  >
                    <Text className={`text-sm font-bold ${on ? 'text-white dark:text-gray-950' : 'text-ink dark:text-gray-100'}`}>
                      {d}
                    </Text>
                    <Text
                      className={`text-[11px] ${
                        warn
                          ? on
                            ? 'font-bold text-alert-tint'
                            : 'font-bold text-alert dark:text-alert-dark'
                          : on
                            ? 'text-accent-100 dark:text-gray-800'
                            : 'text-gray-500 dark:text-gray-400'
                      }`}
                      style={{ fontVariant: ['tabular-nums'] }}
                    >
                      {`${doneN}/${codes.length}`}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <UnitGroup
              title={t('gloria.list.quadrats')}
              required
              codes={QUADRAT_CODES.filter((c) => c[0] === dir)}
              subtitle={(c) => (state.p5m[dir] && c === dir + state.p5m[dir] ? t('gloria.p5mCorner') : null)}
              state={state}
              onOpen={openUnit}
            />
            <UnitGroup
              title={t('gloria.list.sas')}
              required
              codes={SAS_CODES.filter((c) => c[0] === dir)}
              subtitle={(c) => t(c.endsWith('05') ? 'gloria.sas05' : 'gloria.sas10')}
              state={state}
              onOpen={openUnit}
            />
            <UnitGroup
              title={`${t('gloria.list.squares')} ${t('gloria.list.optional')}`}
              codes={SQUARE_CODES.filter((c) => c[0] === dir)}
              subtitle={() => null}
              state={state}
              onOpen={openUnit}
            />
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
          <Pressable
            onPress={() => undefined}
            className="gap-2 rounded-t-sheet bg-card p-4 dark:bg-card-dark"
            // The overlay is absolute, so the SafeAreaView's bottom edge does
            // not apply to it: clear the system navigation bar by hand.
            style={{ paddingBottom: insets.bottom + 16 }}
          >
            <View className="flex-row items-center">
              <Text className="flex-1 text-base font-bold text-gray-900 dark:text-gray-100">
                {t('gloria.p5m.title', { direction: help })}
              </Text>
              <Btn small label={t('common.close')} onPress={() => setHelp(null)} />
            </View>
            <P5mDiagram direction={help} corner={state.p5m[help] ?? '11'} measure={measure} statusOf={state.statusOf} />
            <Text className="text-xs text-gray-600 dark:text-gray-300">
              {state.p5m[help]
                ? t('gloria.p5m.explain', { point: help + state.p5m[help] })
                : t('gloria.p5m.notSet', { direction: help })}
            </Text>
            {/* The four 1×1 m quadrats, straight to their unit page. */}
            <View className="flex-row gap-2">
              {QUADRAT_CODES.filter((c) => c[0] === help).map((c) => {
                const look = statusLook(tc, state.statusOf(c));
                return (
                  <Pressable
                    key={c}
                    onPress={() => {
                      setHelp(null);
                      openUnit(c);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={c}
                    className="flex-1 items-center justify-center rounded-xl active:opacity-80"
                    style={{
                      minHeight: 48,
                      backgroundColor: look.fill,
                      ...(look.border ? { borderWidth: 1.5, borderColor: look.border } : null),
                    }}
                  >
                    <Text className="font-mono text-base font-bold" style={{ color: look.onFill }}>{c}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

/** A unit's status as a small box: filled, or outlined when not started. */
function StatusSwatch({ status }: { status: ReturnType<SurveyState['statusOf']> }) {
  const look = statusLook(useThemeColors(), status);
  return (
    <View
      className="mr-1.5 h-2.5 w-2.5 rounded-sm"
      style={{ backgroundColor: look.fill, ...(look.border ? { borderWidth: 1, borderColor: look.border } : null) }}
    />
  );
}

/**
 * Progress under the header (§4e): one bar per unit type, widths in the
 * 16 : 8 : 4 ratio of their unit counts. Moss is done, acorn is started or
 * flagged; the rest is empty.
 */
function ProgressStrip({ state }: { state: SurveyState }) {
  const { t } = useTranslation();
  const groups = [
    { key: 'quadrats', codes: QUADRAT_CODES, label: t('gloria.list.quadrats') },
    { key: 'sas', codes: SAS_CODES, label: t('gloria.list.sas') },
    { key: 'squares', codes: SQUARE_CODES, label: t('gloria.list.squares') },
  ];
  return (
    <View className="flex-row gap-1.5 border-b border-line bg-card px-4 pb-2 pt-1.5 dark:border-line-dark dark:bg-card-dark">
      {groups.map((g) => {
        const n = g.codes.length;
        const done = g.codes.filter((c) => state.statusOf(c) === 'done').length;
        const open = g.codes.filter((c) => {
          const st = state.statusOf(c);
          return st === 'progress' || st === 'warn';
        }).length;
        return (
          <View
            key={g.key}
            style={{ flex: n }}
            accessible
            accessibilityLabel={`${g.label} ${done}/${n}`}
          >
            <View className="h-1.5 flex-row overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <View className="bg-accent-600 dark:bg-accent-400" style={{ flex: done }} />
              <View className="bg-acorn" style={{ flex: open }} />
              <View style={{ flex: n - done - open }} />
            </View>
            <Text className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400" style={{ fontVariant: ['tabular-nums'] }}>
              {`${done}/${n}`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * One unit type's rows for the chosen direction: a code box in the status
 * colour, the status, and what this survey has in it (species count, or the
 * unit's first warning).
 */
function UnitGroup({
  title,
  required = false,
  codes,
  subtitle,
  state,
  onOpen,
}: {
  title: string;
  required?: boolean;
  codes: string[];
  /** A fixed note for the unit (p5m 角點, 5 m 區域); null for none. */
  subtitle: (code: string) => string | null;
  state: SurveyState;
  onOpen: (code: string) => void;
}) {
  const { t } = useTranslation();
  const tc = useThemeColors();
  return (
    <View className="gap-1.5">
      <Label>
        {title}
        {required ? <Text className="text-alert dark:text-alert-dark"> *</Text> : null}
      </Label>
      <Card>
        {codes.map((c, k) => {
          const st = state.statusOf(c);
          const look = statusLook(tc, st);
          const issue = state.issues.find((i) => i.unit === c);
          const n = state.speciesOf(c).length;
          const detail = [
            subtitle(c),
            issue ? issueText(t, issue) : n > 0 ? t('plotStats.sppCount', { count: n }) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              key={c}
              onPress={() => onOpen(c)}
              accessibilityRole="button"
              accessibilityLabel={`${c} ${t(`gloria.status.${st}`)}`}
              className={`flex-row items-center px-3 py-2 active:bg-gray-100 dark:active:bg-gray-800 ${k ? 'border-t border-line dark:border-line-dark' : ''}`}
              style={{ minHeight: 56 }}
            >
              <View
                className="mr-3 items-center justify-center rounded-md"
                style={{
                  width: 48,
                  height: 32,
                  backgroundColor: look.fill,
                  ...(look.border ? { borderWidth: 1.5, borderColor: look.border } : null),
                }}
              >
                <Text className="font-mono text-sm font-bold" style={{ color: look.onFill }}>{c}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold" style={{ color: look.text }}>{t(`gloria.status.${st}`)}</Text>
                {detail ? (
                  <Text numberOfLines={2} className={`text-xs ${issue ? 'text-alert dark:text-alert-dark' : 'text-gray-500 dark:text-gray-400'}`}>
                    {detail}
                  </Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={16} color={tc.ink3} />
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}
