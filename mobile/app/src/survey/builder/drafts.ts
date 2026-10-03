/**
 * The builder's draft on the app's connection (Phase 2D-a). The database is
 * the draft's only copy: every edit reads it, applies one operation from
 * template/edit.ts and writes it back, so the screens over each other (the
 * template, one component) never hold stale copies, and leaving the app
 * loses nothing.
 *
 * The flows that start a draft — a blank template, a copy, editing a saved
 * one — are here too, with the words they ask for.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Alert } from 'react-native';
import { useCallback, useState } from 'react';
import { showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import { generateUuid } from '~/db/uuid';
import i18n from '~/i18n';
import { decodeUtf8 } from '~/lib/utf8';
import { shareThenDelete } from '~/lib/shareFile';
import { useToast } from '~/stores/toast';
import { discardDraft, getDraft, getTemplate, listTemplates, saveDraft, saveTemplate, type TemplateDraft } from '~/survey/db/surveys';
import { readTemplateFile, TEMPLATE_FILE_EXT, templateFileText } from '~/survey/template/share';
import { blankTemplate, copyTemplate, labelParts, makeLabel, type BuilderStyle } from '~/survey/template/edit';
import type { SurveyTemplate } from '~/survey/template/types';
import { SAMPLE_TEMPLATES } from '~/survey/templates/samples';
import { BUILTIN_TEMPLATES } from '~/survey/templates/builtins';
import { STEMMAP_TEMPLATE } from '~/survey/templates/stemmap';
import { templateName } from '~/survey/form/text';

export const templatesHref = '/survey/templates' as Href;
export const templateHref = (id: string) => `/survey/templates/${encodeURIComponent(id)}` as Href;
export const componentHref = (id: string, key: string) => `/survey/templates/${encodeURIComponent(id)}/component/${encodeURIComponent(key)}` as Href;
export const previewHref = (id: string) => `/survey/templates/${encodeURIComponent(id)}/preview` as Href;
export const listHref = (id: string, listId: string) => `/survey/templates/${encodeURIComponent(id)}/list/${encodeURIComponent(listId)}` as Href;

type DraftState = { draft: TemplateDraft | null; saved: SurveyTemplate | null };

const read = (id: string): DraftState => ({ draft: getDraft(id), saved: getTemplate(id) });

/**
 * The draft of template `id` and the version saved before it (null for a new
 * template). `update` applies one edit and stores it at once.
 */
export function useTemplateDraft(id: string): DraftState & { update: (edit: (t: SurveyTemplate) => SurveyTemplate) => void } {
  const [state, setState] = useState<DraftState>(() => read(id));
  useFocusEffect(useCallback(() => setState(read(id)), [id]));
  const update = useCallback(
    (edit: (t: SurveyTemplate) => SurveyTemplate) => {
      // From the database, not this render's copy: two edits in one gesture (a field's blur, then a tap) both land.
      const cur = getDraft(id);
      if (!cur) return;
      const next = edit(cur.template);
      if (next === cur.template) return;
      saveDraft(next, cur.baseVersion);
      setState({ draft: { ...cur, template: next }, saved: getTemplate(id) });
    },
    [id],
  );
  return { ...state, update };
}

/** The user's templates, without built-ins and samples (both copied only). */
export function userTemplates(opts?: { archived?: 'exclude' | 'include' | 'only' }): SurveyTemplate[] {
  const builtin = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
  return listTemplates(opts).filter((t) => !builtin.has(t.id));
}

const newId = () => `user:${generateUuid()}`;

async function askName(defaultValue: string): Promise<string | null> {
  const name = await promptText({
    title: i18n.t('builder.new.nameTitle'),
    message: i18n.t('builder.new.nameMsg'),
    defaultValue,
    autoCapitalize: 'none',
    confirmText: i18n.t('builder.new.create'),
  });
  return name?.trim() ? name.trim() : null;
}

async function startDraft(template: SurveyTemplate): Promise<void> {
  saveDraft(template, null);
  router.push(templateHref(template.id));
}

/** A blank template of one style. */
export async function createBlankTemplate(style: BuilderStyle): Promise<void> {
  const name = await askName('');
  const label = name ? makeLabel(name) : null;
  if (!label) return;
  const unit = makeLabel(i18n.t('builder.new.firstUnit'))!;
  await startDraft(blankTemplate(style, newId(), label, unit));
}

/** A copy of a sample or of one of the user's templates, under a new id. */
export async function copyTemplateAndEdit(src: SurveyTemplate): Promise<void> {
  const name = await askName(i18n.t('builder.new.copyName', { name: templateName(i18n.t, i18n.language, src) }));
  const label = name ? makeLabel(name, labelParts(src.name).en ? `${labelParts(src.name).en} (copy)` : null) : null;
  if (!label) return;
  await startDraft(copyTemplate(src, newId(), label));
}

/** A bottom sheet (a Modal on Android) is still closing: a system sheet opened now would not show. */
const afterSheet = () => new Promise((r) => setTimeout(r, 450));

/** Share a template as a `.mtpl.json` file: its structure only. */
export async function exportTemplate(tpl: SurveyTemplate): Promise<void> {
  const base = (templateName(i18n.t, i18n.language, tpl) || 'template').replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 60);
  const file = new File(Paths.cache, `${base}${TEMPLATE_FILE_EXT}`);
  if (file.exists) file.delete();
  file.create();
  file.write(templateFileText(tpl, Date.now()));
  await afterSheet();
  await shareThenDelete(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: base });
}

/** A `.mtpl.json` file in: stored as an imported template (a new id when its id is here already). */
export async function importTemplateFile(): Promise<void> {
  await afterSheet();
  const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
  if (picked.canceled || !picked.assets?.[0]) return;
  let text: string | null = null;
  try {
    text = decodeUtf8(await new File(picked.assets[0].uri).bytes());
  } catch {
    text = null;
  }
  const taken = new Set([...listTemplates({ archived: 'include' }).map((t) => t.id)]);
  const read = text == null ? ({ ok: false, reason: 'not_a_template' } as const) : readTemplateFile(text, taken, newId);
  if (!read.ok) {
    const msg =
      read.reason === 'newer_app'
        ? i18n.t('builder.import.newerApp', { types: read.types.join(', ') })
        : read.reason === 'invalid'
          ? i18n.t('builder.import.invalid', { detail: read.detail })
          : i18n.t('builder.import.notTemplate');
    Alert.alert(i18n.t('builder.import.failTitle'), msg);
    return;
  }
  const saved = saveTemplate(read.template);
  useToast.getState().show(i18n.t(read.renamed ? 'builder.import.doneRenamed' : 'builder.import.done', { name: templateName(i18n.t, i18n.language, saved) }));
}

/**
 * 建立模板: blank (checklist or plot), a tree census (a copy of the built-in:
 * a census template is never blank), a copy of a sample, built-in or one of
 * the user's, or a file.
 */
export async function createTemplateFlow(onImported?: () => void): Promise<void> {
  const sources = [...SAMPLE_TEMPLATES, ...BUILTIN_TEMPLATES, ...userTemplates()];
  const pick = await showActionSheet({
    title: i18n.t('builder.new.title'),
    options: [
      { label: i18n.t('builder.new.blankChecklist') },
      { label: i18n.t('builder.new.blankPlot') },
      { label: i18n.t('builder.new.census') },
      { label: i18n.t('builder.new.copy') },
      { label: i18n.t('builder.import.fromFile') },
    ],
    cancelLabel: i18n.t('common.cancel'),
  });
  if (pick === 0) return createBlankTemplate('checklist');
  if (pick === 1) return createBlankTemplate('plot');
  if (pick === 2) return copyTemplateAndEdit(STEMMAP_TEMPLATE);
  if (pick === 4) {
    await importTemplateFile();
    onImported?.();
    return;
  }
  if (pick !== 3) return;
  const idx = await showActionSheet({
    title: i18n.t('builder.new.copyFrom'),
    options: sources.map((t) => ({ label: templateName(i18n.t, i18n.language, t) })),
    cancelLabel: i18n.t('common.cancel'),
  });
  const src = sources[idx];
  if (src) await copyTemplateAndEdit(src);
}

/** Open a saved template in the builder: its draft, or a new draft of its latest version. */
export function editTemplate(id: string): void {
  if (!getDraft(id)) {
    const latest = getTemplate(id);
    if (!latest) return;
    saveDraft(latest, latest.version);
  }
  router.push(templateHref(id));
}

export { discardDraft };
