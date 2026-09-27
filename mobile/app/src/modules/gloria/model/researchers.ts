/**
 * The survey's researchers gathered from its units. A unit with its own
 * researchers (recorded_by) adds whoever the survey does not list yet, in
 * the order they first appear (survey first, then units in unit order);
 * units with none follow the survey and add nobody. Pure.
 */
const split = (s: string | null | undefined): string[] =>
  (s ?? '')
    .split(/\s*[,，|]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

export function researchersFromUnits(
  surveyBy: string | null,
  units: ReadonlyArray<{ recorded_by: string | null }>,
): { value: string | null; added: string[] } {
  const names = split(surveyBy);
  const added: string[] = [];
  for (const u of units)
    for (const n of split(u.recorded_by))
      if (!names.includes(n)) {
        names.push(n);
        added.push(n);
      }
  return { value: names.length ? names.join(', ') : null, added };
}
