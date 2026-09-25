/**
 * Start / end times of a unit's survey. A 1×1 m quadrat has two (sheet 11_:
 * covEst… and freqEst… Start/StopTime); SAS (21_ covEst…) and 10×10 m (31_
 * start/stopTime) have one. The app records them by itself — the start at the
 * first entry, the end at 完成; frequency starts at the first stroke and its
 * end follows the latest edit — and the user can correct any of them.
 * A hand-set frequency end is kept (freq_stop_manual) instead of being moved
 * by the next stroke.
 *
 * Each unit also has its own researchers (recorded_by); empty means the
 * survey's, which is what the export writes then too.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { DateTimeField } from '~/components/DateTimeField';
import { isoStamp } from '~/lib/datetime';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { updateUnit, type GloriaUnit, type UnitPatch } from '../db';
import { Card, Label } from './ui';

type Pair = { label: string; start: 'start_ts' | 'freq_start_ts'; stop: 'stop_ts' | 'freq_stop_ts' };

export function SurveyTimes({
  unit,
  surveyBy,
  reload,
}: {
  unit: GloriaUnit;
  /** The survey's researchers — what an empty unit value stands for. */
  surveyBy: string | null;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const pairs: Pair[] =
    unit.unit_type === 'quadrat'
      ? [
          { label: t('gloria.times.cover'), start: 'start_ts', stop: 'stop_ts' },
          { label: t('gloria.times.freq'), start: 'freq_start_ts', stop: 'freq_stop_ts' },
        ]
      : [{ label: t('gloria.times.survey'), start: 'start_ts', stop: 'stop_ts' }];
  const save = (p: Pair, col: Pair['start'] | Pair['stop'], ts: number) => {
    const start = col === p.start ? ts : unit[p.start];
    const stop = col === p.stop ? ts : unit[p.stop];
    if (start != null && stop != null && stop < start) {
      Alert.alert(t('gloria.times.orderTitle'), t('gloria.times.order', { what: p.label }));
      return;
    }
    const patch: UnitPatch = { [col]: ts };
    if (col === 'freq_stop_ts') patch.freq_stop_manual = 1;
    updateUnit(unit.id, patch);
    reload();
  };
  const cell = (p: Pair, col: Pair['start'] | Pair['stop'], label: string) => {
    const v = unit[col];
    return (
      // One row each, full width: the iOS picker expands inline under its
      // field and must not cover the other one.
      <View className="flex-row items-start gap-2">
        <Text className="w-10 pt-2.5 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
        {v != null ? (
          <View className="flex-1">
            <DateTimeField value={v} mode="datetime" format={isoStamp} onChange={(ts) => save(p, col, ts)} />
          </View>
        ) : (
          <Pressable
            onPress={() => save(p, col, Date.now())}
            accessibilityRole="button"
            accessibilityLabel={`${p.label} ${label}`}
            className="flex-1 rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-600"
          >
            <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.times.now')}</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <>
      <Label>{t('gloria.times.title')}</Label>
      <Card className="gap-2 p-3">
        <Pressable
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel={t('gloria.times.by')}
          className="flex-row items-center border-b border-gray-100 pb-2 dark:border-gray-800"
        >
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.times.by')}</Text>
          <Text
            className={`ml-3 flex-1 text-right text-sm ${unit.recorded_by ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}
            numberOfLines={2}
          >
            {unit.recorded_by || (surveyBy ? t('gloria.times.bySurvey', { names: surveyBy }) : t('gloria.times.byNone'))}
          </Text>
        </Pressable>
        {pairs.map((p) => (
          <View key={p.start} className="gap-1">
            <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.label}</Text>
            {cell(p, p.start, t('gloria.times.start'))}
            {cell(p, p.stop, t('gloria.times.stop'))}
          </View>
        ))}
        <Text className="text-[11px] text-gray-400">{t(unit.unit_type === 'quadrat' ? 'gloria.times.hintQuadrat' : 'gloria.times.hint')}</Text>
      </Card>
      <SurveyorAssignSheet
        visible={picking}
        current={unit.recorded_by ?? surveyBy ?? ''}
        onCancel={() => setPicking(false)}
        onAssign={(v) => {
          setPicking(false);
          // Same people as the survey → store nothing, so it keeps following the survey.
          updateUnit(unit.id, { recorded_by: v && v !== surveyBy ? v : null });
          reload();
        }}
      />
    </>
  );
}
