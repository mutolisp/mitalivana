/**
 * One MIREN survey (a route in one year): the site × plot matrix with each
 * plot's state, the next plot to do, survey-level fields, and ending /
 * reopening the survey.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { confirmReopenOver } from '~/lib/recordCreate';
import {
  deleteMirenSurvey,
  endMirenSurvey,
  listPlots,
  reopenMirenSurvey,
  surveyContext,
  updateMirenSurvey,
  type MirenPlotWithSite,
} from '~/modules/miren/db';
import { useActiveMiren } from '~/modules/miren/store';
import { PLOT_NUMBERS, formatSiteCode } from '~/modules/miren/model/codes';
import { nextPlot, plotState, type PlotState } from '~/modules/miren/model/survey';
import { TextBlock, TextCommit, FieldRow } from '~/modules/miren/components/fields';
import { Btn, Card, Label, Seg } from '~/modules/gloria/components/ui';

const STATE_STYLE: Record<PlotState, string> = {
  todo: 'border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900',
  blind: 'border-amber-500 bg-amber-100 dark:bg-amber-900/50',
  recheck: 'border-orange-600 bg-orange-100 dark:bg-orange-900/50',
  done: 'border-emerald-600 bg-emerald-600',
  skip: 'border-gray-300 bg-gray-200 dark:border-gray-700 dark:bg-gray-800',
};

export default function MirenSurveyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [ctx, setCtx] = useState(() => surveyContext(id));
  const [plots, setPlots] = useState<MirenPlotWithSite[]>(() => listPlots(id));
  const [descending, setDescending] = useState(false);
  const reload = useCallback(() => {
    setCtx(surveyContext(id));
    setPlots(listPlots(id));
    useActiveMiren.getState().refresh();
  }, [id]);
  useFocusEffect(reload);

  if (!ctx) {
    return <Text className="p-4 text-gray-500">{t('miren.notFound')}</Text>;
  }
  const { survey, route, regionCode } = ctx;
  const bySite = new Map<number, MirenPlotWithSite[]>();
  for (const p of plots) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p]);
  const siteRows = [...bySite.values()].sort((a, b) => (descending ? b[0].site_no - a[0].site_no : a[0].site_no - b[0].site_no));
  const states = plots.map(plotState);
  const sampled = states.filter((s) => s !== 'skip').length;
  const done = states.filter((s) => s === 'done').length;
  const next = nextPlot(plots, descending);
  const active = survey.status === 'active';

  const toggleStatus = async () => {
    if (active) {
      const chosen = await chooseEndTime(survey.stop_ts);
      if (chosen === undefined) return;
      endMirenSurvey(survey.id, chosen);
    } else {
      // Reopening ends any open record: ask first (code review N2).
      if (!(await confirmReopenOver())) return;
      reopenMirenSurvey(survey.id);
    }
    reload();
  };
  const remove = () =>
    Alert.alert(t('miren.survey.deleteTitle'), t('miren.survey.deleteMsg', { year: survey.year }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteMirenSurvey(survey.id);
          useActiveMiren.getState().refresh();
          router.back();
        },
      },
    ]);

  return (
    <>
      <Stack.Screen options={{ title: `${regionCode}.${route.code} · ${survey.year}` }} />
      <ScrollView className="flex-1 bg-gray-50 dark:bg-gray-950" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-gray-700 dark:text-gray-300">{t('miren.survey.progress', { done, total: sampled })}</Text>
          <Text className={`text-xs font-semibold ${active ? 'text-emerald-600' : 'text-gray-500'}`}>{t(active ? 'miren.survey.active' : 'miren.survey.done')}</Text>
        </View>
        <View className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
          <View className="h-full bg-emerald-600" style={{ width: `${sampled ? (done / sampled) * 100 : 0}%` }} />
        </View>
        {next ? (
          <Btn
            primary
            label={t('miren.survey.continue', { code: `${formatSiteCode(regionCode, route.code, next.site_no, next.suffix)}.${next.plot_no}` })}
            onPress={() => router.push(`/miren/plot/${next.id}` as Href)}
          />
        ) : null}

        <View className="flex-row items-center justify-between">
          <Label>{t('miren.survey.matrix')}</Label>
          <View className="w-44">
            <Seg
              value={descending ? 'down' : 'up'}
              onChange={(v) => setDescending(v === 'down')}
              options={[
                { value: 'up', label: t('miren.survey.lowFirst') },
                { value: 'down', label: t('miren.survey.highFirst') },
              ]}
            />
          </View>
        </View>
        <Card className="p-2">
          <View className="flex-row px-1 pb-1">
            <Text className="w-24 text-[11px] text-gray-500">{t(route.kind === 'road' ? 'miren.survey.site' : 'miren.survey.transect')}</Text>
            {PLOT_NUMBERS[route.kind].map((n) => (
              <Text key={n} className="flex-1 text-center text-[11px] text-gray-500">
                {n}
              </Text>
            ))}
          </View>
          {siteRows.map((row) => (
            <View key={row[0].site_id} className="flex-row items-center px-1 py-0.5">
              <Text className="w-24 font-mono text-xs text-gray-800 dark:text-gray-200">{`${String(row[0].site_no).padStart(2, '0')}${row[0].suffix}${row[0].elev != null ? ` · ${Math.round(row[0].elev)}` : ''}`}</Text>
              {PLOT_NUMBERS[route.kind].map((n) => {
                const p = row.find((x) => x.plot_no === n && x.visit === 1);
                if (!p) return <View key={n} className="mx-0.5 h-9 flex-1" />;
                const s = plotState(p);
                return (
                  <Pressable
                    key={n}
                    onPress={() => router.push(`/miren/plot/${p.id}` as Href)}
                    accessibilityRole="button"
                    accessibilityLabel={`${String(p.site_no).padStart(2, '0')}.${n} ${t(`miren.state.${s}`)}`}
                    className={`mx-0.5 h-9 flex-1 items-center justify-center rounded-md border ${STATE_STYLE[s]}`}
                  >
                    <Text className={`text-[11px] ${s === 'done' ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-200'}`}>
                      {s === 'skip' ? '–' : p.species_count || ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </Card>
        <View className="flex-row flex-wrap gap-x-3 gap-y-1">
          {(['todo', 'blind', 'recheck', 'done', 'skip'] as const).map((s) => (
            <View key={s} className="flex-row items-center gap-1">
              <View className={`h-3 w-3 rounded-sm border ${STATE_STYLE[s]}`} />
              <Text className="text-[11px] text-gray-500 dark:text-gray-400">{t(`miren.state.${s}`)}</Text>
            </View>
          ))}
        </View>

        <Label>{t('miren.survey.base')}</Label>
        <Card className="gap-0.5 p-3">
          <FieldRow label={t('miren.survey.observers')} hint={t('miren.survey.observersHint')}>
            <TextCommit value={survey.recorded_by} onCommit={(v) => (updateMirenSurvey(survey.id, { recorded_by: v }), reload())} accessibilityLabel={t('miren.survey.observers')} />
          </FieldRow>
        </Card>
        <Label>{t('miren.survey.literature')}</Label>
        <TextBlock
          value={survey.literature}
          onCommit={(v) => (updateMirenSurvey(survey.id, { literature: v }), reload())}
          placeholder={ctx.region.default_literature ?? undefined}
          accessibilityLabel={t('miren.survey.literature')}
        />
        <Label>{t('miren.survey.notes')}</Label>
        <TextBlock value={survey.notes} onCommit={(v) => (updateMirenSurvey(survey.id, { notes: v }), reload())} accessibilityLabel={t('miren.survey.notes')} />

        <Btn label={t(active ? 'miren.survey.end' : 'miren.survey.reopen')} onPress={() => void toggleStatus()} />
        <Btn label={t('miren.survey.deleteTitle')} onPress={remove} />
      </ScrollView>
    </>
  );
}
