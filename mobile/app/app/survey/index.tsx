/**
 * Permanent plots of the tree census (docs/ForestGEO/Stem_mapping.md): each
 * with its size, threshold and latest census. Reached from the create sheet
 * and from settings; a plot opens its own screen, where censuses start.
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, Text, View } from 'react-native';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { Button } from '~/components/ui/Button';
import { STRESS_TEST_OFFERED } from '~/survey/stress/stressCore';
import { listCensuses, listFrames, type CensusListRow, type FrameRow } from '~/survey/db/stemmap';
import { Chevron } from '~/components/ui/Chevron';
import { showActionSheet } from '~/components/ActionSheet';
import { startModularSurveyAndOpen } from '~/lib/recordCreate';
import { templateName } from '~/survey/form/text';
import { SAMPLE_TEMPLATES, SAMPLE_TEMPLATES_OFFERED } from '~/survey/templates/samples';

type Row = { frame: FrameRow; last: CensusListRow | null; censuses: number };

function load(): Row[] {
  const censuses = listCensuses();
  return listFrames().map((frame) => {
    const own = censuses.filter((c) => c.frame_id === frame.id);
    return { frame, last: own[0] ?? null, censuses: own.length };
  });
}

export default function SurveyFramesScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(load);
  useFocusEffect(useCallback(() => setRows(load()), []));
  const newFrame = () => router.push('/survey/frame/edit' as Href);
  const startSample = async () => {
    const idx = await showActionSheet({
      options: SAMPLE_TEMPLATES.map((x) => ({ label: templateName(t, i18n.language, x) })),
      cancelLabel: t('common.cancel'),
    });
    const template = SAMPLE_TEMPLATES[idx];
    if (template) await startModularSurveyAndOpen(template);
  };

  return (
    <SettingsPage headerRight={() => <HeaderIconButton icon="add" label={t('survey.frame.new')} onPress={newFrame} />}>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.frame.id)}
        contentContainerClassName="gap-3 p-4"
        ListHeaderComponent={<Text className="text-sm text-gray-600 dark:text-gray-400">{t('survey.frames.desc')}</Text>}
        // The 1E stress test (app/survey/stress.tsx); in release builds too until testing is done.
        // The component preview (app/survey/components-preview.tsx, 2B) and the
        // checklist / plot-style test templates (2C) in development builds only.
        ListFooterComponent={
          <View className="gap-2">
            {SAMPLE_TEMPLATES_OFFERED ? <Button label="名錄型／樣區型調查（開發版）" variant="secondary" onPress={() => void startSample()} /> : null}
            {STRESS_TEST_OFFERED ? <Button label="每木壓力測試（測試用）" variant="secondary" onPress={() => router.push('/survey/stress' as Href)} /> : null}
            {__DEV__ ? <Button label="元件預覽（開發版）" variant="secondary" onPress={() => router.push('/survey/components-preview' as Href)} /> : null}
          </View>
        }
        ListEmptyComponent={
          <View className="items-center gap-3 py-10">
            <Text className="text-center text-sm text-gray-500 dark:text-gray-400">{t('survey.frames.empty')}</Text>
            <Button label={t('survey.frame.new')} icon="add" onPress={newFrame} />
          </View>
        }
        renderItem={({ item: { frame, last, censuses } }) => (
          <Pressable
            onPress={() => router.push(`/survey/frame/${frame.id}` as Href)}
            accessibilityRole="button"
            className="flex-row items-center rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
          >
            <View className="flex-1">
              <Text className="font-mono text-base font-bold text-ink dark:text-gray-100">
                {frame.code}
                {frame.name ? <Text className="font-sans font-semibold"> {frame.name}</Text> : null}
              </Text>
              <Text className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                {t('survey.frame.summary', { x: frame.size_x_m, y: frame.size_y_m, dbh: frame.dbh_min_cm })}
              </Text>
              <Text className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                {!last
                  ? t('survey.frames.noCensus')
                  : last.status === 'active'
                    ? t('survey.frames.lastActive', { n: last.census_no, count: censuses })
                    : t('survey.frames.lastDone', { n: last.census_no, count: censuses })}
              </Text>
            </View>
            <Chevron />
          </Pressable>
        )}
      />
    </SettingsPage>
  );
}
