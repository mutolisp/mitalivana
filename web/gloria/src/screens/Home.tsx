/**
 * Home: the GLORIA surveys on this device, and the ways in — a new survey,
 * the summit list, importing survey files (one or several, bundles too),
 * exporting several surveys in one bundle, and the review page. Prompts once
 * for the species checklist download, which the species search needs.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect } from '../router/router';
import { listGloriaSurveysWithMeta, type GloriaSurveyWithMeta } from '~/modules/gloria/db';
import { Button } from '~/components/ui/Button';
import { CheckboxMark } from '~/components/ui/Checkbox';
import { showActionSheet } from '~/components/ActionSheet';
import { useThemeColors } from '~/theme/colors';
import { useToast } from '~/stores/toast';
import { errText } from '~/lib/errText';
import { importRecordPromptAndOpen, openNewGloria } from '../host/recordCreate';
import { downloadSpecies, fetchSpeciesManifest } from '../host/speciesInstall';
import { formatBytes } from '../host/exportSize';
import { deliver } from '../host/sharing';
import { buildBatchZip } from '../export/exportSurvey';
import { setSpeciesVersion, useBoot } from '../shell/bootStore';
import { LANGUAGE_CATALOGUE, resolveLanguage, setLanguage } from '../host/i18n';
import { useSettings, type Language } from '~/stores/settings';

/** With or without photos; null when cancelled. */
async function askPhotos(t: (k: string) => string): Promise<boolean | null> {
  const idx = await showActionSheet({
    title: t('common.export'),
    cancelLabel: t('common.cancel'),
    options: [
      { label: t('web.export.withoutPhotos'), icon: 'document-outline' },
      { label: t('web.export.withPhotos'), icon: 'images-outline' },
    ],
  });
  return idx < 0 ? null : idx === 1;
}

export default function Home() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const boot = useBoot();
  const [surveys, setSurveys] = useState<GloriaSurveyWithMeta[]>(() => listGloriaSurveysWithMeta());
  const reload = useCallback(() => setSurveys(listGloriaSurveysWithMeta()), []);
  useFocusEffect(reload);
  // An import finishes on this screen: pick it up when it is saved.
  useEffect(() => boot?.flusher.subscribe((s) => s === 'saved' && reload()), [boot, reload]);
  const [selected, setSelected] = useState<Set<number> | null>(null);

  const exportSurveys = async (ids: number[]) => {
    const photos = await askPhotos(t);
    if (photos == null) return;
    const toast = useToast.getState();
    toast.show(t('export.exporting'), { durationMs: 120_000 });
    try {
      const zip = await buildBatchZip(ids, { includePhotos: photos });
      toast.dismiss();
      await deliver(zip.bytes, zip.filename, 'application/zip');
      toast.show(t('export.done', { filename: zip.filename }));
      setSelected(null);
    } catch (e) {
      toast.dismiss();
      Alert.alert(t('export.failed'), errText(e));
    }
  };

  const startExport = async () => {
    const idx = await showActionSheet({
      title: t('common.export'),
      cancelLabel: t('common.cancel'),
      options: [{ label: t('web.batch.exportAll', { count: surveys.length }), icon: 'albums-outline' }, { label: t('web.batch.choose'), icon: 'checkbox-outline' }],
    });
    if (idx === 0) void exportSurveys(surveys.map((s) => s.id));
    if (idx === 1) setSelected(new Set());
  };

  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ScrollView contentContainerClassName="gap-4 p-4 pb-24">
      <Stack.Screen options={{ title: t('web.home.title') }} />
      {boot && !boot.speciesVersion ? <SpeciesPrompt /> : null}
      {boot?.recoveredFromPrev ? <Text className="text-sm text-acorn-deep">{t('web.home.recovered')}</Text> : null}

      <View className="flex-row flex-wrap gap-2">
        <Button variant="primary" icon="add" label={t('web.home.newSurvey')} onPress={openNewGloria} />
        <Button variant="secondary" icon="flag-outline" label={t('web.home.summits')} onPress={() => router.push('/gloria/summits')} />
        <Button variant="secondary" icon="download-outline" label={t('web.home.importFile')} onPress={() => void importRecordPromptAndOpen()} />
        <Button variant="secondary" icon="globe-outline" label={t('web.home.packs')} onPress={() => router.push('/packs')} />
        {surveys.length ? (
          <>
            <Button variant="secondary" icon="share-outline" label={t('common.export')} onPress={() => void startExport()} />
            <Button variant="secondary" icon="checkmark-done-outline" label={t('web.review.title')} onPress={() => router.push('/review')} />
          </>
        ) : null}
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
                onPress={() => (selected ? toggle(s.id) : router.push(`/gloria/${s.id}`))}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-disc dark:active:bg-disc-dark-pressed ${i > 0 ? 'border-t border-line dark:border-line-dark' : ''}`}
              >
                {selected ? <CheckboxMark checked={selected.has(s.id)} /> : null}
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
                {selected ? null : <Ionicons name="chevron-forward" size={16} color={c.ink3} />}
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {selected ? (
        <View className="flex-row items-center gap-2">
          <Button
            variant="primary"
            icon="share-outline"
            label={t('web.batch.exportSelected', { count: selected.size })}
            disabled={selected.size === 0}
            onPress={() => void exportSurveys(surveys.filter((s) => selected.has(s.id)).map((s) => s.id))}
          />
          <Button variant="ghost" label={t('common.cancel')} onPress={() => setSelected(null)} />
        </View>
      ) : null}

      <LanguageButton />

      <Pressable onPress={() => router.push('/diag')} className="self-start py-2">
        <Text className="text-xs text-ink-3 underline dark:text-gray-400">{t('web.home.diagnostics')}</Text>
      </Pressable>
    </ScrollView>
  );
}

/** UI language: follow the browser, or one of the app's languages (mobile settings.language). */
function LanguageButton() {
  const { t } = useTranslation();
  const c = useThemeColors();
  const setting = useSettings((s) => s.language);
  const current = LANGUAGE_CATALOGUE.find((l) => l.value === setting);
  const choose = async () => {
    const values: Language[] = ['system', ...LANGUAGE_CATALOGUE.map((l) => l.value as Language)];
    const idx = await showActionSheet({
      title: t('settings.language'),
      cancelLabel: t('common.cancel'),
      options: values.map((v) => {
        const l = LANGUAGE_CATALOGUE.find((x) => x.value === v);
        return { label: l ? l.native : t('settings.languageSystem'), description: l && l.native !== l.english ? l.english : undefined, selected: v === setting };
      }),
    });
    if (idx < 0) return;
    useSettings.getState().set('language', values[idx]);
    await setLanguage(resolveLanguage(values[idx]));
  };
  return (
    <Pressable onPress={() => void choose()} className="flex-row items-center gap-2 self-start py-2" accessibilityRole="button">
      <Ionicons name="language-outline" size={16} color={c.ink2} />
      <Text className="text-sm text-ink-2 dark:text-gray-300">
        {t('settings.language')} · {current ? current.native : t('settings.languageSystem')}
      </Text>
    </Pressable>
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
