/**
 * The device's Ed25519 signing key, and the identity it signs as.
 *
 * Split from `signing.ts` on purpose: that module is pure so the three
 * verifiers and `check:sign` can exercise it, while everything that touches
 * the keychain or the database lives here.
 *
 * ## Where the seed comes from
 *
 * SQLite's `randomblob(32)` — the same CSPRNG `generateUuid()` already relies
 * on (`src/db/uuid.ts` explains the choice). noble-ed25519's own `keygen()`
 * would reach for `crypto.getRandomValues`, which React Native does not
 * provide, and polyfilling it means adding `expo-crypto` or
 * `react-native-get-random-values` — a native module, hence a native rebuild.
 * Passing our own seed to the library avoids that entirely; signing itself is
 * deterministic (RFC 8032 §5.1.6) and needs no randomness at all.
 *
 * ## Where it is stored, and why it is never backed up
 *
 * `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, the same setting
 * `inatAuth.ts` and `googleAuth.ts` use. That flag keeps the item out of
 * iCloud/iTunes backups and stops it migrating to a replacement device, which
 * is the behaviour we want rather than a limitation to work around:
 *
 *   - Settings ride along inside backup zips. A private key must not.
 *   - A key that cannot travel cannot be stolen from a backup that travelled.
 *   - A new device simply mints a new key. The researcher adds its public key
 *     to the same ORCID profile next to the old one and never removes the old
 *     one, so everything signed on the previous phone stays verifiable.
 *
 * There is no export, no passphrase escrow and no recovery. Losing the phone
 * loses the key, and that is the intended trade.
 */
import * as SecureStore from 'expo-secure-store';

import { getUserDb } from '~/db/init';
import { useSettings } from '~/stores/settings';

import { normalizeOrcid, publicKeyFromSeed, type SignerIdentity } from './signing';

const KEY_SEED = 'provenance_ed25519_seed';

/** 32 bytes of hex from SQLite's CSPRNG. */
function newSeedHex(): string {
  const res = getUserDb().executeSync(`SELECT lower(hex(randomblob(32))) AS s;`);
  const s = (res.rows?.[0] as { s?: string } | undefined)?.s;
  if (!s || s.length !== 64) throw new Error('newSeedHex: SQLite returned no seed');
  return s;
}

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The raw seed, or null when this device has never made one. */
export async function readSeed(): Promise<Uint8Array | null> {
  let hex: string | null = null;
  try {
    hex = await SecureStore.getItemAsync(KEY_SEED);
  } catch (e) {
    // A locked keychain reads as "no key" rather than crashing the export.
    if (__DEV__) console.warn('[signingKey] SecureStore read failed', e);
    return null;
  }
  return hex && /^[0-9a-f]{64}$/.test(hex) ? hexToBytes32(hex) : null;
}

/**
 * Make a key if there is none, and return its public half.
 *
 * Idempotent: called again with a key already present, it returns the existing
 * public key rather than rolling it. Rolling would orphan every signature made
 * so far, so it is only ever done by an explicit `deleteKey()` first.
 */
export async function ensureKey(): Promise<string> {
  const existing = await readSeed();
  if (existing) return publicKeyFromSeed(existing);
  const hex = newSeedHex();
  await SecureStore.setItemAsync(KEY_SEED, hex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return publicKeyFromSeed(hexToBytes32(hex));
}

/** The public key if one exists, without creating one. */
export async function readPublicKey(): Promise<string | null> {
  const seed = await readSeed();
  return seed ? publicKeyFromSeed(seed) : null;
}

/** Forget the key. Past exports stay verifiable; future ones get a new key. */
export async function deleteKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_SEED);
  } catch (e) {
    if (__DEV__) console.warn('[signingKey] SecureStore delete failed', e);
  }
}

/**
 * Who this device signs as, plus the seed to sign with — or null.
 *
 * Null means exports carry no signature at all. Three things have to line up,
 * and a partial setup signs nothing rather than something half-attributed:
 * signing must be switched on, a key must exist, and an ORCID must be set.
 * A signature with no ORCID would assert "some key signed this" and prove
 * nothing about who, which is the one thing this feature exists to do.
 */
export async function activeSigner(): Promise<{
  signer: SignerIdentity;
  seed: Uint8Array;
} | null> {
  const s = useSettings.getState();
  if (!s.sign_exports) return null;
  const orcid = normalizeOrcid(s.signer_orcid);
  if (!orcid) return null;
  const seed = await readSeed();
  if (!seed) return null;
  return {
    seed,
    signer: { name: s.signer_name, orcid, publicKey: publicKeyFromSeed(seed) },
  };
}
