/**
 * The executeSync wrapper must behave like op-sqlite where the reused mobile
 * DB layer depends on it, and like the node:sqlite shim the mobile check
 * scripts use (scripts/schema-columns.mjs).
 */
import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/host/sqlite';

describe('executeSync contract', () => {
  it('returns rows as objects, insertId and rowsAffected for writes only', async () => {
    let writes = 0;
    const db = await openMemoryDb(null, () => writes++);
    db.executeSync('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)');
    const ins = db.executeSync('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 1]);
    expect(ins.insertId).toBe(1);
    expect(ins.rowsAffected).toBe(1);
    const sel = db.executeSync('SELECT * FROM t');
    expect(sel.rows).toEqual([{ id: 1, a: 'x', b: 1 }]);
    // sqlite3_changes would still say 1 here; the wrapper must say 0.
    expect(sel.rowsAffected).toBe(0);
    expect(sel.insertId).toBeUndefined();
    expect(writes).toBe(1);
    db.close();
  });

  it('binds undefined as NULL and booleans as 0/1', async () => {
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE t (a, b, c)');
    db.executeSync('INSERT INTO t VALUES (?, ?, ?)', [undefined, true, false]);
    expect(db.executeSync('SELECT a, b, c FROM t').rows).toEqual([{ a: null, b: 1, c: 0 }]);
    db.close();
  });

  it('UPDATE that matches nothing reports 0 rows', async () => {
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE t (a)');
    expect(db.executeSync('UPDATE t SET a = 1').rowsAffected).toBe(0);
    db.close();
  });

  it('runs several statements in one call (migrations do this)', async () => {
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO a VALUES (1);');
    expect(db.executeSync('SELECT x FROM a').rows).toEqual([{ x: 1 }]);
    db.close();
  });

  it('round-trips through export / deserialize', async () => {
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE t (a TEXT)');
    db.executeSync('INSERT INTO t VALUES (?)', ['臺灣']);
    const bytes = db.exportBytes();
    db.close();
    const again = await openMemoryDb(bytes);
    expect(again.executeSync('SELECT a FROM t').rows).toEqual([{ a: '臺灣' }]);
    again.executeSync('INSERT INTO t VALUES (?)', ['grows after deserialize']);
    expect(again.executeSync('SELECT count(*) AS n FROM t').rows[0].n).toBe(2);
    again.close();
  });
});
