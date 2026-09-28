/**
 * The recheck of one plot, right after its blind list is closed (Road
 * protocol §2.5.3, p. 5; §2.5.3.2, p. 6): every taxon the previous survey had
 * in this plot but the blind list has not is shown with last time's values,
 * and each needs an answer — found (then its cover and abundance), not found,
 * or recorded under another name this time. The plot is finished once all
 * are answered. Species found here are exported with Found after recheck = 1.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScientificName } from '~/components/ScientificName';
import { showActionSheet } from '~/components/ActionSheet';
import { useToast } from '~/stores/toast';
import {
  answerRecheck,
  ensureRosterTaxon,
  finishPlot,
  getPlot,
  listPlotSpecies,
  recheckState,
  surveyContext,
  updatePlotSpecies,
  type PrevSpecies,
} from '~/modules/miren/db';
import { formatPlotCode } from '~/modules/miren/model/codes';
import { plotMeasures } from '~/modules/miren/model/scales';
import { taxonKey, type RecheckOutcome } from '~/modules/miren/model/compare';
import { Banner, BannerText, Btn, Card } from '~/modules/gloria/components/ui';

const OUTCOMES: RecheckOutcome[] = ['found', 'not_found', 'reidentified'];

export default function MirenRecheckScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [plot, setPlot] = useState(() => getPlot(id));
  const [state, setState] = useState(() => recheckState(id));
  const [species, setSpecies] = useState(() => listPlotSpecies(id));
  const reload = useCallback(() => {
    setPlot(getPlot(id));
    setState(recheckState(id));
    setSpecies(listPlotSpecies(id));
  }, [id]);
  useFocusEffect(reload);
  const ctx = plot ? surveyContext(plot.survey_id) : null;
  if (!plot || !ctx || !state) {
    return <Text className="p-4 text-gray-500">{t('miren.recheck.notOpen')}</Text>;
  }
  const code = formatPlotCode({ region: ctx.regionCode, route: ctx.route.code, site: plot.site_no, plot: plot.plot_no, suffix: plot.suffix });
  const measures = plotMeasures(ctx.route.kind, plot.plot_no);
  const finished = plot.compared_at != null;
  const answerOf = (c: PrevSpecies) => state.answers.find((a) => taxonKey({ taxonId: a.prev_taxon_id, verbatim: a.prev_verbatim_identification }) === taxonKey(c));
  const rowFor = (c: PrevSpecies) =>
    species.find((s) => s.phase === 'recheck' && s.taxon_id === c.taxonId && (s.verbatim_identification ?? '') === (c.verbatim ?? ''));
  const nameOf = (c: { verbatim?: string | null; simple_name?: string; taxonId?: string }) => c.verbatim || c.simple_name || c.taxonId || '';

  const answer = async (c: PrevSpecies, outcome: RecheckOutcome) => {
    if (finished) return;
    if (outcome !== 'reidentified') {
      answerRecheck(plot.id, c, outcome);
      reload();
      return;
    }
    // Re-identified: which entry on this plot is the same plant?
    const blind = species.filter((s) => s.phase === 'blind');
    if (blind.length === 0) {
      Alert.alert(t('miren.recheck.reidentified'), t('miren.recheck.noneToPick'));
      return;
    }
    const idx = await showActionSheet({
      title: t('miren.recheck.pickTitle', { name: nameOf(c) }),
      message: t('miren.recheck.pickMsg'),
      options: blind.map((s) => ({ label: s.verbatim_identification || s.simple_name || s.taxon_id })),
      cancelLabel: t('common.cancel'),
    });
    const target = blind[idx];
    if (!target) return;
    answerRecheck(plot.id, c, 'reidentified', ensureRosterTaxon(plot.survey_id, target.taxon_id, target.verbatim_identification));
    reload();
  };
  const finish = () => {
    if (finishPlot(plot.id)) {
      toast(t('miren.plot.finished'));
      router.back();
    } else Alert.alert(t('miren.recheck.finish'), t('miren.recheck.unanswered'));
  };
  const answered = state.candidates.filter((c) => answerOf(c)).length;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: `${t('miren.recheck.title')} · ${code}` }} />
      <ScrollView contentContainerClassName="gap-3 p-4">
        <Banner tone="info">
          <BannerText tone="info">
            {state.candidates.length
              ? t('miren.recheck.intro', { year: state.year, n: state.candidates.length })
              : t('miren.recheck.nothing', { year: state.year })}
          </BannerText>
        </Banner>
        {state.candidates.map((c) => {
          const a = answerOf(c);
          const row = a?.outcome === 'found' ? rowFor(c) : undefined;
          const target = a?.outcome === 'reidentified' ? species.find((s) => s.miren_taxon_id === a.new_miren_taxon_id) : undefined;
          return (
            <Card key={taxonKey(c)} className="gap-2 p-3">
              <View>
                {c.verbatim ? (
                  <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.verbatim}</Text>
                ) : (
                  <ScientificName name={c.simple_name || c.taxonId} rank={c.rank} className="text-sm font-semibold text-gray-900 dark:text-gray-100" />
                )}
                <Text className="text-xs text-gray-500 dark:text-gray-400">
                  {[c.common_name_c, measures.mode === 'presence' ? t('miren.recheck.lastPresent', { year: state.year }) : t('miren.recheck.last', { year: state.year, c: c.cover_class ?? '–', a: c.abundance_class ?? '–' })]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <View className="flex-row gap-1.5">
                {OUTCOMES.map((o) => {
                  const on = a?.outcome === o;
                  return (
                    <Pressable
                      key={o}
                      disabled={finished}
                      onPress={() => void answer(c, o)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      style={{ minHeight: 44 }}
                      className={`flex-1 items-center justify-center rounded-lg border px-1 ${on ? 'border-accent-600 bg-accent-600' : 'border-gray-300 bg-card dark:border-gray-700 dark:bg-gray-900'}`}
                    >
                      <Text className={`text-xs font-semibold ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{t(`miren.recheck.${o}`)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {row && measures.mode === 'cover-abundance' ? (
                <View className="gap-1.5">
                  <Text className="text-xs text-gray-500">{t('miren.recheck.valuesNow')}</Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {measures.cover.map((k) => (
                      <Pressable
                        key={`c${k.value}`}
                        disabled={finished}
                        onPress={() => (updatePlotSpecies(row.id, { cover_class: k.value }), reload())}
                        style={{ minWidth: 44, minHeight: 40 }}
                        className={`items-center justify-center rounded-md border ${row.cover_class === k.value ? 'border-accent-600 bg-accent-600' : 'border-gray-300 dark:border-gray-700'}`}
                      >
                        <Text className={`text-sm ${row.cover_class === k.value ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{`C${k.value}`}</Text>
                        <Text className={`text-[9px] ${row.cover_class === k.value ? 'text-white/90' : 'text-gray-500'}`}>{`${k.label}%`}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View className="flex-row flex-wrap gap-1.5">
                    {measures.abundance.map((k) => (
                      <Pressable
                        key={`a${k.value}`}
                        disabled={finished}
                        onPress={() => (updatePlotSpecies(row.id, { abundance_class: k.value }), reload())}
                        style={{ minWidth: 60, minHeight: 40 }}
                        className={`items-center justify-center rounded-md border ${row.abundance_class === k.value ? 'border-accent-600 bg-accent-600' : 'border-gray-300 dark:border-gray-700'}`}
                      >
                        <Text className={`text-sm ${row.abundance_class === k.value ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{`A${k.value}`}</Text>
                        <Text className={`text-[9px] ${row.abundance_class === k.value ? 'text-white/90' : 'text-gray-500'}`}>{k.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
              {target ? (
                <Text className="text-xs text-gray-600 dark:text-gray-300">
                  {t('miren.recheck.sameAs', { name: target.verbatim_identification || target.simple_name || target.taxon_id })}
                </Text>
              ) : null}
            </Card>
          );
        })}
        {!finished ? (
          <Btn primary disabled={!state.complete} label={t('miren.recheck.finishCount', { done: answered, total: state.candidates.length })} onPress={finish} />
        ) : (
          <Text className="text-center text-sm text-emerald-700">{t('miren.plot.banner_done')}</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
