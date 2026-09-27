/**
 * Temperature logger visits and loggers (migration v65; model/loggers.ts).
 * A visit belongs to the summit; its monitoring cycle is worked out from the
 * date (cycleOf), never stored, so back-filled visits and moved survey dates
 * stay right.
 */
import { defaultSurveyorString } from '~/db/surveyors';
import type { Scalar } from '@op-engineering/op-sqlite';
import { getUserDb, withTransaction } from '~/db/init';
import { generateUuid } from '~/db/uuid';
import { onDay } from './model/quadratTimes';
import { carryForward, cycleOf, missingCarry, nextLoggerLabel, utcDiffHours, type CarrySeed, type LoggerRole } from './model/loggers';
import type { Direction } from './model/units';

export type LoggerVisit = {
  id: number;
  uuid: string;
  summit_id: number;
  survey_id: number | null;
  visit_ts: number;
  researchers: string | null;
  comments: string | null;
  /** JSON FileRef[] — Form 4 scans (photos or PDF). */
  form4_files: string | null;
  /** 1 = marked done; NULL = open. */
  locked: number | null;
  created_at: number;
  updated_at: number;
};

export type GloriaLogger = {
  id: number;
  uuid: string;
  visit_id: number;
  role: LoggerRole;
  direction: Direction;
  quadrat: string;
  label: string | null;
  serial: string | null;
  logger_type: string | null;
  start_ts: number | null;
  stop_ts: number | null;
  utc_diff_h: number | null;
  dist11_m: number | null;
  dist31_m: number | null;
  photo_open: number | null;
  photo_closed: number | null;
  photo_open_uri: string | null;
  photo_closed_uri: string | null;
  /** JSON LoggerFlag[]. */
  flags: string | null;
  researcher: string | null;
  comments: string | null;
  /** JSON FileRef[] — the logger's data exports. */
  data_files: string | null;
  prev_uuid: string | null;
  sort_order: number | null;
  updated_at: number;
};

export type VisitPatch = Partial<Pick<LoggerVisit, 'visit_ts' | 'researchers' | 'comments' | 'form4_files' | 'locked'>>;
export type LoggerPatch = Partial<Omit<GloriaLogger, 'id' | 'uuid' | 'visit_id' | 'updated_at'>>;

const rows = <T>(res: { rows?: unknown[] }): T[] => (res.rows ?? []) as T[];
const SAFE_COL = /^[a-z0-9_]+$/;

function patchRow(table: string, id: number, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  for (const k of keys) if (!SAFE_COL.test(k)) throw new Error(`bad column ${k}`);
  getUserDb().executeSync(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => patch[k] as Scalar),
    Date.now(),
    id,
  ]);
}

const touchVisit = (visitId: number) =>
  getUserDb().executeSync(`UPDATE gloria_logger_visits SET updated_at = ? WHERE id = ?`, [Date.now(), visitId]);

/** The summit's surveys, for working out cycles. */
export function summitCycles(summitId: number): Array<{ id: number; mocy: number; start_ts: number }> {
  return rows(getUserDb().executeSync(`SELECT id, mocy, start_ts FROM gloria_surveys WHERE summit_id = ? ORDER BY start_ts`, [summitId]));
}

export function listVisits(summitId: number): LoggerVisit[] {
  return rows<LoggerVisit>(
    getUserDb().executeSync(`SELECT * FROM gloria_logger_visits WHERE summit_id = ? ORDER BY visit_ts, id`, [summitId]),
  );
}

/** The visits of one survey's cycle (every visit from its start until the next survey's). */
export function visitsOfSurvey(surveyId: number): LoggerVisit[] {
  const sv = rows<{ summit_id: number; mocy: number }>(
    getUserDb().executeSync(`SELECT summit_id, mocy FROM gloria_surveys WHERE id = ?`, [surveyId]),
  )[0];
  if (!sv) return [];
  const cycles = summitCycles(sv.summit_id);
  return listVisits(sv.summit_id).filter((v) => cycleOf(v.visit_ts, cycles) === sv.mocy);
}

export function getVisit(id: number): LoggerVisit | null {
  return rows<LoggerVisit>(getUserDb().executeSync(`SELECT * FROM gloria_logger_visits WHERE id = ?`, [id]))[0] ?? null;
}

const DIR_ORDER = `CASE direction WHEN 'E' THEN 0 WHEN 'N' THEN 1 WHEN 'S' THEN 2 ELSE 3 END`;

export function listLoggers(visitId: number): GloriaLogger[] {
  return rows<GloriaLogger>(
    getUserDb().executeSync(
      `SELECT * FROM gloria_loggers WHERE visit_id = ?
        ORDER BY ${DIR_ORDER}, CASE role WHEN 'readout' THEN 0 ELSE 1 END, quadrat, label, id`,
      [visitId],
    ),
  );
}

/** Letters used at one position on the summit, in any visit. */
function usedLabels(summitId: number, quadrat: string): string[] {
  return rows<{ label: string | null }>(
    getUserDb().executeSync(
      `SELECT l.label FROM gloria_loggers l JOIN gloria_logger_visits v ON v.id = l.visit_id
        WHERE v.summit_id = ? AND l.quadrat = ?`,
      [summitId, quadrat],
    ),
  ).map((r) => r.label ?? '');
}

function insertCarried(visitId: number, seeds: ReadonlyArray<CarrySeed>, startOrder: number): void {
  const db = getUserDb();
  const now = Date.now();
  seeds.forEach((s, i) => {
    db.executeSync(
      `INSERT INTO gloria_loggers (uuid, visit_id, role, direction, quadrat, label, serial, logger_type, start_ts,
         utc_diff_h, dist11_m, dist31_m, prev_uuid, sort_order, updated_at)
       VALUES (?, ?, 'readout', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateUuid(), visitId, s.direction, s.quadrat, s.label, s.serial, s.logger_type, s.start_ts,
        s.start_ts != null ? utcDiffHours(new Date(s.start_ts)) : null, s.dist11_m, s.dist31_m, s.prev_uuid, startOrder + i, now],
    );
  });
}

/**
 * A new visit on `visitTs`. The loggers still in the ground after the latest
 * earlier visit (carryForward) come in as rows to read out.
 */
export function createLoggerVisit(summitId: number, opts: { visitTs: number; surveyId?: number | null; researchers?: string | null }): number {
  return withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    const prev = rows<{ id: number }>(
      db.executeSync(
        `SELECT id FROM gloria_logger_visits WHERE summit_id = ? AND visit_ts <= ? ORDER BY visit_ts DESC, id DESC LIMIT 1`,
        [summitId, opts.visitTs],
      ),
    )[0];
    const r = db.executeSync(
      `INSERT INTO gloria_logger_visits (uuid, summit_id, survey_id, visit_ts, researchers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [generateUuid(), summitId, opts.surveyId ?? null, opts.visitTs, opts.researchers || defaultSurveyorString(), now, now],
    );
    const visitId = Number(r.insertId);
    if (prev) insertCarried(visitId, carryForward(listLoggers(prev.id)), 0);
    return visitId;
  });
}

/**
 * Pull in again what the latest earlier visit left in the ground — for when
 * that visit was typed in after this one. Returns how many rows were added,
 * or null without an earlier visit.
 */
export function refillReadouts(visitId: number): number | null {
  return withTransaction(() => {
    const db = getUserDb();
    const v = getVisit(visitId);
    if (!v) throw new Error(`logger visit ${visitId} not found`);
    const prev = rows<{ id: number }>(
      db.executeSync(
        `SELECT id FROM gloria_logger_visits WHERE summit_id = ? AND id != ? AND (visit_ts < ? OR (visit_ts = ? AND id < ?))
          ORDER BY visit_ts DESC, id DESC LIMIT 1`,
        [v.summit_id, visitId, v.visit_ts, v.visit_ts, visitId],
      ),
    )[0];
    if (!prev) return null;
    const mine = listLoggers(visitId);
    const seeds = missingCarry(carryForward(listLoggers(prev.id)), mine);
    if (!seeds.length) return 0;
    insertCarried(visitId, seeds, mine.reduce((m, l) => Math.max(m, l.sort_order ?? 0), -1) + 1);
    touchVisit(visitId);
    return seeds.length;
  });
}

/**
 * A logger already in the ground whose installation is not in the app (a
 * paper Form 4, or a visit not typed in yet): a read-out row with the next
 * free letter, the type last used, and the installation set to the visit's
 * day for the user to correct.
 */
export function addReadout(visitId: number, direction: Direction, quadrat = `${direction}22`): number {
  return insertLogger(visitId, 'readout', direction, quadrat);
}

/**
 * A logger installed on this visit, at `quadrat` (the cluster's centre by
 * default), with the next free letter there and the type last used on this
 * summit. The start is now — on the visit's day when that is another day
 * (a Form 4 typed in later).
 */
export function addInstall(visitId: number, direction: Direction, quadrat = `${direction}22`): number {
  return insertLogger(visitId, 'install', direction, quadrat);
}

function insertLogger(visitId: number, role: LoggerRole, direction: Direction, quadrat: string): number {
  return withTransaction(() => {
    const db = getUserDb();
    const v = getVisit(visitId);
    if (!v) throw new Error(`logger visit ${visitId} not found`);
    const lastType = rows<{ logger_type: string | null }>(
      db.executeSync(
        `SELECT l.logger_type FROM gloria_loggers l JOIN gloria_logger_visits v ON v.id = l.visit_id
          WHERE v.summit_id = ? AND l.logger_type IS NOT NULL AND l.logger_type != '' ORDER BY l.id DESC LIMIT 1`,
        [v.summit_id],
      ),
    )[0]?.logger_type ?? null;
    const now = Date.now();
    // An installation starts now (on the visit's day); an old one read out is dated to the visit until corrected.
    const start = role === 'install' ? onDay(now, v.visit_ts) : v.visit_ts;
    const r = db.executeSync(
      `INSERT INTO gloria_loggers (uuid, visit_id, role, direction, quadrat, label, logger_type, start_ts, utc_diff_h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateUuid(), visitId, role, direction, quadrat, nextLoggerLabel(usedLabels(v.summit_id, quadrat)), lastType, start, utcDiffHours(new Date(start)), now],
    );
    touchVisit(visitId);
    return Number(r.insertId);
  });
}

export function updateVisit(id: number, patch: VisitPatch): void {
  patchRow('gloria_logger_visits', id, patch);
}

export function updateLogger(id: number, patch: LoggerPatch): void {
  const row = rows<{ visit_id: number }>(getUserDb().executeSync(`SELECT visit_id FROM gloria_loggers WHERE id = ?`, [id]))[0];
  patchRow('gloria_loggers', id, patch);
  if (row) touchVisit(row.visit_id);
}

export function deleteLogger(id: number): void {
  const row = rows<{ visit_id: number }>(getUserDb().executeSync(`SELECT visit_id FROM gloria_loggers WHERE id = ?`, [id]))[0];
  getUserDb().executeSync(`DELETE FROM gloria_loggers WHERE id = ?`, [id]);
  if (row) touchVisit(row.visit_id);
}

export function deleteVisit(id: number): void {
  withTransaction(() => {
    getUserDb().executeSync(`DELETE FROM gloria_loggers WHERE visit_id = ?`, [id]);
    getUserDb().executeSync(`DELETE FROM gloria_logger_visits WHERE id = ?`, [id]);
  });
}

// ── round trip and merge ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const VISIT_COLS = ['visit_ts', 'researchers', 'comments', 'form4_files', 'locked', 'created_at', 'updated_at'];
const LOGGER_COLS = [
  'role', 'direction', 'quadrat', 'label', 'serial', 'logger_type', 'start_ts', 'stop_ts', 'utc_diff_h', 'dist11_m',
  'dist31_m', 'photo_open', 'photo_closed', 'photo_open_uri', 'photo_closed_uri', 'flags', 'researcher', 'comments',
  'data_files', 'prev_uuid', 'sort_order', 'updated_at',
];
const val = (r: Row, k: string): Scalar => (r[k] ?? null) as Scalar;
const visitIdByUuid = (uuid: string): number | null =>
  rows<{ id: number }>(getUserDb().executeSync(`SELECT id FROM gloria_logger_visits WHERE uuid = ?`, [uuid]))[0]?.id ?? null;

/**
 * A file's visits onto the summit, by uuid: an existing visit takes the
 * file's values and loggers; a new one is added. Inside the caller's
 * transaction.
 */
export function importLoggerVisits(summitId: number, visits: ReadonlyArray<Row & { loggers?: Row[] }>): void {
  const db = getUserDb();
  const now = Date.now();
  for (const v of visits) {
    const uuid = String(v.uuid ?? '');
    if (!uuid) continue;
    let id = visitIdByUuid(uuid);
    if (id == null) {
      const r = db.executeSync(
        `INSERT INTO gloria_logger_visits (uuid, summit_id, ${VISIT_COLS.join(', ')}) VALUES (?, ?, ${VISIT_COLS.map(() => '?').join(', ')})`,
        [uuid, summitId, ...VISIT_COLS.map((k) => (k === 'created_at' || k === 'updated_at' ? ((v[k] as number) ?? now) : val(v, k)))],
      );
      id = Number(r.insertId);
    } else {
      db.executeSync(`UPDATE gloria_logger_visits SET ${VISIT_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [
        ...VISIT_COLS.map((k) => (k === 'created_at' || k === 'updated_at' ? ((v[k] as number) ?? now) : val(v, k))),
        id,
      ]);
      db.executeSync(`DELETE FROM gloria_loggers WHERE visit_id = ?`, [id]);
    }
    for (const l of v.loggers ?? []) {
      db.executeSync(`DELETE FROM gloria_loggers WHERE uuid = ?`, [String(l.uuid)]);
      db.executeSync(
        `INSERT INTO gloria_loggers (uuid, visit_id, ${LOGGER_COLS.join(', ')}) VALUES (?, ?, ${LOGGER_COLS.map(() => '?').join(', ')})`,
        [String(l.uuid), id, ...LOGGER_COLS.map((k) => (k === 'updated_at' ? ((l[k] as number) ?? now) : val(l, k)))],
      );
    }
  }
}

/** Merge writes for the `visit` and `logger` sides (mergeDocs gloriaSide). Inside the caller's transaction. */
export function applyLoggerOp(
  summitId: number,
  op: { op: 'insert'; tbl: string; row: { key: string; data: Row } } | { op: 'update'; tbl: string; key: string; data: Row } | { op: 'delete'; tbl: string; key: string },
): void {
  const db = getUserDb();
  const now = Date.now();
  const clean = (data: Row, cols: string[]) => Object.fromEntries(Object.entries(data).filter(([k]) => cols.includes(k)));
  if (op.tbl === 'visit') {
    if (op.op === 'delete') {
      const id = visitIdByUuid(op.key);
      if (id != null) {
        db.executeSync(`DELETE FROM gloria_loggers WHERE visit_id = ?`, [id]);
        db.executeSync(`DELETE FROM gloria_logger_visits WHERE id = ?`, [id]);
      }
      return;
    }
    const key = op.op === 'insert' ? op.row.key : op.key;
    const data = clean(op.op === 'insert' ? op.row.data : op.data, VISIT_COLS);
    const id = visitIdByUuid(key);
    if (id == null) {
      const cols = Object.keys(data);
      db.executeSync(
        `INSERT INTO gloria_logger_visits (uuid, summit_id, created_at, updated_at${cols.map((c) => `, ${c}`).join('')})
         VALUES (?, ?, ?, ?${cols.map(() => ', ?').join('')})`,
        [key, summitId, now, now, ...cols.map((c) => data[c] as Scalar)],
      );
    } else if (Object.keys(data).length) {
      patchRow('gloria_logger_visits', id, data);
    }
    return;
  }
  if (op.tbl !== 'logger') return;
  if (op.op === 'delete') {
    db.executeSync(`DELETE FROM gloria_loggers WHERE uuid = ?`, [op.key]);
    return;
  }
  const key = op.op === 'insert' ? op.row.key : op.key;
  const raw = op.op === 'insert' ? op.row.data : op.data;
  const data = clean(raw, LOGGER_COLS);
  const exists = rows<{ id: number }>(db.executeSync(`SELECT id FROM gloria_loggers WHERE uuid = ?`, [key]))[0]?.id ?? null;
  if (exists == null) {
    const visitId = raw.visit != null ? visitIdByUuid(String(raw.visit)) : null;
    if (visitId == null) throw new Error(`logger ${key} refers to a missing visit`);
    const cols = Object.keys(data);
    db.executeSync(
      `INSERT INTO gloria_loggers (uuid, visit_id, updated_at${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?${cols.map(() => ', ?').join('')})`,
      [key, visitId, now, ...cols.map((c) => data[c] as Scalar)],
    );
  } else if (Object.keys(data).length) {
    patchRow('gloria_loggers', exists, data);
  }
}
