/**
 * One group of a survey's 調查資料 (2G-f; canvas 16g–16j): 基本資料, 時間資料,
 * 空間資料 or 調查法, full screen, opened from the group list (the checklist
 * style's 調查資料 page, the plot style's environment tab). ‹ › in the header
 * and a horizontal swipe step to the neighbouring group, without a hint
 * (asked 2026-10-04). Each edit is one step of the survey's undo history.
 *
 * `?unlocked=1`: opened from a finished survey unlocked on its screen.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NumAccessory } from '~/components/form/NumField';
import { HeaderTitleText } from '~/components/HeaderTitleText';
import { LockedBanner } from '~/components/RecordEditButtons';
import { SwipeBlockProvider, SwipeNavArea, useSwipeNav } from '~/components/SwipeNavigator';
import { StepPager } from '~/components/ui/StepPager';
import { BackHeaderLeft } from '~/lib/goBack';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { GROUP_TITLE, SurveyGroupBody } from '~/survey/form/SurveyGroupViews';
import { surveyGroups, type GroupKey } from '~/survey/form/surveyGroups';
import { useSurveyForm } from '~/survey/form/useSurveyForm';

export default function SurveyGroupScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; g: string; unlocked?: string }>();
  const id = Number(params.id);
  useVersionOnLeave('modular', id);
  const { data, reload: load } = useSurveyForm(id);
  const edit = useRecordEditing('modular', id, data?.survey.status === 'done', params.unlocked === '1');
  const { checkpoint } = edit;
  /** After a write: read again, and the change becomes one undo step. */
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);
  const keys = data ? surveyGroups(data.template).map((g) => g.key) : [];
  const index = keys.indexOf(params.g as GroupKey);
  const step = (dir: -1 | 1) => {
    const next = keys[index + dir];
    if (next) router.setParams({ g: next });
  };
  const nav = useSwipeNav({ onStep: step, hasPrev: index > 0, hasNext: index >= 0 && index < keys.length - 1 });

  if (!data || index < 0) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const group = keys[index];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: t(GROUP_TITLE[group]),
          headerTitle: () => (
            <HeaderTitleText
              text={t(GROUP_TITLE[group])}
              subtitle={
                <Text numberOfLines={1} className="text-xs text-gray-500 dark:text-gray-400">
                  {t('surveyForm.group.pageOf', { n: index + 1, total: keys.length })}
                </Text>
              }
            />
          ),
          headerLeft: BackHeaderLeft,
          headerRight: () => <StepPager index={index} total={keys.length} onStep={step} />,
        }}
      />
      {edit.locked ? <LockedBanner text={t('surveyForm.dataLocked')} /> : null}
      <SwipeBlockProvider nav={nav}>
        <SwipeNavArea nav={nav}>
          <KeyboardAwareScrollView key={group} className="flex-1" keyboardShouldPersistTaps="handled" bottomOffset={24}>
            <SurveyGroupBody data={data} edit={edit} group={group} onChanged={reload} />
          </KeyboardAwareScrollView>
        </SwipeNavArea>
      </SwipeBlockProvider>
      <NumAccessory />
    </SafeAreaView>
  );
}
