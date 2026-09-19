/**
 * Google OAuth device flow + Drive query helpers — pure, no Expo imports
 * (scripts/check-gdrive.mjs loads this under plain Node).
 *
 * Why the device flow and not a redirect: Google's own documentation for
 * mobile & desktop apps states "Custom URI schemes are no longer supported on
 * Android and Chrome apps", the loopback redirect is deprecated on mobile, and
 * an embedded WebView is refused with `disallowed_useragent`. That leaves
 * either a native sign-in SDK (a new native module, so a rebuild of both dev
 * clients, two OAuth clients, three SHA-1 fingerprints to keep alive) or this:
 * the flow documented for "TVs and Limited Input Devices", whose published
 * allowed-scope list includes `drive.file` and `drive.appdata`. It is plain
 * HTTP, identical on both platforms, and needs no native code at all.
 *
 * The cost is that the user types an 8-character code into a browser once.
 * After that the refresh token renews silently.
 */

// ── endpoints ────────────────────────────────────────────────────────────────

export const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Non-sensitive: no OAuth verification security assessment, unlike the full
 *  `drive` scope. Lets the app touch only the files it created itself. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Top-level folder created in the user's Drive. */
export const DRIVE_ROOT_FOLDER_NAME = 'Mitalivana';
/** Key of the `appProperties` marker that identifies our folders. Invisible to
 *  the user, so renaming or moving a folder in Drive cannot break the app. */
export const ROLE_KEY = 'checklisterRole';
export type FolderRole = 'root' | 'backups' | 'photos';

// ── token lifetime ───────────────────────────────────────────────────────────

/**
 * How early an access token counts as expired. An upload that starts with 30
 * seconds left would die mid-transfer; renewing is one cheap request.
 */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** Google's documented default when the device-code response omits `interval`. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;
/** Added to the interval each time the server answers `slow_down`. */
export const SLOW_DOWN_STEP_MS = 5000;

export function accessTokenUsable(
  expiresAtMs: number,
  nowMs: number = Date.now(),
  marginMs: number = ACCESS_TOKEN_MARGIN_MS,
): boolean {
  return expiresAtMs - nowMs > marginMs;
}

// ── device flow ──────────────────────────────────────────────────────────────

export type DeviceCode = {
  /** Secret half — polled for, never shown. */
  deviceCode: string;
  /** The short code the user types, e.g. `BDWC-ZHVL`. */
  userCode: string;
  /** Where the user types it, e.g. https://www.google.com/device. */
  verificationUrl: string;
  expiresAtMs: number;
  intervalMs: number;
};

export type TokenSet = {
  accessToken: string;
  expiresAtMs: number;
  /** Absent on a refresh response — Google only issues it once. */
  refreshToken: string | null;
};

export type PollOutcome =
  /** Authorized: tokens in hand. */
  | { kind: 'token'; tokens: TokenSet }
  /** The user has not finished yet — keep polling. */
  | { kind: 'pending' }
  /** Polling too fast; lengthen the interval and keep going. */
  | { kind: 'slow_down' }
  /** The user said no. */
  | { kind: 'denied' }
  /** The code timed out before the user used it. */
  | { kind: 'expired' }
  /** Anything else: a misconfigured client id, a revoked grant, junk. */
  | { kind: 'fatal'; code: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function secondsToMs(v: unknown, fallbackSeconds: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return (Number.isFinite(n) && n > 0 ? n : fallbackSeconds) * 1000;
}

/**
 * Parse the device-code response.
 *
 * Accepts both `verification_url` (what Google actually returns) and
 * `verification_uri` (what RFC 8628 specifies). They differ by one letter and
 * getting it wrong is a blank screen rather than an error, so both are read.
 */
export function parseDeviceCode(json: unknown, nowMs: number = Date.now()): DeviceCode | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const deviceCode = str(o.device_code);
  const userCode = str(o.user_code);
  const verificationUrl = str(o.verification_url) ?? str(o.verification_uri);
  if (!deviceCode || !userCode || !verificationUrl) return null;
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAtMs: nowMs + secondsToMs(o.expires_in, 1800),
    intervalMs: Math.max(secondsToMs(o.interval, 5), DEFAULT_POLL_INTERVAL_MS),
  };
}

export function parseTokenResponse(json: unknown, nowMs: number = Date.now()): TokenSet | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const accessToken = str(o.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    // Google issues 1 h; the field is authoritative and the fallback only
    // matters if it is ever missing.
    expiresAtMs: nowMs + secondsToMs(o.expires_in, 3600),
    refreshToken: str(o.refresh_token),
  };
}

/** Parse a JSON error body without throwing — `detail` may be truncated or empty. */
export function safeJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Turn one poll response into what the driver should do next.
 *
 * Classified on the `error` string first and the status only as a fallback:
 * one status carries three different meanings (403 is `slow_down`,
 * `access_denied` and plain forbidden) and `authorization_pending` arrives
 * with HTTP 428, which any generic client treats as a hard failure.
 */
export function classifyPoll(
  status: number,
  body: unknown,
  nowMs: number = Date.now(),
): PollOutcome {
  if (status === 200) {
    const tokens = parseTokenResponse(body, nowMs);
    return tokens ? { kind: 'token', tokens } : { kind: 'fatal', code: 'unparseable_token' };
  }
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const error = o ? str(o.error) : null;
  switch (error) {
    case 'authorization_pending':
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'slow_down' };
    case 'access_denied':
      return { kind: 'denied' };
    case 'expired_token':
      return { kind: 'expired' };
  }
  // No usable error string: 428 is only ever "still waiting", and 429 is the
  // same instruction as slow_down — neither is a reason to abandon a code the
  // user may be typing in right now.
  if (!error && status === 428) return { kind: 'pending' };
  if (!error && status === 429) return { kind: 'slow_down' };
  return { kind: 'fatal', code: error ?? `http_${status}` };
}

// ── Drive query building ─────────────────────────────────────────────────────

/**
 * Escape a value for a Drive `q=` string literal.
 *
 * Not cosmetic: folder and file names come from this app, but a user's Drive
 * can contain anything, and one unescaped apostrophe terminates the literal
 * and changes what the query means.
 */
export function driveQuoteValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Find one of our marked folders, optionally inside a known parent. */
export function folderQuery(role: FolderRole, parentId?: string): string {
  const parts = [
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    'trashed=false',
    `appProperties has { key='${ROLE_KEY}' and value='${driveQuoteValue(role)}' }`,
  ];
  if (parentId) parts.push(`'${driveQuoteValue(parentId)}' in parents`);
  return parts.join(' and ');
}

/** Everything inside a folder. `trashed=false` matters: a file the user threw
 *  away must not be offered for restore. */
export function childrenQuery(parentId: string): string {
  return `'${driveQuoteValue(parentId)}' in parents and trashed=false`;
}

// ── backup file metadata ─────────────────────────────────────────────────────

export const BACKUP_KIND = 'user-backup';
export const KIND_KEY = 'checklisterKind';

/** Prefix `backup.ts` gives every generated zip. Rotation only ever deletes
 *  files that still carry it, so renaming one in Drive pins it. */
export const BACKUP_NAME_PREFIX = 'checklister-backup-';

export type BackupMeta = {
  schemaVersion: number | null;
  appVersion: string | null;
  createdAtMs: number | null;
};

/**
 * Recover the timestamp from a backup filename.
 *
 * `backup.ts` names files from `toISOString()` with `:` and `.` replaced by
 * `-`, so `2026-09-17T08-30-00` is UTC and converts back exactly.
 */
export function backupTimestampFromName(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What a backup file says about itself, so the restore list can rule one out
 * BEFORE downloading it. Falls back to the filename because files uploaded by
 * an older build carry no `appProperties`.
 */
export function parseBackupMeta(
  appProperties: Record<string, string> | undefined,
  name: string,
): BackupMeta {
  const schema = Number(appProperties?.schemaVersion);
  const created = Number(appProperties?.createdAt);
  return {
    schemaVersion: Number.isInteger(schema) && schema > 0 ? schema : null,
    appVersion: str(appProperties?.appVersion),
    createdAtMs:
      Number.isFinite(created) && created > 0 ? created : backupTimestampFromName(name),
  };
}
