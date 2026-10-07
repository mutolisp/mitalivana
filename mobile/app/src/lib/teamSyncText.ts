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

/** A tree census's sync refusals (src/survey/db/censusSyncCore.ts CensusSyncError), by code. */
const CENSUS = new Set(['previous_missing', 'frame_code_taken', 'series_code_taken', 'block_size_differs', 'template_differs', 'unreadable', 'undecided']);

export function teamSyncErrorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (!(e instanceof TeamSyncError)) return typeof code === 'string' && CENSUS.has(code) ? i18n.t(`teamSync.err.${code}`) : errText(e);
  if (!KNOWN.has(e.code)) return i18n.t('teamSync.err.unknown', { detail: e.message });
  const limit =
    e.limit == null ? '' : BYTE_LIMITS.has(e.code) && e.limit > 1000 ? formatBytes(e.limit) : String(e.limit);
  return i18n.t(`teamSync.err.${e.code}`, { limit, detail: e.message });
}

/** What a team sync that went on past records it could not do says about them; null when there were none (code review M1). */
export function syncFailuresText(failed: readonly { error: unknown }[]): string | null {
  if (!failed.length) return null;
  return i18n.t('teamSync.someFailed', { count: failed.length, reason: teamSyncErrorText(failed[0].error) });
}
