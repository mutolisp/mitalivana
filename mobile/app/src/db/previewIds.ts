/**
 * A builder preview's ids (previewDb.ts): every id in its scratch file is at
 * least PREVIEW_ID_BASE, which is how a call knows where it belongs.
 *
 * Pure: check:survey-core runs it under Node.
 */

/** Far above any id a phone's user.db reaches, well below 2^53. */
export const PREVIEW_ID_BASE = 1_000_000_000_000;

export const isPreviewId = (id: number | null | undefined): boolean => id != null && id >= PREVIEW_ID_BASE;

type SeqDb = { executeSync(sql: string, params?: (string | number)[]): { rows?: unknown[] } };

/** Raise every AUTOINCREMENT table of a freshly migrated scratch file so its ids are preview ids. */
export function raisePreviewIds(db: SeqDb): void {
  const tables = (db.executeSync(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'`).rows ?? []) as { name: string }[];
  for (const { name } of tables) {
    db.executeSync(`DELETE FROM sqlite_sequence WHERE name = ?`, [name]);
    db.executeSync(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, [name, PREVIEW_ID_BASE]);
  }
}
