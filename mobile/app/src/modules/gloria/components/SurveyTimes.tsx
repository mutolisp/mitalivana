/**
 * Start / end times of a unit's survey. A 1×1 m quadrat has three: cover and
 * frequency (sheet 11_: covEst… and freqEst… Start/StopTime) and point-framing
 * (app only; the sheet has no column for it). SAS (21_ covEst…) and 10×10 m
 * (31_ start/stopTime) have one. The app records them by itself — each starts
 * at its first entry and ends at its 完成; the frequency end also follows the
 * latest edit — and the user can correct any of them.
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
import { followCoverTimes, nextMinute, onDay } from '../model/quadratTimes';
import { Card, Label, Req } from './ui';

type Pair = {
  label: string;
  start: 'start_ts' | 'freq_start_ts' | 'pf_start_ts';
  stop: 'stop_ts' | 'freq_stop_ts' | 'pf_stop_ts';
  /** Required (model/validate missingRequired): not point-framing, not a 10×10 m square. */
  required?: boolean;
};

/**
 * Who recorded a unit: its own list; none at all once cleared
 * (no_researchers); otherwise the survey's (shown greyed).
 */
export function unitResearchers(unit: GloriaUnit, surveyBy: string | null): string | null {
  if (unit.no_researchers === 1) return null;
  return unit.recorded_by || surveyBy;
}

/**
 * The researchers row with its picker. On a 1×1 m quadrat it sits in the
 * collapsible 樣區環境 card; on SAS and 10×10 m in the times card.
 */
export function ResearcherRow({
  unit,
  surveyBy,
  reload,
  required = false,
}: {
  unit: GloriaUnit;
  /** The survey's researchers — what an empty unit value stands for. */
  surveyBy: string | null;
  reload: () => void;
  /** Marked required (1×1 m and SAS; model/validate missingRequired). */
  required?: boolean;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setPicking(true)}
        accessibilityRole="button"
        accessibilityLabel={t('gloria.times.by')}
        className="flex-row items-center border-b border-gray-100 pb-2 dark:border-gray-800"
      >
        <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('gloria.times.by')}
          <Req on={required} />
        </Text>
        <Text
          className={`ml-3 flex-1 text-right text-sm ${unit.recorded_by ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}
          numberOfLines={2}
        >
          {unit.recorded_by ||
            (surveyBy && unit.no_researchers !== 1 ? t('gloria.times.bySurvey', { names: surveyBy }) : t('gloria.times.byNone'))}
        </Text>
      </Pressable>
      <SurveyorAssignSheet
        visible={picking}
        current={unit.recorded_by ?? (unit.no_researchers === 1 ? '' : (surveyBy ?? ''))}
        onCancel={() => setPicking(false)}
        onAssign={(v) => {
          setPicking(false);
          // Same people as the survey → store nothing, so it keeps following the survey;
          // nobody picked → explicitly none (as after clearing).
          updateUnit(
            unit.id,
            !v.trim()
              ? { recorded_by: null, no_researchers: 1 }
              : { recorded_by: v === surveyBy ? null : v, no_researchers: null },
          );
          reload();
        }}
      />
    </>
  );
}

export function SurveyTimes({
  unit,
  surveyBy,
  reload,
  withResearchers = true,
  embedded = false,
}: {
  unit: GloriaUnit;
  /** The survey's researchers — what an empty unit value stands for. */
  surveyBy: string | null;
  reload: () => void;
  /** false where the researchers row lives elsewhere (1×1 m: in 樣區環境). */
  withResearchers?: boolean;
  /** Only the time pairs and hint, no title or card — for nesting in another card. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const pairs: Pair[] =
    unit.unit_type === 'quadrat'
      ? [
          { label: t('gloria.times.cover'), start: 'start_ts', stop: 'stop_ts', required: true },
          // Skipped (shrubs): no frequency or point-framing, so no times to fill.
          ...(unit.freq_skipped === 1
            ? []
            : ([
                { label: t('gloria.times.freq'), start: 'freq_start_ts', stop: 'freq_stop_ts', required: true },
                { label: t('gloria.step.pointframe'), start: 'pf_start_ts', stop: 'pf_stop_ts' },
              ] as Pair[])),
        ]
      : [{ label: t('gloria.times.survey'), start: 'start_ts', stop: 'stop_ts', required: unit.unit_type === 'sas' }];
  /** `part`: which half was picked — a time on a date-only start makes it a real start. */
  const save = (p: Pair, col: Pair['start'] | Pair['stop'], ts: number, part?: 'date' | 'time') => {
    const start = col === p.start ? ts : unit[p.start];
    const stop = col === p.stop ? ts : unit[p.stop];
    if (start != null && stop != null && stop < start) {
      Alert.alert(t('gloria.times.orderTitle'), t('gloria.times.order', { what: p.label }));
      return;
    }
    const patch: UnitPatch = { [col]: ts };
    if (col === 'freq_stop_ts') patch.freq_stop_manual = 1;
    if (col === 'start_ts' && part === 'time' && unit.date_only === 1) patch.date_only = null;
    // Frequency follows the cover estimate: same day, next minute (model/quadratTimes).
    if (unit.unit_type === 'quadrat' && unit.freq_skipped !== 1 && (col === 'start_ts' || col === 'stop_ts')) {
      Object.assign(patch, followCoverTimes(unit, col, ts));
    }
    updateUnit(unit.id, patch);
    reload();
  };
  // An empty frequency start on a quadrat whose cover estimate is recorded
  // starts from it — the minute after its end, or its day at the current
  // clock time — rather than today, which is wrong for an old sheet.
  const freqFromCover =
    unit.unit_type === 'quadrat' && unit.start_ts != null
      ? unit.stop_ts != null
        ? nextMinute(unit.stop_ts)
        : onDay(Date.now(), unit.start_ts)
      : null;
  const cell = (p: Pair, col: Pair['start'] | Pair['stop'], label: string) => {
    const v = unit[col];
    const fill = col === 'freq_start_ts' && freqFromCover != null ? freqFromCover : null;
    return (
      // One row each, full width: the iOS picker expands inline under its
      // field and must not cover the other one.
      <View className="flex-row items-start gap-2">
        <Text className="w-10 pt-2.5 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
        {v != null ? (
          // Date and time apart: the date wheel reaches an old survey year in a
          // few flicks, where one datetime wheel steps through every day.
          // Stacked, not side by side — a half-width spinner overflows.
          <View className="flex-1 gap-1.5">
            <DateTimeField value={v} mode="date" onChange={(ts) => save(p, col, ts, 'date')} />
            <DateTimeField
              value={v}
              mode="time"
              // A start filled from the survey date has no time yet.
              format={(ts) => (col === 'start_ts' && unit.date_only === 1 ? t('gloria.times.timeUnset') : isoStamp(ts).slice(11))}
              onChange={(ts) => save(p, col, ts, 'time')}
            />
          </View>
        ) : (
          <View className="flex-1 gap-1.5">
            {/* An empty end with a start: copy the start (date and time) to adjust
                from — an old sheet's end is that day, rarely today. */}
            {col === p.stop && unit[p.start] != null ? (
              <Pressable
                onPress={() => save(p, col, unit[p.start] as number)}
                accessibilityRole="button"
                accessibilityLabel={`${p.label} ${label}`}
                className="rounded-lg border border-dashed border-[#00A2A5] px-3 py-2"
              >
                <Text className="text-xs text-[#00797b] dark:text-cyan-300">
                  {t('gloria.times.sameAsStart', {
                    // A date-only start has no time to copy.
                    time: isoStamp(unit[p.start] as number).slice(0, p.start === 'start_ts' && unit.date_only === 1 ? 10 : 16),
                  })}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => save(p, col, fill ?? Date.now())}
              accessibilityRole="button"
              accessibilityLabel={`${p.label} ${label}`}
              className="rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-600"
            >
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {fill != null ? t('gloria.times.afterCover', { time: isoStamp(fill).slice(0, 16) }) : t('gloria.times.now')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  };

  const body = (
    <>
      {pairs.map((p) => (
        <View key={p.start} className="gap-1">
          <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {p.label}
            <Req on={!!p.required} />
          </Text>
          {cell(p, p.start, t('gloria.times.start'))}
          {cell(p, p.stop, t('gloria.times.stop'))}
        </View>
      ))}
      <Text className="text-[11px] text-gray-400">{t(unit.unit_type === 'quadrat' ? 'gloria.times.hintQuadrat' : 'gloria.times.hint')}</Text>
    </>
  );
  if (embedded) return <View className="gap-2">{body}</View>;

  return (
    <>
      <Label>{t(withResearchers ? 'gloria.times.title' : 'gloria.times.titleOnly')}</Label>
      <Card className="gap-2 p-3">
        {withResearchers ? <ResearcherRow unit={unit} surveyBy={surveyBy} reload={reload} required={unit.unit_type !== 'square'} /> : null}
        {body}
      </Card>
    </>
  );
}
