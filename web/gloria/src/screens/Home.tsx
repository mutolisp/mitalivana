/**
 * Home: the GLORIA surveys on this device, and the ways in — a new survey,
 * the summit list, importing a survey file. Prompts once for the species
 * checklist download, which the species search needs.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect } from '../router/router';
import { listGloriaSurveysWithMeta, type GloriaSurveyWithMeta } from '~/modules/gloria/db';
import { Button } from '~/components/ui/Button';
import { useThemeColors } from '~/theme/colors';
import { importRecordPromptAndOpen, openNewGloria } from '../host/recordCreate';
import { downloadSpecies, fetchSpeciesManifest } from '../host/speciesInstall';
import { formatBytes } from '../host/exportSize';
import { setSpeciesVersion, useBoot } from '../shell/bootStore';

export default function Home() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const boot = useBoot();
  const [surveys, setSurveys] = useState<GloriaSurveyWithMeta[]>(() => listGloriaSurveysWithMeta());
  useFocusEffect(useCallback(() => setSurveys(listGloriaSurveysWithMeta()), []));

  return (
    <ScrollView contentContainerClassName="gap-4 p-4 pb-12">
      <Stack.Screen options={{ title: t('web.home.title') }} />
      {boot && !boot.speciesVersion ? <SpeciesPrompt /> : null}
      {boot?.recoveredFromPrev ? <Text className="text-sm text-acorn-deep">{t('web.home.recovered')}</Text> : null}

      <View className="flex-row flex-wrap gap-2">
        <Button variant="primary" icon="add" label={t('web.home.newSurvey')} onPress={openNewGloria} />
        <Button variant="secondary" icon="flag-outline" label={t('web.home.summits')} onPress={() => router.push('/gloria/summits')} />
        <Button variant="secondary" icon="download-outline" label={t('web.home.importFile')} onPress={() => void importRecordPromptAndOpen()} />
      </View>

      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{t('web.home.surveys')}</Text>
        {surveys.length === 0 ? (
          <Text className="text-sm text-ink-2 dark:text-gray-300">{t('web.home.empty')}</Text>
        ) : (
          <View className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
            {surveys.map((s, i) => (
              <Pressable
                key={s.id}
                onPress={() => router.push(`/gloria/${s.id}`)}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-disc dark:active:bg-disc-dark-pressed ${i > 0 ? 'border-t border-line dark:border-line-dark' : ''}`}
              >
                <View className="flex-1 gap-0.5">
                  <Text className="text-sm font-semibold text-ink dark:text-gray-100">
                    {s.full_code}
                    {s.summit_name ? ` · ${s.summit_name}` : ''}
                  </Text>
                  <Text className="text-xs text-ink-3 dark:text-gray-400">
                    {t('web.home.surveyLine', { mocy: s.mocy, species: s.species_count, started: s.units_started })}
                  </Text>
                </View>
                <Text className={`text-xs ${s.status === 'active' ? 'text-accent dark:text-emerald-400' : 'text-ink-3 dark:text-gray-400'}`}>
                  {s.status === 'active' ? t('web.home.active') : t('web.home.done')}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={c.ink3} />
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <Pressable onPress={() => router.push('/diag')} className="self-start py-2">
        <Text className="text-xs text-ink-3 underline dark:text-gray-400">{t('web.home.diagnostics')}</Text>
      </Pressable>
    </ScrollView>
  );
}

function SpeciesPrompt() {
  const { t } = useTranslation();
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const m = await fetchSpeciesManifest();
      await downloadSpecies(m, (done, total) => setState(t('web.home.speciesProgress', { done: formatBytes(done), total: formatBytes(total) })));
      setSpeciesVersion(m.version);
    } catch (e) {
      setState(t('web.home.speciesFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 rounded-card border border-acorn-edge bg-acorn-wash p-4 dark:border-line-dark dark:bg-card-dark">
      <Text className="text-sm text-ink dark:text-gray-100">{t('web.home.speciesMissing')}</Text>
      <View className="flex-row items-center gap-3">
        <Button variant="primary" label={t('web.home.speciesDownload')} onPress={() => void go()} disabled={busy} />
        {state ? <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">{state}</Text> : null}
      </View>
    </View>
  );
}
