/**
 * Review (檢查模式): every survey on this device with what is left to fix —
 * the same checks the survey screens run (validateSurvey via useSurvey's
 * loadSurveyState, worded by issues.ts), unit statuses, and obligatory photos
 * still missing. A unit code opens that unit; survey-level items open the
 * survey. Made for after a day of entering paper forms on a desktop.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect } from '../router/router';
import { listGloriaSurveysWithMeta } from '~/modules/gloria/db';
import { loadSurveyState, type SurveyState, type UnitStatus } from '~/modules/gloria/useSurvey';
import { missingRequiredPhotos } from '~/modules/gloria/components/PhotoChecklist';
import { issueText } from '~/modules/gloria/issues';
import { statusLook } from '~/modules/gloria/statusColors';
import { ALL_UNITS } from '~/modules/gloria/model/units';
import type { Issue } from '~/modules/gloria/model/validate';
import { useThemeColors } from '~/theme/colors';
import { useBoot } from '../shell/bootStore';

type Row = { state: SurveyState; photosMissing: number; counts: Record<UnitStatus, number>; byUnit: Array<[string, Issue[]]> };

function load(): Row[] {
  return listGloriaSurveysWithMeta().flatMap((s) => {
    const state = loadSurveyState(s.id);
    if (!state) return [];
    const counts: Record<UnitStatus, number> = { none: 0, progress: 0, done: 0, warn: 0 };
    for (const u of ALL_UNITS) counts[state.statusOf(u.code)] += 1;
    const byUnit = new Map<string, Issue[]>();
    for (const i of state.issues) byUnit.set(i.unit, [...(byUnit.get(i.unit) ?? []), i]);
    return [{ state, photosMissing: missingRequiredPhotos(state), counts, byUnit: [...byUnit.entries()] }];
  });
}

const isUnit = (code: string) => ALL_UNITS.some((u) => u.code === code);

export default function Review() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const boot = useBoot();
  const [rows, setRows] = useState<Row[]>(load);
  const reload = useCallback(() => setRows(load()), []);
  useFocusEffect(reload);
  useEffect(() => boot?.flusher.subscribe((s) => s === 'saved' && reload()), [boot, reload]);
  const open = rows.reduce((n, r) => n + r.state.issues.length + (r.photosMissing ? 1 : 0), 0);

  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-16">
      <Stack.Screen options={{ title: t('web.review.title') }} />
      <Text className="text-sm text-ink-2 dark:text-gray-300">
        {open ? t('web.review.summary', { count: open }) : t('web.review.allClear')}
      </Text>
      {rows.map(({ state, photosMissing, counts, byUnit }) => {
        const id = state.survey.id;
        return (
          <View key={id} className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
            <Pressable onPress={() => router.push(`/gloria/${id}`)} className="flex-row items-center gap-2 px-4 py-3 active:bg-disc">
              <View className="flex-1">
                <Text className="font-mono text-sm font-bold text-ink dark:text-gray-100">
                  {state.summit.full_code} · mocy {state.survey.mocy}
                </Text>
                <View className="mt-1 flex-row flex-wrap gap-2">
                  {(['done', 'progress', 'warn', 'none'] as const).map((k) =>
                    counts[k] ? (
                      <Text key={k} className="text-xs" style={{ color: statusLook(c, k).text }}>
                        {t(`gloria.status.${k}`)} {counts[k]}
                      </Text>
                    ) : null,
                  )}
                </View>
              </View>
              <Ionicons name="chevron-forward" size={16} color={c.ink3} />
            </Pressable>
            {byUnit.length === 0 && !photosMissing ? (
              <Text className="border-t border-line px-4 py-2 text-xs text-accent dark:border-line-dark dark:text-emerald-400">✓ {t('web.review.noIssues')}</Text>
            ) : null}
            {photosMissing ? (
              <Pressable onPress={() => router.push(`/gloria/${id}`)} className="flex-row gap-3 border-t border-line px-4 py-2 dark:border-line-dark">
                <View className="w-12"><Ionicons name="camera-outline" size={14} color={c.ink2} /></View>
                <Text className="flex-1 text-xs text-ink dark:text-gray-100">{t('web.review.photosMissing', { count: photosMissing })}</Text>
              </Pressable>
            ) : null}
            {byUnit.map(([unit, issues]) => (
              <Pressable
                key={unit}
                onPress={() => router.push(isUnit(unit) ? `/gloria/${id}/${unit}` : `/gloria/${id}`)}
                className="flex-row gap-3 border-t border-line px-4 py-2 active:bg-disc dark:border-line-dark"
              >
                <Text className="w-12 font-mono text-xs font-bold text-alert dark:text-alert-dark">{unit}</Text>
                <View className="flex-1 gap-0.5">
                  {issues.map((i, k) => (
                    <Text key={k} className="text-xs text-ink dark:text-gray-100">
                      {issueText(t, i)}
                    </Text>
                  ))}
                </View>
              </Pressable>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}
