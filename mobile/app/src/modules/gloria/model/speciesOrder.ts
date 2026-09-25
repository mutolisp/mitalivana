/**
 * The order of a unit's species: the one the user dragged them into
 * (`sort_order`, v55), then — for rows never reordered, e.g. added since —
 * roster serial. Screens and the sheet export share it, so the export's
 * `…-1x1_sp-N` numbering follows the list the user sees.
 */
export type Orderable = { sort_order?: number | null; serial: number };

export function bySpeciesOrder(a: Orderable, b: Orderable): number {
  const ao = a.sort_order ?? Number.POSITIVE_INFINITY;
  const bo = b.sort_order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.serial - b.serial;
}
