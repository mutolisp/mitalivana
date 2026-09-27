/**
 * Accepted ranges for GLORIA numeric entries — pure.
 *
 * `min` / `max`: outside is impossible, the entry is refused.
 * `warnMin` / `warnMax`: outside is unusual, the entry is kept but the user
 * is asked to check it (a typo like 2.35 for 23.5 m).
 *
 * Distance limits are a field-practice sanity band set by the project
 * (2026-09-25), not a manual rule: measurement points lie roughly 10–150 m
 * of surface distance from the HSP.
 */

export type Range = { min?: number; max?: number; warnMin?: number; warnMax?: number; integer?: boolean; unit: string };

export const RANGES = {
  bearing: { min: 0, max: 360, unit: '°' },
  aspect: { min: 0, max: 360, unit: '°' },
  slope: { min: 0, max: 90, unit: '°' },
  percent: { min: 0, max: 100, unit: '%' },
  distance: { min: 0, warnMin: 10, warnMax: 150, unit: 'm' },
  latitude: { min: -90, max: 90, unit: '°' },
  longitude: { min: -180, max: 180, unit: '°' },
  elevation: { min: -500, max: 9000, unit: 'm' },
  /** Monitoring cycle; Annex III gives it two digits in photo names. */
  mocy: { min: 1, max: 99, integer: true, unit: '' },
  /** Frequency entered as a count: whole cells out of 100. */
  cells: { min: 0, max: 100, integer: true, unit: '' },
  /** Temperature logger to a p5m corner of its cluster (Form 4 Dist-11 / Dist-31): inside a 3 × 3 m cluster. */
  loggerDist: { min: 0, max: 10, warnMax: 4.3, unit: 'm' },
  /** Form 4 note 5: hours from local time to UTC. */
  utcDiff: { min: -14, max: 14, unit: 'h' },
} satisfies Record<string, Range>;

export type RangeCheck = 'ok' | 'reject' | 'warn';

export function checkRange(v: number | null, r: Range): RangeCheck {
  if (v == null) return 'ok';
  if ((r.min != null && v < r.min) || (r.max != null && v > r.max)) return 'reject';
  if (r.integer && !Number.isInteger(v)) return 'reject';
  if ((r.warnMin != null && v < r.warnMin) || (r.warnMax != null && v > r.warnMax)) return 'warn';
  return 'ok';
}
