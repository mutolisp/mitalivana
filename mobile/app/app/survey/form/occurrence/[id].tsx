/**
 * One occurrence of a checklist / plot-style survey: every component the
 * template puts on the occurrence level, written field by field (values the
 * store cannot hold are refused and shown; missing and cross-field problems
 * are shown, and finishing the survey reminds of them).
 *
 * A painted frequency grid gets a tab of its own that does not scroll: in a
 * scrolling form a swipe starting on the grid paints instead of scrolling
 * (found in 2B).
 *
 * A blind occurrence is sealed once the survey's blind phase is closed, as in
 * MIREN. `?unlocked=1`: opened from a finished survey unlocked on its screen.
 *
 * Interactions (2F) have a card of their own below the components: it lists
 * them from this occurrence's side and opens the screen that records one; a
 * sealed occurrence still takes new ones.
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { LineTabs } from '~/components/form/Segmented';
import { NumAccessory } from '~/components/form/NumField';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { LockedBanner } from '~/components/RecordEditButtons';
import { ScientificName } from '~/components/ScientificName';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { FormCard } from '~/survey/components/FormBits';
import { InteractionCard } from '~/survey/components/InteractionCard';
import { HeaderOccurrenceName } from '~/survey/components/NameText';
import { snapshotOf } from '~/survey/db/surveyCore';
import { deleteOccurrence, getFwSurvey, getOccurrence, interactionCountOf, listUnits, readComponent, updateOccurrence } from '~/survey/db/surveys';
import { layerCountOf } from '~/survey/form/checks';
import { ComponentCards } from '~/survey/form/ComponentCards';
import { labelForEdit } from '~/survey/form/labelPick';
import { formComponents } from '~/survey/form/occurrenceForm';
import { formErrorText } from '~/survey/form/text';
import { unitPath } from '~/survey/form/units';
import { occurrenceTitle, withNames } from '~/survey/form/useSurveyForm';
import type { ComponentInstance } from '~/survey/template/types';

type Tab = 'data' | 'freq';

/** A frequency component painted cell by cell (count mode is one number and stays in the form). */
const isGrid = (c: ComponentInstance) => c.type === 'frequency' && c.params.mode !== 'count';

function load(id: number) {
  const row = getOccurrence(id);
  const survey = row ? getFwSurvey(row.survey_id) : null;
  if (!row || !survey || survey.style === 'individual') return null;
  const template = snapshotOf(survey);
  const occurrence = withNames([row])[0];
  const all = formComponents(template, 'occurrence');
  // Interactions are rows of their own (InteractionCard), not values of this occurrence.
  const comps = all.filter((c) => c.type !== 'interaction');
  const interaction = all.find((c) => c.type === 'interaction') ?? null;
  const surveyComps = formComponents(template, 'survey');
  return {
    occurrence,
    survey,
    template,
    comps,
    interaction,
    /** What deleting it also deletes. */
    linked: interactionCountOf(id),
    units: survey.style === 'plot' ? listUnits(survey.id) : [],
    values: Object.fromEntries(comps.map((c) => [c.key, readComponent({ kind: 'occurrence', id }, c.key)])),
    surveyValues: Object.fromEntries(surveyComps.map((c) => [c.key, readComponent({ kind: 'survey', id: survey.id }, c.key)])),
    sealed: row.phase === 'blind' && survey.blind_closed_at != null,
  };
}

export default function OccurrenceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; unlocked?: string }>();
  const id = Number(params.id);
  const [data, setData] = useState(() => load(id));
  const [tab, setTab] = useState<Tab>('data');
  const reload = useCallback(() => setData(load(id)), [id]);
  useFocusEffect(reload);

  if (!data) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { occurrence: o, survey, template, comps } = data;
  const locked = survey.status === 'done' && params.unlocked !== '1';
  const readOnly = locked || data.sealed;
  const refuse = () => toast(t(data.sealed ? 'surveyForm.err.blindSealed' : 'surveyForm.lockedToast'));
  const grid = comps.filter(isGrid);
  const formComps = grid.length ? comps.filter((c) => !isGrid(c)) : comps;
  const shownTab: Tab = tab === 'freq' && grid.length ? 'freq' : 'data';
  const context = { kingdom: o.kingdom || null, className: o.class || null, layerCount: layerCountOf(template, data.surveyValues) };
  const name = o.common_name_c || o.simple_name || o.taxon_id;

  const relabel = async () => {
    const label = await labelForEdit(survey, { taxon_id: o.taxon_id, rank: o.rank, name }, o.verbatim_identification);
    if (label === undefined) return;
    try {
      updateOccurrence(o.id, { verbatim_identification: label });
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };
  const move = async () => {
    const rows = data.units;
    const idx = await showActionSheet({
      title: t('surveyForm.moveTitle'),
      options: [{ label: t('surveyForm.outsideUnits') }, ...rows.map((u) => ({ label: unitPath(rows, u.id) }))],
      cancelLabel: t('common.cancel'),
    });
    if (idx < 0 || idx > rows.length) return;
    const unitId = idx === 0 ? null : rows[idx - 1].id;
    try {
      updateOccurrence(o.id, { unit_id: unitId });
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };
  const remove = () =>
    Alert.alert(t('surveyForm.occ.deleteTitle'), [occurrenceTitle(o), data.linked ? t('survey.interaction.deleteWith', { count: data.linked }) : ''].filter(Boolean).join('\n\n'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          try {
            deleteOccurrence(o.id);
          } catch (e) {
            toast(formErrorText(t, e));
            return;
          }
          router.back();
        },
      },
    ]);
  const more = async () => {
    if (readOnly) return refuse();
    const items: { label: string; destructive?: boolean; run: () => void }[] = [
      { label: t('surveyForm.occ.label'), run: () => void relabel() },
      ...(survey.style === 'plot' ? [{ label: t('surveyForm.moveTitle'), run: () => void move() }] : []),
      { label: t('common.delete'), destructive: true, run: remove },
    ];
    const idx = await showActionSheet({ title: occurrenceTitle(o), options: items.map((x) => ({ label: x.label, destructive: x.destructive })), cancelLabel: t('common.cancel') });
    items[idx]?.run();
  };

  const header = (
    <FormCard>
      {/* With neither a label nor a common name the scientific name is the title, in italics by rank. */}
      {o.verbatim_identification || o.common_name_c ? <Text className="text-lg font-bold text-ink dark:text-gray-100">{o.verbatim_identification || o.common_name_c}</Text> : null}
      <ScientificName
        name={o.simple_name || o.taxon_id}
        rank={o.rank}
        kingdom={o.kingdom}
        className={o.verbatim_identification || o.common_name_c ? 'text-base text-ink-2 dark:text-gray-300' : 'text-lg font-bold text-ink dark:text-gray-100'}
      />
      <Text className="text-xs text-ink-3 dark:text-gray-400">
        {[
          // The scientific name is the line above (italic): only the common name here.
          o.verbatim_identification ? o.common_name_c : null,
          o.family,
          o.unit_id != null ? unitPath(data.units, o.unit_id) : survey.style === 'plot' ? t('surveyForm.outsideUnits') : null,
          o.phase === 'recheck' ? t('surveyForm.phase.recheck') : o.phase === 'blind' ? t('surveyForm.phase.blind') : null,
          o.via_interaction ? t('survey.interaction.viaTag') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </FormCard>
  );

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: occurrenceTitle(o),
          // The scientific name in italics by rank (a plain title cannot).
          headerTitle: () => <HeaderOccurrenceName o={o} plain={occurrenceTitle(o)} />,
          headerLeft: BackHeaderLeft,
          headerRight: () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} />,
        }}
      />
      {grid.length ? (
        <LineTabs
          value={shownTab}
          options={[
            { value: 'data', label: t('surveyForm.tab.data') },
            { value: 'freq', label: t('surveyForm.tab.freq') },
          ]}
          onChange={setTab}
        />
      ) : null}
      {locked ? <LockedBanner text={t('surveyForm.lockedBanner')} /> : data.sealed ? <LockedBanner text={t('surveyForm.err.blindSealed')} /> : null}
      {shownTab === 'freq' ? (
        // Not a ScrollView: the grid takes every swipe that starts on it.
        <View className="gap-3 p-4">
          <ComponentCards owner={{ kind: 'occurrence', id: o.id }} instances={grid} values={data.values} readOnly={readOnly} refuse={refuse} context={context} codelists={data.template.codelists} onChanged={reload} />
        </View>
      ) : (
        <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
          {header}
          <ComponentCards owner={{ kind: 'occurrence', id: o.id }} instances={formComps} values={data.values} readOnly={readOnly} refuse={refuse} context={context} codelists={data.template.codelists} onChanged={reload} />
          {data.interaction ? (
            <InteractionCard
              surveyId={survey.id}
              occurrenceId={o.id}
              instance={data.interaction}
              template={template}
              locked={locked}
              unlocked={params.unlocked === '1'}
              refuse={() => toast(t('surveyForm.lockedToast'))}
            />
          ) : null}
        </ScrollView>
      )}
      <NumAccessory />
    </SafeAreaView>
  );
}
