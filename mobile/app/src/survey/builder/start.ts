/**
 * Starting a survey from the user's templates. On a permanent plot: the
 * plot-style template to use is picked, or the builder offered when there is
 * none yet (2D-a); a tree census picks its census template — the built-in or
 * one of the user's copies — when there is more than one, and its series when
 * the template is new on the plot (2D-b).
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import { defaultSurveyorString } from '~/db/surveyors';
import i18n from '~/i18n';
import { startModularSurveyAndOpen } from '~/lib/recordCreate';
import { censusSeriesOptions, censusSeriesPlan, listCensuses, listFrames, startCensus } from '~/survey/db/stemmap';
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

/** A yes / no question: true on the confirming button. */
const confirm = (title: string, message: string, go: string) =>
  new Promise<boolean>((resolve) =>
    Alert.alert(title, message, [
      { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: go, onPress: () => resolve(true) },
    ]),
  );

const askSeriesCode = async (): Promise<string | null> =>
  (
    await promptText({
      title: i18n.t('surveyForm.seriesCodeTitle'),
      message: i18n.t('surveyForm.seriesCodeMsg'),
      placeholder: 'ams',
      autoCapitalize: 'none',
      confirmText: i18n.t('survey.frame.start'),
    })
  )?.trim() || null;

const nameOf = (t: SurveyTemplate | null) => (t ? templateName(i18n.t, i18n.language, t) : '?');

/**
 * The next census on permanent plot `frameId`, opened. The template is asked
 * when the user has census templates of their own (the previous census's
 * marked). Its series (censusSeriesPlan, decided 2026-10-03): a series of this
 * template goes on; a template new on a plot with censuses asks whether to
 * carry a series on (the same trees) or open its own (a series code).
 */
export async function startCensusOnFrame(frameId: number, template?: SurveyTemplate): Promise<void> {
  const latest = listCensuses(frameId)[0] ?? null;
  if (latest?.status === 'active') {
    router.push(`/survey/${latest.id}` as Href);
    return;
  }
  let tpl = template;
  if (!tpl) {
    const list = censusTemplates();
    if (list.length === 1) tpl = list[0];
    else {
      const idx = await showActionSheet({
        title: i18n.t('builder.census.pick'),
        options: list.map((x) => ({ label: x.id === latest?.template_id ? i18n.t('builder.census.lastUsed', { name: nameOf(x) }) : nameOf(x) })),
        cancelLabel: i18n.t('common.cancel'),
      });
      tpl = list[idx];
      if (!tpl) return;
    }
  }
  const plan = censusSeriesPlan(frameId, tpl.id);
  let seriesId: number | undefined;
  let seriesCode: string | undefined;
  if (plan.kind === 'ask') {
    const idx = await showActionSheet({
      title: i18n.t('builder.census.seriesTitle', { name: nameOf(tpl) }),
      message: i18n.t('builder.census.seriesMsg'),
      options: [
        ...plan.options.map((o) => ({
          label: o.seriesCode
            ? i18n.t('builder.census.seriesContinueCode', { code: o.seriesCode, n: o.lastNo + 1, name: nameOf(o.lastTemplate) })
            : i18n.t('builder.census.seriesContinue', { n: o.lastNo + 1, name: nameOf(o.lastTemplate) }),
        })),
        { label: i18n.t('builder.census.seriesNew') },
      ],
      cancelLabel: i18n.t('common.cancel'),
    });
    if (idx < 0 || idx > plan.options.length) return;
    if (idx < plan.options.length) seriesId = plan.options[idx].seriesId;
    else {
      // The code prompt is the confirmation.
      seriesCode = (await askSeriesCode()) ?? undefined;
      if (!seriesCode) return;
    }
  } else {
    const option = plan.kind === 'continue' ? censusSeriesOptions(frameId).find((o) => o.seriesId === plan.seriesId) : undefined;
    seriesId = option?.seriesId;
    const n = (option?.lastNo ?? 0) + 1;
    const ok = await confirm(
      i18n.t('survey.frame.startTitle', { n }),
      `${nameOf(tpl)}\n${option ? i18n.t('survey.frame.startRecensusMsg') : i18n.t('survey.frame.startFirstMsg')}`,
      i18n.t('survey.frame.start'),
    );
    if (!ok) return;
    if (plan.kind === 'new' && plan.codeNeeded) {
      seriesCode = (await askSeriesCode()) ?? undefined;
      if (!seriesCode) return;
    }
  }
  const id = startCensus({ frameId, template: tpl, seriesId, seriesCode, investigators: defaultSurveyorString() });
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
