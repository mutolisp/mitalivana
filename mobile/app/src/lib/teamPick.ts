/**
 * Which team a record's cloud button syncs to. Pure, so check:team-pick runs
 * it in Node.
 *
 * A record remembers the teams it was synced with (sync_links). With one
 * linked team the button used it without asking — which hid where the data
 * went: a team re-created on another server left records on the old one, and
 * a GLORIA survey linked to a team on the default server kept uploading there
 * after the user had moved on (2026-09-28). So:
 *   - with more than one team on the phone the button always asks, every
 *     option with its server, the teams this record was synced with first
 *     and marked;
 *   - choosing a same-named team other than the one the record was synced
 *     with asks again (confirmSwitch).
 */
export type PickTeam = { team_id: string; name: string; host: string };

export type PickPlan =
  | { kind: 'use'; teamId: string }
  | { kind: 'ask'; options: Array<{ teamId: string; name: string; host: string | null; linked: boolean }> };

const key = (name: string) => name.trim().toLowerCase();

/** Names used by more than one team on this device. */
export function duplicateNames(teams: ReadonlyArray<Pick<PickTeam, 'name'>>): Set<string> {
  const seen = new Map<string, number>();
  for (const t of teams) seen.set(key(t.name), (seen.get(key(t.name)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

export function planTeamPick(teams: ReadonlyArray<PickTeam>, linked: ReadonlyArray<string>): PickPlan {
  if (teams.length === 1) return { kind: 'use', teamId: teams[0].team_id };
  const known = new Set(linked.filter((id) => teams.some((t) => t.team_id === id)));
  // Linked first, then the device's order (stable sort).
  const ordered = [...teams].sort((a, b) => Number(known.has(b.team_id)) - Number(known.has(a.team_id)));
  return {
    kind: 'ask',
    options: ordered.map((t) => ({ teamId: t.team_id, name: t.name, host: t.host, linked: known.has(t.team_id) })),
  };
}

/** The same-named team this record was synced with, when `chosen` is another one; else null. */
export function confirmSwitch(teams: ReadonlyArray<PickTeam>, linked: ReadonlyArray<string>, chosen: string): PickTeam | null {
  const pick = teams.find((t) => t.team_id === chosen);
  if (!pick || linked.includes(chosen)) return null;
  return teams.find((t) => t.team_id !== chosen && linked.includes(t.team_id) && key(t.name) === key(pick.name)) ?? null;
}
