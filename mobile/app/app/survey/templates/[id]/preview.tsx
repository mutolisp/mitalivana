/**
 * 預覽: the draft as a survey of it will be — the real survey screen (2G-e,
 * decided 2026-10-04) on a new survey in a scratch file (previewSurvey.ts):
 * every screen it leads to works as in the field, and nothing reaches
 * user.db; the file goes when the preview closes. (A census template has no
 * 預覽: its screens need a frame.) The template's own problems are listed
 * instead when it cannot start yet.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NumAccessory } from '~/components/form/NumField';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import { useTemplateDraft } from '~/survey/builder/drafts';
import { openPreviewSurvey } from '~/survey/builder/previewSurvey';
import { issueText } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { ChecklistSurveyScreen } from '~/survey/form/ChecklistSurveyScreen';
import { PlotSurveyScreen } from '~/survey/form/PlotSurveyScreen';
import { draftIssues } from '~/survey/template/edit';
import type { SurveyTemplate } from '~/survey/template/types';
import { validateTemplate, withRequired } from '~/survey/template/validate';
import { useThemeColors } from '~/theme/colors';

export default function TemplatePreviewScreen() {
  const { t, i18n } = useTranslation();
  const id = String(useLocalSearchParams<{ id: string }>().id);
  const { draft } = useTemplateDraft(id);
  const template = useMemo(() => (draft ? { ...withRequired(draft.template), version: 1 } : null), [draft]);
  const issues = template ? draftIssues(template) : [];
  const problems = template && !issues.length ? validateTemplate(template) : [];
  const ready = template && !issues.length && !problems.length ? template : null;

  if (ready) return <LivePreview template={ready} />;
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: template ? t('builder.previewTitle', { name: labelText(t, i18n.language, template.name, t('builder.untitled')) }) : '', headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <Text className="text-xs leading-5 text-ink-2 dark:text-gray-400">{t('builder.previewIntro')}</Text>
        {!template ? <Text className="text-ink-3 dark:text-gray-400">{t('builder.notFound')}</Text> : null}
        {issues.map((x, i) => (
          <Text key={i} className="text-sm text-alert dark:text-alert-dark">{`• ${issueText(t, i18n.language, template!, x)}`}</Text>
        ))}
        {problems.length ? <Text className="text-sm text-alert dark:text-alert-dark">{t('builder.save.invalid', { detail: problems.join('\n') })}</Text> : null}
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}

/** The real survey screen on a scratch survey of `template`. */
function LivePreview({ template }: { template: SurveyTemplate }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const [surveyId, setSurveyId] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The template as it was when the preview opened: the draft reloads on focus,
  // which must not start the preview over and lose what was tried.
  const first = useRef(template);
  useEffect(() => {
    let gone = false;
    let close: (() => void) | null = null;
    openPreviewSurvey(first.current)
      .then((p) => {
        if (gone) p.close();
        else {
          close = p.close;
          setSurveyId(p.id);
        }
      })
      .catch((e) => setFailure(errText(e)));
    return () => {
      gone = true;
      close?.();
    };
  }, []);

  if (surveyId == null)
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 bg-paper p-4 dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        {failure ? <Text className="text-sm text-alert dark:text-alert-dark">{failure}</Text> : null}
      </SafeAreaView>
    );
  return (
    <View className="flex-1 bg-gray-50 dark:bg-gray-950">
      <View className="mx-4 mt-2 flex-row items-center gap-2 rounded-lg bg-accent-50 px-3 py-2 dark:bg-accent-950/40">
        <Ionicons name="eye-outline" size={16} color={c.accent} />
        <Text className="flex-1 text-xs leading-4 text-ink dark:text-gray-100">{t('builder.previewIntro')}</Text>
      </View>
      {template.style === 'checklist' ? <ChecklistSurveyScreen id={surveyId} /> : <PlotSurveyScreen id={surveyId} />}
    </View>
  );
}
