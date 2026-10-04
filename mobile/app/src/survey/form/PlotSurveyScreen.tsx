/**
 * A plot-style survey drawn with the fixed plot's screen (2G-d; Modular_survey.md
 * §9): the same header (the name over the diversity summary, ⋯, lock, 結束 /
 * 繼續), the same tabs (環境, 物種 n, then the units) switched by tab or by a
 * horizontal swipe between 環境 and 物種, and the template's components in the
 * fixed plot's blocks (PlotSurveyEnvTab, PlotSurveySpeciesTab).
 *
 * Kept from the survey screen it replaces (Phase 2C): the template upgrade
 * banner and the blind phase of a recheck. The first unit level is the
 * environment tab's 小區; a second level gets the fixed plot's 小樣方 tab
 * (PlotSurveyQuadratsTab, 2G-d4); a third and below are reached from a
 * quadrat, on the unit page.
 */
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { plotStatsSummary } from '~/components/PlotDiversityCard';
import { PlotHeaderTitle } from '~/components/plot/PlotHeaderTitle';
import { TabBtn } from '~/components/plot/TabBtn';
import { RecordEditButtons } from '~/components/RecordEditButtons';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { SwipeBlockProvider, SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { onVersionRestored, saveVersionSoon } from '~/db/recordVersions';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { BackHeaderLeft } from '~/lib/goBack';
import { confirmReopenOver } from '~/lib/recordCreate';
import { isPreviewId } from '~/db/previewDb';
import { isRecordingTarget, pauseIfNot, pauseRecording } from '~/lib/trackRecorder';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { closeBlindPhase, deleteSurvey, finishSurvey, reopenBlindPhase, reopenSurvey, updateSurvey, upgradeSurvey } from '~/survey/db/surveys';
import { useActiveSurvey } from './activeSurvey';
import { surveyDataStatus } from './surveyGroups';
import { PlotSurveyEnvTab } from './PlotSurveyEnvTab';
import { PlotSurveyFreqTab } from './PlotSurveyFreqTab';
import { PlotSurveyQuadratsTab } from './PlotSurveyQuadratsTab';
import { formComponents } from './occurrenceForm';
import { PlotSurveySpeciesTab } from './PlotSurveySpeciesTab';
import { formErrorText, levelLabel } from './text';
import { useSurveyForm } from './useSurveyForm';
import { plotSurveyTab, setPlotSurveyTab, surveyView, setSurveyView, type PlotSurveyTab, type UnitPick } from './viewState';

const refreshStores = () => {
  useActiveSurvey.getState().refresh();
  useActiveSession.getState().refresh();
  useActivePlot.getState().refresh();
  useActiveGloria.getState().refresh();
  useActiveMiren.getState().refresh();
};

export function PlotSurveyScreen({ id }: { id: number }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { data, reload: load } = useSurveyForm(id);
  const survey = data?.survey ?? null;
  useVersionOnLeave('modular', id);
  const edit = useRecordEditing('modular', id, survey?.status === 'done');
  const { checkpoint, absorb } = edit;
  // Bumped after an undo / redo or a restored version: the tabs keep drafts and remount to read again.
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);
  const reloadQuiet = useCallback(() => {
    load();
    absorb();
  }, [load, absorb]);
  useEffect(
    () =>
      onVersionRestored((kind, rid) => {
        if (kind !== 'modular' || rid !== id) return;
        setRev((n) => n + 1);
        load();
      }),
    [id, load],
  );

  const [tab, setTabState] = useState<PlotSurveyTab>(() => plotSurveyTab(id) ?? 'env');
  const selectTab = (next: PlotSurveyTab) => {
    setTabState(next);
    setPlotSurveyTab(id, next);
  };
  // Where the species tab adds and lists: a unit page may have sent the user here to record in that unit.
  const [scope, setScopeState] = useState<UnitPick>(() => surveyView(id)?.unit ?? 'all');
  const setScope = (next: UnitPick) => {
    setScopeState(next);
    setSurveyView(id, { unit: next });
    if (survey?.status === 'active') useActiveSurvey.getState().setUnit(id, typeof next === 'number' ? next : null);
  };
  useFocusEffect(
    useCallback(() => {
      const v = surveyView(id);
      if (v?.tab === 'species' && typeof v.unit === 'number') {
        setScopeState(v.unit);
        setTabState('species');
        setSurveyView(id, { tab: 'data' });
      }
    }, [id]),
  );
  const units = data?.units;
  // 'all' (or a unit gone) means the first unit, as the fixed plot opens on its first subplot.
  const shownScope: UnitPick = !units?.length ? 'none' : typeof scope === 'number' && units.some((u) => u.unit.id === scope) ? scope : scope === 'none' ? 'none' : units[0].unit.id;
  // Quick adds from other screens go to the unit picked here while this survey is open.
  useFocusEffect(
    useCallback(() => {
      if (survey?.status === 'active') useActiveSurvey.getState().setUnit(id, typeof shownScope === 'number' ? shownScope : null);
    }, [survey?.status, id, shownScope]),
  );

  const statsExpanded = useSettings((s) => s.plot_stats_expanded);
  const dataLayout = useSettings((s) => s.survey_data_layout);
  const setSetting = useSettings((s) => s.set);
  const statsLine = useMemo(() => plotStatsSummary((data?.occurrences ?? []).filter((o) => !o.via_interaction)), [data]);
  const tabNav = useSwipeNav({ onStep: (dir) => selectTab(dir === 1 ? 'species' : 'env'), hasPrev: tab === 'species', hasNext: tab === 'env' });

  if (!data || !survey) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { template } = data;
  const isActive = survey.status === 'active';
  const blindOpen = !!data.recheck && survey.blind_closed_at == null;
  const counted = data.occurrences.filter((o) => !o.via_interaction).length;
  // The 頻度 tab exists when the template puts Frequency on its occurrences (the fixed plot's switch).
  const freqComp = formComponents(template, 'occurrence').find((x) => x.type === 'frequency') ?? null;
  const freqTally = {
    done: data.occurrences.filter((o) => !o.via_interaction && (o.freq_cells?.includes('1') || (o.freq_count ?? 0) > 0)).length,
    total: counted,
  };
  const shownTab: PlotSurveyTab = (tab === 'quadrats' && data.levelKeys.length < 2) || (tab === 'freq' && !freqComp) ? 'env' : tab;

  const finish = async () => {
    // Counted at the last read (2G-e): an occurrence with a value that does not fit, or 必填未填; and the survey's own 必填.
    const errors = data.occurrences.filter((o) => !o.via_interaction && data.errorIds.has(o.id)).length;
    const dataMissing = surveyDataStatus(template, data.surveyValues, survey).missing;
    const open = data.recheckState?.open ?? 0;
    const chosen = await chooseEndTime(survey.stop_ts, {
      title: t('surveyForm.finish.title'),
      note:
        [
          blindOpen ? t('surveyForm.finish.blindOpen') : null,
          open > 0 ? t('surveyForm.finish.recheckOpen', { count: open }) : null,
          errors > 0 ? t('surveyForm.finish.errors', { count: errors }) : null,
          dataMissing > 0 ? t('surveyForm.finish.dataMissing', { count: dataMissing }) : null,
        ]
          .filter(Boolean)
          .join('\n') || undefined,
    });
    if (chosen === undefined) return;
    if (isRecordingTarget({ kind: 'modular', id })) pauseRecording();
    finishSurvey(id, chosen);
    saveVersionSoon('modular', id, 'done');
    refreshStores();
    reload();
  };

  const reopen = async () => {
    // A builder preview reopens in its scratch file only: no other record to end.
    if (!isPreviewId(id) && !(await confirmReopenOver())) return;
    pauseIfNot({ kind: 'modular', id });
    reopenSurvey(id);
    refreshStores();
    reload();
  };

  const rename = async () => {
    if (edit.refuse()) return;
    const name = await promptText({ title: t('surveyForm.rename'), defaultValue: survey.name ?? '', autoCapitalize: 'none' });
    if (!name?.trim()) return;
    updateSurvey(id, { name: name.trim() });
    refreshStores();
    reload();
  };

  const endBlind = () =>
    Alert.alert(t('surveyForm.blind.endTitle'), t('surveyForm.blind.endMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('surveyForm.blind.end'),
        onPress: () => {
          closeBlindPhase(id);
          reload();
          router.push(`/survey/form/${id}/recheck` as Href);
        },
      },
    ]);

  const upgrade = () => {
    const to = data.upgradeTo;
    if (!to) return;
    Alert.alert(t('builder.upgrade.title'), t('surveyForm.upgrade.msg', { n: to.version }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.upgrade.go'),
        onPress: () => {
          try {
            upgradeSurvey(id, to);
          } catch (e) {
            toast(formErrorText(t, e));
          }
          reload();
        },
      },
    ]);
  };

  const remove = () =>
    Alert.alert(t('surveyForm.deleteTitle'), `${t('surveyForm.deleteMsg', { name: survey.name ?? '', count: data.occurrences.length })}\n\n${t('records.deleteRecoverable')}`, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (isRecordingTarget({ kind: 'modular', id })) pauseRecording();
          deleteSurvey(id);
          refreshStores();
          router.back();
        },
      },
    ]);

  const menuExtra = [
    { label: t('surveyForm.rename'), onPress: () => void rename() },
    // 調查資料 is on the environment tab: one page, or a list of group pages (shared setting).
    ...(shownTab === 'env'
      ? [
          {
            label: t(dataLayout === 'single' ? 'surveyForm.layout.toGrouped' : 'surveyForm.layout.toSingle'),
            icon: dataLayout === 'single' ? ('list-outline' as const) : ('reader-outline' as const),
            onPress: () => setSetting('survey_data_layout', dataLayout === 'single' ? 'grouped' : 'single'),
          },
        ]
      : []),
    ...(blindOpen && !edit.locked ? [{ label: t('surveyForm.blind.end'), onPress: endBlind }] : []),
    ...(data.recheck && survey.blind_closed_at != null ? [{ label: t('surveyForm.recheck.open'), onPress: () => router.push(`/survey/form/${id}/recheck` as Href) }] : []),
    ...(data.recheck && survey.blind_closed_at != null && !edit.locked
      ? [
          {
            label: t('surveyForm.blind.reopen'),
            onPress: () => {
              try {
                reopenBlindPhase(id);
              } catch (e) {
                Alert.alert(t('surveyForm.blind.reopen'), formErrorText(t, e));
              }
              reload();
            },
          },
        ]
      : []),
  ];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          headerTitle: () => (
            <PlotHeaderTitle
              plotid={survey.name ?? ''}
              stats={tab === 'species' ? statsLine : null}
              expanded={statsExpanded}
              onToggle={() => setSetting('plot_stats_expanded', !statsExpanded)}
            />
          ),
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <View className="flex-row items-center gap-3">
              <RecordMenuButton
                kind="modular"
                id={id}
                extra={menuExtra}
                last={[{ label: t('surveyForm.deleteTitle'), icon: 'trash-outline', destructive: true, onPress: remove }]}
                edit={edit}
                onEdited={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
                onSynced={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
              />
              <RecordEditButtons
                edit={edit}
                ended={!isActive}
                onChanged={() => {
                  setRev((n) => n + 1);
                  reload();
                }}
                inMenu
              />
              {!isActive && !edit.locked ? null : (
                <HeaderIconButton
                  icon={isActive ? 'stop-circle-outline' : 'refresh-outline'}
                  tone={isActive ? 'danger' : 'default'}
                  label={isActive ? t('session.end') : t('plot.reopen')}
                  onPress={() => void (isActive ? finish() : reopen())}
                />
              )}
            </View>
          ),
        }}
      />
      <View className="flex-row border-b border-gray-200 bg-card dark:border-gray-700 dark:bg-gray-900">
        <TabBtn label={t('plot.tabEnv')} active={shownTab === 'env'} onPress={() => selectTab('env')} />
        <TabBtn label={`${t('plot.tabSpecies')} ${counted > 0 ? counted : ''}`} active={shownTab === 'species'} onPress={() => selectTab('species')} />
        {freqComp ? <TabBtn label={`${t('plot.tabFreq')} ${freqTally.done}/${freqTally.total}`} active={shownTab === 'freq'} onPress={() => selectTab('freq')} /> : null}
        {data.levelKeys.length >= 2 ? (
          <TabBtn
            label={`${levelLabel(t, i18n.language, template, data.levelKeys[1])} ${data.units.filter((u) => u.unit.level_key === data.levelKeys[1]).length}`}
            active={shownTab === 'quadrats'}
            onPress={() => selectTab('quadrats')}
          />
        ) : null}
      </View>
      {data.upgradeTo && !edit.locked ? (
        <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
          <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">{t('surveyForm.upgrade.banner', { n: data.upgradeTo.version })}</Text>
          <Button label={t('builder.upgrade.go')} variant="secondary" onPress={upgrade} />
        </View>
      ) : null}
      {data.recheck ? (
        <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
          <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">
            {blindOpen ? t('surveyForm.blind.banner') : t('surveyForm.recheck.banner', { count: data.recheckState?.open ?? 0 })}
          </Text>
          {blindOpen ? (
            !edit.locked ? <Button label={t('surveyForm.blind.end')} variant="secondary" onPress={endBlind} /> : null
          ) : (
            <Button label={t('surveyForm.recheck.open')} variant="secondary" onPress={() => router.push(`/survey/form/${id}/recheck` as Href)} />
          )}
        </View>
      ) : null}
      <SwipeBlockProvider nav={tabNav}>
        <SwipeNavArea nav={tabNav}>
          {shownTab === 'env' ? <PlotSurveyEnvTab key={rev} data={data} edit={edit} onChanged={reload} /> : null}
          {shownTab === 'species' ? (
            <PlotSurveySpeciesTab key={rev} data={data} edit={edit} scope={shownScope} onScope={setScope} onChanged={reload} onChangedQuiet={reloadQuiet} />
          ) : null}
          {shownTab === 'freq' && freqComp ? (
            <PlotSurveyFreqTab
              key={rev}
              data={data}
              edit={edit}
              freq={freqComp}
              scope={shownScope}
              onScope={setScope}
              onChanged={reload}
              onGoSpecies={() => selectTab('species')}
            />
          ) : null}
          {shownTab === 'quadrats' ? <PlotSurveyQuadratsTab data={data} edit={edit} onChanged={reload} /> : null}
        </SwipeNavArea>
      </SwipeBlockProvider>
    </SafeAreaView>
  );
}
