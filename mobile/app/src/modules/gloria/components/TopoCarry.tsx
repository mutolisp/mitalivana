/**
 * Fill the 1×1 m quadrats' aspect and slope from the previous survey of the
 * summit, for surveys created before a new survey carried them by itself
 * (model/prefill). Only quadrats with neither value get filled.
 */
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { useToast } from '~/stores/toast';
import { applyTopoFill, planTopoFromPrevious } from '../db';
import type { SurveyState } from '../useSurvey';
import { Btn } from './ui';

export function TopoCarry({ state, reload }: { state: SurveyState; reload: () => void }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const plan = planTopoFromPrevious(state.survey.id);
  if (!plan) return null;
  return (
    <Btn
      label={t('gloria.topo.carry', { mocy: plan.prev.mocy })}
      onPress={() => {
        if (!plan.fill.length) {
          toast(t('gloria.topo.none', { mocy: plan.prev.mocy }));
          return;
        }
        Alert.alert(
          t('gloria.topo.title'),
          t('gloria.topo.msg', { mocy: plan.prev.mocy, count: plan.fill.length, list: plan.fill.map((f) => f.code).join(' ') }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('gloria.dates.apply'),
              onPress: () => {
                applyTopoFill(state.survey.id, plan.fill);
                reload();
                toast(t('gloria.topo.done', { count: plan.fill.length }));
              },
            },
          ],
        );
      }}
    />
  );
}
