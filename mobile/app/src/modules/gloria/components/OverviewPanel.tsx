/**
 * The "overview" panel every GLORIA input screen opens from its header: the
 * steps of this unit (with their state), the unit's issues, and all 28 units
 * to jump to. Anchored inside the screen, not a Modal — it has no inputs and
 * must not cover the app's toast host.
 *
 * Every edit is already written when the user leaves a screen, so jumping
 * around loses nothing.
 */
import { useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { visitedCount } from '../model/grid';
import { unitTypeOf } from '../model/units';
import { issueText } from '../issues';
import type { SurveyState } from '../useSurvey';
import { statusLook } from '../statusColors';
import { useThemeColors } from '~/theme/colors';
import { Btn } from './ui';

export type UnitStep = 'cover' | 'frequency' | 'pointframe' | 'sas' | 'points';

export function OverviewPanel({
  state,
  code,
  current,
  onClose,
}: {
  state: SurveyState;
  code: string;
  current: UnitStep;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const tc = useThemeColors();
  const router = useRouter();
  const id = state.survey.id;
  const u = state.unit(code);
  const spp = state.speciesOf(code);
  const type = unitTypeOf(code);

  const go = (href: string) => {
    onClose();
    // Sibling screens replace each other so the back stack stays "summit → unit".
    router.replace(href as Href);
  };
  const steps: Array<{ key: UnitStep; label: string; detail: string; href: string }> = [];
  if (type === 'quadrat') {
    const freqCells = spp.filter((s) => s.freq_cells != null || s.freq_count != null);
    const freqKey = state.unit(code)?.freq_mode === 'count' ? 'gloria.step.freqCounted' : 'gloria.step.freqDone';
    const skipped = u?.freq_skipped === 1;
    steps.push(
      { key: 'cover', label: t('gloria.step.cover'), detail: t('gloria.step.speciesCount', { count: spp.length }), href: `/gloria/${id}/${code}` },
    );
    if (skipped) steps.push({ key: 'frequency', label: `${t('gloria.step.frequency')}／${t('gloria.step.pointframe')}`, detail: t('gloria.step.skipped'), href: `/gloria/${id}/${code}` });
    else steps.push(
      {
        key: 'frequency',
        label: t('gloria.step.frequency'),
        detail:
          (state.unit(code)?.freq_locked ? `${t('gloria.freq.doneShort')} · ` : '') +
          (freqCells.length ? t(freqKey, { count: freqCells.length }) : t('gloria.step.notStarted')),
        href: `/gloria/${id}/${code}/frequency`,
      },
      {
        key: 'pointframe',
        label: t('gloria.step.pointframe'),
        detail: u?.point_surface ? t('gloria.step.pointsDone', { done: visitedCount(u.point_surface), total: 100 }) : t('gloria.step.notStarted'),
        href: `/gloria/${id}/${code}/points`,
      },
    );
  } else if (type === 'sas') {
    steps.push({ key: 'sas', label: t('gloria.step.sas'), detail: t('gloria.step.speciesCount', { count: spp.length }), href: `/gloria/${id}/${code}` });
  } else {
    const visited = visitedCount(u?.point_surface);
    steps.push(
      { key: 'points', label: t('gloria.step.linePoints'), detail: t('gloria.step.pointsDone', { done: visited, total: 400 }), href: `/gloria/${id}/${code}/points` },
      { key: 'cover', label: t('gloria.step.additional'), detail: t('gloria.step.speciesCount', { count: spp.length }), href: `/gloria/${id}/${code}` },
    );
  }
  const issues = state.issues.filter((i) => i.unit === code);

  // Narrow, fixed-width buttons with a readable label; the 10×10 one spans two.
  const unitBtn = (c: string, label: string, wide = false) => {
    const look = statusLook(tc, state.statusOf(c));
    return (
    <Pressable
      key={c}
      onPress={() => go(`/gloria/${id}/${c}`)}
      accessibilityRole="button"
      accessibilityLabel={c}
      style={{
        backgroundColor: look.fill,
        width: wide ? 76 : 36,
        // The selected unit's dark frame wins over 未開始's outline.
        ...(look.border && c !== code ? { borderWidth: 1.5, borderColor: look.border } : null),
      }}
      className={`m-0.5 items-center rounded py-1.5 ${c === code ? 'border-2 border-gray-900 dark:border-white' : ''}`}
    >
      <Text className="text-sm font-semibold" style={{ color: look.onFill }}>{label}</Text>
    </Pressable>
    );
  };

  return (
    <Pressable onPress={onClose} className="absolute inset-0 bg-black/35 px-2.5 pt-2">
      <Pressable onPress={() => undefined} className="max-h-[92%] rounded-2xl bg-card dark:bg-gray-900">
        <ScrollView contentContainerClassName="gap-3 p-3">
          <View className="flex-row items-center">
            <Text className="flex-1 text-base font-bold text-gray-900 dark:text-gray-100">{code}</Text>
            <Btn small label={t('common.close')} onPress={onClose} />
          </View>
          <View className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
            {steps.map((s, i) => (
              <Pressable
                key={s.key + i}
                onPress={() => (s.key === current ? onClose() : go(s.href))}
                className={`flex-row items-center px-3 py-2.5 ${i ? 'border-t border-gray-100 dark:border-gray-800' : ''} ${
                  s.key === current ? 'bg-accent-50 dark:bg-accent-950/40' : 'active:bg-gray-50 dark:active:bg-gray-800'
                }`}
              >
                <Text className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{s.label}</Text>
                <Text className="text-xs text-gray-500 dark:text-gray-400">{s.key === current ? t('gloria.step.here') : s.detail}</Text>
              </Pressable>
            ))}
          </View>
          {issues.length ? (
            <View className="gap-1 rounded-lg border border-red-400 p-2.5">
              {issues.map((i, k) => (
                <Text key={k} className="text-xs text-red-700 dark:text-red-300">{issueText(t, i)}</Text>
              ))}
            </View>
          ) : null}
          <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('gloria.step.jump')}</Text>
          <View className="flex-row justify-around">
            {(['E', 'N', 'S', 'W'] as const).map((d) => (
              <View key={d} className="items-center">
                <Text className="text-center text-sm font-bold text-gray-600 dark:text-gray-300">{d}</Text>
                <View className="flex-row">{['13', '33'].map((q) => unitBtn(d + q, q))}</View>
                <View className="flex-row">{['11', '31'].map((q) => unitBtn(d + q, q))}</View>
                <View className="flex-row">{[`${d}05`, `${d}10`].map((c) => unitBtn(c, c.slice(1)))}</View>
                <View className="flex-row">{unitBtn(d, '10×10', true)}</View>
              </View>
            ))}
          </View>
          <Btn
            label={t('gloria.step.backToSummit')}
            onPress={() => {
              onClose();
              router.navigate(`/gloria/${id}` as Href);
            }}
          />
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

