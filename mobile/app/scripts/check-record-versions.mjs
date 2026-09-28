/**
 * Record versions (src/lib/recordVersionsCore.ts, v73) — the pure rules and a
 * restore round-trip through the merge engine:
 *   - same content as the latest version → nothing stored; manual always is;
 *   - a leave within 30 minutes of a leave updates it, later → a new version,
 *     and a leave never extends a non-leave version;
 *   - pruning keeps the newest 30 automatic versions and every manual one;
 *   - a deleted record's versions expire after 30 days, not before;
 *   - restoring (version = remote, current = base, every decision remote)
 *     turns the current rows into exactly the version's rows: changed fields
 *     back, added rows removed, deleted rows back; and restoring the saved
 *     "before restore" state undoes it;
 *   - the diff shown (describeMerge) names each of those changes.
 */
import { baseOf, describeMerge, diffSides, planOps } from '../src/lib/mergeEngine.ts';
import { DELETED_KEEP_MS, KEEP_AUTO, LEAVE_MERGE_MS, expired, pickPrune, planSave, restoreDecisions } from '../src/lib/recordVersionsCore.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

// ── planSave ──
const T = 1_800_000_000_000;
const v = (id, reason, hash, at) => ({ id, reason, content_hash: hash, created_at: at, updated_at: at });
eq('first version is stored', planSave(null, 'h1', 'done', T), { kind: 'insert' });
eq('unchanged content is not stored', planSave(v(1, 'done', 'h1', T), 'h1', 'leave', T + 1000), { kind: 'skip' });
eq('manual is stored even if unchanged', planSave(v(1, 'done', 'h1', T), 'h1', 'manual', T), { kind: 'insert' });
eq('leave within 30 min extends the leave', planSave(v(7, 'leave', 'h1', T), 'h2', 'leave', T + LEAVE_MERGE_MS - 1), { kind: 'update', id: 7 });
eq('leave after 30 min is a new version', planSave(v(7, 'leave', 'h1', T), 'h2', 'leave', T + LEAVE_MERGE_MS), { kind: 'insert' });
eq('leave never extends a done version', planSave(v(7, 'done', 'h1', T), 'h2', 'leave', T + 1000), { kind: 'insert' });
eq('done after a leave is a new version', planSave(v(7, 'leave', 'h1', T), 'h2', 'done', T + 1000), { kind: 'insert' });
eq('30 min counts from the last update', planSave({ ...v(7, 'leave', 'h1', T), updated_at: T + LEAVE_MERGE_MS }, 'h2', 'leave', T + LEAVE_MERGE_MS + 1000), { kind: 'update', id: 7 });

// ── pickPrune ──
const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, reason: i % 10 === 0 ? 'manual' : 'leave', created_at: T + i * 1000 }));
const pruned = pickPrune(many);
const autos = many.filter((x) => x.reason !== 'manual');
eq('prunes automatic versions beyond 30', pruned.length, autos.length - KEEP_AUTO);
eq('prunes the oldest ones', pruned.sort((a, b) => a - b), autos.slice(0, autos.length - KEEP_AUTO).map((x) => x.id));
eq('never prunes a manual version', pruned.some((id) => many.find((x) => x.id === id).reason === 'manual'), false);
eq('30 or fewer → nothing pruned', pickPrune(autos.slice(0, KEEP_AUTO)), []);

// ── expired ──
eq('not deleted → never expires', expired(null, T), false);
eq('within 30 days → kept', expired(T, T + DELETED_KEEP_MS), false);
eq('after 30 days → expires', expired(T, T + DELETED_KEEP_MS + 1), true);

// ── restore round-trip ──
const row = (key, data) => ({ key, data, label: key });
function apply(side, ops) {
  const out = Object.fromEntries(Object.entries(side).map(([t, rows]) => [t, rows.map((r) => ({ ...r, data: { ...r.data } }))]));
  for (const op of ops) {
    const rows = (out[op.tbl] ??= []);
    if (op.op === 'insert') rows.push({ ...op.row, data: { ...op.row.data } });
    else if (op.op === 'delete') out[op.tbl] = rows.filter((r) => r.key !== op.key);
    else Object.assign(rows.find((x) => x.key === op.key).data, op.data);
  }
  return out;
}
const norm = (side) => Object.fromEntries(Object.entries(side).map(([t, rows]) => [t, rows.map((r) => [r.key, r.data]).sort((a, b) => (a[0] < b[0] ? -1 : 1))]).filter(([, r]) => r.length));
const restore = (current, version) => {
  const items = diffSides(current, version, baseOf(current));
  return { items, out: apply(current, planOps(items, restoreDecisions(items))) };
};

const version = {
  record: [row('r', { name: 'Plot A', notes: 'old' })],
  species: [row('a', { taxon_id: 't1', cover: 5 }), row('b', { taxon_id: 't2', cover: 10 }), row('c', { taxon_id: 't3', cover: 1 })],
};
const current = {
  record: [row('r', { name: 'Plot A', notes: 'new' })],
  species: [row('a', { taxon_id: 't1', cover: 25 }), row('b', { taxon_id: 't2', cover: 10 }), row('d', { taxon_id: 't4', cover: 3 })],
};
const { items, out } = restore(current, version);
eq('restore yields exactly the version', norm(out), norm(version));
const undo = restore(out, current).out;
eq('restoring the before-restore state undoes it', norm(undo), norm(current));
eq('restoring the same content changes nothing', planOps(diffSides(version, version, baseOf(version)), new Map()).length, 0);

const shown = describeMerge(items, restoreDecisions(items)).map((c) => `${c.action}:${c.label}`).sort();
eq('diff names each change', shown, ['added:c', 'changed:a', 'changed:r', 'deleted:d']);

if (failed) {
  console.error(`\n${failed} record-version check(s) failed`);
  process.exit(1);
}
console.log('✓ record versions: save / merge-leave / prune / expiry / restore round-trip');
