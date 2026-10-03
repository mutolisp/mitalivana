/**
 * 預覽 (Phase 2D-a): the draft's forms as a survey will show them, filled in
 * on a scratch database (TemplatePreview), place by place. Nothing is saved;
 * the template's own problems are listed instead when it cannot start yet.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NumAccessory } from '~/components/form/NumField';
import { BackHeaderLeft } from '~/lib/goBack';
import { useTemplateDraft } from '~/survey/builder/drafts';
import { TemplatePreview } from '~/survey/builder/TemplatePreview';
import { issueText } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { draftIssues } from '~/survey/template/edit';
import { validateTemplate, withRequired } from '~/survey/template/validate';

export default function TemplatePreviewScreen() {
  const { t, i18n } = useTranslation();
  const id = String(useLocalSearchParams<{ id: string }>().id);
  const { draft } = useTemplateDraft(id);
  const template = useMemo(() => (draft ? { ...withRequired(draft.template), version: 1 } : null), [draft]);
  const issues = template ? draftIssues(template) : [];
  const problems = template && !issues.length ? validateTemplate(template) : [];

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
        {template && !issues.length && !problems.length ? <TemplatePreview template={template} /> : null}
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
