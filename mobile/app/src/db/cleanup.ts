/**
 * One-shot DB cleanup tasks run from `initDb()` after migrations.
 *
 * `enforceSingleActiveOnStartup` mops up leftover multi-active records from
 * before single-active-enforcement was added; `purgeOrphanRows` clears child
 * rows stranded by deletes that relied on an inert ON DELETE CASCADE.
 * Both idempotent — running on a clean DB is a no-op.
 */
import type { VersionKind } from './recordVersions';
import { File, Paths } from 'expo-file-system';
import { getDatasetDb } from './datasets';
import { getUserDb } from './init';
import { endActiveRecord, type ActiveKind } from './activeRecords';
import { CASCADE_ORPHANS, NULL_DANGLING, PROJECT_FK_TABLES } from './integrityRules';
import { DELETED_KEEP_MS } from '~/lib/recordVersionsCore';
import type { MergeKind } from '~/lib/mergeDocs';

/**
 * Enforce the single-active invariant at app start.
 *
 * Steps:
 *   1. Per-kind: keep the most recently started active record; force-end
 *      every other open session / plot / GLORIA survey.
 *   2. Cross-kind: if more than one kind is still active, keep the most
 *      recently started and end the rest.
 *
 * Run idempotently — second invocation on the same data ends nothing.
 */
export function enforceSingleActiveOnStartup(): void {
  const db = getUserDb();
  const now = Date.now();

  // ── Step 1a: keep latest active session ────────────────────────────────
  db.executeSync(
    `UPDATE sessions
        SET status = 'done', ended_at = COALESCE(ended_at, ?)
      WHERE status = 'active'
        AND id NOT IN (
          SELECT id FROM sessions
           WHERE status = 'active'
           ORDER BY started_at DESC
           LIMIT 1
        )`,
    [now],
  );

  // ── Step 1b: keep latest active plot ───────────────────────────────────
  db.executeSync(
    `UPDATE plot_surveys
        SET status = 'done',
            stop_ts = COALESCE(stop_ts, ?),
            updated_at = ?
      WHERE status = 'active'
        AND id NOT IN (
          SELECT id FROM plot_surveys
           WHERE status = 'active'
           ORDER BY COALESCE(start_ts, created_at) DESC
           LIMIT 1
        )`,
    [now, now],
  );

  // ── Step 1c: keep latest active GLORIA survey ──────────────────────────
  db.executeSync(
    `UPDATE gloria_surveys
        SET status = 'done',
            stop_ts = COALESCE(stop_ts, ?),
            updated_at = ?
      WHERE status = 'active'
        AND id NOT IN (
          SELECT id FROM gloria_surveys
           WHERE status = 'active'
           ORDER BY start_ts DESC
           LIMIT 1
        )`,
    [now, now],
  );

  // ── Step 1d: keep latest active MIREN survey ───────────────────────────
  db.executeSync(
    `UPDATE miren_surveys
        SET status = 'done',
            stop_ts = COALESCE(stop_ts, ?),
            updated_at = ?
      WHERE status = 'active'
        AND id NOT IN (
          SELECT id FROM miren_surveys
           WHERE status = 'active'
           ORDER BY start_ts DESC
           LIMIT 1
        )`,
    [now, now],
  );

  // ── Step 1e: keep latest active checklist / plot-style survey (censuses are exempt) ──
  db.executeSync(
    `UPDATE fw_surveys
        SET status = 'done',
            stop_ts = COALESCE(stop_ts, ?),
            updated_at = ?
      WHERE status = 'active' AND style <> 'individual'
        AND id NOT IN (
          SELECT id FROM fw_surveys
           WHERE status = 'active' AND style <> 'individual'
           ORDER BY start_ts DESC
           LIMIT 1
        )`,
    [now, now],
  );

  // ── Step 2: cross-kind exclusion — the most recently started survives ──
  const candidates: Array<{ kind: ActiveKind; id: number; ts: number }> = [];
  const sessRow = db.executeSync(
    `SELECT id, started_at AS ts FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
  ).rows?.[0] as { id: number; ts: number } | undefined;
  if (sessRow) candidates.push({ kind: 'session', ...sessRow });
  const plotRow = db.executeSync(
    `SELECT id, COALESCE(start_ts, created_at) AS ts FROM plot_surveys WHERE status = 'active' ORDER BY ts DESC LIMIT 1`,
  ).rows?.[0] as { id: number; ts: number } | undefined;
  if (plotRow) candidates.push({ kind: 'plot', ...plotRow });
  const gloriaRow = db.executeSync(
    `SELECT id, start_ts AS ts FROM gloria_surveys WHERE status = 'active' ORDER BY start_ts DESC LIMIT 1`,
  ).rows?.[0] as { id: number; ts: number } | undefined;
  if (gloriaRow) candidates.push({ kind: 'gloria', ...gloriaRow });
  const mirenRow = db.executeSync(
    `SELECT id, start_ts AS ts FROM miren_surveys WHERE status = 'active' ORDER BY start_ts DESC LIMIT 1`,
  ).rows?.[0] as { id: number; ts: number } | undefined;
  if (mirenRow) candidates.push({ kind: 'miren', ...mirenRow });
  const surveyRow = db.executeSync(
    `SELECT id, start_ts AS ts FROM fw_surveys WHERE status = 'active' AND style <> 'individual' ORDER BY start_ts DESC LIMIT 1`,
  ).rows?.[0] as { id: number; ts: number } | undefined;
  if (surveyRow) candidates.push({ kind: 'survey', ...surveyRow });

  if (candidates.length < 2) return;
  const keep = candidates.reduce((a, b) => (b.ts > a.ts ? b : a));
  for (const c of candidates) if (c !== keep) endActiveRecord(db, now, c.kind, c.id);
}

/** Prefix for the automatic pre-repair snapshots. */
const SAFETY_PREFIX = 'safety-backup-';

/**
 * Consistent snapshot of user.db, written next to it in the document dir.
 *
 * Uses `VACUUM INTO` rather than `createBackup()` for two reasons: that helper
 * lives in `~/lib/backup` which imports from `~/db` (circular from here), and
 * it base64s the whole DB into a JS string — far too heavy for the cold-start
 * path (see the field-use constraints: nothing expensive on startup).
 *
 * Returns the file name, or null if the snapshot could not be taken — a failed
 * snapshot must never block the repair, but the caller logs it.
 */
function createSafetySnapshot(): string | null {
  try {
    const name = `${SAFETY_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const dest = new File(Paths.document, name);
    if (dest.exists) dest.delete();
    // VACUUM INTO needs a plain filesystem path, not a file:// URI.
    getUserDb().executeSync('VACUUM INTO ?;', [dest.uri.replace(/^file:\/\//, '')]);
    return name;
  } catch (e) {
    if (__DEV__) console.warn('[cleanup] safety snapshot failed:', e);
    return null;
  }
}

/** Snapshots taken before an automatic repair, newest first. */
export function listSafetyBackups(): { name: string; uri: string; size: number }[] {
  try {
    return Paths.document
      .list()
      .filter((f): f is File => f instanceof File && f.name.startsWith(SAFETY_PREFIX))
      .map((f) => ({ name: f.name, uri: f.uri, size: f.size ?? 0 }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/**
 * Delete child rows whose parent is gone, and null out dangling references.
 *
 * Why these exist: in earlier builds every `ON DELETE CASCADE` in the schema
 * was inert, because `PRAGMA foreign_keys` was never set when the connection
 * opened and op-sqlite does not define `SQLITE_DEFAULT_FOREIGN_KEYS`, so SQLite
 * used its default of OFF. Deleting a trip / session / plot therefore left
 * every child row behind. `initDb()` now enables FK enforcement and the delete
 * helpers also remove children explicitly, but rows stranded by those earlier
 * builds are still sitting in existing users' databases.
 *
 * This pass deliberately runs while enforcement is still OFF: the rows it
 * repairs are the ones with dangling references, and SQLite validates FK on
 * every row it modifies, so with FK already on the repair would throw instead
 * of healing.
 *
 * The visible symptom this fixes: orphaned `collection_specimens` still count
 * toward `maxRecordNumberSeq()` and `isRecordNumberTaken()`, so collection
 * numbers kept climbing past specimens the user had already deleted, and the
 * number could not be reset back down.
 *
 * Idempotent: a second run finds nothing.
 */
/**
 * Record versions (v73): a record gone → its versions wait 30 days for
 * "recently deleted"; one back (recovered, re-imported) → not deleted. Run at
 * start-up and when the "recently deleted" list opens.
 */
export function sweepRecordVersions(now = Date.now()): void {
  const db = getUserDb();
  for (const [kind, sql] of Object.entries(VERSION_LIVE_UUIDS)) {
    db.executeSync(`UPDATE record_versions SET deleted_at = ? WHERE record_kind = ? AND deleted_at IS NULL AND record_uuid NOT IN (${sql})`, [now, kind]);
    db.executeSync(`UPDATE record_versions SET deleted_at = NULL WHERE record_kind = ? AND deleted_at IS NOT NULL AND record_uuid IN (${sql})`, [kind]);
  }
  db.executeSync(`DELETE FROM record_versions WHERE deleted_at IS NOT NULL AND deleted_at < ?`, [now - DELETED_KEEP_MS]);
}

/** Uuids of the records of each synced / versioned kind that still exist. */
const LIVE_UUIDS: Record<MergeKind, string> = {
  session: `SELECT uuid FROM sessions WHERE uuid IS NOT NULL`,
  plot: `SELECT uuid FROM plot_surveys`,
  gloria: `SELECT uuid FROM gloria_surveys`,
};

/** The same for team sync, which also links a tree census (its blocks below). */
const SYNC_LIVE_UUIDS: Record<MergeKind | 'survey', string> = {
  ...LIVE_UUIDS,
  survey: `SELECT uuid FROM fw_surveys`,
};

/** The same for record versions, which also keep a census per quadrat and
 *  whole (its quadrats come back with it when it is recovered). */
const VERSION_LIVE_UUIDS: Record<VersionKind, string> = {
  ...LIVE_UUIDS,
  survey_quadrat: `SELECT uuid FROM fw_survey_quadrats`,
  survey: `SELECT uuid FROM fw_surveys`,
};

export function purgeOrphanRows(): void {
  const db = getUserDb();

  // Declared ON DELETE CASCADE → the parent is gone, so the child must go too.
  const orphanDeletes: Array<readonly [string, string]> = [
    ...CASCADE_ORPHANS,
    // Rows keyed by (record_kind, record_uuid) whose record is no longer here:
    // team-merge ancestors (v57), team-sync links and queued sends (v58), the
    // merge log (v67). One rule per kind, from LIVE_UUIDS — a kind missing
    // there is a type error, never a rule that deletes its rows wholesale.
    ...(['sync_base', 'sync_links', 'merge_log', 'sync_queue'] as const).flatMap((table) =>
      Object.entries(SYNC_LIVE_UUIDS).map(
        ([kind, sql]) => [table, `record_kind = '${kind}' AND record_uuid NOT IN (${sql})`] as const,
      ),
    ),
    // A census's blocks are linked as '<census uuid>#<block>' (src/survey/censusSync.ts).
    ['sync_links', `record_kind = 'survey_block' AND substr(record_uuid, 1, instr(record_uuid, '#') - 1) NOT IN (SELECT uuid FROM fw_surveys)`],
    // Block claims per census and this phone's roll of tags per plot (settings keys).
    ['settings', `key LIKE 'fw\\_claims:%' ESCAPE '\\' AND substr(key, 11) NOT IN (SELECT uuid FROM fw_surveys)`],
    ['settings', `key LIKE 'fw\\_tag\\_roll:%' ESCAPE '\\' AND substr(key, 13) NOT IN (SELECT uuid FROM fw_frames)`],
    // Sync log (v70): only teams still on this device, newest 500 per team.
    // Entries of deleted records stay (their label says what they were).
    ['sync_log', `team_id NOT IN (SELECT team_id FROM sync_teams)`],
    ['sync_log', `id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY at DESC, id DESC) AS rn FROM sync_log) WHERE rn > 500)`],
  ];
  for (const [table, where] of orphanDeletes) {
    // Parent before child: FK is OFF here, so nothing cascades. Deleting
    // plot_subplots first means the subplot_layers sweep also catches the rows
    // whose subplot was orphaned by a deleted plot — in one pass instead of
    // on the next launch.
    db.executeSync(`DELETE FROM ${table} WHERE ${where};`);
  }

  sweepRecordVersions();

  // Declared ON DELETE SET NULL (or no FK at all) → keep the row, drop the dangling pointer.
  for (const [table, column, parent] of NULL_DANGLING) {
    db.executeSync(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM ${parent});`);
  }

  repairDanglingProjectIds(db);
}

/**
 * Reassign rows whose `project_id` points at a deleted project back to 0 (未分類).
 *
 * This is data RECOVERY, not cleanup: `listSites` and `listCollectionTrips`
 * inner-joined `projects`, so after a project was deleted its 樣點 and 採集記錄
 * vanished from the lists while the rows sat in the DB. Those queries are now
 * LEFT JOINs, and this pass repoints the orphaned rows so they land back under
 * 未分類 instead of showing a blank project.
 *
 * Takes an automatic snapshot first — this is the only pass that rewrites a
 * column on rows the user can see. Gated on there actually being something to
 * repair, so a healthy DB pays nothing at startup.
 */
function repairDanglingProjectIds(db: ReturnType<typeof getUserDb>): void {
  const where = `project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`;
  const counts = PROJECT_FK_TABLES.map((t) => {
    const res = db.executeSync(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where};`);
    return { table: t, n: Number((res.rows?.[0] as { n?: number })?.n ?? 0) };
  }).filter((c) => c.n > 0);

  if (counts.length === 0) return;

  const snapshot = createSafetySnapshot();
  if (__DEV__) {
    console.warn(
      `[cleanup] repairing dangling project_id: ` +
        counts.map((c) => `${c.table}=${c.n}`).join(', ') +
        ` (snapshot: ${snapshot ?? 'FAILED'})`,
    );
  }
  for (const { table } of counts) {
    db.executeSync(`UPDATE ${table} SET project_id = 0 WHERE ${where};`);
  }
}

/** Read-only integrity report. Counts only — never modifies anything. */
export type IntegrityReport = {
  duplicateOccurrenceIds: { table: string; groups: number; rows: number }[];
  orphanRows: { table: string; n: number }[];
  danglingProjectIds: { table: string; n: number }[];
  fkViolations: number;
  /** Records whose deliberately adopted name no longer checks out against the
   *  bundled checklist. Between the 2026-02 and 2026-04 TaiCOL releases 527
   *  non-accepted names moved to a different taxon and 3 name_ids disappeared,
   *  so this drifts on its own — and it is the user's call, not ours, whether
   *  a record should follow. Reported, never rewritten. */
  staleAdoptedNames: { table: string; n: number }[];
};

/**
 * Count the things a repair *could* fix, without fixing anything.
 *
 * Exists because duplicate `occurrence_id`s are deliberately left alone: they
 * are published DwC identifiers, so re-minting them would break any export
 * already handed over. The user needs the actual numbers to decide.
 */
const ADOPTION_TABLES = ['checklist_records', 'plot_species_records', 'collection_specimens', 'gloria_taxa'];

/**
 * Rows whose stored adopted name the checklist no longer confirms — the id is
 * gone, now spells something else, or has moved to another taxon.
 *
 * The record still displays the name the recorder chose (the stored string is
 * authoritative for display); this only surfaces that the checklist has since
 * disagreed, so the user can revisit those determinations if they want to.
 */
function countStaleAdoptions(table: string): number {
  const userDb = getUserDb();
  const res = userDb.executeSync(
    `SELECT taxon_id, used_name_id, used_scientific_name FROM ${table}
      WHERE used_name_id IS NOT NULL`,
  );
  const rows = (res.rows ?? []) as Array<{
    taxon_id?: string;
    used_name_id?: number;
    used_scientific_name?: string;
  }>;
  if (rows.length === 0) return 0;

  // 臺灣名錄模組不在時回 0 而不是 rows.length：模組還沒下載 / 被刪掉時，把每一
  // 筆採用名都報成 stale 是假警報，使用者會以為資料壞了。
  const namesDb = getDatasetDb('tw-taicol');
  if (!namesDb) return 0;

  const ids = rows.map((r) => r.used_name_id).filter((v): v is number => typeof v === 'number');
  const ph = ids.map(() => '?').join(',');
  const namesRes = namesDb.executeSync(
    `SELECT name_id, simple_name, taxon_id FROM taicol_names WHERE name_id IN (${ph})`,
    ids,
  );
  const live = new Map<number, { simple_name: string; taxon_id: string }>();
  for (const r of (namesRes.rows ?? []) as Array<Record<string, unknown>>) {
    live.set(Number(r.name_id), {
      simple_name: (r.simple_name as string) ?? '',
      taxon_id: (r.taxon_id as string) ?? '',
    });
  }

  let stale = 0;
  for (const r of rows) {
    const hit = r.used_name_id != null ? live.get(r.used_name_id) : undefined;
    if (!hit) {
      stale += 1; // the name_id is gone from this checklist release
      continue;
    }
    const stored = (r.used_scientific_name ?? '').trim();
    if (stored && hit.simple_name !== stored) stale += 1; // renamed under us
    else if (hit.taxon_id && r.taxon_id && hit.taxon_id !== r.taxon_id) stale += 1; // moved taxon
  }
  return stale;
}

export function checkIntegrity(): IntegrityReport {
  const db = getUserDb();
  const num = (sql: string): number => {
    const r = db.executeSync(sql);
    return Number((r.rows?.[0] as { n?: number })?.n ?? 0);
  };

  const OCC_TABLES = ['checklist_records', 'plot_species_records', 'collection_specimens', 'gloria_unit_species'];
  const duplicateOccurrenceIds = OCC_TABLES.map((table) => {
    const dup = `SELECT occurrence_id, COUNT(*) AS c FROM ${table}
                 WHERE occurrence_id IS NOT NULL AND occurrence_id != ''
                 GROUP BY occurrence_id HAVING c > 1`;
    return {
      table,
      groups: num(`SELECT COUNT(*) AS n FROM (${dup})`),
      rows: num(`SELECT COALESCE(SUM(c), 0) AS n FROM (${dup})`),
    };
  }).filter((d) => d.groups > 0);

  // The adopted name is checked against the checklist, which lives in the OTHER
  // database handle — so this is counted per table in JS rather than joined.
  const staleAdoptedNames = ADOPTION_TABLES.map((table) => ({
    table,
    n: countStaleAdoptions(table),
  })).filter((a) => a.n > 0);

  const orphanRows = CASCADE_ORPHANS.map(([table, where]) => ({ table, n: num(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`) }))
    .filter((o) => o.n > 0);

  const danglingProjectIds = PROJECT_FK_TABLES.map((table) => ({
    table,
    n: num(
      `SELECT COUNT(*) AS n FROM ${table}
        WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`,
    ),
  })).filter((d) => d.n > 0);

  return {
    duplicateOccurrenceIds,
    orphanRows,
    danglingProjectIds,
    staleAdoptedNames,
    fkViolations: db.executeSync('PRAGMA foreign_key_check;').rows?.length ?? 0,
  };
}
