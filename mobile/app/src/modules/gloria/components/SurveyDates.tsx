/**
 * The survey's start and end dates (sheet 01_), on the base-data tab, and
 * carrying dates between the survey and its 28 units either way
 * (model/surveyDates):
 *   - 從各樣區帶入: the earliest / latest unit time become the survey dates;
 *   - 帶入各樣區: units with no start get the survey's start date, date only.
 *     A unit that already has a start is never overwritten; one on another
 *     day is listed in the confirmation.
 * Only dates are edited here; the survey's clock times stay as recorded.
 */
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { DateTimeField } from '~/components/DateTimeField';
import { isoStamp } from '~/lib/datetime';
import { useToast } from '~/stores/toast';
import { fillUnitDates, setSurveyDates } from '../db';
import { onDay } from '../model/quadratTimes';
import { planUnitDates, surveyDatesFromUnits, unitTimeSpan } from '../model/surveyDates';
import type { SurveyState } from '../useSurvey';
import { Btn, Card, Label } from './ui';

const day = (ts: number) => isoStamp(ts).slice(0, 10);

export function SurveyDates({ state, reload }: { state: SurveyState; reload: () => void }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const sv = state.survey;
  const span = unitTimeSpan(state.units);

  const save = (start_ts: number, stop_ts: number | null) => {
    if (stop_ts != null && stop_ts < start_ts) {
      Alert.alert(t('gloria.dates.orderTitle'), t('gloria.dates.order'));
      return;
    }
    setSurveyDates(sv.id, { start_ts, stop_ts });
    reload();
  };

  const fromUnits = () => {
    if (!span) return;
    const next = surveyDatesFromUnits(sv, span);
    Alert.alert(t('gloria.dates.fromUnitsTitle'), t('gloria.dates.fromUnitsMsg', { start: day(next.start_ts), end: day(next.stop_ts) }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('gloria.dates.apply'), onPress: () => save(next.start_ts, next.stop_ts) },
    ]);
  };

  const toUnits = () => {
    const plan = planUnitDates(state.units, sv.start_ts);
    // One line per date (「2026-08-05  N11 N31 …」): shorter than a date per
    // unit, and unit codes separated by spaces read the same in every language.
    const byDay = new Map<string, string[]>();
    for (const u of plan.otherDay) byDay.set(day(u.start_ts), [...(byDay.get(day(u.start_ts)) ?? []), u.code]);
    const other = '\n' + [...byDay].map(([d, codes]) => `${d}  ${codes.join(' ')}`).join('\n');
    const otherLine = plan.otherDay.length ? t('gloria.dates.otherDay', { count: plan.otherDay.length, list: other }) : '';
    if (plan.fill.length === 0) {
      if (otherLine) Alert.alert(t('gloria.dates.toUnitsTitle'), `${t('gloria.dates.noneEmpty')}\n\n${otherLine}`);
      else toast(t('gloria.dates.noneEmpty'));
      return;
    }
    const msg = [t('gloria.dates.toUnitsMsg', { count: plan.fill.length, date: day(sv.start_ts) }), otherLine].filter(Boolean).join('\n\n');
    Alert.alert(t('gloria.dates.toUnitsTitle'), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('gloria.dates.apply'),
        onPress: () => {
          const n = fillUnitDates(sv.id, plan.fill, plan.value);
          reload();
          toast(t('gloria.dates.filled', { count: n }));
        },
      },
    ]);
  };

  return (
    <>
      <Label>{t('gloria.dates.title')}</Label>
      <Card className="gap-2 p-3">
        <View className="flex-row items-center gap-2">
          <Text className="w-16 text-sm text-gray-700 dark:text-gray-300">{t('gloria.dates.start')}</Text>
          <View className="flex-1">
            <DateTimeField value={sv.start_ts} mode="date" onChange={(ts) => save(onDay(sv.start_ts, ts), sv.stop_ts)} />
          </View>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="w-16 text-sm text-gray-700 dark:text-gray-300">{t('gloria.dates.end')}</Text>
          <View className="flex-1">
            {sv.stop_ts != null ? (
              <DateTimeField value={sv.stop_ts} mode="date" onChange={(ts) => save(sv.start_ts, onDay(sv.stop_ts as number, ts))} />
            ) : (
              // No end yet: start from the start day, the usual case for a one-day survey.
              <Pressable
                onPress={() => save(sv.start_ts, sv.start_ts)}
                accessibilityRole="button"
                className="rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-600"
              >
                <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.dates.endSameDay', { date: day(sv.start_ts) })}</Text>
              </Pressable>
            )}
          </View>
        </View>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn small label={t('gloria.dates.fromUnits')} onPress={fromUnits} disabled={!span} />
          </View>
          <View className="flex-1">
            <Btn small label={t('gloria.dates.toUnits')} onPress={toUnits} />
          </View>
        </View>
        <Text className="text-[11px] text-gray-400">{t('gloria.dates.hint')}</Text>
      </Card>
    </>
  );
}
