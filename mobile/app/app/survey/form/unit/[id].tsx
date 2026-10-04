/**
 * One unit of a plot-style survey (a subplot, a quadrat…): its code and
 * label, the components the template puts on its level, its sub-units, and a
 * way to record species in it (the survey screen's 物種 tab, on this unit).
 *
 * On a permanent plot the unit is the frame's layout too (fw_frame_units): its
 * code is fixed once a survey used it, and deleting it here leaves the frame
 * unit (retire it on the plot's layout screen). Deleting a subplot keeps its
 * species and sub-units, moved up to its parent; deleting a quadrat (second
 * level and below) takes them with it, as the fixed plot does.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { NumAccessory } from '~/components/form/NumField';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { LockedBanner } from '~/components/RecordEditButtons';
import { promptText } from '~/components/TextPromptModal';
import { Button } from '~/components/ui/Button';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { FormCard } from '~/survey/components/FormBits';
import { snapshotOf, unitLevelsOf } from '~/survey/db/surveyCore';
import { addUnit, deleteUnit, deleteUnitWithContents, environmentCarried, getFwSurvey, getUnit, listOccurrences, listUnits, readComponent, updateUnit } from '~/survey/db/surveys';
import { useActiveSurvey } from '~/survey/form/activeSurvey';
import { ComponentCards } from '~/survey/form/ComponentCards';
import { layerCountOf } from '~/survey/form/checks';
import { formComponents } from '~/survey/form/occurrenceForm';
import { layerHeightUnit } from '~/survey/form/plotStyle';
import { carriedNotes, formErrorText, levelLabel } from '~/survey/form/text';
import { childLevel, unitPath, unitSubtree } from '~/survey/form/units';
import { setSurveyView } from '~/survey/form/viewState';

function load(id: number) {
  const unit = getUnit(id);
  const survey = unit ? getFwSurvey(unit.survey_id) : null;
  if (!unit || !survey || survey.style !== 'plot') return null;
  const template = snapshotOf(survey);
  const units = listUnits(survey.id);
  const comps = formComponents(template, { unit: unit.level_key });
  // A unit's layers follow the survey's: how many, and the unit each layer's height is shown in.
  const structure = formComponents(template, 'survey').find((c) => c.type === 'structure');
  const surveyLayers = structure ? readComponent({ kind: 'survey', id: survey.id }, structure.key) : undefined;
  const occurrences = listOccurrences(survey.id);
  const subtree = new Set(unitSubtree(units, id));
  return {
    unit,
    survey,
    template,
    units,
    levelKeys: unitLevelsOf(survey).map((u) => u.key),
    comps,
    values: Object.fromEntries(comps.map((c) => [c.key, readComponent({ kind: 'unit', id }, c.key)])),
    // Not those made only as an interaction's other side (2F).
    species: occurrences.filter((o) => o.unit_id === id && !o.via_interaction).length,
    // In it or in a unit below it: what deleting a quadrat takes.
    inside: occurrences.filter((o) => o.unit_id != null && subtree.has(o.unit_id) && !o.via_interaction).length,
    carried: environmentCarried({ kind: 'unit', id }),
    layers: {
      layerCount: layerCountOf(template, structure && surveyLayers ? { [structure.key]: surveyLayers } : {}),
      heightUnitOf: layerHeightUnit(surveyLayers),
    },
  };
}

export default function SurveyUnitScreen() {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ id: string; unlocked?: string }>();
  const id = Number(params.id);
  const [data, setData] = useState(() => load(id));
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
  const { unit, survey, template, units } = data;
  const locked = survey.status === 'done' && params.unlocked !== '1';
  const refuse = () => toast(t('surveyForm.lockedToast'));
  const path = unitPath(units, unit.id);
  const level = levelLabel(t, i18n.language, template, unit.level_key);
  const below = childLevel(data.levelKeys, unit.level_key);
  const children = units.filter((u) => u.parent_id === unit.id);
  const suffix = params.unlocked === '1' ? '?unlocked=1' : '';

  const edit = async (field: 'code' | 'label') => {
    if (locked) return refuse();
    const v = await promptText({
      title: t(field === 'code' ? 'surveyForm.unit.code' : 'surveyForm.unit.label'),
      defaultValue: (field === 'code' ? unit.code : unit.label) ?? '',
      autoCapitalize: field === 'code' ? 'characters' : 'sentences',
      allowEmpty: field === 'label',
    });
    if (v == null) return;
    const patch = field === 'code' ? { code: v.trim() } : { label: v.trim() || null };
    try {
      updateUnit(unit.id, patch);
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };
  const addChild = async () => {
    if (locked) return refuse();
    if (!below) return;
    const code = await promptText({
      title: t('surveyForm.unit.addTitle', { level: levelLabel(t, i18n.language, template, below) }),
      message: t('surveyForm.unit.codeMsg'),
      placeholder: `${unit.code}1`,
      autoCapitalize: 'characters',
    });
    if (!code?.trim()) return;
    const input = { levelKey: below, code: code.trim(), parentId: unit.id, sort: children.length };
    try {
      addUnit(survey.id, input);
    } catch (e) {
      toast(formErrorText(t, e));
    }
    reload();
  };
  const quadrat = data.levelKeys.indexOf(unit.level_key) >= 1;
  const remove = () =>
    Alert.alert(
      t('surveyForm.unit.deleteTitle', { path }),
      quadrat ? t('surveyForm.unit.deleteAllMsg', { count: data.inside }) : t('surveyForm.unit.deleteMsg', { count: data.species }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            try {
              if (quadrat) deleteUnitWithContents(unit.id);
              else deleteUnit(unit.id);
            } catch (e) {
              toast(formErrorText(t, e));
              return;
            }
            router.back();
          },
        },
      ],
    );
  const recordHere = () => {
    setSurveyView(survey.id, { tab: 'species', unit: unit.id });
    if (survey.status === 'active') useActiveSurvey.getState().setUnit(survey.id, unit.id);
    router.dismissTo(`/survey/form/${survey.id}` as Href);
  };
  const more = async () => {
    if (locked) return refuse();
    const items: { label: string; destructive?: boolean; run: () => void }[] = [
      { label: t('surveyForm.unit.code'), run: () => void edit('code') },
      { label: t('surveyForm.unit.label'), run: () => void edit('label') },
      { label: t('common.delete'), destructive: true, run: remove },
    ];
    const idx = await showActionSheet({ title: path, options: items.map((x) => ({ label: x.label, destructive: x.destructive })), cancelLabel: t('common.cancel') });
    items[idx]?.run();
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: path,
          headerLeft: BackHeaderLeft,
          headerRight: () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} />,
        }}
      />
      {locked ? <LockedBanner text={t('surveyForm.lockedBanner')} /> : null}
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <FormCard title={level}>
          <View className="flex-row">
            <Text className="w-24 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.unit.code')}</Text>
            <Text className="flex-1 font-mono text-sm font-bold text-ink dark:text-gray-100">{unit.code}</Text>
          </View>
          {unit.label ? (
            <View className="flex-row">
              <Text className="w-24 text-sm text-ink-3 dark:text-gray-400">{t('surveyForm.unit.label')}</Text>
              <Text className="flex-1 text-sm text-ink dark:text-gray-100">{unit.label}</Text>
            </View>
          ) : null}
          {unit.frame_unit_id != null ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('surveyForm.unit.onFrameNote')}</Text> : null}
          <Button label={t('surveyForm.unit.recordHere', { count: data.species })} icon="leaf-outline" onPress={recordHere} />
        </FormCard>
        <ComponentCards
          owner={{ kind: 'unit', id: unit.id }}
          instances={data.comps}
          values={data.values}
          readOnly={locked}
          refuse={refuse}
          onChanged={reload}
          notes={carriedNotes(t, data.carried)}
          codelists={data.template.codelists}
          context={data.layers}
        />
        {below ? (
          <FormCard title={levelLabel(t, i18n.language, template, below)}>
            {children.map((u) => (
              <Pressable
                key={u.id}
                onPress={() => router.push(`/survey/form/unit/${u.id}${suffix}` as Href)}
                accessibilityRole="button"
                className="flex-row items-center py-2 active:opacity-70"
              >
                <Text className="flex-1 font-mono text-base font-semibold text-ink dark:text-gray-100">{u.code}</Text>
                {u.label ? <Text className="mr-2 text-sm text-ink-3 dark:text-gray-400">{u.label}</Text> : null}
                <Ionicons name="chevron-forward" size={18} color={c.ink3} />
              </Pressable>
            ))}
            {!locked ? <Button label={t('surveyForm.unit.addTitle', { level: levelLabel(t, i18n.language, template, below) })} icon="add" variant="secondary" onPress={() => void addChild()} /> : null}
          </FormCard>
        ) : null}
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
