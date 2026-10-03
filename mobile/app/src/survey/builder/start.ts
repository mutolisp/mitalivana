/**
 * Starting a survey from the user's templates. On a permanent plot: the
 * plot-style template to use is picked, or the builder offered when there is
 * none yet (2D-a); a tree census picks its census template — the built-in or
 * one of the user's copies — when there is more than one (2D-b). Every census
 * of a plot is one series whichever template it uses (censusSeriesId).
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import { defaultSurveyorString } from '~/db/surveyors';
import i18n from '~/i18n';
import { startModularSurveyAndOpen } from '~/lib/recordCreate';
import { censusSeriesCodeNeeded, listCensuses, listFrames, startCensus } from '~/survey/db/stemmap';
import { templateName } from '~/survey/form/text';
import type { SurveyTemplate } from '~/survey/template/types';
import { STEMMAP_TEMPLATE } from '~/survey/templates/stemmap';
import { templatesHref, userTemplates } from './drafts';

/** A new plot-style survey on permanent plot `frameId`, with the template the user picks. */
export async function startPlotTemplateOnFrame(frameId: number): Promise<void> {
  const plots = userTemplates().filter((t) => t.style === 'plot');
  if (!plots.length) {
    Alert.alert(i18n.t('builder.noPlotTemplate.title'), i18n.t('builder.noPlotTemplate.msg'), [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('builder.title'), onPress: () => router.push(templatesHref) },
    ]);
    return;
  }
  if (plots.length === 1) return startModularSurveyAndOpen(plots[0], frameId);
  const idx = await showActionSheet({
    title: i18n.t('builder.pickTemplate'),
    options: plots.map((t) => ({ label: templateName(i18n.t, i18n.language, t) })),
    cancelLabel: i18n.t('common.cancel'),
  });
  if (plots[idx]) await startModularSurveyAndOpen(plots[idx], frameId);
}

/** The census templates: the built-in, then the user's own. */
export function censusTemplates(): SurveyTemplate[] {
  return [STEMMAP_TEMPLATE, ...userTemplates().filter((t) => t.style === 'individual')];
}

/**
 * Census n+1 on permanent plot `frameId`, opened after the user confirms.
 * Without `template`, the one to use is asked when the user has census
 * templates of their own (the previous census's marked); that question is
 * the confirmation.
 */
export async function startCensusOnFrame(frameId: number, template?: SurveyTemplate): Promise<void> {
  const latest = listCensuses(frameId)[0] ?? null;
  if (latest?.status === 'active') {
    router.push(`/survey/${latest.id}` as Href);
    return;
  }
  const n = (latest?.census_no ?? 0) + 1;
  const title = i18n.t('survey.frame.startTitle', { n });
  const message = latest ? i18n.t('survey.frame.startRecensusMsg') : i18n.t('survey.frame.startFirstMsg');
  const list = template ? [template] : censusTemplates();
  let tpl: SurveyTemplate | undefined;
  if (list.length === 1) {
    const go = await new Promise<boolean>((resolve) =>
      Alert.alert(title, template ? `${templateName(i18n.t, i18n.language, template)}\n${message}` : message, [
        { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: i18n.t('survey.frame.start'), onPress: () => resolve(true) },
      ]),
    );
    if (!go) return;
    tpl = list[0];
  } else {
    const idx = await showActionSheet({
      title,
      message: `${message}\n${i18n.t('builder.census.pick')}`,
      options: list.map((x) => ({
        label: x.id === latest?.template_id ? i18n.t('builder.census.lastUsed', { name: templateName(i18n.t, i18n.language, x) }) : templateName(i18n.t, i18n.language, x),
      })),
      cancelLabel: i18n.t('common.cancel'),
    });
    tpl = list[idx];
    if (!tpl) return;
  }
  let seriesCode: string | undefined;
  if (censusSeriesCodeNeeded(frameId, tpl.id)) {
    const raw = await promptText({
      title: i18n.t('surveyForm.seriesCodeTitle'),
      message: i18n.t('surveyForm.seriesCodeMsg'),
      placeholder: 'tree',
      autoCapitalize: 'none',
      confirmText: i18n.t('survey.frame.start'),
    });
    seriesCode = raw?.trim();
    if (!seriesCode) return;
  }
  const id = startCensus({ frameId, template: tpl, seriesCode, investigators: defaultSurveyorString() });
  router.push(`/survey/${id}` as Href);
}

/** A census with `template` on a permanent plot the user picks (from the template list). */
export async function startCensusWithTemplate(template: SurveyTemplate): Promise<void> {
  const frames = listFrames();
  if (!frames.length) {
    Alert.alert(i18n.t('create.surveyOnFrame'), i18n.t('create.surveyNoFrames'));
    return;
  }
  const idx = await showActionSheet({
    title: i18n.t('builder.census.pickFrame'),
    options: frames.map((f) => ({ label: f.name ? `${f.code} ${f.name}` : f.code })),
    cancelLabel: i18n.t('common.cancel'),
  });
  const frame = frames[idx];
  if (!frame) return;
  const latest = listCensuses(frame.id)[0] ?? null;
  if (latest?.status === 'active') {
    // One census open per plot: finish it first (its template stays as it was).
    Alert.alert(i18n.t('builder.census.openTitle'), i18n.t('builder.census.openMsg', { n: latest.census_no }), [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('builder.census.openGo'), onPress: () => router.push(`/survey/${latest.id}` as Href) },
    ]);
    return;
  }
  await startCensusOnFrame(frame.id, template);
}
