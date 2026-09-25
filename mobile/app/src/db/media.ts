/**
 * Which app-owned photo / audio files some record still points to. Read from
 * every column in MEDIA_COLUMNS (src/lib/mediaNames), by file NAME — stored
 * absolute paths go stale on reinstall (appFiles.ts).
 */
import { MEDIA_COLUMNS, mediaNamesIn } from '~/lib/mediaNames';
import { getUserDb } from './init';

export function referencedMediaNames(): Set<string> {
  const db = getUserDb();
  const names = new Set<string>();
  for (const [table, column] of MEDIA_COLUMNS) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = (db.executeSync(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).rows ??
        []) as Array<Record<string, unknown>>;
    } catch {
      // A table an older schema does not have yet: nothing referenced there.
      continue;
    }
    for (const r of rows) for (const n of mediaNamesIn(String(r.v))) names.add(n);
  }
  return names;
}
