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

export type SnapshotKind = 'session' | 'plot' | 'collection' | 'modular';

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
  // A checklist / plot-style survey (Modular_survey.md). Its permanent plot's
  // layout and morphospecies are the plot's, shared with its other surveys:
  // not part of it (as in its record versions).
  modular: {
    parent: 'fw_surveys',
    children: [
      { table: 'fw_units', where: 'survey_id = ?' },
      { table: 'fw_survey_values', where: 'survey_id = ?' },
      { table: 'fw_unit_values', where: 'unit_id IN (SELECT id FROM fw_units WHERE survey_id = ?)' },
      { table: 'fw_occurrences', where: 'survey_id = ?' },
      { table: 'fw_occurrence_values', where: 'occurrence_id IN (SELECT id FROM fw_occurrences WHERE survey_id = ?)' },
      { table: 'fw_rechecks', where: 'survey_id = ?' },
      { table: 'fw_media', where: 'survey_id = ?' },
    ],
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
  // A survey's blind phase and template are its lifecycle, not edits.
  'blind_closed_at',
  'template_id',
  'template_version',
  'template_snapshot',
  'template_hash',
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

/**
 * Rows a restore leaves as they are, by table. A closed blind phase seals its
 * records (Modular_survey.md §5.5): undo neither removes, changes nor brings
 * back a blind occurrence, its values or its photos — whether it is here now
 * or only in the snapshot.
 */
function sealedRows(db: SnapshotDb, snap: RecordSnapshot): Record<string, Set<number>> {
  if (snap.kind !== 'modular') return {};
  const select = (sql: string, args: Scalar[]) => selectIn(db, sql, args);
  if (select(`SELECT blind_closed_at FROM fw_surveys WHERE id = ?`, [snap.id])[0]?.blind_closed_at == null) return {};
  const occ = new Set<number>([
    ...select(`SELECT id FROM fw_occurrences WHERE survey_id = ? AND phase = 'blind'`, [snap.id]).map((r) => r.id as number),
    ...snap.children.fw_occurrences.filter((r) => r.phase === 'blind').map((r) => r.id as number),
  ]);
  const ofOcc = (table: string) =>
    new Set<number>(
      [
        ...select(`SELECT id, occurrence_id FROM ${table} WHERE occurrence_id IN (SELECT id FROM fw_occurrences WHERE survey_id = ?)`, [snap.id]),
        ...snap.children[table],
      ]
        .filter((r) => occ.has(r.occurrence_id as number))
        .map((r) => r.id as number),
    );
  // The units they sit in, and those units' parents, are not removed either:
  // that would move a sealed record (SET NULL). Only units the restore would
  // remove are listed, so one in the snapshot still gets its old values back.
  const parentOf = new Map(select(`SELECT id, parent_id FROM fw_units WHERE survey_id = ?`, [snap.id]).map((r) => [r.id as number, r.parent_id as number | null]));
  const units = new Set<number>();
  for (const r of select(`SELECT unit_id FROM fw_occurrences WHERE survey_id = ? AND phase = 'blind' AND unit_id IS NOT NULL`, [snap.id])) {
    for (let u: number | null = r.unit_id as number; u != null && !units.has(u); u = parentOf.get(u) ?? null) units.add(u);
  }
  for (const r of snap.children.fw_units) units.delete(r.id as number);
  return { fw_occurrences: occ, fw_occurrence_values: ofOcc('fw_occurrence_values'), fw_media: ofOcc('fw_media'), fw_units: units };
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
    const sealed = sealedRows(db, snap);
    const isSealed = (table: string, rid: number) => sealed[table]?.has(rid) ?? false;
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
        if (!keep.has(rid) && !isSealed(c.table, rid)) db.executeSync(`DELETE FROM ${c.table} WHERE id = ?`, [rid]);
      }
    }
    // 2. The record itself, then its children in order: update or re-insert.
    update(spec.parent, snap.parent, true);
    for (const c of spec.children) {
      for (const row of snap.children[c.table]) {
        if (isSealed(c.table, row.id as number)) continue;
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
