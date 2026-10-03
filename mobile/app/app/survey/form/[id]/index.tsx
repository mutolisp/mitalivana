/**
 * A checklist / plot-style survey (Modular_survey.md; Phase 2C-a): its own
 * data, its units (plot style) and its species.
 *
 * - Species are added from the search docked at the bottom of 物種, into the
 *   unit picked in the chips above the list ("全部" adds outside any unit);
 *   when this survey is the open record, species added elsewhere (species
 *   tab, taxonomy tree, favorites, keys) go to the same unit (quickAdd.ts).
 * - An occurrence opens its own screen (app/survey/form/occurrence/[id].tsx).
 * - A recheck of a permanent plot starts blind (§5.5): the previous list
 *   stays hidden until 結束盲測, after which the blind occurrences are sealed
 *   and every taxon of the previous survey missing from them needs an answer
 *   (recheck.tsx).
 * - Interactions (2F) have a tab of their own when the template has them;
 *   an occurrence made only as an interaction's other side is listed after
 *   the others, marked, and not counted as a species of the survey.
 * - A finished survey is locked until unlocked here, as 樣區 are. Every edit
 *   made here is a step undo / redo in ⋯ takes back (useRecordEditing; a
 *   closed blind phase's records excepted, recordSnapshotCore.ts); a version
 *   is kept on leaving and on finishing, and ⋯ opens the versions and team
 *   sync (Phase 2C-b).
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { LineTabs } from '~/components/form/Segmented';
import { NumAccessory } from '~/components/form/NumField';
import { KeyboardStickyView } from '~/components/KeyboardAvoidingView';
import { LockedBanner } from '~/components/RecordEditButtons';
import { RecordMenuButton } from '~/components/RecordMenuButton';
import { ScientificName } from '~/components/ScientificName';
import { SearchBox } from '~/components/SearchBox';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { Chip } from '~/components/ui/Chip';
import type { AdoptionInput } from '~/db/taxonLookup';
import type { SearchResult } from '~/db';
import { onVersionRestored, saveVersionSoon } from '~/db/recordVersions';
import { isoStamp } from '~/lib/datetime';
import { chooseEndTime } from '~/lib/endTimeChoice';
import { BackHeaderLeft } from '~/lib/goBack';
import { useRecordEditing } from '~/lib/useRecordEditing';
import { useVersionOnLeave } from '~/lib/useVersionOnLeave';
import { useActiveGloria } from '~/modules/gloria/store';
import { useActiveMiren } from '~/modules/miren/store';
import { useActivePlot } from '~/stores/activePlot';
import { useActiveSession } from '~/stores/activeSession';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { componentSummary } from '~/survey/components/editors/ComponentEditor';
import { FormCard } from '~/survey/components/FormBits';
import { InteractionSummary } from '~/survey/components/InteractionSummary';
import {
  addOccurrence,
  addUnit,
  closeBlindPhase,
  deleteOccurrence,
  deleteSurvey,
  findOccurrence,
  finishSurvey,
  interactionCountOf,
  reopenBlindPhase,
  reopenSurvey,
  updateSurvey,
  upgradeSurvey,
} from '~/survey/db/surveys';
import { useActiveSurvey } from '~/survey/form/activeSurvey';
import { occurrencesWithErrors } from '~/survey/form/checks';
import { ComponentCards } from '~/survey/form/ComponentCards';
import { labelForNew } from '~/survey/form/labelPick';
import { blankOccurrenceHasErrors, formComponents } from '~/survey/form/occurrenceForm';
import { carriedNotes, formErrorText, levelLabel, templateName } from '~/survey/form/text';
import { occurrenceTitle, useSurveyForm, type OccurrenceView } from '~/survey/form/useSurveyForm';
import { setSurveyView, surveyView, type SurveyTab, type UnitPick } from '~/survey/form/viewState';

type Tab = SurveyTab;

const refreshStores = () => {
  useActiveSurvey.getState().refresh();
  useActiveSession.getState().refresh();
  useActivePlot.getState().refresh();
  useActiveGloria.getState().refresh();
  useActiveMiren.getState().refresh();
};

export default function SurveyFormScreen() {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const { data, reload: load } = useSurveyForm(id);
  const [tab, setTabState] = useState<Tab>(() => surveyView(id)?.tab ?? 'species');
  const [unitPick, setUnitPickState] = useState<UnitPick>(() => surveyView(id)?.unit ?? 'all');
  const rootRef = useRef<View>(null);
  const [rootTop, setRootTop] = useState<number | undefined>(undefined);

  const survey = data?.survey;
  const isPlot = survey?.style === 'plot';
  // Lock + undo / redo: a finished survey is read-only until unlocked here; every reload after an edit is one step.
  const edit = useRecordEditing('modular', id, survey?.status === 'done');
  const { checkpoint, unlocked, locked } = edit;
  const reload = useCallback(() => {
    load();
    checkpoint();
  }, [load, checkpoint]);
  useVersionOnLeave('modular', id);
  // A version restored from the versions screen (opened over this one): read everything again.
  useEffect(() => onVersionRestored((kind, rid) => kind === 'modular' && rid === id && load()), [id, load]);
  const blindOpen = !!data?.recheck && survey?.blind_closed_at == null;
  const unitIds = useMemo(() => new Set(data?.units.map((u) => u.unit.id) ?? []), [data]);
  const pick: UnitPick = typeof unitPick === 'number' && !unitIds.has(unitPick) ? 'all' : unitPick;
  /** Where the dock adds to: a unit, or outside any unit. */
  const dest: number | null = typeof pick === 'number' ? pick : null;

  const setTab = (next: Tab) => {
    setTabState(next);
    setSurveyView(id, { tab: next });
  };
  const setUnitPick = (next: UnitPick) => {
    setUnitPickState(next);
    setSurveyView(id, { unit: next });
    if (survey?.status === 'active') useActiveSurvey.getState().setUnit(id, typeof next === 'number' ? next : null);
  };
  // A unit screen may have sent the user here to record in that unit.
  useFocusEffect(
    useCallback(() => {
      const v = surveyView(id);
      if (v) {
        setTabState(v.tab);
        setUnitPickState(v.unit);
      }
    }, [id]),
  );
  // Quick adds from other screens go to the unit picked here while this survey is open.
  useFocusEffect(
    useCallback(() => {
      if (survey?.status === 'active') useActiveSurvey.getState().setUnit(id, dest);
    }, [survey?.status, id, dest]),
  );

  const shown = useMemo(() => {
    const all = data?.occurrences ?? [];
    const here = pick === 'all' ? all : pick === 'none' ? all.filter((o) => o.unit_id == null) : all.filter((o) => o.unit_id === pick);
    // Those made only as an interaction's other side come last (2F).
    return [...here.filter((o) => !o.via_interaction), ...here.filter((o) => o.via_interaction)];
  }, [data, pick]);
  const taken = useMemo(
    // One made only as an interaction's other side is not in the list yet: adding it takes it over.
    () => new Set((data?.occurrences ?? []).filter((o) => o.unit_id === dest && !o.verbatim_identification && !o.via_interaction).map((o) => o.taxon_id)),
    [data, dest],
  );
  const abundance = data ? formComponents(data.template, 'occurrence').find((c) => c.type === 'abundance') : undefined;

  if (!data || !survey) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-ink-3 dark:text-gray-400">{t('surveyForm.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const { template } = data;
  const refuse = () => toast(t('surveyForm.lockedToast'));
  const unitName = (u: UnitPick) =>
    u === 'all' || u === 'none' ? t('surveyForm.outsideUnits') : (data.units.find((x) => x.unit.id === u)?.path ?? '');

  // ── actions ────────────────────────────────────────────────────────────────

  const add = async (r: SearchResult, adopted?: AdoptionInput | null) => {
    if (!r.taxon_id) return;
    if (locked) return refuse();
    const name = r.cname || r.name;
    const label = await labelForNew(survey, { taxon_id: r.taxon_id, rank: r.rank, name });
    if (label === undefined) return;
    if (findOccurrence(id, dest, r.taxon_id, label)) {
      toast(t('addToRecord.alreadyInRecord', { name: label ?? name }));
      return;
    }
    // Built outside the try: a value block inside one makes React Compiler skip the component (errText.ts).
    const fields = {
      taxon_id: r.taxon_id,
      unit_id: dest,
      verbatim_identification: label,
      ...(adopted ? { used_name_id: adopted.name_id ?? null, used_scientific_name: adopted.scientific_name } : {}),
    };
    const openForm = blankOccurrenceHasErrors(template);
    let occ: number;
    try {
      occ = addOccurrence(id, fields);
    } catch (e) {
      toast(formErrorText(t, e));
      return;
    }
    reload();
    if (openForm) router.push(`/survey/form/occurrence/${occ}` as Href);
  };

  const occurrenceMenu = async (o: OccurrenceView) => {
    if (locked) return refuse();
    if (o.sealed) {
      toast(t('surveyForm.err.blindSealed'));
      return;
    }
    const linked = interactionCountOf(o.id);
    const idx = await showActionSheet({
      title: occurrenceTitle(o),
      ...(linked ? { message: t('survey.interaction.deleteWith', { count: linked }) } : {}),
      options: [{ label: t('common.delete'), destructive: true }],
      cancelLabel: t('common.cancel'),
    });
    if (idx !== 0) return;
    try {
      deleteOccurrence(o.id);
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };

  const addTopUnit = async () => {
    if (locked) return refuse();
    const level = data.levelKeys[0];
    if (!level) return;
    const code = await promptText({
      title: t('surveyForm.unit.addTitle', { level: levelLabel(t, i18n.language, template, level) }),
      message: t('surveyForm.unit.codeMsg'),
      placeholder: 'A',
      autoCapitalize: 'characters',
    });
    if (!code?.trim()) return;
    try {
      addUnit(id, { levelKey: level, code: code.trim(), sort: data.units.length });
      reload();
    } catch (e) {
      toast(formErrorText(t, e));
    }
  };

  const rename = async () => {
    if (locked) return refuse();
    const name = await promptText({ title: t('surveyForm.rename'), defaultValue: survey.name ?? '', autoCapitalize: 'none' });
    if (!name?.trim()) return;
    updateSurvey(id, { name: name.trim() });
    refreshStores();
    reload();
  };

  const endBlind = () =>
    Alert.alert(t('surveyForm.blind.endTitle'), t('surveyForm.blind.endMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('surveyForm.blind.end'),
        onPress: () => {
          closeBlindPhase(id);
          reload();
          router.push(`/survey/form/${id}/recheck` as Href);
        },
      },
    ]);

  const finish = async (afterDialog = false) => {
    const errors = occurrencesWithErrors(template, data.occurrences.map((o) => o.id));
    const open = data.recheckState?.open ?? 0;
    const note = [
      blindOpen ? t('surveyForm.finish.blindOpen') : null,
      open > 0 ? t('surveyForm.finish.recheckOpen', { count: open }) : null,
      errors > 0 ? t('surveyForm.finish.errors', { count: errors }) : null,
    ]
      .filter(Boolean)
      .join('\n');
    const chosen = await chooseEndTime(survey.stop_ts, { title: t('surveyForm.finish.title'), note: note || undefined, afterDialog });
    if (chosen === undefined) return;
    finishSurvey(id, chosen);
    saveVersionSoon('modular', id, 'done');
    refreshStores();
    reload();
  };

  /** The template's newer version (an additive change): new fields appear, nothing recorded changes. */
  const upgrade = () => {
    const to = data.upgradeTo;
    if (!to) return;
    Alert.alert(t('builder.upgrade.title'), t('surveyForm.upgrade.msg', { n: to.version }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.upgrade.go'),
        onPress: () => {
          try {
            upgradeSurvey(id, to);
          } catch (e) {
            toast(formErrorText(t, e));
          }
          reload();
        },
      },
    ]);
  };

  const reopen = () => {
    reopenSurvey(id);
    refreshStores();
    reload();
  };

  const remove = () =>
    Alert.alert(t('surveyForm.deleteTitle'), `${t('surveyForm.deleteMsg', { name: survey.name ?? '', count: data.occurrences.length })}\n\n${t('records.deleteRecoverable')}`, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteSurvey(id);
          refreshStores();
          router.back();
        },
      },
    ]);

  // ⋯: this survey's actions, then (RecordMenuButton) undo / redo, versions, merge log and team sync, then delete.
  const menuExtra: { label: string; onPress: () => void }[] = [
    { label: t('surveyForm.rename'), onPress: () => void rename() },
    ...(blindOpen && !locked ? [{ label: t('surveyForm.blind.end'), onPress: endBlind }] : []),
    ...(data.recheck && survey.blind_closed_at != null ? [{ label: t('surveyForm.recheck.open'), onPress: () => router.push(`/survey/form/${id}/recheck` as Href) }] : []),
    ...(data.recheck && survey.blind_closed_at != null && !locked
      ? [
          {
            label: t('surveyForm.blind.reopen'),
            onPress: () => {
              try {
                reopenBlindPhase(id);
              } catch (e) {
                Alert.alert(t('surveyForm.blind.reopen'), formErrorText(t, e));
              }
              reload();
            },
          },
        ]
      : []),
    ...(survey.status === 'active'
      ? [{ label: t('surveyForm.finish.title'), onPress: () => void finish() }]
      : [
          { label: unlocked ? t('recordLock.relock') : t('recordLock.unlock'), onPress: () => edit.setUnlocked(!unlocked) },
          { label: t('surveyForm.reopen'), onPress: reopen },
        ]),
  ];

  // ── tabs ───────────────────────────────────────────────────────────────────

  const dataTab = (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
      <FormCard title={t('surveyForm.about')}>
        <Pressable onPress={() => void rename()} accessibilityRole="button" accessibilityLabel={t('surveyForm.rename')} className="flex-row items-center">
          <Text className="w-28 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.name')}</Text>
          <Text className="flex-1 text-sm font-semibold text-ink dark:text-gray-100">{survey.name}</Text>
          <Ionicons name="create-outline" size={16} color={c.ink3} />
        </Pressable>
        <View className="flex-row">
          <Text className="w-28 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.template')}</Text>
          <Text className="flex-1 text-sm text-ink dark:text-gray-100">{`${templateName(t, i18n.language, template)} · ${t(`surveyForm.style.${survey.style}`)}`}</Text>
        </View>
        {data.frameCode ? (
          <View className="flex-row">
            <Text className="w-28 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.frameLabel')}</Text>
            <Text className="flex-1 text-sm text-ink dark:text-gray-100">{t('surveyForm.frameValue', { code: data.frameCode, n: survey.census_no ?? 1 })}</Text>
          </View>
        ) : null}
        {survey.stop_ts != null ? (
          <View className="flex-row">
            <Text className="w-28 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.ended')}</Text>
            <Text className="flex-1 text-sm text-ink dark:text-gray-100">{isoStamp(survey.stop_ts)}</Text>
          </View>
        ) : null}
      </FormCard>
      <ComponentCards
        owner={{ kind: 'survey', id }}
        instances={formComponents(template, 'survey')}
        values={data.surveyValues}
        readOnly={locked}
        refuse={refuse}
        onChanged={reload}
        notes={carriedNotes(t, data.carried)}
        codelists={template.codelists}
      />
    </ScrollView>
  );

  const unitsTab = (
    <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
      {data.units.length === 0 ? <Text className="text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.unit.empty')}</Text> : null}
      {data.units.map(({ unit, depth, path }) => {
        const n = data.occurrences.filter((o) => o.unit_id === unit.id && !o.via_interaction).length;
        return (
          <Pressable
            key={unit.id}
            onPress={() => router.push(`/survey/form/unit/${unit.id}${unlocked ? '?unlocked=1' : ''}` as Href)}
            accessibilityRole="button"
            style={{ marginLeft: depth * 20 }}
            className="flex-row items-center rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
          >
            <View className="flex-1">
              <Text className="font-mono text-base font-bold text-ink dark:text-gray-100">{path}</Text>
              <Text className="mt-0.5 text-xs text-ink-3 dark:text-gray-400">
                {[levelLabel(t, i18n.language, template, unit.level_key), unit.label, t('surveyForm.speciesCount', { count: n })].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {unit.frame_unit_id != null ? <Ionicons name="link-outline" size={16} color={c.ink3} accessibilityLabel={t('surveyForm.unit.onFrame')} /> : null}
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </Pressable>
        );
      })}
      {!locked && data.levelKeys.length ? (
        <Button
          label={t('surveyForm.unit.addTitle', { level: levelLabel(t, i18n.language, template, data.levelKeys[0]) })}
          icon="add"
          variant="secondary"
          onPress={() => void addTopUnit()}
        />
      ) : null}
    </ScrollView>
  );

  // Counts leave out those made only as an interaction's other side (2F).
  const recorded = data.occurrences.filter((o) => !o.via_interaction);
  const unitChips: { key: string; pick: UnitPick; label: string; count: number }[] = isPlot
    ? [
        { key: 'all', pick: 'all', label: t('surveyForm.allUnits'), count: recorded.length },
        { key: 'none', pick: 'none', label: t('surveyForm.outsideUnits'), count: recorded.filter((o) => o.unit_id == null).length },
        ...data.units.map((u) => ({ key: String(u.unit.id), pick: u.unit.id as UnitPick, label: u.path, count: recorded.filter((o) => o.unit_id === u.unit.id).length })),
      ]
    : [];

  const speciesTab = (
    <View className="flex-1">
      {isPlot ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="grow-0" contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
          {unitChips.map((c) => (
            <Chip key={c.key} label={c.label} count={c.count} selected={pick === c.pick} onPress={() => setUnitPick(c.pick)} />
          ))}
        </ScrollView>
      ) : null}
      <ScrollView contentContainerClassName="gap-2 px-4 pb-6 pt-2" keyboardShouldPersistTaps="handled">
        {shown.length === 0 ? <Text className="text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.noSpecies')}</Text> : null}
        {shown.map((o) => {
          const summary = abundance && o.abundance ? componentSummary(t, i18n.language, abundance, o.abundance) : '';
          return (
            <Pressable
              key={o.id}
              onPress={() => router.push(`/survey/form/occurrence/${o.id}${unlocked ? '?unlocked=1' : ''}` as Href)}
              onLongPress={() => void occurrenceMenu(o)}
              accessibilityRole="button"
              className="flex-row items-center gap-2 rounded-card border border-line bg-card px-4 py-3 active:opacity-70 dark:border-line-dark dark:bg-card-dark"
            >
              <View className="flex-1">
                {/* With neither a label nor a common name the scientific name is the title, in italics by rank. */}
                {o.verbatim_identification || o.common_name_c ? (
                  <Text className="text-base font-semibold text-ink dark:text-gray-100">{o.verbatim_identification || o.common_name_c}</Text>
                ) : null}
                <ScientificName
                  name={o.simple_name || o.taxon_id}
                  rank={o.rank}
                  kingdom={o.kingdom}
                  className={o.verbatim_identification || o.common_name_c ? 'text-sm text-ink-2 dark:text-gray-300' : 'text-base font-semibold text-ink dark:text-gray-100'}
                />
                <Text className="text-xs text-ink-3 dark:text-gray-400">
                  {[
                    pick === 'all' && o.unitPath ? o.unitPath : null,
                    o.phase === 'recheck' ? t('surveyForm.phase.recheck') : o.phase === 'blind' && survey.blind_closed_at != null ? t('surveyForm.phase.blind') : null,
                    o.via_interaction ? t('survey.interaction.viaTag') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              {summary ? <Text className="font-mono text-sm text-ink-2 dark:text-gray-300">{summary}</Text> : null}
              {o.sealed ? <Ionicons name="lock-closed" size={14} color={c.ink3} accessibilityLabel={t('surveyForm.err.blindSealed')} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
      {!locked ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View>
            {isPlot || survey.blind_closed_at != null ? (
              <Text className="border-t border-line bg-card px-4 py-1.5 text-xs text-ink-2 dark:border-line-dark dark:bg-card-dark dark:text-gray-300">
                {[
                  isPlot ? t('surveyForm.addingTo', { unit: unitName(pick) }) : null,
                  survey.blind_closed_at != null ? t('surveyForm.addingAfterBlind') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
            <SearchBox onSelect={(r, adopted) => void add(r, adopted)} topLimit={rootTop} markedTaxa={taken} markLabel={t('surveyForm.inList')} />
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );

  const tabs: { value: Tab; label: string }[] = [
    { value: 'data', label: t('surveyForm.tab.data') },
    ...(isPlot ? [{ value: 'units' as Tab, label: t('surveyForm.tab.units', { count: data.units.length }) }] : []),
    { value: 'species', label: t('surveyForm.tab.species', { count: recorded.length }) },
    ...(data.interactions != null ? [{ value: 'interactions' as Tab, label: t('surveyForm.tab.interactions', { count: data.interactions }) }] : []),
  ];
  const shownTab: Tab = (tab === 'units' && !isPlot) || (tab === 'interactions' && data.interactions == null) ? 'species' : tab;

  return (
    <SafeAreaView
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setRootTop(y))}
      edges={['bottom']}
      className="flex-1 bg-paper dark:bg-paper-dark"
    >
      <Stack.Screen
        options={{
          title: survey.name ?? '',
          headerLeft: BackHeaderLeft,
          headerRight: () => (
            <RecordMenuButton
              kind="modular"
              id={id}
              extra={menuExtra}
              last={[{ label: t('surveyForm.deleteTitle'), icon: 'trash-outline', destructive: true, onPress: remove }]}
              edit={edit}
              onEdited={load}
              onSynced={reload}
            />
          ),
        }}
      />
      <LineTabs value={shownTab} options={tabs} onChange={setTab} />
      {locked ? <LockedBanner text={t('surveyForm.lockedBanner')} /> : null}
      {data.upgradeTo && !locked ? (
        <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
          <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">{t('surveyForm.upgrade.banner', { n: data.upgradeTo.version })}</Text>
          <Button label={t('builder.upgrade.go')} variant="secondary" onPress={upgrade} />
        </View>
      ) : null}
      {data.recheck ? (
        <View className="mx-4 mt-3 flex-row items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 dark:border-line-dark dark:bg-card-dark">
          <Text className="flex-1 text-xs text-ink-2 dark:text-gray-300">
            {blindOpen ? t('surveyForm.blind.banner') : t('surveyForm.recheck.banner', { count: data.recheckState?.open ?? 0 })}
          </Text>
          {blindOpen ? (
            !locked ? <Button label={t('surveyForm.blind.end')} variant="secondary" onPress={endBlind} /> : null
          ) : (
            <Button label={t('surveyForm.recheck.open')} variant="secondary" onPress={() => router.push(`/survey/form/${id}/recheck` as Href)} />
          )}
        </View>
      ) : null}
      {shownTab === 'data' ? dataTab : shownTab === 'units' ? unitsTab : shownTab === 'interactions' ? <InteractionSummary surveyId={id} template={template} unlocked={unlocked} /> : speciesTab}
      <NumAccessory />
    </SafeAreaView>
  );
}

