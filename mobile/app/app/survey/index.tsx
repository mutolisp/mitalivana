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
import { listCensuses, listFrames, type CensusListRow, type FrameRow } from '~/survey/db/stemmap';
import { Chevron } from '~/components/ui/Chevron';

type Row = { frame: FrameRow; last: CensusListRow | null; censuses: number };

function load(): Row[] {
  const censuses = listCensuses();
  return listFrames().map((frame) => {
    const own = censuses.filter((c) => c.frame_id === frame.id);
    return { frame, last: own[0] ?? null, censuses: own.length };
  });
}

export default function SurveyFramesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(load);
  useFocusEffect(useCallback(() => setRows(load()), []));
  const newFrame = () => router.push('/survey/frame/edit' as Href);

  return (
    <SettingsPage headerRight={() => <HeaderIconButton icon="add" label={t('survey.frame.new')} onPress={newFrame} />}>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.frame.id)}
        contentContainerClassName="gap-3 p-4"
        ListHeaderComponent={<Text className="text-sm text-gray-600 dark:text-gray-400">{t('survey.frames.desc')}</Text>}
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
