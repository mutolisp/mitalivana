/**
 * Locally saved GBIF credentials for region-pack downloads (opt-in).
 *
 * Kept in SecureStore (Keychain / Keystore, this device only, readable while
 * unlocked), like the other tokens — never in user.db's settings table, whose
 * backups a user may share, and no longer as a plain JSON file in Documents:
 * that file rode along into iCloud / Android Auto Backup (security audit S2,
 * 2026-09-28). A file left by an older build is moved in on first read and
 * deleted. Saving at all is the user's explicit choice via a prompt.
 */
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

const KEY = 'gbif_credentials';
/** Where builds before 2026-09-28 kept them, in plain text. */
const LEGACY_FILE = 'gbif_credentials.json';
const OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type GbifCredentials = { username: string; password: string };

const parse = (text: string | null): GbifCredentials | null => {
  if (!text) return null;
  try {
    const p = JSON.parse(text);
    return typeof p?.username === 'string' && typeof p?.password === 'string' ? { username: p.username, password: p.password } : null;
  } catch {
    return null;
  }
};

function deleteLegacyFile(): void {
  try {
    const f = new File(Paths.document, LEGACY_FILE);
    if (f.exists) f.delete();
  } catch (e) {
    if (__DEV__) console.warn('[gbif] legacy credentials file delete failed:', e);
  }
}

export async function loadGbifCredentials(): Promise<GbifCredentials | null> {
  try {
    const stored = parse(await SecureStore.getItemAsync(KEY));
    if (stored) return stored;
    // An older build's plain file: move it into SecureStore, then remove it.
    const legacy = new File(Paths.document, LEGACY_FILE);
    if (!legacy.exists) return null;
    const moved = parse(await legacy.text());
    if (moved) await SecureStore.setItemAsync(KEY, JSON.stringify(moved), OPTS);
    deleteLegacyFile();
    return moved;
  } catch (e) {
    if (__DEV__) console.warn('[gbif] credentials load failed:', e);
    return null;
  }
}

export async function saveGbifCredentials(creds: GbifCredentials): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(creds), OPTS);
  } catch (e) {
    if (__DEV__) console.warn('[gbif] credentials save failed:', e);
  }
  deleteLegacyFile();
}

/** Called on a 401 (stale password), when the user opts out, and by "clear all data". */
export async function clearGbifCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch (e) {
    if (__DEV__) console.warn('[gbif] credentials clear failed:', e);
  }
  deleteLegacyFile();
}
