/**
 * "Which language should this document be in?" — one sheet, shared by the
 * report and the checklist exports.
 *
 * The current UI language is listed first and labelled, so the common case is a
 * single tap. The chosen language never touches `i18n.changeLanguage`: callers
 * pass it to `i18n.getFixedT(lang)`, which pins a translator for the render
 * without disturbing what the user is looking at.
 */
import { showActionSheet } from '~/components/ActionSheet';
import i18n, { LANGUAGE_CATALOGUE, type SupportedLanguage } from '~/i18n';
import type { Translate } from './reportTypes';

/** The picked language, or null when the user dismissed the sheet. */
export async function pickExportLanguage(
  t: Translate,
  titleKey: string,
): Promise<SupportedLanguage | null> {
  const current = i18n.language as SupportedLanguage;
  const ordered = [
    ...LANGUAGE_CATALOGUE.filter((l) => l.value === current),
    ...LANGUAGE_CATALOGUE.filter((l) => l.value !== current),
  ];
  const idx = await showActionSheet({
    title: t(titleKey),
    options: ordered.map((l, i) => ({
      label: l.native,
      description: i === 0 ? t('report.currentLanguage') : undefined,
      selected: i === 0,
      keywords: `${l.english} ${l.value}`,
    })),
  });
  if (idx < 0) return null;
  return ordered[idx].value;
}
