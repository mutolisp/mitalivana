/**
 * Team sync prompts shared by the team list (app/settings/team-sync.tsx) and
 * a team's own page (app/settings/team/[id].tsx).
 *
 * Order matters on iOS: a native sheet presented while a prompt's Modal is
 * still animating out is dismissed with it, so every flow opens its sheet
 * first and its prompts after.
 */
import type { TFunction } from 'i18next';
import { Alert } from 'react-native';
import { defaultSurveyorString } from '~/db/surveyors';
import { isHttpsUrl } from '~/lib/teamCrypto';
import { DEFAULT_SERVER, defaultServerForNewTeams, hostOf, listServers, serverAlias, serverLabel, setServerAlias } from '~/lib/teamSync';
import { showActionSheet } from './ActionSheet';
import { promptText } from './TextPromptModal';

const host = (u: string) => serverLabel(u);

/**
 * Pick a relay: the built-in one, the remembered ones (deployed here first),
 * or a URL typed now. `undefined` = cancelled.
 */
export async function pickServer(t: TFunction, title: string, exclude?: string): Promise<string | undefined> {
  const def = defaultServerForNewTeams();
  const known = listServers();
  const own = new Set(known.filter((x) => x.is_own).map((x) => x.url));
  const choices = [DEFAULT_SERVER, ...known.map((x) => x.url)].filter((u) => u !== exclude);
  choices.sort((a, b) => (a === def ? -1 : b === def ? 1 : 0));
  const labelOf = (u: string) => {
    const base =
      u === DEFAULT_SERVER
        ? t('teamSync.serverBuiltin', { host: host(u) })
        : own.has(u)
          ? t('teamSync.serverOwn', { host: host(u) })
          : host(u);
    return u === def ? `${base}${t('teamSync.defaultMark')}` : base;
  };
  const idx = await showActionSheet({
    title,
    message: t('teamSync.serverMsg'),
    cancelLabel: t('common.cancel'),
    options: [...choices.map((u) => ({ label: labelOf(u), icon: 'server-outline' as const })), { label: t('teamSync.serverOther'), icon: 'create-outline' as const }],
  });
  if (idx < 0 || idx > choices.length) return undefined;
  if (idx < choices.length) return choices[idx];
  const url = await promptText({
    title: t('teamSync.serverCustom'),
    message: t('teamSync.serverUrlMsg'),
    placeholder: 'https://mitalivana-sync.example.workers.dev',
    autoCapitalize: 'none',
    keyboardType: 'email-address',
  });
  if (!url) return undefined;
  const u = url.trim().replace(/\/+$/, '');
  if (!isHttpsUrl(u)) {
    Alert.alert(t('teamSync.failTitle'), t('teamSync.err.server'));
    return undefined;
  }
  return u;
}

/**
 * Give a server a short name on this device (v71); empty clears it and the
 * address shows again. Resolves true when something was saved.
 */
export async function renameServer(t: TFunction, url: string): Promise<boolean> {
  const v = await promptText({
    title: t('teamSync.aliasTitle'),
    message: t('teamSync.aliasMsg', { host: hostOf(url) }),
    defaultValue: serverAlias(url) ?? '',
    placeholder: t('teamSync.aliasPlaceholder'),
  });
  if (v === null) return false;
  setServerAlias(url, v);
  return true;
}

/** This device's name in a team; null = cancelled. Starts from the default surveyor. */
export function askMyName(t: TFunction, current: string | null): Promise<string | null> {
  return promptText({
    title: t('teamSync.myNameTitle'),
    message: t('teamSync.myNameMsg'),
    defaultValue: current ?? defaultSurveyorString() ?? '',
    placeholder: t('teamSync.myNamePlaceholder'),
  });
}

/** An alert right after a prompt (a Modal) is dropped on iOS during its exit animation. */
export const afterPrompt = () => new Promise((r) => setTimeout(r, 450));
