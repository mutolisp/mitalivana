/**
 * What end time to record when the user marks something finished (結束／完成).
 *
 * Old field sheets get digitised after the fact, so "now" is often wrong: the
 * user may already have typed the real end time, or not know it yet. Every
 * manual finish therefore asks —
 *   - an end time exists: update it to now, or keep it;
 *   - none yet: record now, or leave it blank to fill in by hand later.
 * Automatic endings (another record started, a stale record closed) do not
 * ask; they keep an existing time and otherwise stamp now.
 */
import i18n from '~/i18n';
import { showActionSheet } from '~/components/ActionSheet';
import { isoStamp } from '~/lib/datetime';
import { shows } from '~/lib/usageMode';
import { currentUsageMode } from '~/lib/useUsageMode';

/** `undefined` = the user cancelled (do not finish); `null` = leave blank. */
export async function chooseEndTime(
  existing: number | null,
  opts: {
    title?: string;
    /** Shown above the question — a warning the old confirmation carried. */
    note?: string;
    /** Called from an Alert button: iOS drops a sheet presented while the
     *  Alert is still animating out, so wait for it first. */
    afterDialog?: boolean;
    /** The caller confirms the finish itself afterwards (the checklist's end
     *  sheet), so this question is not the only chance to back out. */
    confirmsAfter?: boolean;
  } = {},
): Promise<number | null | undefined> {
  const t = i18n.t.bind(i18n);
  // 先不記錄 is for typing in paper sheets later, which the simpler modes do
  // not do. Without it the one answer left needs no question — unless this
  // question is also the confirmation, or carries a warning.
  const later = shows(currentUsageMode(), 'endTimeLater');
  if (existing == null && !later && opts.confirmsAfter && !opts.note) return Date.now();
  if (opts.afterDialog) await new Promise((r) => setTimeout(r, 450));
  const question =
    existing != null ? t('endTime.hasTime', { time: isoStamp(existing) }) : t('endTime.noTime');
  const idx = await showActionSheet({
    title: opts.title ?? t('endTime.title'),
    message: opts.note ? `${opts.note}\n\n${question}` : question,
    options:
      existing != null
        ? [
            { label: t('endTime.useNow') },
            { label: t('endTime.keep', { time: isoStamp(existing).slice(0, 16) }) },
          ]
        : [{ label: t('endTime.recordNow') }, ...(later ? [{ label: t('endTime.leaveBlank') }] : [])],
    cancelLabel: t('common.cancel'),
  });
  if (idx < 0) return undefined;
  if (idx === 0) return Date.now();
  return existing;
}
