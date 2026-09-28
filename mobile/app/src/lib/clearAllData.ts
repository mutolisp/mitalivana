/**
 * 設定 →「清除所有資料」: everything this phone holds for the user, not only
 * user.db (security audit S3, 2026-09-28). Before, the database went but
 * team secrets, relay admin tokens, the signing key, the GBIF password, the
 * app's photos / recordings / attachments, safety snapshots, pre-merge
 * backups and the iNaturalist web session all stayed — the next person with
 * the phone could upload to the previous user's iNaturalist account without
 * signing in.
 *
 * Kept on purpose: the downloaded checklist modules and offline maps (public
 * data, large downloads), and photos saved to the system photo library (the
 * user's own). Google Drive backups are in the user's Drive, not here.
 *
 * Secrets that are listed in user.db (teams, own relays) are collected first,
 * since the database goes next.
 */
import { Directory, Paths } from 'expo-file-system';
import { clearAllUserData } from '~/db';
import { clearGbifCredentials } from './gbifCredentials';
import { clearGoogleTokens } from './googleAuth';
import { clearInatTokens, markInatSessionRevoked } from './inatAuth';
import { deleteKey } from './signingKey';
import { clearCache, mergeBackups, safetyBackups } from './storage';
import { forgetAllTeamSecrets, listServers, listTeams, serverOf } from './teamSync';
import { deleteAdminToken } from './teamSyncAdmin';

const MEDIA_DIRS = ['photos', 'audio', 'files'] as const;

async function quietly(what: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (__DEV__) console.warn(`[clearAllData] ${what} failed`, e);
  }
}

export async function clearAllData(): Promise<void> {
  // Read from user.db before it goes.
  const relays = [...new Set([...listServers().map((s) => s.url), ...listTeams().map(serverOf)])];
  await quietly('team secrets', forgetAllTeamSecrets);
  for (const url of relays) await quietly('admin token', () => deleteAdminToken(url));

  await clearAllUserData();

  // The iNaturalist web session too: the hidden token WebView would otherwise
  // sign the next user in as this one. Marked, not logged out here — that
  // needs the network; the next sign-in logs the old session out first.
  await quietly('iNaturalist tokens', clearInatTokens);
  await quietly('iNaturalist session', markInatSessionRevoked);
  await quietly('Google tokens', clearGoogleTokens);
  await quietly('GBIF credentials', clearGbifCredentials);
  await quietly('signing key', deleteKey);

  for (const f of [...safetyBackups(), ...mergeBackups()]) await quietly(`delete ${f.name}`, () => f.delete());
  for (const name of MEDIA_DIRS) {
    await quietly(`delete ${name}/`, () => {
      const dir = new Directory(Paths.document, name);
      if (dir.exists) dir.delete();
    });
  }
  await quietly('cache', clearCache);
}
