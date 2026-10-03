/**
 * Recently deleted records (record versions, v73): for 30 days after a
 * checklist, plot survey, GLORIA survey, checklist / plot-style survey or
 * tree census is deleted, its versions stay and
 * the record can be rebuilt from the latest one (recoverRecord), under its own
 * uuid and finished. Photos come back only if their files are still here.
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SettingsPage } from '~/components/settings/SettingsPage';
import { sweepRecordVersions } from '~/db/cleanup';
import { listDeletedRecords, recoverRecord, type DeletedRecord, type VersionKind } from '~/db/recordVersions';
import { RecoverCensusError } from '~/survey/db/censusVersions';
import { InsertSurveyError } from '~/survey/db/surveyDocs';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { DELETED_KEEP_MS } from '~/lib/recordVersionsCore';
import { syncedRecordHref } from '~/lib/teamSync';
import { useToast } from '~/stores/toast';

const DAY = 24 * 3600 * 1000;

export default function DeletedRecordsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [items, setItems] = useState<DeletedRecord[]>([]);
  const load = useCallback(() => {
    // A record deleted since start-up is noticed now, not at the next launch.
    sweepRecordVersions();
    setItems(listDeletedRecords());
  }, []);
  useFocusEffect(load);

  const hrefOf = (kind: VersionKind, id: number): Href => {
    switch (kind) {
      case 'survey':
        return `/survey/${id}` as Href;
      case 'survey_quadrat':
        return '/survey' as Href; // never listed: quadrats come back with their census
      default:
        return syncedRecordHref(kind, id);
    }
  };
  const recover = (r: DeletedRecord) =>
    Alert.alert(t('versions.recoverTitle'), t('versions.recoverMsg', { name: r.label ?? '' }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('versions.recoverGo'),
        onPress: () => {
          try {
            const id = recoverRecord(r.kind, r.uuid);
            load();
            toast(t('versions.recovered', { name: r.label ?? '' }));
            router.push(hrefOf(r.kind, id));
          } catch (e) {
            const why =
              e instanceof RecoverCensusError
                ? e.code === 'census_no_taken'
                  ? t('survey.census.recoverNumberTaken')
                  : t('survey.census.recoverCodeTaken')
                : e instanceof InsertSurveyError
                  ? e.code === 'number_taken'
                    ? t('surveyForm.recoverNumberTaken')
                    : t('survey.census.recoverCodeTaken')
                  : errText(e);
            Alert.alert(t('versions.recoverFail'), why);
          }
        },
      },
    ]);

  return (
    <SettingsPage title={t('versions.deletedTitle')}>
      <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
        <Text className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('versions.deletedIntro')}</Text>
        {items.length === 0 ? <Text className="py-6 text-center text-sm text-gray-400">{t('versions.deletedNone')}</Text> : null}
        {items.map((r) => {
          const left = Math.max(0, Math.ceil((r.deletedAt + DELETED_KEEP_MS - Date.now()) / DAY));
          return (
            <Pressable
              key={`${r.kind}|${r.uuid}`}
              onPress={() => recover(r)}
              accessibilityRole="button"
              className="flex-row items-center gap-3 rounded-lg border border-gray-200 bg-card px-3 py-2.5 active:bg-gray-50 dark:border-gray-800 dark:bg-gray-900"
            >
              <View className="flex-1">
                <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{r.label || t('teamSync.log.unnamed')}</Text>
                <Text className="text-xs text-gray-500 dark:text-gray-400">
                  {t(`versions.kind.${r.kind}`)} · {t('versions.deletedAt', { when: isoStamp(r.deletedAt).slice(0, 16) })} ·{' '}
                  {t('versions.daysLeft', { n: left })}
                </Text>
              </View>
              <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('versions.recoverGo')}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </SettingsPage>
  );
}
