/**
 * "Add this species to the open record" for a checklist / plot-style survey
 * (Modular_survey.md §7.1). Every add path that would otherwise start a
 * checklist session calls this first: starting a session ends every open
 * record (closeActiveRecords), which would close the survey without a word,
 * as it once closed MIREN surveys (data-model audit A11).
 *
 *   - the template allows quick add: the species becomes an occurrence in the
 *     unit the survey's screen has selected; when the template requires a
 *     field the add leaves empty, the occurrence's form opens;
 *   - it does not: the user is told and offered the survey, as with MIREN.
 *
 * check:add-guard keeps every implicit checklist start behind it.
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import type { AdoptionInput } from '~/db/taxonLookup';
import i18n from '~/i18n';
import { errText } from '~/lib/errText';
import { useToast } from '~/stores/toast';
import { snapshotOf } from '~/survey/db/surveyCore';
import { withTransaction } from '~/db/init';
import { addOccurrence, findOccurrence, getActiveSurvey } from '~/survey/db/surveys';
import { quickAddUnit, useActiveSurvey } from './activeSurvey';
import { blankOccurrenceHasErrors } from './occurrenceForm';

export type QuickAddSpecies = { taxon_id: string; cname?: string | null; name: string };

/**
 * True when an open checklist / plot-style survey took the species or refused
 * them (the caller stops there). One species may open its form; several (the
 * taxonomy tree's select mode) never do, as a batch add to a plot does not.
 */
export function takenByActiveSurvey(list: readonly QuickAddSpecies[], adopted?: AdoptionInput | null): boolean {
  // Read the database, not the store: the store can lag behind another screen.
  const survey = getActiveSurvey();
  useActiveSurvey.getState().refresh();
  if (!survey) return false;
  const t = i18n.t.bind(i18n);
  const toast = useToast.getState().show;
  const href = `/survey/form/${survey.id}` as Href;
  const template = snapshotOf(survey);
  if (!template.quick_add) {
    Alert.alert(t('addToRecord.surveyNoQuickTitle'), t('addToRecord.surveyNoQuickMsg', { name: survey.name ?? '' }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('addToRecord.goToSurvey'), onPress: () => router.push(href) },
    ]);
    return true;
  }
  const unitId = quickAddUnit(survey.id);
  const fresh = list.filter((sp, i) => sp.taxon_id && list.findIndex((x) => x.taxon_id === sp.taxon_id) === i && !findOccurrence(survey.id, unitId, sp.taxon_id, null));
  const added: number[] = [];
  try {
    withTransaction(() => {
      for (const sp of fresh) {
        added.push(
          addOccurrence(survey.id, {
            taxon_id: sp.taxon_id,
            unit_id: unitId,
            ...(adopted && list.length === 1 ? { used_name_id: adopted.name_id ?? null, used_scientific_name: adopted.scientific_name } : {}),
          }),
        );
      }
    });
  } catch (e) {
    toast(errText(e));
    return true;
  }
  useActiveSurvey.getState().refresh();
  const goTo = { action: { label: t('addToRecord.goTo'), onPress: () => router.push(href) } };
  if (list.length === 1) {
    const label = list[0].cname || list[0].name;
    if (!added.length) toast(t('addToRecord.alreadyInRecord', { name: label }));
    else if (blankOccurrenceHasErrors(template)) router.push(`/survey/form/occurrence/${added[0]}` as Href);
    else toast(t('addToRecord.addedToSurvey', { name: label }), goTo);
    return true;
  }
  const skipped = list.length - added.length;
  toast(
    [t('addToRecord.addedManyToSurvey', { count: added.length }), skipped > 0 ? t('addToRecord.skippedExisting', { count: skipped }) : null].filter(Boolean).join('\n'),
    goTo,
  );
  return true;
}
