/**
 * 調查資料 of a checklist-style survey (2G-c, regrouped in 2G-f; canvas 16f,
 * decided 2026-10-04): opened from the context strip's chip, the survey's
 * data in four fixed groups — 基本資料, 時間資料, 空間資料 and 調查法 —
 * each a full-screen page (group/[g].tsx) stepping to the next with ‹ › or a
 * swipe. Time, surveyors and place keep their own chips too.
 *
 * `?unlocked=1`: opened from a finished survey unlocked on its screen.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { LockedBanner } from '~/components/RecordEditButtons';
import { BackHeaderLeft } from '~/lib/goBack';
import { SurveyGroupList } from '~/survey/form/SurveyGroupViews';
import { surveyDataStatus } from '~/survey/form/surveyGroups';
import { templateName } from '~/survey/form/text';
import { useSurveyForm } from '~/survey/form/useSurveyForm';

export default function SurveyDataScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; unlocked?: string }>();
  const id = Number(params.id);
  const { data } = useSurveyForm(id);
  if (!data) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { survey, template } = data;
  const locked = survey.status === 'done' && params.unlocked !== '1';
  const status = surveyDataStatus(template, data.surveyValues, survey);
  const suffix = params.unlocked === '1' ? '?unlocked=1' : '';

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: t('surveyForm.surveyData'),
          headerTitle: () => (
            <HeaderTitleText
              text={t('surveyForm.surveyData')}
              subtitle={
                <Text numberOfLines={1} className="text-xs text-gray-500 dark:text-gray-400">
                  {`${templateName(t, i18n.language, template)} · ${t('surveyForm.dataFilled', { filled: status.filled, total: status.total })}`}
                </Text>
              }
            />
          ),
          headerLeft: BackHeaderLeft,
        }}
      />
      {locked ? <LockedBanner text={t('surveyForm.dataLocked')} /> : null}
      <ScrollView>
        <SurveyGroupList data={data} onOpen={(g) => router.push(`/survey/form/${id}/group/${g}${suffix}` as Href)} />
      </ScrollView>
    </SafeAreaView>
  );
}
