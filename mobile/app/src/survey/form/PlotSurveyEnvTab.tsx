/**
 * The 環境 tab of a plot-style survey (2G-d; regrouped in 2G-f, canvas 16l):
 *
 *   - its name and project;
 *   - 調查資料 in its four groups (SurveyGroupList: 基本資料, 時間資料, 空間資料,
 *     調查法), each a full-screen page — the centre, track, time, surveyors,
 *     environment, photos, comment and the other survey components are there;
 *   - the survey's Structure as the fixed plot's 分層 section, then the
 *     template's first unit level as its 小區 section (count, names, one size
 *     or each its own — on a permanent plot the layout's size).
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { LabeledField } from '~/components/form/LabeledField';
import { Section } from '~/components/form/Section';
import { LayerSectionView, ProjectRow, SubplotSectionView, type LayerPatch, type SubplotValues } from '~/components/plot/EnvSections';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { LockedBanner } from '~/components/RecordEditButtons';
import { getActiveLayers, getProject, MAX_LAYER_COUNT, type AbundanceMethod } from '~/db';
import { withTransaction } from '~/db/init';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import type { ComponentOwner, UnitRow } from '~/survey/db/surveyCore';
import { addUnit, deleteUnit, getFrameUnit, listUnits, updateFrameUnit, updateSurvey, updateUnit, writeComponent } from '~/survey/db/surveys';
import type { ComponentValues, FieldValue } from '~/survey/registry';
import type { ComponentInstance } from '~/survey/template/types';
import { layerCountOf } from './checks';
import { formComponents } from './occurrenceForm';
import { surveyModules } from './moduleMap';
import { layerRows, nextUnitCode } from './plotStyle';
import { SurveyGroupList, SurveyGroupSections } from './SurveyGroupViews';
import { formErrorText } from './text';
import { unitRows } from './units';
import type { SurveyForm } from './useSurveyForm';

export function PlotSurveyEnvTab({ data, edit, onChanged }: { data: SurveyForm; edit: RecordEditing; onChanged: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { survey, template } = data;
  const id = survey.id;
  const owner: ComponentOwner = { kind: 'survey', id };
  const [projectOpen, setProjectOpen] = useState(false);
  const project = getProject(survey.project_id);
  const layout = useSettings((s) => s.survey_data_layout);

  const smods = surveyModules(template);
  const structure = smods.data.find((c) => c.type === 'structure') ?? null;
  const level1 = template.units?.[0]?.key ?? null;
  const subplots = data.units.filter((u) => u.unit.level_key === level1);
  // What the template records on a subplot beyond its layers (the species tab's) is on the unit page.
  const subplotFields = level1 ? formComponents(template, { unit: level1 }).some((c) => c.type !== 'structure') : false;

  /** One edit: refused while locked; a value the store refuses is told. */
  const write = (run: () => void) => {
    if (edit.refuse()) return;
    try {
      run();
    } catch (e) {
      toast(formErrorText(t, e));
    }
    onChanged();
  };

  /** The survey's Structure as the fixed plot's 分層: layer count, and each layer's cover, height and default unit. */
  const layerSection = (c: ComponentInstance) => {
    const v = data.surveyValues[c.key] ?? {};
    const count = layerCountOf(template, data.surveyValues) ?? 4;
    const methods = (Array.isArray(c.params.methods) ? c.params.methods : []) as AbundanceMethod[];
    return (
      <LayerSectionView
        key={c.key}
        layerCount={count}
        maxLayers={MAX_LAYER_COUNT}
        activeLayers={getActiveLayers(count)}
        layers={layerRows(v, count)}
        methods={methods}
        onLayerCount={(n) => write(() => writeComponent(owner, c.key, { layer_count: n }))}
        onPatchLayer={(idx, fields: LayerPatch) =>
          write(() => writeComponent(owner, c.key, Object.fromEntries(Object.entries(fields).map(([f, x]) => [f, { [idx]: x as FieldValue }])) as ComponentValues))
        }
      />
    );
  };

  /** The first unit level as the fixed plot's 小區: on a permanent plot each takes the layout's size. */
  const toRows = (list: readonly { unit: UnitRow }[]): SubplotValues[] =>
    list.map(({ unit }, i) => {
      const fu = unit.frame_unit_id != null ? getFrameUnit(unit.frame_unit_id) : null;
      return { id: unit.id, idx: i + 1, label: unit.label ?? unit.code, width_m: unit.width_m ?? fu?.width_m ?? null, length_m: unit.length_m ?? fu?.length_m ?? null };
    });
  const subplotRows = toRows(subplots);
  const subplotSection = level1 ? (
    <SubplotSectionView
      subplots={subplotRows}
      setCount={(n) => {
        if (edit.refuse()) return subplotRows;
        try {
          withTransaction(() => {
            const codes = subplots.map((u) => u.unit.code);
            for (let k = subplots.length; k < n; k++) {
              const code = nextUnitCode(codes);
              codes.push(code);
              addUnit(id, { levelKey: level1, code, label: code, sort: k });
            }
            // Fewer: the last ones go; their species move up, as on the fixed plot.
            for (const { unit } of subplots.slice(n).reverse()) deleteUnit(unit.id);
          });
        } catch (e) {
          toast(formErrorText(t, e));
        }
        // The rows as they now are: new ones take the shared size (the view's uniform mode).
        return toRows(unitRows(data.levelKeys, listUnits(id)).filter((u) => u.unit.level_key === level1));
      }}
      update={(unitId, fields) => {
        const u = subplots.find((x) => x.unit.id === unitId)?.unit;
        if (!u || edit.refuse()) return;
        const size = {
          ...(fields.width_m !== undefined ? { widthM: fields.width_m } : {}),
          ...(fields.length_m !== undefined ? { lengthM: fields.length_m } : {}),
        };
        try {
          if (fields.label !== undefined) updateUnit(unitId, { label: fields.label || null });
          // On a permanent plot the size is the layout's, fixed once a survey used it (refused then).
          if (Object.keys(size).length) {
            if (u.frame_unit_id != null) updateFrameUnit(u.frame_unit_id, size);
            else updateUnit(unitId, size);
          }
        } catch (e) {
          toast(formErrorText(t, e));
        }
      }}
      onChanged={onChanged}
      onOpen={subplotFields ? (unitId) => router.push(`/survey/form/unit/${unitId}${edit.unlocked ? '?unlocked=1' : ''}` as Href) : undefined}
      openLabel={t('surveyForm.quadrat.unitFields')}
    />
  ) : null;

  return (
    <KeyboardAwareScrollView className="flex-1" keyboardShouldPersistTaps="handled" bottomOffset={24}>
      {edit.locked ? <LockedBanner /> : null}
      <View pointerEvents={edit.locked ? 'none' : 'auto'}>
        <Section title={t('surveyForm.about')}>
          <LabeledField label={t('surveyForm.name')} value={survey.name ?? ''} onSave={(v) => v.trim() && write(() => updateSurvey(id, { name: v }))} />
          <ProjectRow project={project && project.id !== 0 ? project : null} onPress={() => (edit.refuse() ? undefined : setProjectOpen(true))} />
        </Section>
      </View>
      {layout === 'single' ? (
        // Every group on this tab, where the list would be (the user's choice from ⋯).
        <SurveyGroupSections data={data} edit={edit} onChanged={onChanged} />
      ) : (
        // Not locked out: the group pages say why on their own.
        <SurveyGroupList data={data} onOpen={(g) => router.push(`/survey/form/${id}/group/${g}${edit.unlocked ? '?unlocked=1' : ''}` as Href)} />
      )}
      <View pointerEvents={edit.locked ? 'none' : 'auto'}>
        {structure ? layerSection(structure) : null}
        {subplotSection}
        <View className="h-12" />
      </View>
      <ProjectAssignSheet
        visible={projectOpen}
        currentProjectId={survey.project_id}
        onCancel={() => setProjectOpen(false)}
        onAssign={(projectId) => {
          setProjectOpen(false);
          write(() => updateSurvey(id, { projectId }));
        }}
      />
    </KeyboardAwareScrollView>
  );
}
