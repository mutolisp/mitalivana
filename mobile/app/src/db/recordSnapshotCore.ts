/**
 * Undo / redo for a whole record: a snapshot is the record's row plus every
 * child row that belongs to it, and restoring one puts all of them back.
 *
 * Columns that other parts of the app write on their own (iNaturalist sync,
 * the star, a running track, the record's lifecycle) are neither compared nor
 * restored — undoing a count must not unlink an uploaded observation or cut a
 * recorded track.
 *
 * Restore never uses INSERT OR REPLACE: REPLACE deletes the old row first,
 * which with foreign keys on cascades into its children (a subplot's layers,
 * a species' subplot link). Rows missing from the snapshot are deleted first
 * (children before parents, so UNIQUE(parent, index) rows free their slot),
 * then existing rows are updated and missing ones inserted with their old ids.
 */
import type { Scalar } from '@op-engineering/op-sqlite';

/** What this module needs of a connection — op-sqlite in the app, a
 *  node:sqlite shim in scripts/check-record-snapshot.mjs. */
export type SnapshotDb = {
  executeSync: (sql: string, params?: Scalar[]) => { rows?: unknown[] };
};

export type SnapshotKind = 'session' | 'plot' | 'collection';

type Row = Record<string, unknown>;
type Child = { table: string; where: string };
type Spec = { parent: string; children: Child[] };

/** Children in insert order; deletes run in reverse. `?` is the record id. */
const SPECS: Record<SnapshotKind, Spec> = {
  session: {
    parent: 'sessions',
    children: [{ table: 'checklist_records', where: 'session_id = ?' }],
  },
  plot: {
    parent: 'plot_surveys',
    children: [
      { table: 'plot_subplots', where: 'plot_survey_id = ?' },
      { table: 'plot_survey_layers', where: 'plot_survey_id = ?' },
      {
        table: 'subplot_layers',
        where: 'subplot_id IN (SELECT id FROM plot_subplots WHERE plot_survey_id = ?)',
      },
      { table: 'plot_species_records', where: 'plot_survey_id = ?' },
      // 1×1 m quadrats (v77), parent before its species.
      { table: 'plot_quadrats', where: 'plot_survey_id = ?' },
      {
        table: 'plot_quadrat_species',
        where: 'quadrat_id IN (SELECT id FROM plot_quadrats WHERE plot_survey_id = ?)',
      },
    ],
  },
  collection: {
    parent: 'collection_trips',
    children: [{ table: 'collection_specimens', where: 'trip_id = ?' }],
  },
};

/** Written elsewhere, or by the lock itself; kept as they are now on restore.
 *  End times (ended_at / stop_ts) are ordinary data since v54 and do restore. */
const KEEP_ANY = new Set(['updated_at', 'starred']);
const KEEP_PARENT = new Set([
  'status',
  'resumed_at',
  'track_geojson',
  'gps_mode',
  'track_finalized',
]);

function kept(col: string, parent: boolean): boolean {
  return (
    col === 'id' || KEEP_ANY.has(col) || col.startsWith('inat_') || (parent && KEEP_PARENT.has(col))
  );
}

export type RecordSnapshot = {
  kind: SnapshotKind;
  id: number;
  parent: Row;
  children: Record<string, Row[]>;
};

function selectIn(db: SnapshotDb, sql: string, args: Scalar[]): Row[] {
  return (db.executeSync(sql, args).rows ?? []) as Row[];
}

export function snapshotRecordIn(
  db: SnapshotDb,
  kind: SnapshotKind,
  id: number,
): RecordSnapshot | null {
  const select = (sql: string, args: Scalar[]) => selectIn(db, sql, args);
  const spec = SPECS[kind];
  const parent = select(`SELECT * FROM ${spec.parent} WHERE id = ?`, [id])[0];
  if (!parent) return null;
  const children: Record<string, Row[]> = {};
  for (const c of spec.children) {
    const n = (c.where.match(/\?/g) ?? []).length;
    children[c.table] = select(
      `SELECT * FROM ${c.table} WHERE ${c.where} ORDER BY id`,
      Array(n).fill(id),
    );
  }
  return { kind, id, parent, children };
}

/** Only what a restore would change: the kept columns are left out. */
function comparable(s: RecordSnapshot): string {
  const strip = (r: Row, parent: boolean) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => k === 'id' || !kept(k, parent)));
  return JSON.stringify([
    strip(s.parent, true),
    Object.fromEntries(
      Object.entries(s.children).map(([t, rs]) => [t, rs.map((r) => strip(r, false))]),
    ),
  ]);
}

export function sameSnapshot(a: RecordSnapshot, b: RecordSnapshot): boolean {
  return comparable(a) === comparable(b);
}

/** `transaction` runs its argument atomically (the app's withTransaction). */
export function restoreRecordSnapshotIn(
  db: SnapshotDb,
  snap: RecordSnapshot,
  transaction: (fn: () => void) => void,
): void {
  const spec = SPECS[snap.kind];
  const select = (sql: string, args: Scalar[]) => selectIn(db, sql, args);
  transaction(() => {
    const update = (table: string, row: Row, parent: boolean) => {
      const cols = Object.keys(row).filter((c) => !kept(c, parent));
      if (!cols.length) return;
      db.executeSync(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
        ...cols.map((c) => row[c] as Scalar),
        row.id as Scalar,
      ]);
    };
    // 1. Rows added since the snapshot go, deepest first.
    const current: Record<string, Set<number>> = {};
    for (const c of spec.children) {
      const n = (c.where.match(/\?/g) ?? []).length;
      current[c.table] = new Set(
        select(`SELECT id FROM ${c.table} WHERE ${c.where}`, Array(n).fill(snap.id)).map(
          (r) => r.id as number,
        ),
      );
    }
    for (const c of [...spec.children].reverse()) {
      const keep = new Set(snap.children[c.table].map((r) => r.id as number));
      for (const rid of current[c.table]) {
        if (!keep.has(rid)) db.executeSync(`DELETE FROM ${c.table} WHERE id = ?`, [rid]);
      }
    }
    // 2. The record itself, then its children in order: update or re-insert.
    update(spec.parent, snap.parent, true);
    for (const c of spec.children) {
      for (const row of snap.children[c.table]) {
        if (current[c.table].has(row.id as number)) {
          update(c.table, row, false);
        } else {
          const cols = Object.keys(row);
          db.executeSync(
            `INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map((k) => row[k] as Scalar),
          );
        }
      }
    }
  });
}
