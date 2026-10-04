/**
 * 調查資料 of a checklist-style survey (2G-c, regrouped in 2G-f; canvas 16f,
 * decided 2026-10-04): opened from the context strip's chip, the survey's
 * data in four fixed groups — 基本資料, 時間資料, 空間資料 and 調查法. Shown
 * as the user last chose from ⋯ (`survey_data_layout`, asked 2026-10-04): a
 * list of the groups, each a full-screen page (group/[g].tsx) stepping to the
 * next with ‹ › or a swipe; or every group on this one page. Time, surveyors
 * and place keep their own chips too.
 *
 * `?unlocked=1`: opened from a finished survey unlocked on its screen.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NumAccessory } from '~/components/form/NumField';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { MenuButton, showMenu } from '~/components/OverflowMenu';
import { LockedBanner } from '~/components/RecordEditButtons';
import { BackHeaderLeft } from '~/lib/goBack';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useSettings } from '~/stores/settings';
import { SurveyGroupList, SurveyGroupSections } from '~/survey/form/SurveyGroupViews';
import { surveyDataStatus } from '~/survey/form/surveyGroups';
import { templateName } from '~/survey/form/text';
import { useSurveyForm } from '~/survey/form/useSurveyForm';

export default function SurveyDataScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; unlocked?: string }>();
  const id = Number(params.id);
  const layout = useSettings((s) => s.survey_data_layout);
  const setSetting = useSettings((s) => s.set);
  useVersionOnLeave('modular', id);
  const { data, reload: load } = useSurveyForm(id);
  // Edited on this page when every group is on it, as on a group page.
  const edit = useRecordEditing('modular', id, data?.survey.status === 'done', params.unlocked === '1');
  const { checkpoint } = edit;
  /** After a write: read again, and the change becomes one undo step. */
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);
  const openMenu = async (anchor: RefObject<View | null>) => {
    const choice = await showMenu(anchor, [
      { items: [{ kind: 'action', id: 'layout', label: t(layout === 'single' ? 'surveyForm.layout.toGrouped' : 'surveyForm.layout.toSingle'), icon: layout === 'single' ? 'list-outline' : 'reader-outline' }] },
    ]);
    if (choice === 'layout') setSetting('survey_data_layout', layout === 'single' ? 'grouped' : 'single');
  };
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
          headerRight: () => <MenuButton onOpen={openMenu} />,
        }}
      />
      {locked ? <LockedBanner text={t('surveyForm.dataLocked')} /> : null}
      {layout === 'single' ? (
        <KeyboardAwareScrollView className="flex-1" keyboardShouldPersistTaps="handled" bottomOffset={24}>
          <SurveyGroupSections data={data} edit={edit} onChanged={reload} />
          <View className="h-10" />
        </KeyboardAwareScrollView>
      ) : (
        <ScrollView>
          <SurveyGroupList data={data} onOpen={(g) => router.push(`/survey/form/${id}/group/${g}${suffix}` as Href)} />
        </ScrollView>
      )}
      <NumAccessory />
    </SafeAreaView>
  );
}
