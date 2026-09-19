/**
 * Google Drive login state — how the app gets and keeps an access token.
 *
 * The flow is OAuth 2.0 for TVs and Limited-Input Devices (see
 * `googleDevice.ts` for why that one): ask Google for a short user code, show
 * it, let the user type it into a browser on any device, poll until they
 * approve. The refresh token that comes back renews access silently from then
 * on, so this screen appears exactly once per install.
 *
 * Imperative API + module-level zustand store + host component, the same
 * pattern as TextPromptModal / ActionSheet / InatTokenHost, so a backup driver
 * can call `ensureAccessToken()` from anywhere without knowing about screens.
 * Unlike InatTokenHost there is no WebView and no hidden mode: the silent path
 * here is a plain HTTP refresh, so UI is only needed for the first link.
 *
 * On the client secret: it is compiled into the app and anyone can extract it.
 * That is inherent to an installed app and expected for this client type —
 * Google's own documentation says "it is assumed that the apps cannot keep
 * secrets". It grants nothing on its own; every token still requires the user
 * to approve the code in their own browser. Do not treat a report of it as a
 * leak, and do not try to "fix" it by hiding the value somewhere else.
 *
 * Storage: refresh token in expo-secure-store (Keychain / Keystore, device-
 * only so it is never synced to another phone); the account email in the
 * settings table (not secret). Backups are a whitelist of files (backup.ts),
 * so no credential can ride along into a backup zip.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { ApiError, postForm, sleep } from './apiFetch';
import { fetchAccountEmail, resetDriveFolderCache } from './drive';
import {
  DEVICE_GRANT_TYPE,
  DRIVE_FILE_SCOPE,
  GOOGLE_DEVICE_CODE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  SLOW_DOWN_STEP_MS,
  accessTokenUsable,
  classifyPoll,
  parseDeviceCode,
  parseTokenResponse,
  safeJsonObject,
  type DeviceCode,
  type PollOutcome,
  type TokenSet,
} from './googleDevice';
import { useDriveState } from './driveState';
import { useSettings } from '~/stores/settings';

const KEY_REFRESH = 'gdrive_refresh_token';

// ── errors ───────────────────────────────────────────────────────────────────

/** The user closed the code sheet, or declined in the browser. */
export class GoogleAuthCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'GoogleAuthCancelled';
  }
}

/** The code sat unused until it timed out. */
export class GoogleCodeExpired extends Error {
  constructor() {
    super('device code expired');
    this.name = 'GoogleCodeExpired';
  }
}

/** No usable refresh token and the caller did not allow interaction — the
 *  user has to link the account before anything else can happen. */
export class GoogleLoginRequired extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GoogleLoginRequired';
  }
}

/** The build carries no OAuth client — a missing `.env` value locally, or a
 *  missing EAS secret in a cloud build. Its own error so the account screen
 *  can say so instead of showing a button that silently does nothing. */
export class GoogleNotConfigured extends Error {
  constructor() {
    super('no Google OAuth client id in app config');
    this.name = 'GoogleNotConfigured';
  }
}

// ── configuration ────────────────────────────────────────────────────────────

type OauthExtra = { clientId?: string; clientSecret?: string };

function readExtra(): OauthExtra {
  const extra = Constants.expoConfig?.extra as { googleOauth?: OauthExtra } | undefined;
  return extra?.googleOauth ?? {};
}

export function isGoogleConfigured(): boolean {
  const { clientId, clientSecret } = readExtra();
  return Boolean(clientId && clientSecret);
}

function credentials(): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = readExtra();
  if (!clientId || !clientSecret) throw new GoogleNotConfigured();
  return { clientId, clientSecret };
}

// ── the device-code sheet ────────────────────────────────────────────────────

export type DeviceFlowRequest = {
  code: DeviceCode;
  /** Set by the host's close button; the polling loop notices and gives up. */
  cancel: () => void;
};

type DeviceFlowState = {
  pending: DeviceFlowRequest | null;
  open: (req: DeviceFlowRequest) => void;
  close: () => void;
};

export const useGoogleDeviceFlow = create<DeviceFlowState>((set) => ({
  pending: null,
  open: (req) => set({ pending: req }),
  close: () => set({ pending: null }),
}));

// ── storage ──────────────────────────────────────────────────────────────────

async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_REFRESH);
  } catch (e) {
    if (__DEV__) console.warn('[googleAuth] SecureStore read failed', e);
    return null;
  }
}

async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_REFRESH, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** Access tokens live an hour; keeping them only in memory costs one extra
 *  refresh per app start and leaves one less credential at rest. */
let cached: { token: string; expiresAtMs: number } | null = null;

/** Drop the in-memory access token (a 401 mid-batch), keeping the refresh
 *  token so the very next call can renew silently. */
export function discardAccessToken(): void {
  cached = null;
}

/**
 * Forget everything about the linked account. Called by 「解除連結」 and by
 * 「清除所有資料」 — the latter deletes user.db, which cannot reach SecureStore,
 * so the caller has to clear this explicitly (same rule as clearInatTokens).
 */
export async function clearGoogleTokens(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(KEY_REFRESH);
  } catch (e) {
    if (__DEV__) console.warn('[googleAuth] SecureStore delete failed', e);
  }
  useSettings.getState().set('gdrive_account', '');
  // The next link may be a different Drive: a cached folder id and an upload
  // history from the old account would both be wrong there.
  resetDriveFolderCache();
  await useDriveState.getState().clear();
}

// ── device flow ──────────────────────────────────────────────────────────────

async function pollOnce(deviceCode: string): Promise<PollOutcome> {
  const { clientId, clientSecret } = credentials();
  try {
    const json = await postForm('gdrive', GOOGLE_TOKEN_URL, {
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    });
    return classifyPoll(200, json);
  } catch (e) {
    if (e instanceof ApiError && e.status) {
      return classifyPoll(e.status, safeJsonObject(e.detail));
    }
    // Offline or timed out. The code is good for half an hour and the user is
    // most likely mid-approval, so a blip is "keep waiting", not "start over".
    if (e instanceof ApiError && (e.kind === 'network' || e.kind === 'timeout')) {
      return { kind: 'pending' };
    }
    throw e;
  }
}

async function runDeviceFlow(): Promise<TokenSet> {
  const { clientId } = credentials();
  const code = parseDeviceCode(
    await postForm('gdrive', GOOGLE_DEVICE_CODE_URL, {
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
    }),
  );
  if (!code) throw new Error('device code response unusable');

  let cancelled = false;
  useGoogleDeviceFlow.getState().open({
    code,
    // Dismiss immediately as well as flagging the loop: the loop is asleep for
    // the poll interval, and a close button that leaves the sheet up for
    // another five seconds reads as a frozen app.
    cancel: () => {
      cancelled = true;
      useGoogleDeviceFlow.getState().close();
    },
  });
  try {
    let intervalMs = code.intervalMs;
    for (;;) {
      await sleep(intervalMs);
      if (cancelled) throw new GoogleAuthCancelled();
      if (Date.now() > code.expiresAtMs) throw new GoogleCodeExpired();

      const outcome = await pollOnce(code.deviceCode);
      switch (outcome.kind) {
        case 'token':
          return outcome.tokens;
        case 'pending':
          break;
        case 'slow_down':
          intervalMs += SLOW_DOWN_STEP_MS;
          break;
        case 'denied':
          throw new GoogleAuthCancelled();
        case 'expired':
          throw new GoogleCodeExpired();
        case 'fatal':
          throw new Error(`device flow failed: ${outcome.code}`);
      }
    }
  } finally {
    useGoogleDeviceFlow.getState().close();
  }
}

/**
 * Trade the refresh token for a fresh access token.
 *
 * null means the grant is gone (revoked in the user's Google account, or
 * expired) and the stored token should be discarded. A transient failure
 * throws instead, because a 5xx or a lost signal must never cost the user
 * their link.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenSet | null> {
  const { clientId, clientSecret } = credentials();
  try {
    return parseTokenResponse(
      await postForm('gdrive', GOOGLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    );
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && (e.status === 400 || e.status === 401)) {
      return null;
    }
    throw e;
  }
}

// ── the one entry point ──────────────────────────────────────────────────────

let inflight: Promise<string> | null = null;

/**
 * An access token good for at least the next few minutes.
 *
 * Order: the in-memory one if it still has margin → renew from the stored
 * refresh token → (only when `interactive`) run the device flow. Concurrent
 * callers share one attempt, so a batch of uploads renews once, not per file.
 *
 * `interactive` defaults to false on purpose: an upload triggered by finishing
 * a survey must never pop an authorization sheet at someone who is walking.
 */
export function ensureAccessToken(opts: { interactive?: boolean } = {}): Promise<string> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (cached && accessTokenUsable(cached.expiresAtMs)) return cached.token;

      const refresh = await getRefreshToken();
      if (refresh) {
        const renewed = await refreshAccessToken(refresh);
        if (renewed) {
          cached = { token: renewed.accessToken, expiresAtMs: renewed.expiresAtMs };
          return renewed.accessToken;
        }
        // The grant is gone. Holding a dead token only buys one failed request
        // per attempt before discovering the same thing.
        await clearGoogleTokens();
      }

      if (!opts.interactive) throw new GoogleLoginRequired('no usable refresh token');

      const tokens = await runDeviceFlow();
      if (tokens.refreshToken) await storeRefreshToken(tokens.refreshToken);
      cached = { token: tokens.accessToken, expiresAtMs: tokens.expiresAtMs };
      await rememberAccount(tokens.accessToken);
      return tokens.accessToken;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function rememberAccount(accessToken: string): Promise<void> {
  try {
    useSettings.getState().set('gdrive_account', await fetchAccountEmail(accessToken));
  } catch (e) {
    // Display only — a link that works but cannot name itself is still a link.
    if (__DEV__) console.warn('[googleAuth] about.get failed (keeping token)', e);
  }
}

// ── account screen actions ───────────────────────────────────────────────────

/** 「連結」: always interactive. */
export async function linkGoogleDrive(): Promise<'ok' | 'cancelled'> {
  try {
    await ensureAccessToken({ interactive: true });
    return 'ok';
  } catch (e) {
    if (e instanceof GoogleAuthCancelled) return 'cancelled';
    throw e;
  }
}

/**
 * 「解除連結」: revoke the grant server-side, then forget it.
 *
 * The revoke matters more here than a local delete would suggest: `drive.file`
 * leaves the app permanent write access to every file it ever created, so
 * unlinking has to actually withdraw that, not just lose the key to it. Best
 * effort — offline simply skips it, and the local half still happens.
 */
export async function unlinkGoogleDrive(): Promise<void> {
  const refresh = await getRefreshToken();
  if (refresh) {
    try {
      await postForm('gdrive', GOOGLE_REVOKE_URL, { token: refresh });
    } catch (e) {
      if (__DEV__) console.warn('[googleAuth] revoke failed', e);
    }
  }
  await clearGoogleTokens();
}

export type GoogleStatus = {
  /** Email of the linked account; '' when about.get never answered. */
  account: string;
};

/** null = not linked (never linked, or cleared). */
export async function getGoogleStatus(): Promise<GoogleStatus | null> {
  const refresh = await getRefreshToken();
  if (!refresh) return null;
  return { account: useSettings.getState().gdrive_account };
}
