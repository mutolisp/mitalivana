/**
 * Web stand-in for mobile/app/src/lib/recordCreate.ts — the GLORIA part.
 *
 * The mobile module creates and imports every record kind (and pulls their
 * code in); the web app has GLORIA surveys only. Same single-active rule and
 * the same strings: before a new survey (or reopening one) an active GLORIA
 * survey is either opened or ended, as the user chooses.
 */
import { router, type Href } from 'expo-router';
import { Alert } from 'react-native';
import i18n from '~/i18n';
import { showActionSheet } from '~/components/ActionSheet';
import { createGloriaSurvey, endGloriaSurvey } from '~/modules/gloria/db';
import { useActiveGloria } from '~/modules/gloria/store';
import * as DocumentPicker from 'expo-document-picker';
import { applyGloriaImport, readGloriaImport } from '../import/importZip';
import { getUserDb } from '~/db/init';
import { useToast } from '~/stores/toast';
import type { GloriaDoc } from '~/modules/gloria/export/yaml';
import { pickedFile } from './documentPicker';

export type NewRecordKind = 'session' | 'plot' | 'gloria' | 'miren' | 'modular';

type Conflict = { label: string; href: Href; end: () => void };

function findActiveConflict(): Conflict | null {
  useActiveGloria.getState().refresh();
  const g = useActiveGloria.getState().survey;
  if (!g) return null;
  return {
    label: `GLORIA mocy ${g.mocy}`,
    href: `/gloria/${g.id}`,
    end: () => {
      endGloriaSurvey(g.id);
      useActiveGloria.getState().refresh();
    },
  };
}

export async function ensureNoConflictingActive(_wanted: NewRecordKind = 'gloria'): Promise<boolean> {
  const conflict = findActiveConflict();
  if (!conflict) return true;
  const noun = i18n.t('nav.gloria');
  const idx = await showActionSheet({
    title: i18n.t('recordCreate.conflictTitle', { noun }),
    message: i18n.t('recordCreate.conflictMsg', { label: conflict.label, noun }),
    cancelLabel: i18n.t('common.cancel'),
    options: [
      { label: i18n.t('recordCreate.goTo', { noun }) },
      { label: i18n.t('recordCreate.endAndStart', { noun }), destructive: true },
    ],
  });
  if (idx === 0) {
    router.push(conflict.href);
    return false;
  }
  if (idx === 1) {
    conflict.end();
    return true;
  }
  return false;
}

export function confirmReopenOver(): Promise<boolean> {
  const conflict = findActiveConflict();
  if (!conflict) return Promise.resolve(true);
  return new Promise((resolve) =>
    Alert.alert(i18n.t('session.otherActiveTitle'), i18n.t('session.otherActiveMsg', { name: conflict.label }), [
      { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      {
        text: i18n.t('session.endOldAndReopen'),
        style: 'destructive',
        onPress: () => {
          conflict.end();
          resolve(true);
        },
      },
    ]),
  );
}

export async function startGloriaAndOpen(summitId: number, recordedBy?: string | null): Promise<void> {
  if (!(await ensureNoConflictingActive('gloria'))) return;
  const id = createGloriaSurvey({ summitId, recorded_by: recordedBy });
  useActiveGloria.getState().refresh();
  router.replace(`/gloria/${id}`);
}

export function openNewGloria(): void {
  router.push('/gloria/new');
}

export function importErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The survey of the same summit and cycle here, if any (mobile merge.ts findGloriaSurveyFor). */
function surveyFor(doc: GloriaDoc): { id: number; uuid: string } | null {
  const r = getUserDb().executeSync(
    `SELECT v.id, v.uuid FROM gloria_surveys v JOIN gloria_summits s ON s.id = v.summit_id WHERE s.full_code = ? AND v.mocy = ?`,
    [doc.summit.full_code, doc.survey.mocy],
  ).rows[0] as { id: number; uuid: string } | undefined;
  return r ?? null;
}

/**
 * Import a GLORIA export (zip or yml), as mobile finishGloriaImport does
 * minus team merge: the same survey here can be overwritten; another copy of
 * the same summit and cycle (other uuid) can only be merged, which the web
 * app does not do yet, so it is refused with mobile's explanation.
 */
export async function importRecordPromptAndOpen(): Promise<void> {
  const r = await DocumentPicker.getDocumentAsync({ type: '*/*' });
  if (r.canceled || !r.assets?.[0]) return;
  const file = pickedFile(r.assets[0].uri);
  if (!file) return;
  const check = readGloriaImport(new Uint8Array(await file.arrayBuffer()));
  if (!check.ok) {
    Alert.alert(i18n.t('recordCreate.importFailTitle'), check.reason === 'not-gloria' ? i18n.t('recordImport.unknownKind') : (check.detail ?? ''));
    return;
  }
  const doc = check.doc;
  const name = `${doc.summit.full_code} mocy ${doc.survey.mocy}`;
  const here = surveyFor(doc);
  if (here && here.uuid !== doc.survey.uuid) {
    Alert.alert(i18n.t('recordImport.gloriaExistsTitle'), i18n.t('teamMerge.gloriaOtherCopy', { name }));
    return;
  }
  if (here || check.exists) {
    const idx = await showActionSheet({
      title: i18n.t('recordImport.gloriaExistsTitle'),
      message: i18n.t('recordImport.gloriaExistsMsg', { name }),
      cancelLabel: i18n.t('common.cancel'),
      options: [{ label: i18n.t('recordCreate.overwrite'), destructive: true }],
    });
    if (idx !== 0) return;
  }
  try {
    const id = applyGloriaImport(doc);
    useActiveGloria.getState().refresh();
    useToast.getState().show(i18n.t('recordImport.gloriaImported', { name }));
    router.push(`/gloria/${id}`);
  } catch (e) {
    Alert.alert(i18n.t('recordCreate.importFailTitle'), importErrorMessage(e));
  }
}
