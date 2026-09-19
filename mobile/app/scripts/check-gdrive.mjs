/**
 * Fixture check for the Google Drive pure module (src/lib/googleDevice.ts).
 * No network, no Expo — same contract as check-inat-payload.mjs.
 * Run: npm run check:gdrive
 */
import {
  ACCESS_TOKEN_MARGIN_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DRIVE_FOLDER_MIME,
  accessTokenUsable,
  backupTimestampFromName,
  childrenQuery,
  classifyPoll,
  driveQuoteValue,
  folderQuery,
  parseBackupMeta,
  parseDeviceCode,
  parseTokenResponse,
  safeJsonObject,
} from '../src/lib/googleDevice.ts';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};
const ok = (label, cond) => {
  if (!cond) fail(label);
};

const NOW = Date.UTC(2026, 8, 17, 8, 0, 0);

// ── device code response ────────────────────────────────────────────────────
{
  // What Google actually returns: `verification_url`.
  const google = parseDeviceCode(
    {
      device_code: 'AH-1Ng',
      user_code: 'BDWC-ZHVL',
      verification_url: 'https://www.google.com/device',
      expires_in: 1800,
      interval: 5,
    },
    NOW,
  );
  eq('google device_code', google?.deviceCode, 'AH-1Ng');
  eq('google user_code', google?.userCode, 'BDWC-ZHVL');
  eq('google verification url', google?.verificationUrl, 'https://www.google.com/device');
  eq('google expiry', google?.expiresAtMs, NOW + 1800_000);
  eq('google interval', google?.intervalMs, 5000);

  // RFC 8628 spells it `verification_uri`. One letter apart, and reading the
  // wrong one shows a blank address instead of failing, so both are accepted.
  const rfc = parseDeviceCode(
    {
      device_code: 'd',
      user_code: 'u',
      verification_uri: 'https://example.test/device',
      expires_in: 600,
    },
    NOW,
  );
  eq('rfc verification uri', rfc?.verificationUrl, 'https://example.test/device');
  eq('missing interval falls back', rfc?.intervalMs, DEFAULT_POLL_INTERVAL_MS);

  // A too-eager interval must not be honoured below Google's documented floor.
  const fast = parseDeviceCode(
    { device_code: 'd', user_code: 'u', verification_url: 'x', interval: 1 },
    NOW,
  );
  eq('interval floored', fast?.intervalMs, DEFAULT_POLL_INTERVAL_MS);

  eq('no device_code', parseDeviceCode({ user_code: 'u', verification_url: 'x' }, NOW), null);
  eq('no user_code', parseDeviceCode({ device_code: 'd', verification_url: 'x' }, NOW), null);
  eq('no url at all', parseDeviceCode({ device_code: 'd', user_code: 'u' }, NOW), null);
  eq('not an object', parseDeviceCode('nope', NOW), null);
  eq('null', parseDeviceCode(null, NOW), null);
}

// ── token response ──────────────────────────────────────────────────────────
{
  const t = parseTokenResponse(
    { access_token: 'at', expires_in: 3599, refresh_token: 'rt', token_type: 'Bearer' },
    NOW,
  );
  eq('access token', t?.accessToken, 'at');
  eq('expiry', t?.expiresAtMs, NOW + 3599_000);
  eq('refresh token', t?.refreshToken, 'rt');

  // A refresh response carries no refresh_token; that must not look like failure.
  const r = parseTokenResponse({ access_token: 'at2', expires_in: 3600 }, NOW);
  eq('refresh response parses', r?.accessToken, 'at2');
  eq('refresh response has no refresh token', r?.refreshToken, null);

  eq('no access token', parseTokenResponse({ refresh_token: 'rt' }, NOW), null);
}

// ── poll classification ─────────────────────────────────────────────────────
{
  // authorization_pending arrives as HTTP 428, not 400. A generic client reads
  // that as a hard failure and abandons a code the user is still typing in.
  eq(
    'pending is 428',
    classifyPoll(428, { error: 'authorization_pending' }, NOW).kind,
    'pending',
  );
  // Some deployments answer 400 with the same error string; go by the string.
  eq(
    'pending on 400 too',
    classifyPoll(400, { error: 'authorization_pending' }, NOW).kind,
    'pending',
  );
  // 403 means three different things — only the body tells them apart.
  eq('slow_down', classifyPoll(403, { error: 'slow_down' }, NOW).kind, 'slow_down');
  eq('denied', classifyPoll(403, { error: 'access_denied' }, NOW).kind, 'denied');
  eq('expired', classifyPoll(400, { error: 'expired_token' }, NOW).kind, 'expired');

  const fatal = classifyPoll(400, { error: 'invalid_grant' }, NOW);
  eq('invalid_grant is fatal', fatal.kind, 'fatal');
  eq('fatal carries the code', fatal.code, 'invalid_grant');

  const success = classifyPoll(200, { access_token: 'at', expires_in: 3600 }, NOW);
  eq('success', success.kind, 'token');
  eq('success token', success.tokens?.accessToken, 'at');
  eq('200 with junk body', classifyPoll(200, { nope: 1 }, NOW).kind, 'fatal');

  // No parseable body: fall back to the status alone.
  eq('bare 428', classifyPoll(428, null, NOW).kind, 'pending');
  eq('bare 429', classifyPoll(429, null, NOW).kind, 'slow_down');
  eq('bare 500', classifyPoll(500, null, NOW).kind, 'fatal');
  eq('bare 500 code', classifyPoll(500, null, NOW).code, 'http_500');

  eq('safeJsonObject parses', safeJsonObject('{"error":"slow_down"}'), { error: 'slow_down' });
  eq('safeJsonObject truncated', safeJsonObject('{"error":"slow_d'), null);
  eq('safeJsonObject empty', safeJsonObject(''), null);
  eq('safeJsonObject undefined', safeJsonObject(undefined), null);
  eq('safeJsonObject non-object', safeJsonObject('42'), null);
}

// ── access token margin ─────────────────────────────────────────────────────
{
  ok('fresh token usable', accessTokenUsable(NOW + 3600_000, NOW));
  ok('expired token unusable', !accessTokenUsable(NOW - 1, NOW));
  ok(
    'inside the margin is unusable',
    !accessTokenUsable(NOW + ACCESS_TOKEN_MARGIN_MS - 1, NOW),
  );
  ok('exactly at the margin is unusable', !accessTokenUsable(NOW + ACCESS_TOKEN_MARGIN_MS, NOW));
  ok('just past the margin is usable', accessTokenUsable(NOW + ACCESS_TOKEN_MARGIN_MS + 1, NOW));
}

// ── Drive query building ────────────────────────────────────────────────────
{
  // The real injection shape: one apostrophe ends the literal and changes what
  // the query means.
  eq('apostrophe escaped', driveQuoteValue("O'Brien"), "O\\'Brien");
  eq('backslash escaped first', driveQuoteValue('a\\b'), 'a\\\\b');
  eq('both', driveQuoteValue("a\\'b"), "a\\\\\\'b");
  eq('plain value untouched', driveQuoteValue('backups'), 'backups');

  eq(
    'root folder query',
    folderQuery('root'),
    `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and appProperties has { key='checklisterRole' and value='root' }`,
  );
  eq(
    'child folder query',
    folderQuery('backups', '1AbC'),
    `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and appProperties has { key='checklisterRole' and value='backups' } and '1AbC' in parents`,
  );
  eq('children query', childrenQuery('1AbC'), `'1AbC' in parents and trashed=false`);
}

// ── backup metadata ─────────────────────────────────────────────────────────
{
  eq(
    'timestamp from filename',
    backupTimestampFromName('checklister-backup-2026-09-17T08-30-00.zip'),
    Date.UTC(2026, 8, 17, 8, 30, 0),
  );
  eq('no timestamp in name', backupTimestampFromName('random.zip'), null);

  const full = parseBackupMeta(
    { schemaVersion: '34', appVersion: '0.5.0', createdAt: '1789000000000' },
    'checklister-backup-2026-09-17T08-30-00.zip',
  );
  eq('schema from appProperties', full.schemaVersion, 34);
  eq('appVersion', full.appVersion, '0.5.0');
  eq('createdAt from appProperties', full.createdAtMs, 1789000000000);

  // Files uploaded by an older build carry no appProperties at all.
  const legacy = parseBackupMeta(undefined, 'checklister-backup-2026-09-17T08-30-00.zip');
  eq('legacy schema unknown', legacy.schemaVersion, null);
  eq('legacy appVersion unknown', legacy.appVersion, null);
  eq('legacy createdAt from name', legacy.createdAtMs, Date.UTC(2026, 8, 17, 8, 30, 0));

  const junk = parseBackupMeta({ schemaVersion: 'abc', createdAt: 'nope' }, 'x.zip');
  eq('junk schema rejected', junk.schemaVersion, null);
  eq('junk createdAt rejected', junk.createdAtMs, null);
}

if (failures > 0) {
  console.error(`\ncheck-gdrive: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-gdrive: ok');
