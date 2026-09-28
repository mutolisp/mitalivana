/**
 * Team sync failures in the user's language. The codes come from the relay
 * (`{"error": code, "limit": n}`) or from teamSync.ts itself.
 */
import i18n from '~/i18n';
import { errText } from './errText';
import { formatBytes } from './exportSize';
import { TeamSyncError } from './teamSync';

const BYTE_LIMITS = new Set(['teamQuota', 'deviceQuota', 'objectTooLarge', 'mediaQuota']);
const KNOWN = new Set([
  'offline', 'notARelay', 'incompatible', 'noTeam', 'noSecret', 'unauthorized', 'exists', 'createRate', 'teamQuota',
  'teamFull', 'deviceQuota', 'deviceRate', 'objectTooLarge', 'serverFull', 'corrupt', 'noRecord', 'server', 'sameServer',
  'mediaDisabled', 'mediaMismatch', 'mediaQuota', 'mediaIncomplete', 'ownerOnly',
]);

export function teamSyncErrorText(e: unknown): string {
  if (!(e instanceof TeamSyncError)) return errText(e);
  if (!KNOWN.has(e.code)) return i18n.t('teamSync.err.unknown', { detail: e.message });
  const limit =
    e.limit == null ? '' : BYTE_LIMITS.has(e.code) && e.limit > 1000 ? formatBytes(e.limit) : String(e.limit);
  return i18n.t(`teamSync.err.${e.code}`, { limit, detail: e.message });
}
