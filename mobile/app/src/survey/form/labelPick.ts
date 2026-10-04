/**
 * The label (verbatim identification, e.g. `sp1`) of an occurrence. On a
 * permanent plot the labels are the plot's morphospecies list
 * (fw_frame_labels, Modular_survey.md §5.5 #7), so `sp1` names the same plant
 * every year: a taxon that has labels there, or one above species level,
 * offers them; a label not on the list is added to it only after asking.
 * Without a permanent plot a label is free text.
 */
import { nameOption, showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import i18n from '~/i18n';
import { isSpeciesLevelRank } from '~/lib/dataQuality';
import type { FwSurveyRow } from '~/survey/db/surveyCore';
import { addFrameLabel, listFrameLabels } from '~/survey/db/surveys';
import { sentenceParts, slot, type NamePart } from '~/lib/nameParts';

type Taxon = { taxon_id: string; rank?: string | null; name: string };

/** A new label typed by the user; on a frame, asked whether it joins the list. Undefined = cancelled. */
async function typeLabel(survey: FwSurveyRow, taxon: Taxon, current: string | null): Promise<string | null | undefined> {
  const raw = await promptText({
    title: i18n.t('surveyForm.label.title', { name: taxon.name }),
    message: i18n.t('surveyForm.label.msg'),
    placeholder: 'sp1',
    defaultValue: current ?? '',
    autoCapitalize: 'none',
    allowEmpty: true,
  });
  if (raw == null) return undefined;
  const label = raw.trim();
  if (!label) return null;
  if (survey.frame_id == null) return label;
  if (listFrameLabels(survey.frame_id).some((l) => l.taxon_id === taxon.taxon_id && l.verbatim_identification === label)) return label;
  const idx = await showActionSheet({
    title: i18n.t('surveyForm.label.newTitle', { label }),
    message: i18n.t('surveyForm.label.newMsg'),
    options: [{ label: i18n.t('surveyForm.label.addToList') }, { label: i18n.t('surveyForm.label.onlyHere') }],
    cancelLabel: i18n.t('common.cancel'),
  });
  if (idx < 0 || idx > 1) return undefined;
  if (idx === 0) addFrameLabel(survey.frame_id, { taxonId: taxon.taxon_id, verbatim: label, firstSurveyId: survey.id });
  return label;
}

/**
 * The label for a species being added: null = none, a string = that label,
 * undefined = cancelled. Asks only on a permanent plot, when the taxon has
 * labels there or is above species level.
 */
export async function labelForNew(survey: FwSurveyRow, taxon: Taxon): Promise<string | null | undefined> {
  if (survey.frame_id == null) return null;
  const mine = listFrameLabels(survey.frame_id).filter((l) => l.taxon_id === taxon.taxon_id);
  if (!mine.length && isSpeciesLevelRank(taxon.rank)) return null;
  return chooseLabel(survey, taxon, mine.map((l) => l.verbatim_identification), null);
}

/** Change an occurrence's label (its form's menu): the same choice, starting from the current one. */
export async function labelForEdit(survey: FwSurveyRow, taxon: Taxon, current: string | null): Promise<string | null | undefined> {
  if (survey.frame_id == null) return typeLabel(survey, taxon, current);
  const mine = listFrameLabels(survey.frame_id).filter((l) => l.taxon_id === taxon.taxon_id);
  return chooseLabel(survey, taxon, mine.map((l) => l.verbatim_identification), current);
}

async function chooseLabel(survey: FwSurveyRow, taxon: Taxon, listed: string[], current: string | null): Promise<string | null | undefined> {
  const name: NamePart[] = [{ sci: taxon.name, rank: taxon.rank ?? null }];
  const idx = await showActionSheet({
    titleParts: sentenceParts(i18n.t('surveyForm.label.pickTitle', { name: slot('name') }), { name }),
    message: i18n.t(listed.length ? 'surveyForm.label.pickMsg' : 'surveyForm.label.pickMsgNone'),
    options: [
      nameOption(sentenceParts(i18n.t('surveyForm.label.none', { name: slot('name') }), { name })),
      ...listed.map((l) => ({ label: l, selected: l === current })),
      { label: i18n.t('surveyForm.label.new') },
    ],
    cancelLabel: i18n.t('common.cancel'),
  });
  if (idx < 0 || idx > listed.length + 1) return undefined;
  if (idx === 0) return null;
  if (idx <= listed.length) return listed[idx - 1];
  return typeLabel(survey, taxon, null);
}
