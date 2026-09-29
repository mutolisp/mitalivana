/**
 * How a fixed-plot quadrat is named on screen: its label (Q1…) plus where it
 * sits — a compass corner as letters (the user's choice for directions), the
 * centre translated, or the subplot it belongs to.
 */
import type { TFunction } from 'i18next';
import type { Quadrat, QuadratLayout, TopEdge } from '~/db/quadrats';
import type { QuadratStatus } from '~/lib/quadratProgress';

export const LAYOUT_KEY: Record<QuadratLayout, string> = {
  cornersCenter: 'plot.quadrats.layoutCornersCenter',
  perSubplot: 'plot.quadrats.layoutPerSubplot',
  diagonal: 'plot.quadrats.layoutDiagonal',
  custom: 'plot.quadrats.layoutCustom',
};

export const STATUS_KEY: Record<QuadratStatus, string> = {
  none: 'plot.quadrats.status.none',
  progress: 'plot.quadrats.status.progress',
  done: 'plot.quadrats.status.done',
  warn: 'plot.quadrats.status.warn',
};

export function topEdgeName(t: TFunction, e: TopEdge | string): string {
  return e === 'upslope' ? t('plot.quadrats.upslope') : e;
}

/** "中心", "NW", a subplot's label, or '' when nothing places it. */
export function quadratPlace(t: TFunction, q: Pick<Quadrat, 'position' | 'subplot_id'>, subplotLabel?: (id: number) => string | undefined): string {
  if (q.position === 'C') return t('plot.quadrats.center');
  if (q.position) return q.position;
  return q.subplot_id != null ? (subplotLabel?.(q.subplot_id) ?? '') : '';
}

/** "Q3 中心" / "Q4". */
export function quadratName(t: TFunction, q: Pick<Quadrat, 'label' | 'position' | 'subplot_id'>, subplotLabel?: (id: number) => string | undefined): string {
  const place = quadratPlace(t, q, subplotLabel);
  return place ? `${q.label} ${place}` : q.label;
}
