/**
 * The recheck of a permanent plot (Modular_survey.md §5.5; v84 fw_rechecks),
 * once the blind phase is closed: the previous survey's list unit by unit,
 * each taxon marked as recorded again in the blind list, or needing an
 * answer — found (added here as a 'recheck' occurrence, then filled in on its
 * screen), not found, or recorded under another name this time. Units the
 * plot no longer uses (retired) are listed but not rechecked.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { ScientificName } from '~/components/ScientificName';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { componentSummary } from '~/survey/components/editors/ComponentEditor';
import { FormCard } from '~/survey/components/FormBits';
import { snapshotOf } from '~/survey/db/surveyCore';
import { answerRecheck, getFwSurvey, listOccurrences, listUnits, previousOccurrences, readComponent, recheckState } from '~/survey/db/surveys';
import { formComponents } from '~/survey/form/occurrenceForm';
import { recheckKey, type RecheckOutcome } from '~/survey/form/recheck';
import { formErrorText } from '~/survey/form/text';
import { unitRows } from '~/survey/form/units';
import { occurrenceTitle, withNames } from '~/survey/form/useSurveyForm';

const OUTCOMES: RecheckOutcome[] = ['found', 'not_found', 'reidentified'];

function load(id: number) {
  const survey = getFwSurvey(id);
  const state = survey && survey.style === 'plot' ? recheckState(id) : null;
  if (!survey || !state) return null;
  const prevSurvey = state.previousId == null ? null : getFwSurvey(state.previousId);
  const prevAbundance = prevSurvey ? formComponents(snapshotOf(prevSurvey), 'occurrence').find((c) => c.type === 'abundance') : undefined;
  const units = unitRows(
    snapshotOf(survey).units?.map((u) => u.key) ?? [],
    listUnits(id),
  );
  const pathAt = new Map(units.filter((u) => u.unit.frame_unit_id != null).map((u) => [u.unit.frame_unit_id as number, u.path]));
  const previous = withNames(previousOccurrences(id)).map((p) => ({
    ...p,
    key: recheckKey({ frameUnitId: p.frame_unit_id, taxonId: p.taxon_id, verbatim: p.verbatim_identification }),
    summary: prevAbundance ? readComponent({ kind: 'occurrence', id: p.id }, prevAbundance.key) : null,
  }));
  return { survey, state, prevSurvey, prevAbundance, previous, pathAt, current: withNames(listOccurrences(id)) };
}

export default function RecheckScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [data, setData] = useState(() => load(id));
  const reload = useCallback(() => setData(load(id)), [id]);
  useFocusEffect(reload);

  if (!data) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: t('surveyForm.recheck.title'), headerLeft: BackHeaderLeft }} />
        <Text className="px-6 text-center text-ink-3 dark:text-gray-400">{t('surveyForm.recheck.notOpen')}</Text>
      </SafeAreaView>
    );
  }
  const { survey, state, previous, pathAt } = data;
  const locked = survey.status === 'done';
  const candidates = new Set(state.candidates.map((c) => c.key));
  const answerOf = (key: string) =>
    state.answers.find((a) => recheckKey({ frameUnitId: a.frame_unit_id, taxonId: a.prev_taxon_id, verbatim: a.prev_verbatim_identification || null }) === key);
  const groups = new Map<string, typeof previous>();
  for (const p of previous) {
    const g = p.frame_unit_id == null ? t('surveyForm.outsideUnits') : (pathAt.get(p.frame_unit_id) ?? t('surveyForm.recheck.retiredUnit', { code: p.unit_code ?? '' }));
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  const answer = async (p: (typeof previous)[number], outcome: RecheckOutcome) => {
    if (locked) {
      toast(t('surveyForm.lockedToast'));
      return;
    }
    const sighting = { frameUnitId: p.frame_unit_id, taxonId: p.taxon_id, verbatim: p.verbatim_identification };
    let target: number | null = null;
    if (outcome === 'reidentified') {
      const unitId = state.candidates.find((c) => c.key === p.key)?.unitId ?? null;
      const here = data.current.filter((o) => o.unit_id === unitId);
      if (!here.length) {
        toast(t('surveyForm.recheck.noneToPick'));
        return;
      }
      const idx = await showActionSheet({
        title: t('surveyForm.recheck.pickTitle', { name: occurrenceTitle(p) }),
        message: t('surveyForm.recheck.pickMsg'),
        options: here.map((o) => ({ label: occurrenceTitle(o) })),
        cancelLabel: t('common.cancel'),
      });
      if (idx < 0 || idx >= here.length) return;
      target = here[idx].id;
    }
    try {
      answerRecheck(id, sighting, outcome, target);
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('surveyForm.recheck.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
        <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">
          {state.previousId == null
            ? t('surveyForm.recheck.noPrevious', { n: Math.max(1, (data.survey.census_no ?? 2) - 1) })
            : previous.length
              ? t('surveyForm.recheck.intro', { n: data.prevSurvey?.census_no ?? 1, open: state.open })
              : t('surveyForm.recheck.nothing')}
        </Text>
        {[...groups.entries()].map(([group, rows]) => (
          <FormCard key={group} title={group}>
            {rows.map((p) => {
              const isCandidate = candidates.has(p.key);
              const a = isCandidate ? answerOf(p.key) : undefined;
              const target = a?.occurrence_id != null ? data.current.find((o) => o.id === a.occurrence_id) : undefined;
              const prev = data.prevAbundance && p.summary ? componentSummary(t, i18n.language, data.prevAbundance, p.summary) : '';
              return (
                <View key={p.id} className="gap-2 border-t border-line pt-2 dark:border-line-dark">
                  <View className="flex-row items-start gap-2">
                    <View className="flex-1">
                      <Text className="text-base font-semibold text-ink dark:text-gray-100">{p.verbatim_identification || p.common_name_c || p.simple_name}</Text>
                      <ScientificName name={p.simple_name || p.taxon_id} rank={p.rank} kingdom={p.kingdom} className="text-sm text-ink-2 dark:text-gray-300" />
                      {prev ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('surveyForm.recheck.last', { value: prev })}</Text> : null}
                    </View>
                    {!isCandidate ? (
                      <Text className="text-xs font-semibold text-accent-700 dark:text-accent-300">
                        {p.frame_unit_id != null && !pathAt.has(p.frame_unit_id) ? t('surveyForm.recheck.notChecked') : t('surveyForm.recheck.recordedBlind')}
                      </Text>
                    ) : null}
                  </View>
                  {isCandidate ? (
                    <View className="flex-row gap-1.5">
                      {OUTCOMES.map((o) => {
                        const on = a?.outcome === o;
                        return (
                          <Pressable
                            key={o}
                            disabled={locked}
                            onPress={() => void answer(p, o)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on, disabled: locked }}
                            style={{ minHeight: 44 }}
                            className={`flex-1 items-center justify-center rounded-lg border px-1 ${on ? 'border-accent-600 bg-accent-600' : 'border-line bg-paper dark:border-line-dark dark:bg-paper-dark'}`}
                          >
                            <Text className={`text-xs font-semibold ${on ? 'text-white' : 'text-ink dark:text-gray-100'}`}>{t(`surveyForm.recheck.${o}`)}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                  {target ? (
                    <Pressable onPress={() => router.push(`/survey/form/occurrence/${target.id}` as Href)} accessibilityRole="button" className="self-start">
                      <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">
                        {a?.outcome === 'found' ? t('surveyForm.recheck.openFound') : t('surveyForm.recheck.sameAs', { name: occurrenceTitle(target) })}
                      </Text>
                    </Pressable>
                  ) : a?.outcome === 'reidentified' ? (
                    <Text className="text-xs text-alert dark:text-alert-dark">{t('surveyForm.recheck.targetGone')}</Text>
                  ) : null}
                </View>
              );
            })}
          </FormCard>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
