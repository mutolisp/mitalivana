/**
 * Dates and times as casual mode writes them: 「今天 · 10月5日（一）」,
 * 「14:32」. No Intl (its date output is not dependable on Hermes; see
 * project_ui_redesign); the words come from i18n.
 */
import i18n from '~/i18n';
import { dayKey } from '~/db';

const pad = (n: number) => String(n).padStart(2, '0');

/** 「14:32」 */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「10月5日（一）」 */
export function dateWithWeekday(ts: number): string {
  const d = new Date(ts);
  return i18n.t('casual.date', {
    month: d.getMonth() + 1,
    day: d.getDate(),
    wd: i18n.t(`casual.wd${d.getDay()}`),
  });
}

/** 「今天 · 10月5日（一）」, 「昨天 · …」, or the date alone. */
export function dayTitle(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  const date = dateWithWeekday(ts);
  if (key === dayKey(now)) return i18n.t('casual.todayDate', { date });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return i18n.t('casual.yesterdayDate', { date });
  return date;
}

/** 「今天 14:32」 for a moment: the day word or date, then the time. */
export function whenShort(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const day =
    key === dayKey(now)
      ? i18n.t('casual.today')
      : key === dayKey(y.getTime())
        ? i18n.t('casual.yesterday')
        : dateWithWeekday(ts);
  return `${day} ${clockTime(ts)}`;
}
