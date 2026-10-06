/**
 * Casual mode's data (docs/planned/UI_modes_impl.md M4): observations kept
 * until they have a name (待鑑定, table pending_observations, v92), and the
 * one quick checklist per day that named observations go into (每日名錄, Q3).
 *
 * Daily checklists are ordinary sessions. Which session is which day's is
 * kept in the setting `casual_daily`, a JSON map from the local date
 * (YYYY-MM-DD) to the session id, so the sessions table needs no column and
 * a daily checklist exports, syncs and opens like any other. A day's entry
 * is dropped once its session is gone.
 *
 *   - Today's is created by the day's first observation, and reopened if it
 *     was ended (another record took the active slot, for instance).
 *   - An earlier day's (an observation identified days later) is created
 *     ended, spanning the observations it receives.
 *   - At the next day's first use, and at app start, an earlier day's that is
 *     still open is ended at its last record's time — unless it was reopened
 *     on a later day, which is the user editing it on purpose.
 *
 * Identifying a pending observation writes a checklist record into the
 * daily checklist of the day it was observed, moves everything it carries
 * (photos, recordings, time, place, note, count, flowering state, wild or
 * not, iNaturalist state) and deletes the pending row, all or nothing. Its
 * uuid becomes the record's occurrenceID, so an observation uploaded to
 * iNaturalist before it had a name stays one observation there.
 *
 * Pure (a db, a clock and uuids are passed in): scripts/check-pending.mjs runs
 * it on node:sqlite. src/db/pendingObservations.ts binds it to the app.
 */
import type { Scalar } from '@op-engineering/op-sqlite';

import { closeActiveRecords } from './activeRecords';

export type PendingDb = {
  executeSync: (sql: string, params?: Scalar[]) => { rows?: unknown[]; insertId?: number; rowsAffected?: number };
};
export type PendingCtx = { db: PendingDb; now: () => number; uuid: () => string };

/** What the user picks before saving one: the group it belongs to. Latin, as taicol `kingdom`. */
export type PendingKingdom = 'Animalia' | 'Plantae' | 'Fungi';
export const PENDING_KINGDOMS: readonly PendingKingdom[] = ['Plantae', 'Animalia', 'Fungi'];

export type PendingObservation = {
  id: number;
  uuid: string;
  kingdom: PendingKingdom;
  observed_at: number;
  created_at: number;
  updated_at: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  elevation_m: number | null;
  /** 'gnss' | 'manual' | null, as checklist_records. */
  elevation_source: string | null;
  /** JSON arrays of app file URIs, as checklist_records. */
  photo_paths: string | null;
  audio_paths: string | null;
  note: string | null;
  /** Individuals; null when not counted. */
  quantity: string | null;
  /** JSON array, as checklist_records. */
  reproductive_condition: string | null;
  degree_of_establishment: string | null;
  inat_observation_id: number | null;
  inat_media_done: number;
  inat_uploaded_at: number | null;
  inat_sync_hash: string | null;
};

export type PendingInput = {
  kingdom: PendingKingdom;
  /** When it was seen; defaults to now (a photo from the library: when it was taken). */
  observed_at?: number;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  elevation_m?: number | null;
  elevation_source?: string | null;
  photo_paths?: string | null;
  audio_paths?: string | null;
  note?: string | null;
  quantity?: string | null;
  reproductive_condition?: string | null;
  degree_of_establishment?: string | null;
};

/** Fields an edit may change. The kingdom too: a first guess can be wrong. */
export type PendingPatch = Partial<Omit<PendingInput, 'observed_at'>> & { observed_at?: number };

const PATCHABLE = [
  'kingdom',
  'observed_at',
  'lat',
  'lng',
  'accuracy',
  'elevation_m',
  'elevation_source',
  'photo_paths',
  'audio_paths',
  'note',
  'quantity',
  'reproductive_condition',
  'degree_of_establishment',
] as const;

const rowsOf = <T>(res: { rows?: unknown[] }) => (res.rows ?? []) as T[];

export function createPending(ctx: PendingCtx, input: PendingInput): number {
  const now = ctx.now();
  const res = ctx.db.executeSync(
    `INSERT INTO pending_observations
       (uuid, kingdom, observed_at, created_at, updated_at, lat, lng, accuracy, elevation_m, elevation_source,
        photo_paths, audio_paths, note, quantity, reproductive_condition, degree_of_establishment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.uuid(),
      input.kingdom,
      input.observed_at ?? now,
      now,
      now,
      input.lat ?? null,
      input.lng ?? null,
      input.accuracy ?? null,
      input.elevation_m ?? null,
      input.elevation_source ?? null,
      input.photo_paths ?? null,
      input.audio_paths ?? null,
      input.note ?? null,
      input.quantity ?? null,
      input.reproductive_condition ?? null,
      input.degree_of_establishment ?? null,
    ],
  );
  return res.insertId ?? 0;
}

export function updatePending(ctx: PendingCtx, id: number, patch: PendingPatch): void {
  const sets: string[] = [];
  const args: Scalar[] = [];
  for (const k of PATCHABLE) {
    if (!(k in patch)) continue;
    sets.push(`${k} = ?`);
    args.push((patch[k] ?? null) as Scalar);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  args.push(ctx.now(), id);
  ctx.db.executeSync(`UPDATE pending_observations SET ${sets.join(', ')} WHERE id = ?`, args);
}

export function getPending(ctx: PendingCtx, id: number): PendingObservation | null {
  return rowsOf<PendingObservation>(ctx.db.executeSync(`SELECT * FROM pending_observations WHERE id = ?`, [id]))[0] ?? null;
}

/** Newest first. */
export function listPending(ctx: PendingCtx): PendingObservation[] {
  return rowsOf<PendingObservation>(ctx.db.executeSync(`SELECT * FROM pending_observations ORDER BY observed_at DESC, id DESC`));
}

/** The row only: its files are left to the storage page, as for any deleted record. */
export function deletePending(ctx: PendingCtx, id: number): void {
  ctx.db.executeSync(`DELETE FROM pending_observations WHERE id = ?`, [id]);
}

// ── Daily checklists ───────────────────────────────────────────────────────

export const DAILY_SETTING = 'casual_daily';
export type DailyMap = Record<string, number>;

const pad = (n: number) => String(n).padStart(2, '0');
/** The local date of `ts`, YYYY-MM-DD: which day's checklist it belongs to. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDailyMap(raw: string | null | undefined): DailyMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DailyMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The map, without days whose session no longer exists. */
export function readDailyMap(ctx: PendingCtx): DailyMap {
  const raw = (rowsOf<{ value: string | null }>(ctx.db.executeSync(`SELECT value FROM settings WHERE key = ?`, [DAILY_SETTING]))[0]
    ?.value ?? null) as string | null;
  const map = parseDailyMap(raw);
  const ids = Object.values(map);
  if (ids.length === 0) return map;
  const alive = new Set(
    rowsOf<{ id: number }>(ctx.db.executeSync(`SELECT id FROM sessions WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)).map((r) => r.id),
  );
  const kept: DailyMap = {};
  for (const [k, v] of Object.entries(map)) if (alive.has(v)) kept[k] = v;
  return kept;
}

function writeDailyMap(ctx: PendingCtx, map: DailyMap): void {
  ctx.db.executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [DAILY_SETTING, JSON.stringify(map)]);
}

export function isDailySession(ctx: PendingCtx, sessionId: number): boolean {
  return Object.values(readDailyMap(ctx)).includes(sessionId);
}

/**
 * End earlier days' daily checklists that are still open, each at its last
 * record's time (its start when it has none). One reopened on a later day is
 * left alone. Returns the ids ended.
 */
export function closeStaleDailySessions(ctx: PendingCtx): number[] {
  const today = dayKey(ctx.now());
  const ended: number[] = [];
  for (const [day, id] of Object.entries(readDailyMap(ctx))) {
    if (day >= today) continue;
    const s = rowsOf<{ status: string; started_at: number; resumed_at: number | null }>(
      ctx.db.executeSync(`SELECT status, started_at, resumed_at FROM sessions WHERE id = ?`, [id]),
    )[0];
    if (!s || s.status !== 'active') continue;
    if (s.resumed_at != null && dayKey(s.resumed_at) !== day) continue;
    const last = rowsOf<{ ts: number | null }>(
      ctx.db.executeSync(`SELECT MAX(observed_at) AS ts FROM checklist_records WHERE session_id = ?`, [id]),
    )[0]?.ts;
    ctx.db.executeSync(`UPDATE sessions SET status = 'done', ended_at = ? WHERE id = ?`, [last ?? s.started_at, id]);
    ended.push(id);
  }
  return ended;
}

export type DailyOptions = {
  /** The checklist's name for that day, e.g. 「10月5日 觀察」. */
  name: string;
  /** DwC recordedBy for a new checklist. */
  recordedBy: string | null;
  /**
   * Today's checklist becomes the active record (reopened, or created active;
   * other open records are ended, as createSession does): what recording a new
   * observation needs, after the UI's single-active prompt. Without it,
   * today's is used as it is, and created active only when nothing else is
   * open: identifying never ends someone's plot.
   */
  activate?: boolean;
};

/** Whether any record is open (the kinds closeActiveRecords ends). */
function anyActive(ctx: PendingCtx): boolean {
  const n = rowsOf<{ n: number }>(
    ctx.db.executeSync(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE status = 'active')
            + (SELECT COUNT(*) FROM plot_surveys WHERE status = 'active')
            + (SELECT COUNT(*) FROM gloria_surveys WHERE status = 'active')
            + (SELECT COUNT(*) FROM miren_surveys WHERE status = 'active')
            + (SELECT COUNT(*) FROM fw_surveys WHERE status = 'active' AND style <> 'individual') AS n`,
    ),
  )[0]?.n;
  return (n ?? 0) > 0;
}

/**
 * The daily checklist of the day `ts` falls on, created if there is none.
 * An earlier day's is never active; today's, see `activate`.
 */
export function dailySessionFor(ctx: PendingCtx, ts: number, opts: DailyOptions): number {
  const now = ctx.now();
  const day = dayKey(ts);
  const today = dayKey(now);
  closeStaleDailySessions(ctx);
  const map = readDailyMap(ctx);
  const existing = map[day];

  if (day === today && (opts.activate || existing == null)) {
    if (existing != null) {
      const status = rowsOf<{ status: string }>(ctx.db.executeSync(`SELECT status FROM sessions WHERE id = ?`, [existing]))[0]?.status;
      if (status !== 'active') {
        closeActiveRecords(ctx.db, now, { kind: 'session', id: existing });
        ctx.db.executeSync(`UPDATE sessions SET status = 'active', resumed_at = ? WHERE id = ?`, [now, existing]);
      }
      return existing;
    }
    if (opts.activate || !anyActive(ctx)) {
      closeActiveRecords(ctx.db, now);
      const id =
        ctx.db.executeSync(
          `INSERT INTO sessions (uuid, name, type, project_id, started_at, recorded_by, status) VALUES (?, ?, 'checklist', 0, ?, ?, 'active')`,
          [ctx.uuid(), opts.name, now, opts.recordedBy],
        ).insertId ?? 0;
      writeDailyMap(ctx, { ...map, [day]: id });
      return id;
    }
  }
  // Another day, or today while something else is open: an ended checklist
  // spanning what it holds. An open one (today's) keeps its times.
  if (existing != null) {
    ctx.db.executeSync(
      `UPDATE sessions SET started_at = MIN(started_at, ?), ended_at = MAX(COALESCE(ended_at, ?), ?)
        WHERE id = ? AND status = 'done'`,
      [ts, ts, ts, existing],
    );
    return existing;
  }
  const id =
    ctx.db.executeSync(
      `INSERT INTO sessions (uuid, name, type, project_id, started_at, ended_at, recorded_by, status) VALUES (?, ?, 'checklist', 0, ?, ?, ?, 'done')`,
      [ctx.uuid(), opts.name, ts, ts, opts.recordedBy],
    ).insertId ?? 0;
  writeDailyMap(ctx, { ...map, [day]: id });
  return id;
}

// ── Identifying ────────────────────────────────────────────────────────────

/** What a checklist record is created from: the app passes addRecord (records.ts). */
export type NewRecord = {
  session_id: number;
  taxon_id: string;
  observed_at: number;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  photo_paths: string | null;
  organism_quantity: string | null;
  organism_quantity_type: string | null;
};

export type IdentifyDeps<A> = {
  insertRecord: (input: NewRecord & { adopted?: A | null }) => number;
  /** The daily checklist's name for the day of `ts`. */
  dailyName: (ts: number) => string;
  recordedBy: string | null;
  adopted?: A | null;
};

/**
 * Name pending observation `id` as `taxonId`: a record in the daily checklist
 * of the day it was observed, carrying everything the pending row had; the
 * row is deleted. All or nothing (a savepoint, so it also nests inside a
 * caller's transaction).
 */
export function identifyPending<A>(
  ctx: PendingCtx,
  id: number,
  taxonId: string,
  deps: IdentifyDeps<A>,
): { sessionId: number; recordId: number } {
  const p = getPending(ctx, id);
  if (!p) throw new Error(`identifyPending: no pending observation ${id}`);
  ctx.db.executeSync('SAVEPOINT identify_pending');
  try {
    const sessionId = dailySessionFor(ctx, p.observed_at, { name: deps.dailyName(p.observed_at), recordedBy: deps.recordedBy });
    const recordId = deps.insertRecord({
      session_id: sessionId,
      taxon_id: taxonId,
      observed_at: p.observed_at,
      notes: p.note,
      lat: p.lat,
      lng: p.lng,
      accuracy: p.accuracy,
      photo_paths: p.photo_paths,
      organism_quantity: p.quantity,
      organism_quantity_type: p.quantity != null ? 'individuals' : null,
      adopted: deps.adopted ?? null,
    });
    if (!recordId) throw new Error('identifyPending: record not created');
    ctx.db.executeSync(
      `UPDATE checklist_records
          SET occurrence_id = ?, audio_paths = ?, elevation_m = ?, elevation_source = ?,
              reproductive_condition = ?, degree_of_establishment = ?,
              inat_observation_id = ?, inat_media_done = ?, inat_uploaded_at = ?, inat_sync_hash = ?
        WHERE id = ?`,
      [
        p.uuid,
        p.audio_paths,
        p.elevation_m,
        p.elevation_source,
        p.reproductive_condition,
        p.degree_of_establishment,
        p.inat_observation_id,
        p.inat_media_done,
        p.inat_uploaded_at,
        p.inat_sync_hash,
        recordId,
      ],
    );
    ctx.db.executeSync(`DELETE FROM pending_observations WHERE id = ?`, [id]);
    ctx.db.executeSync('RELEASE identify_pending');
    return { sessionId, recordId };
  } catch (e) {
    ctx.db.executeSync('ROLLBACK TO identify_pending');
    ctx.db.executeSync('RELEASE identify_pending');
    throw e;
  }
}
