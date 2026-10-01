/**
 * A numeric field's accepted range — pure.
 *
 * `min` / `max`: outside is impossible, the entry is refused.
 * `warnMin` / `warnMax`: outside is unusual, the entry is kept but the user is
 * asked to check it. Moved from src/modules/gloria/model/ranges.ts (which
 * keeps GLORIA's own RANGES and re-exports these) for the shared NumField.
 */
export type Range = { min?: number; max?: number; warnMin?: number; warnMax?: number; integer?: boolean; unit: string };

export type RangeCheck = 'ok' | 'reject' | 'warn';

export function checkRange(v: number | null, r: Range): RangeCheck {
  if (v == null) return 'ok';
  if ((r.min != null && v < r.min) || (r.max != null && v > r.max)) return 'reject';
  if (r.integer && !Number.isInteger(v)) return 'reject';
  if ((r.warnMin != null && v < r.warnMin) || (r.warnMax != null && v > r.warnMax)) return 'warn';
  return 'ok';
}
