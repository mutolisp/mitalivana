/**
 * Which team a 同步 goes to (records' ⋯ menu and the census screen): with
 * several teams it always asks, each with its server, and switching between
 * same-named ones asks again (teamPick.ts) — a record must not silently keep
 * going to an old server. Null when cancelled.
 */
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import i18n from '~/i18n';
import { confirmSwitch, planTeamPick } from './teamPick';
import { listTeams, teamServerLabel } from './teamSync';

export async function pickSyncTeam(linked: string[]): Promise<string | null> {
  const t = i18n.t.bind(i18n);
  const teams = listTeams().map((x) => ({ team_id: x.team_id, name: x.name, host: teamServerLabel(x) }));
  const plan = planTeamPick(teams, linked);
  let chosen: string | null;
  if (plan.kind === 'use') chosen = plan.teamId;
  else {
    const idx = await showActionSheet({
      title: t('teamSync.pickTeam'),
      cancelLabel: t('common.cancel'),
      options: plan.options.map((o) => ({
        label: o.name,
        icon: 'people-outline' as const,
        description: [o.host, o.linked ? t('teamSync.pickLinked') : null].filter(Boolean).join(' · ') || undefined,
        selected: o.linked,
      })),
    });
    chosen = plan.options[idx]?.teamId ?? null;
  }
  if (!chosen) return null;
  const from = confirmSwitch(teams, linked, chosen);
  if (!from) return chosen;
  const to = teams.find((x) => x.team_id === chosen)!;
  const ok = await new Promise<boolean>((resolve) =>
    Alert.alert(t('teamSync.switchTitle'), t('teamSync.switchMsg', { name: to.name, from: from.host, to: to.host }), [
      { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      // No host on the button: Android capitalises dialog buttons; the message names it.
      { text: t('teamSync.switchGo'), onPress: () => resolve(true) },
    ]),
  );
  return ok ? chosen : null;
}
