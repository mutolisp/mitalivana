/**
 * What a number field says when an entry is out of its range: both bounds,
 * only a lower one (inclusive, or exclusive as a cover above 0), or only an
 * upper one. A one-sided range used to read "between 0 and 100" (2G-e).
 *
 * Pure: check:survey-core runs it under Node.
 */
import type { TFunction } from 'i18next';

export function rangeText(t: TFunction, min: number | undefined, max: number | undefined, minExclusive = false): string | null {
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined) return minExclusive ? t('plot.numAboveMax', { min, max }) : t('plot.numRange', { min, max });
  if (min !== undefined) return minExclusive ? t('plot.numAbove', { min }) : t('plot.numMin', { min });
  return t('plot.numMax', { max });
}
