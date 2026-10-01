/**
 * This phone's roll of tags for a plot (Modular_survey.md §9, 1C-b, decided
 * 2026-10-01): in a team each group carries its own numbered tags, so a new
 * tree takes the next free number from the roll's first one instead of its
 * tag block's. Kept on this phone only (settings `fw_tag_roll:<plot uuid>`),
 * never synced.
 */
import { getUserDb } from '~/db/init';

const key = (frameUuid: string) => `fw_tag_roll:${frameUuid}`;

export function getTagRollStart(frameUuid: string): number | null {
  const v = Number((getUserDb().executeSync(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [key(frameUuid)]).rows?.[0] as { value?: string } | undefined)?.value);
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function setTagRollStart(frameUuid: string, start: number | null): void {
  if (start == null) getUserDb().executeSync(`DELETE FROM settings WHERE key = ?`, [key(frameUuid)]);
  else getUserDb().executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key(frameUuid), String(start)]);
}
