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
import { applyGloriaImport, readGloriaImports, type ImportCheck } from '../import/importZip';
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

/**
 * Import GLORIA files — one or several, each a single survey or a bundle —
 * as mobile finishGloriaImport does, minus team merge. Everything is read
 * first; surveys already here are asked about once (overwrite / skip);
 * another copy of the same summit and cycle can only be merged, so it is
 * skipped with mobile's explanation. One clean survey opens straight away,
 * as before; otherwise a summary says what happened to each.
 */
export async function importRecordPromptAndOpen(): Promise<void> {
  const r = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true });
  if (r.canceled || !r.assets?.length) return;
  const checks: ImportCheck[] = [];
  for (const a of r.assets) {
    const file = pickedFile(a.uri);
    if (file) checks.push(...readGloriaImports(new Uint8Array(await file.arrayBuffer()), file.name));
  }
  const nameOf = (d: GloriaDoc) => `${d.summit.full_code} mocy ${d.survey.mocy}`;
  const good = checks.filter((c): c is Extract<ImportCheck, { ok: true }> => c.ok && !c.otherCopy);
  const existing = good.filter((c) => c.exists);
  let overwrite = true;
  if (existing.length) {
    const idx = await showActionSheet({
      title: i18n.t('recordImport.gloriaExistsTitle'),
      message: i18n.t('web.batch.existingMsg', { count: existing.length, names: existing.map((c) => nameOf(c.doc)).join('、') }),
      cancelLabel: i18n.t('common.cancel'),
      options: [{ label: i18n.t('web.batch.overwriteAll', { count: existing.length }), destructive: true }, { label: i18n.t('web.batch.skipExisting') }],
    });
    if (idx < 0) return;
    overwrite = idx === 0;
  }
  const done: Array<{ id: number; name: string }> = [];
  const lines: string[] = [];
  for (const c of checks) {
    if (!c.ok) {
      lines.push(`✕ ${c.source}: ${c.reason === 'not-gloria' ? i18n.t('recordImport.unknownKind') : (c.detail ?? '')}`);
      continue;
    }
    const name = nameOf(c.doc);
    if (c.otherCopy) {
      lines.push(`✕ ${name}: ${i18n.t('teamMerge.gloriaOtherCopy', { name })}`);
      continue;
    }
    if (c.exists && !overwrite) {
      lines.push(`– ${name}: ${i18n.t('web.batch.skipped')}`);
      continue;
    }
    try {
      done.push({ id: await applyGloriaImport(c.doc, c.attached), name });
      lines.push(`✓ ${name}`);
    } catch (e) {
      lines.push(`✕ ${name}: ${importErrorMessage(e)}`);
    }
  }
  useActiveGloria.getState().refresh();
  if (done.length === 1 && checks.length === 1) {
    useToast.getState().show(i18n.t('recordImport.gloriaImported', { name: done[0].name }));
    router.push(`/gloria/${done[0].id}`);
    return;
  }
  Alert.alert(i18n.t('web.batch.summaryTitle', { count: done.length, total: checks.length }), lines.join('\n'));
  if (done.length) router.replace('/');
}
