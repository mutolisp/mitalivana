/**
 * Temperature-logger visits of a summit, grouped by monitoring cycle (the
 * cycle comes from the date: model/loggers cycleOf). Used on the summit page
 * (all cycles, no survey needed) and on a survey's 溫度計 tab (its cycle).
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { isoStamp } from '~/lib/datetime';
import { createLoggerVisit, listLoggers, listVisits, summitCycles, type LoggerVisit } from '../loggerDb';
import { cycleOf } from '../model/loggers';
import { Btn, Card } from './ui';

export function LoggerVisitList({
  summitId,
  surveyId,
  onlyMocy,
  researchers,
}: {
  summitId: number;
  /** Set on visits added from a survey (which survey it was entered from). */
  surveyId?: number;
  /** Show one cycle only (the survey tab). */
  onlyMocy?: number;
  /** Default researchers of a new visit. */
  researchers?: string | null;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [visits, setVisits] = useState<LoggerVisit[]>([]);
  const [cycles, setCycles] = useState<Array<{ mocy: number; start_ts: number }>>([]);
  const reload = useCallback(() => {
    setVisits(listVisits(summitId));
    setCycles(summitCycles(summitId));
  }, [summitId]);
  useFocusEffect(reload);

  const groups = new Map<number | null, LoggerVisit[]>();
  for (const v of visits) {
    const c = cycleOf(v.visit_ts, cycles);
    if (onlyMocy != null && c !== onlyMocy) continue;
    groups.set(c, [...(groups.get(c) ?? []), v]);
  }
  const add = () => {
    const id = createLoggerVisit(summitId, { visitTs: Date.now(), surveyId: surveyId ?? null, researchers: researchers ?? null });
    router.push(`/gloria/logger/${id}` as Href);
  };

  return (
    <View className="gap-2">
      <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.intro')}</Text>
      {groups.size === 0 ? <Text className="py-2 text-sm text-gray-400">{t('gloria.logger.none')}</Text> : null}
      {[...groups.entries()]
        .sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))
        .map(([mocy, vs]) => {
          const start = cycles.find((c) => c.mocy === mocy)?.start_ts;
          return (
            <Card key={String(mocy)}>
              <Text className="px-3 pt-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
                {mocy != null
                  ? t('gloria.logger.cycle', { mocy, date: start != null ? isoStamp(start).slice(0, 10) : '' })
                  : t('gloria.logger.cycleNone')}
              </Text>
              {[...vs].reverse().map((v) => {
                const ls = listLoggers(v.id);
                return (
                  <Pressable
                    key={v.id}
                    onPress={() => router.push(`/gloria/logger/${v.id}` as Href)}
                    className="flex-row items-center border-t border-gray-100 px-3 py-2.5 dark:border-gray-800"
                  >
                    <Text className="w-28 text-sm font-semibold text-gray-900 dark:text-gray-100">{isoStamp(v.visit_ts).slice(0, 10)}</Text>
                    <Text className="flex-1 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
                      {[
                        t('gloria.logger.readoutCount', { count: ls.filter((l) => l.role === 'readout').length }),
                        t('gloria.logger.installCount', { count: ls.filter((l) => l.role === 'install').length }),
                        v.locked === 1 ? t('gloria.logger.doneShort') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    <Text className="text-gray-400">›</Text>
                  </Pressable>
                );
              })}
            </Card>
          );
        })}
      <Btn label={t('gloria.logger.addVisit')} onPress={add} />
    </View>
  );
}
