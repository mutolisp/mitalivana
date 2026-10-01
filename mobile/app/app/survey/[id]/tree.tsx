/**
 * One tree, full screen (phones; tablets edit beside the list). `ind` opens a
 * tree, no `ind` a new one in quadrat `q` (at `x`,`y` when the map was
 * tapped). "Save, next tree" steps through the quadrat in walking order, or
 * opens another new tree after a new one.
 *
 * Leaving with unsaved changes asks first. After a save the form reports
 * itself clean before the screen navigates (the effect below), so the guard
 * does not stop the screen's own navigation.
 */
import { usePreventRemove } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StepPager } from '~/components/ui/StepPager';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { TreeEditor } from '~/survey/components/TreeEditor';
import { loadQuadratRows, useCensus } from '~/survey/useCensus';

export default function CensusTreeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const navigation = useNavigation();
  const toast = useToast((s) => s.show);
  const p = useLocalSearchParams<{ id: string; ind?: string; q?: string; x?: string; y?: string }>();
  const surveyId = Number(p.id);
  const individualId = p.ind ? Number(p.ind) : null;
  const { data } = useCensus(surveyId);
  const state = data?.states.find((s) => s.id === individualId) ?? null;
  const quadrat = p.q ?? state?.quadratCode ?? '0000';
  const at = p.x != null && p.y != null ? { x: Number(p.x), y: Number(p.y) } : null;
  const order = useMemo(() => (data ? loadQuadratRows(data, quadrat).map((r) => r.view.individual.id) : []), [data, quadrat]);
  const index = individualId == null ? -1 : order.indexOf(individualId);

  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<null | (() => void)>(null);
  usePreventRemove(dirty, ({ data: ev }) => {
    Alert.alert(t('survey.tree.unsavedTitle'), t('survey.tree.unsavedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.tree.discard'), style: 'destructive', onPress: () => navigation.dispatch(ev.action) },
    ]);
  });
  useEffect(() => {
    if (pending && !dirty) {
      setPending(null);
      pending();
    }
  }, [pending, dirty]);

  const goTo = (id: number) => router.replace(`/survey/${surveyId}/tree?ind=${id}&q=${quadrat}` as Href);

  if (!data) return <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark" />;

  return (
    <>
      <Stack.Screen
        options={{
          title: individualId == null ? t('survey.census.newTree') : `#${state?.tag ?? ''}`,
          headerLeft: BackHeaderLeft,
          headerRight:
            index >= 0 && order.length > 1
              ? () => <StepPager index={index} total={order.length} onStep={(dir) => goTo(order[index + dir])} />
              : undefined,
        }}
      />
      <TreeEditor
        key={`${individualId ?? 'new'}-${p.x ?? ''}-${p.y ?? ''}`}
        surveyId={surveyId}
        frame={data.frame}
        firstCensus={data.firstCensus}
        individualId={individualId}
        quadrat={quadrat}
        at={at}
        states={data.states}
        recordedBy={data.quadrats.find((q) => q.quadrat_code === quadrat)?.recorded_by ?? data.survey.investigators ?? null}
        onDirtyChange={setDirty}
        onSaved={(id, next) => {
          if (!next) return setPending(() => () => router.back());
          if (individualId == null) return setPending(() => () => router.replace(`/survey/${surveyId}/tree?q=${quadrat}` as Href));
          const after = order[order.indexOf(id) + 1];
          if (after != null) return setPending(() => () => goTo(after));
          toast(t('survey.tree.lastInQuadrat'));
          setPending(() => () => router.back());
        }}
      />
    </>
  );
}
