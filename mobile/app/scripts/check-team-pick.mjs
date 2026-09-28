/**
 * Which team a record's cloud button syncs to (src/lib/teamPick.ts):
 *   - with one team on the phone it is used; with more the button always
 *     asks, every option with its server, the record's own first and marked
 *     (a record silently kept going to an old server, 2026-09-28);
 *   - switching to a same-named team the record was not synced with asks.
 */
import { confirmSwitch, duplicateNames, planTeamPick } from '../src/lib/teamPick.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

const oldV = { team_id: 'old', name: 'veglab', host: 'mitalivana-sync.x.workers.dev' };
const newV = { team_id: 'new', name: 'Veglab ', host: 'mitalivana-sync-media.x.workers.dev' };
const other = { team_id: 'oth', name: 'GLORIA', host: 'sync.mitalivana.org' };

eq('duplicate names ignore case and spaces', [...duplicateNames([oldV, newV, other])], ['veglab']);
eq('one team: used without asking', planTeamPick([other], []), { kind: 'use', teamId: 'oth' });
eq('several teams, record linked to one with a unique name: still asked (it may be the old server)',
  planTeamPick([oldV, other], ['oth']), {
    kind: 'ask',
    options: [
      { teamId: 'oth', name: 'GLORIA', host: other.host, linked: true },
      { teamId: 'old', name: 'veglab', host: oldV.host, linked: false },
    ],
  });
eq('every option shows its server, linked first and marked', planTeamPick([oldV, newV, other], ['old']), {
  kind: 'ask',
  options: [
    { teamId: 'old', name: 'veglab', host: oldV.host, linked: true },
    { teamId: 'new', name: 'Veglab ', host: newV.host, linked: false },
    { teamId: 'oth', name: 'GLORIA', host: other.host, linked: false },
  ],
});
eq('not linked, several teams: asked in the device order', planTeamPick([oldV, other], []).options?.map((o) => o.teamId), ['old', 'oth']);
eq('a link to a team no longer on the phone marks nothing', planTeamPick([oldV, other], ['gone']).options?.some((o) => o.linked), false);
eq('switch to the same-named twin: confirm, naming the old one', confirmSwitch([oldV, newV, other], ['old'], 'new')?.team_id, 'old');
eq('choosing the linked team, or a differently named one: no confirm', [confirmSwitch([oldV, newV, other], ['old'], 'old'), confirmSwitch([oldV, newV, other], ['old'], 'oth')], [null, null]);
eq('already synced with both twins: no confirm', confirmSwitch([oldV, newV], ['old', 'new'], 'new'), null);

if (failed) {
  console.error(`check:team-pick — ${failed} failed`);
  process.exit(1);
}
console.log('✓ team-pick: several teams always asked with their servers, switching between same-named ones confirmed');
