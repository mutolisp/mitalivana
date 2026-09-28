/**
 * Admin tokens of relays this device deployed (「用我自己的 Cloudflare」). They
 * change per-team limits (PUT /v1/admin/t/{teamId}/limits) and are kept in the
 * Keychain / Keystore only — lost with the phone, like the deployment's
 * ownership in the app; the Cloudflare dashboard can always redeploy.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { strToU8 } from 'fflate';
import * as SecureStore from 'expo-secure-store';
import { fetchText } from './apiFetch';
import { TeamSyncError } from './teamSync';

const keyFor = (url: string) => `syncAdmin_${bytesToHex(sha256(strToU8(url.replace(/\/+$/, '')))).slice(0, 32)}`;

export async function saveAdminToken(url: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(keyFor(url), token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function deleteAdminToken(url: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(url));
}

export async function adminTokenFor(url: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyFor(url));
}

export type TeamLimitOverrides = { maxTeamBytes?: number; maxTeamDevices?: number; maxDeviceBytes?: number; maxTeamObjects?: number };

export async function setTeamLimits(server: string, teamId: string, overrides: TeamLimitOverrides): Promise<Record<string, number>> {
  const token = await adminTokenFor(server);
  if (!token) throw new TeamSyncError('unauthorized');
  const res = await fetchText('sync', 'PUT', `${server.replace(/\/+$/, '')}/v1/admin/t/${teamId}/limits`, {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(overrides),
    contentType: 'application/json',
  });
  return JSON.parse(res.text) as Record<string, number>;
}
