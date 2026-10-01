/**
 * One tree, full screen (phones; tablets edit beside the list). `ind` opens a
 * tree, no `ind` a new one in quadrat `q` (at `x`,`y` when the map was
 * tapped). "Save, next tree" steps through the quadrat in walking order, or
 * opens another new tree after a new one.
 *
 * Stepping to another tree stays on this screen and swaps the form (`cur`):
 * replacing the screen with itself crashed Android's native stack
 * ("ScreenStackFragment added into a non-stack container", react-native-screens,
 * found 2026-10-01). Only leaving uses navigation.
 *
 * Leaving with unsaved changes asks first. After a save the form reports
 * itself clean before the screen leaves (the effect below), so the guard does
 * not stop the screen's own navigation.
 *
 * A header update reaching a screen that is already being popped crashes
 * Android the same way. usePreventRemove writes its flag into the header
 * config (native-stack NativeStackView: headerBackButtonMenuEnabled), so the
 * flag going false after a save must reach the native side before the pop:
 * the leave waits a moment after the form turns clean. The leave path sets no
 * state of its own (the census screen reloads on focus), and the header
 * options are memoised on their values.
 */
import { usePreventRemove } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StepPager } from '~/components/ui/StepPager';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { TreeEditor } from '~/survey/components/TreeEditor';
import { loadQuadratRows, useCensus } from '~/survey/useCensus';

type Current = { id: number | null; at: { x: number; y: number } | null; n: number };

/** Time for the cleared leave guard to reach the native header (see above). */
const LEAVE_AFTER_MS = 120;

export default function CensusTreeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const navigation = useNavigation();
  const toast = useToast((s) => s.show);
  const p = useLocalSearchParams<{ id: string; ind?: string; q?: string; x?: string; y?: string }>();
  const surveyId = Number(p.id);
  const { data, reload } = useCensus(surveyId);
  const [cur, setCur] = useState<Current>(() => ({
    id: p.ind ? Number(p.ind) : null,
    at: p.x != null && p.y != null ? { x: Number(p.x), y: Number(p.y) } : null,
    n: 0,
  }));
  const state = data?.states.find((s) => s.id === cur.id) ?? null;
  const quadrat = p.q ?? state?.quadratCode ?? '0000';
  const order = useMemo(() => (data ? loadQuadratRows(data, quadrat).map((r) => r.view.individual.id) : []), [data, quadrat]);
  const index = cur.id == null ? -1 : order.indexOf(cur.id);

  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(false);
  usePreventRemove(dirty, ({ data: ev }) => {
    Alert.alert(t('survey.tree.unsavedTitle'), t('survey.tree.unsavedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.tree.discard'), style: 'destructive', onPress: () => navigation.dispatch(ev.action) },
    ]);
  });
  useEffect(() => {
    if (!leaving || dirty || left.current) return;
    const timer = setTimeout(() => {
      left.current = true;
      router.back();
    }, LEAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [leaving, dirty, router]);

  const show = (id: number | null) => setCur({ id, at: null, n: Date.now() });
  const step = (dir: -1 | 1) => {
    const target = order[index + dir];
    if (target == null) return;
    if (!dirty) return show(target);
    Alert.alert(t('survey.tree.unsavedTitle'), t('survey.tree.unsavedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('survey.tree.discard'), style: 'destructive', onPress: () => show(target) },
    ]);
  };

  const title = cur.id == null ? t('survey.census.newTree') : `#${state?.tag ?? ''}`;
  const pager = index >= 0 && order.length > 1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(
    () => ({ title, headerLeft: BackHeaderLeft, headerRight: pager ? () => <StepPager index={index} total={order.length} onStep={step} /> : undefined }),
    [title, pager, index, order.length, dirty],
  );

  if (!data) return <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark" />;

  return (
    <>
      <Stack.Screen options={options} />
      <TreeEditor
        key={`${cur.id ?? 'new'}-${cur.n}`}
        surveyId={surveyId}
        frame={data.frame}
        firstCensus={data.firstCensus}
        individualId={cur.id}
        quadrat={quadrat}
        at={cur.at}
        states={data.states}
        recordedBy={data.quadrats.find((q) => q.quadrat_code === quadrat)?.recorded_by ?? data.survey.investigators ?? null}
        onDirtyChange={setDirty}
        onChanged={reload}
        onSaved={(id, next) => {
          if (!next) return setLeaving(true);
          reload();
          if (cur.id == null) return show(null);
          const after = order[order.indexOf(id) + 1];
          if (after != null) return show(after);
          toast(t('survey.tree.lastInQuadrat'));
          setLeaving(true);
        }}
      />
    </>
  );
}
