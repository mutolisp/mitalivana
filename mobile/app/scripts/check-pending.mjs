#!/usr/bin/env node
/**
 * Casual mode's data layer (src/db/pendingCore.ts, v92) on the real migrated
 * schema, foreign keys ON as the app runs them.
 *
 * What must hold:
 *   - pending_observations refuses a kingdom other than Animalia, Plantae,
 *     Fungi and a repeated uuid; rows create, read, list newest first,
 *     update (updated_at moves) and delete;
 *   - a day is the local date: 23:59 and 00:01 are two days, in Taipei and
 *     in Los Angeles alike;
 *   - the day's first observation creates today's daily checklist, active,
 *     ending whatever else was open; the next one reuses it, reopening it if
 *     it was ended;
 *   - at the next day's first use, yesterday's is ended at its last record's
 *     time; one reopened on a later day is left open;
 *   - identifying writes a record into the daily checklist of the day it was
 *     observed (an earlier day's is created ended and grows to span what it
 *     holds), moving photos, recordings, time, place, note, count,
 *     flowering state, wild or not and iNaturalist state; the record's
 *     occurrenceID is the pending uuid; the pending row is gone;
 *   - identifying today while a plot is open does not end the plot;
 *   - a failure part-way leaves everything as it was, inside a caller's
 *     transaction too;
 *   - a deleted daily checklist drops out of the map; a corrupt map reads empty.
 *
 * Run: npm run check:pending
 */
import { DatabaseSync } from 'node:sqlite';
import { runUserMigrations } from '../src/db/migrations.ts';
import * as p from '../src/db/pendingCore.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

process.env.TZ = 'Asia/Taipei';
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
const db = {
  executeSync(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
    const res = stmt.run(...params);
    return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
  },
};
await runUserMigrations(db);
sqlite.exec('PRAGMA foreign_keys = ON;');
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const count = (table, where = '1', ...a) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).n;
const rejects = (sql, params, msg) => {
  try {
    sqlite.prepare(sql).run(...params);
  } catch {
    return;
  }
  ok(false, `${msg} (was accepted)`);
};

let clock = at(2026, 10, 6, 9, 0);
let n = 0;
const ctx = { db, now: () => clock, uuid: () => `u-${++n}` };
const insertRecord = (r) =>
  db.executeSync(
    `INSERT INTO checklist_records (session_id, taxon_id, occurrence_id, observed_at, updated_at, notes, lat, lng, accuracy, photo_paths, organism_quantity, organism_quantity_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.session_id, r.taxon_id, `rec-${++n}`, r.observed_at, clock, ...[r.notes, r.lat, r.lng, r.accuracy, r.photo_paths, r.organism_quantity, r.organism_quantity_type].map((v) => v ?? null)],
  ).insertId;
const deps = { insertRecord, dailyName: (ts) => `觀察 ${p.dayKey(ts)}`, recordedBy: 'Lin' };
const opts = (ts) => ({ name: `觀察 ${p.dayKey(ts)}`, recordedBy: 'Lin', activate: true });
const status = (id) => one('SELECT status FROM sessions WHERE id = ?', id)?.status;

// ── the table ──────────────────────────────────────────────────────────────
rejects(`INSERT INTO pending_observations (uuid, kingdom, observed_at, created_at, updated_at) VALUES ('x1', 'Chromista', 1, 1, 1)`, [], 'schema: kingdom limited to three');
rejects(`INSERT INTO pending_observations (uuid, kingdom, observed_at, created_at, updated_at) VALUES (NULL, 'Plantae', 1, 1, 1)`, [], 'schema: uuid required');
const a = p.createPending(ctx, { kingdom: 'Plantae', observed_at: at(2026, 10, 6, 8, 30), note: '花粉紅' });
rejects(`INSERT INTO pending_observations (uuid, kingdom, observed_at, created_at, updated_at) VALUES ('u-1', 'Plantae', 1, 1, 1)`, [], 'schema: uuid unique');
const b = p.createPending(ctx, { kingdom: 'Animalia', observed_at: at(2026, 10, 6, 8, 45) });
eq(p.listPending(ctx).map((r) => r.id), [b, a], 'list: newest first');
clock += 1000;
p.updatePending(ctx, a, { kingdom: 'Fungi', quantity: '3' });
const ra = p.getPending(ctx, a);
ok(ra.kingdom === 'Fungi' && ra.quantity === '3' && ra.note === '花粉紅' && ra.updated_at === clock, 'update: changed fields only, updated_at moves');
p.deletePending(ctx, b);
eq(p.getPending(ctx, b), null, 'delete');

// ── days ───────────────────────────────────────────────────────────────────
ok(p.dayKey(at(2026, 10, 5, 23, 59)) === '2026-10-05' && p.dayKey(at(2026, 10, 6, 0, 1)) === '2026-10-06', 'day: 23:59 and 00:01 are two days (Taipei)');
const utc = Date.UTC(2026, 9, 6, 3, 0); // 11:00 in Taipei, 20:00 the day before in Los Angeles
ok(p.dayKey(utc) === '2026-10-06', 'day: local date in Taipei');
process.env.TZ = 'America/Los_Angeles';
ok(p.dayKey(utc) === '2026-10-05', 'day: local date in Los Angeles');
process.env.TZ = 'Asia/Taipei';

// ── today's checklist ──────────────────────────────────────────────────────
const plotA = db.executeSync(`INSERT INTO plot_surveys (plotid, plot_type, status, created_at, updated_at, uuid) VALUES ('P1', 'point_count', 'active', 1, 1, 'pu1')`).insertId;
const d6 = p.dailySessionFor(ctx, clock, opts(clock));
ok(status(d6) === 'active', 'today: created active');
ok(one('SELECT status FROM plot_surveys WHERE id = ?', plotA).status === 'done', 'today: the open plot was ended (single active)');
eq(p.readDailyMap(ctx), { '2026-10-06': d6 }, 'today: in the map');
ok(one('SELECT recorded_by FROM sessions WHERE id = ?', d6).recorded_by === 'Lin', 'today: recordedBy set');
eq(p.dailySessionFor(ctx, clock + 60_000, opts(clock)), d6, 'today: reused');
db.executeSync(`UPDATE sessions SET status = 'done', ended_at = ? WHERE id = ?`, [clock, d6]);
eq(p.dailySessionFor(ctx, clock, opts(clock)), d6, 'today: reused after being ended');
ok(status(d6) === 'active', 'today: reopened');
ok(p.isDailySession(ctx, d6) && !p.isDailySession(ctx, 9999), 'isDailySession');
insertRecord({ session_id: d6, taxon_id: 't1', observed_at: at(2026, 10, 6, 15, 20) });

// ── next day ───────────────────────────────────────────────────────────────
clock = at(2026, 10, 7, 7, 0);
const d7 = p.dailySessionFor(ctx, clock, opts(clock));
ok(d7 !== d6 && status(d7) === 'active', 'next day: a new checklist');
ok(status(d6) === 'done' && one('SELECT ended_at FROM sessions WHERE id = ?', d6).ended_at === at(2026, 10, 6, 15, 20), "next day: yesterday's ended at its last record");
// Reopened on a later day: left open by the sweep.
db.executeSync(`UPDATE sessions SET status = 'active', resumed_at = ? WHERE id = ?`, [clock, d6]);
db.executeSync(`UPDATE sessions SET status = 'done' WHERE id = ?`, [d7]);
eq(p.closeStaleDailySessions(ctx), [], 'sweep: one reopened on a later day is left open');
db.executeSync(`UPDATE sessions SET status = 'done' WHERE id = ?`, [d6]);

// ── identifying ────────────────────────────────────────────────────────────
const photos = JSON.stringify(['file:///doc/photos/p1.jpg']);
const audio = JSON.stringify(['file:///doc/audio/a1.m4a']);
const old = p.createPending(ctx, {
  kingdom: 'Plantae',
  observed_at: at(2026, 10, 3, 10, 0),
  lat: 25.18,
  lng: 121.53,
  accuracy: 6,
  elevation_m: 820,
  elevation_source: 'gnss',
  photo_paths: photos,
  audio_paths: audio,
  note: '葉子：互生',
  quantity: '2',
  reproductive_condition: '["flowering"]',
  degree_of_establishment: 'wild',
});
db.executeSync(`UPDATE pending_observations SET inat_observation_id = 777, inat_media_done = 2, inat_uploaded_at = 5, inat_sync_hash = 'h1' WHERE id = ?`, [old]);
const oldUuid = p.getPending(ctx, old).uuid;
const r1 = p.identifyPending(ctx, old, 't42', deps);
const s3 = one('SELECT * FROM sessions WHERE id = ?', r1.sessionId);
ok(s3.status === 'done' && s3.started_at === at(2026, 10, 3, 10, 0) && s3.ended_at === at(2026, 10, 3, 10, 0), 'earlier day: created ended at the observation');
eq(p.readDailyMap(ctx)['2026-10-03'], r1.sessionId, 'earlier day: in the map');
const rec = one('SELECT * FROM checklist_records WHERE id = ?', r1.recordId);
ok(rec.taxon_id === 't42' && rec.session_id === r1.sessionId, 'identify: record with the taxon, in that day');
ok(rec.occurrence_id === oldUuid, 'identify: occurrenceID is the pending uuid');
ok(
  rec.observed_at === at(2026, 10, 3, 10, 0) && rec.lat === 25.18 && rec.lng === 121.53 && rec.accuracy === 6 && rec.elevation_m === 820 && rec.elevation_source === 'gnss',
  'identify: time and place moved',
);
ok(rec.photo_paths === photos && rec.audio_paths === audio, 'identify: photos and recordings moved');
ok(rec.notes === '葉子：互生' && rec.organism_quantity === '2' && rec.organism_quantity_type === 'individuals', 'identify: note and count moved');
ok(rec.reproductive_condition === '["flowering"]' && rec.degree_of_establishment === 'wild', 'identify: flowering state and wild moved');
ok(rec.inat_observation_id === 777 && rec.inat_media_done === 2 && rec.inat_uploaded_at === 5 && rec.inat_sync_hash === 'h1', 'identify: iNaturalist state moved');
eq(p.getPending(ctx, old), null, 'identify: pending row gone');
// A later observation of the same earlier day widens it.
const old2 = p.createPending(ctx, { kingdom: 'Animalia', observed_at: at(2026, 10, 3, 16, 30) });
const r2 = p.identifyPending(ctx, old2, 't43', deps);
const s3b = one('SELECT started_at, ended_at FROM sessions WHERE id = ?', r2.sessionId);
ok(r2.sessionId === r1.sessionId && s3b.ended_at === at(2026, 10, 3, 16, 30) && s3b.started_at === at(2026, 10, 3, 10, 0), 'earlier day: same checklist, widened');
ok(one('SELECT organism_quantity_type AS t FROM checklist_records WHERE id = ?', r2.recordId).t === null, 'identify: no count, no quantity type');

// Today, while a plot is open: the plot stays open.
const plotB = db.executeSync(`INSERT INTO plot_surveys (plotid, plot_type, status, created_at, updated_at, uuid) VALUES ('P2', 'transect', 'active', 1, 1, 'pu2')`).insertId;
clock = at(2026, 10, 8, 9, 0);
const today = p.createPending(ctx, { kingdom: 'Fungi', observed_at: at(2026, 10, 8, 8, 0) });
const r3 = p.identifyPending(ctx, today, 't44', deps);
ok(one('SELECT status FROM plot_surveys WHERE id = ?', plotB).status === 'active', 'identify today: the open plot stays open');
ok(status(r3.sessionId) === 'done', "identify today: today's checklist made without taking the active slot");
// Recording a new observation later today takes it over (after the UI asked).
eq(p.dailySessionFor(ctx, clock, opts(clock)), r3.sessionId, "capture today: the same day's checklist");
ok(status(r3.sessionId) === 'active' && one('SELECT status FROM plot_surveys WHERE id = ?', plotB).status === 'done', 'capture today: active, the plot ended');

// ── all or nothing ─────────────────────────────────────────────────────────
const fail = p.createPending(ctx, { kingdom: 'Plantae', observed_at: at(2026, 9, 30, 10, 0) });
const before = { sessions: count('sessions'), records: count('checklist_records'), map: JSON.stringify(p.readDailyMap(ctx)) };
const boom = { ...deps, insertRecord: () => { throw new Error('boom'); } };
let threw = false;
try {
  p.identifyPending(ctx, fail, 't45', boom);
} catch {
  threw = true;
}
ok(threw, 'failure: thrown');
ok(count('sessions') === before.sessions && count('checklist_records') === before.records, 'failure: no checklist, no record');
ok(JSON.stringify(p.readDailyMap(ctx)) === before.map, 'failure: map unchanged');
ok(p.getPending(ctx, fail) !== null, 'failure: pending row kept');
// Inside a caller's transaction.
sqlite.exec('BEGIN');
try {
  p.identifyPending(ctx, fail, 't45', boom);
} catch {
  /* expected */
}
ok(p.getPending(ctx, fail) !== null && count('sessions') === before.sessions, 'failure in a transaction: rolled back to the savepoint');
const r4 = p.identifyPending(ctx, fail, 't45', deps);
sqlite.exec('COMMIT');
ok(p.getPending(ctx, fail) === null && count('checklist_records', 'id = ?', r4.recordId) === 1, 'success in a transaction: committed with it');

// ── the map ────────────────────────────────────────────────────────────────
db.executeSync(`DELETE FROM checklist_records WHERE session_id = ?`, [r4.sessionId]);
db.executeSync(`DELETE FROM sessions WHERE id = ?`, [r4.sessionId]);
ok(!('2026-09-30' in p.readDailyMap(ctx)), 'map: a deleted checklist drops out');
eq(p.parseDailyMap('{oops'), {}, 'map: corrupt reads empty');
eq(p.parseDailyMap(JSON.stringify({ '2026-10-01': 3, bad: 4, '2026-10-02': 'x', '2026-10-03': 0 })), { '2026-10-01': 3 }, 'map: bad entries dropped');

if (failed) {
  console.error(`\n✗ pending: ${failed} problem(s)`);
  process.exit(1);
}
console.log('✓ pending: table, days across midnight and time zones, daily checklists, identifying, all or nothing');
