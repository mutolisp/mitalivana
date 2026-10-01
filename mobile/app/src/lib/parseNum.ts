/**
 * Read a number typed into a decimal field.
 *
 * A decimal comma ("12,5") must read as 12.5: plain `Number("12,5")` is NaN,
 * which used to drop the value silently (a DBH stem was not added, a plot
 * field was cleared). Empty or unparsable → null, so callers decide between
 * "cleared" and "invalid" by checking the trimmed text themselves.
 *
 * Pure (no React Native imports) so check scripts can run it under Node.
 */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
