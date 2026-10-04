/**
 * 調查表模板 (Phase 2D-a): the user's templates, the ones being edited, the
 * samples and built-ins to copy, and the archived ones. From here a template
 * is started, edited (a draft of its next version), copied, shared as a file
 * or archived; 建立模板 starts a blank checklist or plot, a tree census (a
 * copy of the built-in), a copy, or a file.
 *
 * A census template (2D-b) starts a census on a permanent plot picked here;
 * the built-in census is listed to be copied.
 */
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { Button } from '~/components/ui/Button';
import { ListRow } from '~/components/ui/ListRow';
import { errText } from '~/lib/errText';
import { BackHeaderLeft } from '~/lib/goBack';
import { startModularOnFrameAndOpen, startModularSurveyAndOpen } from '~/lib/recordCreate';
import { useToast } from '~/stores/toast';
import { copyTemplateAndEdit, createTemplateFlow, editTemplate, exportTemplate, templateHref, userTemplates } from '~/survey/builder/drafts';
import { startCensusWithTemplate } from '~/survey/builder/start';
import { BUILTIN_TEMPLATES } from '~/survey/templates/builtins';
import { labelText } from '~/survey/components/editors/shared';
import { styleName } from '~/survey/builder/words';
import { deleteTemplate, discardDraft, listDrafts, setTemplateArchived, templateDeleteBlocker, templateUseCounts } from '~/survey/db/surveys';
import { templateHash } from '~/survey/template/validate';
import { templateName } from '~/survey/form/text';
import type { SurveyTemplate } from '~/survey/template/types';
import { SAMPLE_TEMPLATES } from '~/survey/templates/samples';

function load() {
  const saved = new Map(userTemplates({ archived: 'include' }).map((t) => [t.id, t]));
  // A draft opened and left unchanged is no draft: dropped, so 編輯 only to look leaves nothing behind.
  const drafts = listDrafts().filter((d) => {
    const s = saved.get(d.template.id);
    if (!s || templateHash(s) !== templateHash(d.template)) return true;
    discardDraft(d.template.id);
    return false;
  });
  const mine = userTemplates();
  const savedIds = new Set(saved.keys());
  return {
    mine,
    archived: userTemplates({ archived: 'only' }),
    // A new template's draft (nothing saved yet) is listed on its own.
    newDrafts: drafts.filter((d) => !savedIds.has(d.template.id)).map((d) => d.template),
    drafting: new Set(drafts.map((d) => d.template.id)),
    uses: templateUseCounts(),
  };
}

export default function TemplatesScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast((s) => s.show);
  const [data, setData] = useState(load);
  const [showArchived, setShowArchived] = useState(false);
  const reload = useCallback(() => setData(load()), []);
  useFocusEffect(reload);

  const name = (tpl: SurveyTemplate) => templateName(t, i18n.language, tpl) || t('builder.untitled');
  const meta = (tpl: SurveyTemplate) => {
    const use = data.uses.get(tpl.id);
    return [
      styleName(t, tpl.style),
      t('builder.version', { n: tpl.version }),
      use?.all ? t('builder.uses', { count: use.all }) : null,
      use?.active ? t('builder.usesActive', { count: use.active }) : null,
      data.drafting.has(tpl.id) ? t('builder.draftTag') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  /** 刪除, offered only while no survey uses the template (asked 2026-10-04); archiving stays for those that are used. */
  const deleteItem = (tpl: SurveyTemplate) =>
    templateDeleteBlocker(tpl.id) === null
      ? [
          {
            label: t('builder.action.delete'),
            destructive: true,
            run: () =>
              Alert.alert(t('builder.delete.title'), t('builder.delete.msg', { name: name(tpl) }), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('builder.action.delete'),
                  style: 'destructive',
                  onPress: () => {
                    try {
                      deleteTemplate(tpl.id);
                      toast(t('builder.delete.done', { name: name(tpl) }));
                    } catch (e) {
                      Alert.alert(t('builder.delete.title'), errText(e));
                    }
                    reload();
                  },
                },
              ]),
          },
        ]
      : [];

  const mineMenu = async (tpl: SurveyTemplate) => {
    const items: { label: string; destructive?: boolean; run: () => unknown }[] = [
      ...(tpl.style === 'individual'
        ? [{ label: t('builder.census.start'), run: () => startCensusWithTemplate(tpl) }]
        : [{ label: t('create.startSurvey'), run: () => startModularSurveyAndOpen(tpl) }]),
      ...(tpl.style === 'plot' ? [{ label: t('create.surveyOnFrame'), run: () => startModularOnFrameAndOpen(tpl) }] : []),
      { label: t('builder.action.edit'), run: () => editTemplate(tpl.id) },
      { label: t('builder.action.copy'), run: () => copyTemplateAndEdit(tpl) },
      { label: t('builder.action.export'), run: () => exportTemplate(tpl) },
      {
        label: t('builder.action.archive'),
        destructive: true,
        run: () => {
          setTemplateArchived(tpl.id, true);
          toast(t('builder.archived', { name: name(tpl) }));
          reload();
        },
      },
      ...deleteItem(tpl),
    ];
    const idx = await showActionSheet({ title: name(tpl), options: items.map((x) => ({ label: x.label, destructive: x.destructive })), cancelLabel: t('common.cancel') });
    await items[idx]?.run();
  };

  const archivedMenu = async (tpl: SurveyTemplate) => {
    const items = [
      {
        label: t('builder.action.unarchive'),
        run: () => {
          setTemplateArchived(tpl.id, false);
          reload();
        },
      },
      { label: t('builder.action.copy'), run: () => copyTemplateAndEdit(tpl) },
      ...deleteItem(tpl),
    ];
    const idx = await showActionSheet({ title: name(tpl), options: items.map((x) => ({ label: x.label, destructive: 'destructive' in x ? x.destructive : undefined })), cancelLabel: t('common.cancel') });
    await items[idx]?.run();
  };

  const sampleMenu = async (tpl: SurveyTemplate) => {
    const idx = await showActionSheet({ title: name(tpl), options: [{ label: t('builder.action.copyToMine') }], cancelLabel: t('common.cancel') });
    if (idx === 0) await copyTemplateAndEdit(tpl);
  };

  const heading = (text: string) => <Text className="px-4 pb-1.5 pt-5 text-xs font-bold text-ink-2 dark:text-gray-400">{text}</Text>;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: t('builder.title'), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="pb-6">
        <Text className="px-4 pt-3 text-xs leading-5 text-ink-2 dark:text-gray-400">{t('builder.intro')}</Text>
        {data.newDrafts.length ? (
          <>
            {heading(t('builder.section.drafts'))}
            <View className="border-y border-line dark:border-line-dark">
              {data.newDrafts.map((tpl, i) => (
                <ListRow
                  key={tpl.id}
                  title={name(tpl)}
                  meta={`${styleName(t, tpl.style)} · ${t('builder.newTemplate')}`}
                  onPress={() => router.push(templateHref(tpl.id))}
                  divider={i < data.newDrafts.length - 1}
                />
              ))}
            </View>
          </>
        ) : null}
        {heading(t('builder.section.mine'))}
        {data.mine.length ? (
          <View className="border-y border-line dark:border-line-dark">
            {data.mine.map((tpl, i) => (
              <ListRow key={tpl.id} title={name(tpl)} meta={meta(tpl)} onPress={() => void mineMenu(tpl)} divider={i < data.mine.length - 1} />
            ))}
          </View>
        ) : (
          <Text className="px-4 text-sm leading-5 text-ink-3 dark:text-gray-400">{t('builder.empty')}</Text>
        )}
        {heading(t('builder.section.builtin'))}
        <View className="border-y border-line dark:border-line-dark">
          {BUILTIN_TEMPLATES.map((tpl, i) => (
            <ListRow
              key={tpl.id}
              title={name(tpl)}
              meta={tpl.description ? labelText(t, i18n.language, tpl.description) : styleName(t, tpl.style)}
              onPress={() => void sampleMenu(tpl)}
              divider={i < BUILTIN_TEMPLATES.length - 1}
            />
          ))}
        </View>
        {heading(t('builder.section.samples'))}
        <View className="border-y border-line dark:border-line-dark">
          {SAMPLE_TEMPLATES.map((tpl, i) => (
            <ListRow key={tpl.id} title={name(tpl)} meta={styleName(t, tpl.style)} onPress={() => void sampleMenu(tpl)} divider={i < SAMPLE_TEMPLATES.length - 1} />
          ))}
        </View>
        {data.archived.length ? (
          <>
            <Pressable onPress={() => setShowArchived(!showArchived)} accessibilityRole="button" className="px-4 pb-1.5 pt-5">
              <Text className="text-xs font-bold text-accent-700 dark:text-accent-300">
                {showArchived ? t('builder.hideArchived') : t('builder.showArchived', { count: data.archived.length })}
              </Text>
            </Pressable>
            {showArchived ? (
              <View className="border-y border-line dark:border-line-dark">
                {data.archived.map((tpl, i) => (
                  <ListRow key={tpl.id} title={name(tpl)} meta={meta(tpl)} onPress={() => void archivedMenu(tpl)} divider={i < data.archived.length - 1} />
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <View className="border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
        <Button label={t('builder.create')} icon="add" onPress={() => void createTemplateFlow(reload)} />
      </View>
    </SafeAreaView>
  );
}
