/**
 * A permanent plot's morphospecies list (fw_frame_labels, Modular_survey.md
 * §5.5 #7): each label (`sp1`) with its taxon, a note and a photo, so the same
 * label names the same plant in every survey of the plot. Labels join the list
 * while recording (the survey asks first); here their note and photo are kept
 * up. The taxon and label are what occurrences match on and do not change.
 */
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { ScientificName } from '~/components/ScientificName';
import { promptText } from '~/components/TextPromptModal';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { useToast } from '~/stores/toast';
import { getFrame } from '~/survey/db/stemmap';
import { listFrameLabels, updateFrameLabel } from '~/survey/db/surveys';
import { withNames } from '~/survey/form/useSurveyForm';

function load(frameId: number) {
  const frame = getFrame(frameId);
  if (!frame) return null;
  return { frame, labels: withNames(listFrameLabels(frameId).map((l) => ({ ...l, used_name_id: null, used_scientific_name: null }))) };
}

export default function FrameLabelsScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const frameId = Number(useLocalSearchParams<{ id: string }>().id);
  const [data, setData] = useState(() => load(frameId));
  const reload = useCallback(() => setData(load(frameId)), [frameId]);
  useFocusEffect(reload);
  if (!data) return null;

  const setPhoto = async (id: number, get: () => Promise<string | null>) => {
    let uri: string | null = null;
    try {
      uri = await get();
    } catch (e) {
      toast(errText(e));
      return;
    }
    if (!uri) return;
    updateFrameLabel(id, { photoUri: uri });
    reload();
  };
  const menu = async (l: (typeof data.labels)[number]) => {
    const items: { label: string; destructive?: boolean; go: () => Promise<void> | void }[] = [
      {
        label: t('surveyForm.labels.note'),
        go: async () => {
          const v = await promptText({ title: t('surveyForm.labels.note'), defaultValue: l.note ?? '', allowEmpty: true });
          if (v == null) return;
          updateFrameLabel(l.id, { note: v.trim() || null });
          reload();
        },
      },
      { label: t('surveyForm.labels.takePhoto'), go: () => setPhoto(l.id, captureEnvPhoto) },
      { label: t('surveyForm.labels.pickPhoto'), go: () => setPhoto(l.id, async () => (await pickPhotos())[0] ?? null) },
      ...(l.photo_uri
        ? [
            {
              label: t('surveyForm.labels.removePhoto'),
              destructive: true,
              go: () => {
                updateFrameLabel(l.id, { photoUri: null });
                reload();
              },
            },
          ]
        : []),
    ];
    const idx = await showActionSheet({ title: l.verbatim_identification, options: items.map((x) => ({ label: x.label, destructive: x.destructive })), cancelLabel: t('common.cancel') });
    await items[idx]?.go();
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('surveyForm.labels.title', { code: data.frame.code }), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
        <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">{t('surveyForm.labels.desc')}</Text>
        {data.labels.length === 0 ? <Text className="text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.labels.empty')}</Text> : null}
        {data.labels.map((l) => (
          <Pressable
            key={l.id}
            onPress={() => void menu(l)}
            accessibilityRole="button"
            className="flex-row items-center gap-3 rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
          >
            {l.photo_uri ? <Image source={{ uri: l.photo_uri }} style={{ width: 56, height: 56, borderRadius: 8 }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
            <View className="flex-1">
              <Text className="text-base font-bold text-ink dark:text-gray-100">{l.verbatim_identification}</Text>
              <ScientificName name={l.simple_name || l.taxon_id} rank={l.rank} kingdom={l.kingdom} className="text-sm text-ink-2 dark:text-gray-300" />
              {l.note ? <Text className="text-xs text-ink-3 dark:text-gray-400">{l.note}</Text> : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
