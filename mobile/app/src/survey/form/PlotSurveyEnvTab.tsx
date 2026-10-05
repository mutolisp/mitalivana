/**
 * The 環境 tab of a plot-style survey (2G-d; regrouped in 2G-f, canvas 16l):
 *
 *   - its name and project;
 *   - 調查資料 in its four groups (SurveyGroupList: 基本資料, 時間資料, 空間資料,
 *     調查法), each a full-screen page — the centre, track, time, surveyors,
 *     environment, photos, comment and the other survey components are there,
 *     and since 2026-10-04 the 分層 and 小區 too, in 調查法
 *     (PlotMethodSections.tsx).
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { LabeledField } from '~/components/form/LabeledField';
import { Section } from '~/components/form/Section';
import { ProjectRow } from '~/components/plot/EnvSections';
import { ProjectAssignSheet } from '~/components/ProjectAssignSheet';
import { LockedBanner } from '~/components/RecordEditButtons';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useSettings } from '~/stores/settings';
import { isPreviewId } from '~/db/previewDb';
import { useToast } from '~/stores/toast';
import { updateSurvey } from '~/survey/db/surveys';
import { SurveyGroupList, SurveyGroupSections } from './SurveyGroupViews';
import { formErrorText } from './text';
import type { SurveyForm } from './useSurveyForm';

export function PlotSurveyEnvTab({ data, edit, onChanged }: { data: SurveyForm; edit: RecordEditing; onChanged: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { survey } = data;
  const id = survey.id;
  const [projectOpen, setProjectOpen] = useState(false);
  const { project } = data;
  const layout = useSettings((s) => s.survey_data_layout);

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

  return (
    <KeyboardAwareScrollView className="flex-1" keyboardShouldPersistTaps="handled" bottomOffset={24}>
      {edit.locked ? <LockedBanner /> : null}
      <View pointerEvents={edit.locked ? 'none' : 'auto'}>
        <Section title={t('surveyForm.about')}>
          <LabeledField label={t('surveyForm.name')} value={survey.name ?? ''} onSave={(v) => v.trim() && write(() => updateSurvey(id, { name: v }))} />
          <ProjectRow
            project={project && project.id !== 0 ? project : null}
            // A preview has no projects of user.db to file under (code review V5).
            onPress={() => (edit.refuse() ? undefined : isPreviewId(id) ? toast(t('builder.previewNoAssign')) : setProjectOpen(true))}
          />
        </Section>
      </View>
      {layout === 'single' ? (
        // Every group on this tab, where the list would be (the user's choice from ⋯).
        <SurveyGroupSections data={data} edit={edit} onChanged={onChanged} />
      ) : (
        // Not locked out: the group pages say why on their own.
        <SurveyGroupList data={data} onOpen={(g) => router.push(`/survey/form/${id}/group/${g}${edit.unlocked ? '?unlocked=1' : ''}` as Href)} />
      )}
      <View className="h-12" />
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
