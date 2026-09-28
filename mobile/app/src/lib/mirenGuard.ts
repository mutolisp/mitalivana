/**
 * A MIREN survey in progress blocks the "add a species" paths that would
 * otherwise start a checklist on their own (species tab, taxonomy tree,
 * favorites, both key runners): starting one ends every other active record
 * (closeActiveRecords), which silently closed the MIREN survey (data-model
 * audit A11). MIREN species are recorded inside its plots under the blind-list
 * rules, so they are not added from here; the user is asked to finish the
 * survey first, or taken to it.
 *
 * check:add-guard keeps every implicit checklist start behind this guard.
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import i18n from '~/i18n';
import { getActiveMirenSurvey } from '~/modules/miren/db';
import { useActiveMiren } from '~/modules/miren/store';

/** True (and the user told why) when an active MIREN survey must not be ended by an implicit checklist start. */
export function blockIfMirenActive(): boolean {
  // Read the database, not the store: the store can lag behind another screen.
  const survey = getActiveMirenSurvey();
  useActiveMiren.getState().refresh();
  if (!survey) return false;
  const t = i18n.t.bind(i18n);
  Alert.alert(t('addToRecord.mirenActiveTitle'), t('addToRecord.mirenActiveMsg', { year: survey.year }), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('addToRecord.goToMiren'), onPress: () => router.push(`/miren/survey/${survey.id}` as Href) },
  ]);
  return true;
}
