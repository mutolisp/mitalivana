/**
 * sqlite-wasm behind the small slice of op-sqlite's API that the reused mobile
 * DB layer calls: `executeSync(sql, params)` → `{ rows, rowsAffected, insertId }`
 * and `close()`.
 *
 * The database lives in memory on the main thread (no OPFS, no COOP/COEP);
 * persistence is a whole-file snapshot taken by `persist.ts`. Keeping the calls
 * synchronous is the point: `modules/gloria/db.ts`, `migrations.ts` and the
 * search stack run without a single change.
 *
 * Semantics pinned by test/host.contract.test.ts:
 *   - `rowsAffected` is the difference of `sqlite3_total_changes` around the
 *     call. `sqlite3_changes` is not reset by a SELECT, so it would report the
 *     previous write's count for a read.
 *   - `insertId` is set only when the statement changed rows.
 *   - bind values: `undefined` → NULL, boolean → 0/1 (op-sqlite does the same).
 */
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

export type Row = Record<string, unknown>;
export type QueryResult = { rows: Row[]; rowsAffected: number; insertId?: number };
export type BindValue = string | number | null | boolean | undefined | bigint | Uint8Array | ArrayBuffer;

export interface SyncDb {
  executeSync(sql: string, params?: BindValue[]): QueryResult;
  close(): void;
  /** Whole database as bytes (sqlite3_js_db_export). */
  exportBytes(): Uint8Array;
  readonly raw: Database;
}

let modulePromise: Promise<Sqlite3Static> | null = null;
let loaded: Sqlite3Static | null = null;

export function loadSqlite(): Promise<Sqlite3Static> {
  if (!modulePromise) {
    modulePromise = sqlite3InitModule().then((m) => {
      loaded = m;
      return m;
    });
  }
  return modulePromise;
}

/** The module once `loadSqlite()` has resolved; synchronous openers need it. */
export function loadedSqlite(): Sqlite3Static {
  if (!loaded) throw new Error('sqlite-wasm not loaded yet — await loadSqlite() first');
  return loaded;
}

function normalize(v: BindValue): string | number | null | bigint | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}

export function wrap(sqlite3: Sqlite3Static, db: Database, onWrite?: () => void): SyncDb {
  const { capi } = sqlite3;
  return {
    raw: db,
    executeSync(sql: string, params: BindValue[] = []): QueryResult {
      const before = capi.sqlite3_total_changes(db.pointer!);
      const rows: Row[] = [];
      db.exec({
        sql,
        bind: params.length ? params.map(normalize) : undefined,
        rowMode: 'object',
        // The typings only model array rows here; rowMode 'object' fills objects.
        resultRows: rows as never,
      });
      const n = capi.sqlite3_total_changes(db.pointer!) - before;
      if (n > 0) onWrite?.();
      return {
        rows,
        rowsAffected: n,
        insertId: n > 0 ? Number(capi.sqlite3_last_insert_rowid(db.pointer!)) : undefined,
      };
    },
    close() {
      db.close();
    },
    exportBytes() {
      return capi.sqlite3_js_db_export(db.pointer!);
    },
  };
}

/** Open an in-memory database, optionally filled from a snapshot. */
export async function openMemoryDb(bytes?: Uint8Array | null, onWrite?: () => void): Promise<SyncDb> {
  await loadSqlite();
  return openMemoryDbSync(bytes, onWrite);
}

/** Same as `openMemoryDb`, for synchronous callers (dataset opener) after load. */
export function openMemoryDbSync(bytes?: Uint8Array | null, onWrite?: () => void): SyncDb {
  const sqlite3 = loadedSqlite();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  if (bytes && bytes.byteLength > 0) {
    const { capi, wasm } = sqlite3;
    const p = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(
      db.pointer!,
      'main',
      p,
      bytes.byteLength,
      bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc !== 0) {
      db.close();
      throw new Error(`sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`);
    }
  }
  return wrap(sqlite3, db, onWrite);
}
