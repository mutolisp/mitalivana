/**
 * The survey's researchers (sheet 01_ via 51_), on the base-data tab: picked
 * from the surveyor list, and gathered from the researchers set on single
 * 1×1 m, SAS and 10×10 m units (model/researchers). A unit with no
 * researchers of its own follows the survey.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text } from 'react-native';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { useToast } from '~/stores/toast';
import { updateGloriaSurvey } from '../db';
import { researchersFromUnits } from '../model/researchers';
import type { SurveyState } from '../useSurvey';
import { Btn, Card, Label } from './ui';

export function SurveyResearchers({ state, reload }: { state: SurveyState; reload: () => void }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [picking, setPicking] = useState(false);
  const sv = state.survey;

  const set = (v: string | null) => {
    updateGloriaSurvey(sv.id, { recorded_by: v });
    reload();
  };

  const fromUnits = () => {
    const { value, added } = researchersFromUnits(sv.recorded_by, state.units);
    if (!added.length) {
      toast(t('gloria.researchers.noneNew'));
      return;
    }
    Alert.alert(t('gloria.researchers.fromUnitsTitle'), t('gloria.researchers.fromUnitsMsg', { names: added.join(', ') }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('gloria.dates.apply'), onPress: () => set(value) },
    ]);
  };

  return (
    <>
      <Label>{t('gloria.new.surveyors')}</Label>
      <Card className="gap-2 p-3">
        <Pressable
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel={t('gloria.new.surveyors')}
          className="rounded-md border border-gray-300 bg-card px-2 py-2 dark:border-gray-700 dark:bg-gray-900"
        >
          <Text className={`text-sm ${sv.recorded_by ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
            {sv.recorded_by || t('gloria.times.byNone')}
          </Text>
        </Pressable>
        <Btn small label={t('gloria.researchers.fromUnits')} onPress={fromUnits} />
        <Text className="text-[11px] text-gray-400">{t('gloria.researchers.hint')}</Text>
      </Card>
      <SurveyorAssignSheet
        visible={picking}
        current={sv.recorded_by ?? ''}
        onCancel={() => setPicking(false)}
        onAssign={(v) => {
          setPicking(false);
          const next = v.trim() || null;
          if (next !== sv.recorded_by) set(next);
        }}
      />
    </>
  );
}
