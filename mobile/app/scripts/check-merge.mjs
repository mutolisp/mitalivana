/**
 * Team merge engine (src/lib/mergeEngine.ts + mergeDocs.ts) on hand-built
 * sides and documents:
 *   - two surveyors, same plot, 10 species each, 3 shared → 17 rows, 3 flagged
 *     as possible duplicates;
 *   - one side changed → taken automatically; both changed → conflict, with
 *     exactly the differing fields;
 *   - deletions through the common ancestor: theirs unchanged here → asked;
 *     changed here → delete conflict; deleted here, unchanged there → stays;
 *   - no ancestor (older file) → never a deletion, differences are conflicts;
 *   - merging the same file again after applying it changes nothing;
 *   - the reviewer's "keep mine" reaches the sender on the way back;
 *   - GLORIA: two devices on different aspects merge with no questions; the
 *     same quadrat and species with different cover is a conflict;
 *   - surveyors / time span combined, not asked.
 */
import {
  baseOf,
  defaultDecision,
  diffSides,
  planOps,
  readSyncBlock,
  rowHash,
  summarizeItems,
} from '../src/lib/mergeEngine.ts';
import { COMBINERS, gloriaSide, sessionSide, trackUnion } from '../src/lib/mergeDocs.ts';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

const row = (key, data, extra) => ({ key, data, extra, dupKey: data.taxon_id ? `${data.taxon_id}|` : undefined, label: key });
const kinds = (items) => items.map((i) => `${i.kind}:${i.key}`);

/** Apply ops to a plain side, the way a DB adapter would. */
function apply(side, ops) {
  const out = Object.fromEntries(Object.entries(side).map(([t, rows]) => [t, rows.map((r) => ({ ...r, data: { ...r.data } }))]));
  for (const op of ops) {
    const rows = (out[op.tbl] ??= []);
    if (op.op === 'insert') rows.push({ ...op.row, data: { ...op.row.data } });
    else if (op.op === 'delete') out[op.tbl] = rows.filter((r) => r.key !== op.key);
    else {
      const r = rows.find((x) => x.key === op.key);
      Object.assign(r.data, op.data);
      if (op.extra) r.extra = { ...r.extra, ...op.extra };
    }
  }
  return out;
}
const decide = (items, pick) => new Map(items.map((i) => [i.id, pick(i) ?? defaultDecision(i)]));

// ── 1. same plot, 10 + 10 species, 3 shared taxa (different occurrence ids) ──
const sp = (who, n) => row(`${who}${n}`, { taxon_id: `t${n}`, cover: 5 });
const A = { sp: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => sp('a', n)) };
const B = { sp: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => sp('b', n)) };
const first = diffSides(A, B, null);
eq('3 shared taxa → possible duplicates, 7 added', summarizeItems(first), {
  added: 7, auto: 0, conflict: 0, duplicate: 3, remoteDeleted: 0, deleteConflict: 0,
});
const merged = apply(A, planOps(first, decide(first, () => null)));
eq('defaults: 17 rows (duplicates keep mine)', merged.sp.length, 17);
const both = apply(A, planOps(first, decide(first, (i) => (i.kind === 'duplicate' ? { pick: 'both' } : null))));
eq('"keep both" → 20 rows', both.sp.length, 20);

// ── 2. ancestor: one side changed → auto; both → conflict with the fields ──
const base = baseOf({ sp: [row('x', { taxon_id: 't1', cover: 5, notes: 'a' }), row('y', { taxon_id: 't2', cover: 5 })] });
const L2 = { sp: [row('x', { taxon_id: 't1', cover: 5, notes: 'a' }), row('y', { taxon_id: 't2', cover: 10 })] };
const R2 = { sp: [row('x', { taxon_id: 't1', cover: 20, notes: 'a' }), row('y', { taxon_id: 't2', cover: 15 })] };
const d2 = diffSides(L2, R2, base);
eq('only theirs changed → auto; both changed → conflict', kinds(d2), ['auto:x', 'conflict:y']);
eq('conflict lists the differing field only', d2[1].fields, ['cover']);
const r2 = apply(L2, planOps(d2, decide(d2, (i) => (i.kind === 'conflict' ? { pick: 'local', fields: { cover: 'remote' } } : null))));
eq('auto took 20, per-field pick took 15', r2.sp.map((r) => r.data.cover), [20, 15]);

// ── 3. deletions through the ancestor ──
const base3 = baseOf({ sp: [row('p', { taxon_id: 't1', v: 1 }), row('q', { taxon_id: 't2', v: 1 }), row('s', { taxon_id: 't3', v: 1 })] });
const L3 = { sp: [row('p', { taxon_id: 't1', v: 1 }), row('q', { taxon_id: 't2', v: 2 })] }; // s deleted here
const R3 = { sp: [row('s', { taxon_id: 't3', v: 1 })] }; // p, q deleted there
eq('deleted there: unchanged here → asked; changed here → conflict; deleted here → nothing',
  kinds(diffSides(L3, R3, base3)), ['remoteDeleted:p', 'deleteConflict:q']);
const R3b = { sp: [row('s', { taxon_id: 't3', v: 9 })] };
eq('deleted here but changed there → delete conflict', kinds(diffSides(L3, R3b, base3)).includes('deleteConflict:s'), true);
eq('nothing is deleted by default', planOps(diffSides(L3, R3, base3), new Map()).filter((o) => o.op === 'delete').length, 0);

// ── 4. no ancestor: never a deletion, a difference is a conflict ──
eq('older file (no base): missing row is not a deletion', diffSides(L3, { sp: [] }, null).length, 0);
eq('older file: differing row is a conflict', kinds(diffSides(L2, R2, null)), ['conflict:x', 'conflict:y']);

// ── 5. idempotent: merge, store their rows as base, merge the same file again ──
const once = diffSides(L2, R2, base);
const after = apply(L2, planOps(once, decide(once, (i) => (i.kind === 'conflict' ? { pick: 'local' } : null))));
eq('same file again → nothing to do', diffSides(after, R2, baseOf(R2)).length, 0);

// ── 6. the reviewer's "keep mine" reaches the sender on the way back ──
// Hub kept its cover 10 for y; its base is now the sender's rows (cover 15).
// The sender, merging the hub's file, must take 10 automatically.
const hubBase = baseOf(R2);
const back = diffSides(R2, after, hubBase);
eq('sender takes the reviewer\'s choice without a question', kinds(back), ['auto:y']);

// ── 7. combined fields: surveyors, time span, track ──
const S = (by, start, end, track) => ({
  uuid: 'u', name: 'N', type: 'checklist', project_name: null, started_at: start, ended_at: end, recorded_by: by,
  notes: null, start_lat: null, start_lng: null, gps_mode: null, track_geojson: track, site: null, records: [],
});
const trA = JSON.stringify({ type: 'MultiLineString', coordinates: [[[121, 23], [121.1, 23.1]]] });
const trB = JSON.stringify({ type: 'MultiLineString', coordinates: [[[121.2, 23.2], [121.3, 23.3]]] });
const c = diffSides(sessionSide(S('甲', 2000, 5000, trA)), sessionSide(S('乙,甲', 1000, 9000, trB)), null, COMBINERS.session);
eq('combined, never a conflict', kinds(c), ['auto:record']);
eq('surveyors union, earliest start, latest end', [c[0].patch.recorded_by, c[0].patch.started_at, c[0].patch.ended_at], ['甲,乙', 1000, 9000]);
eq('track union keeps both walks', JSON.parse(c[0].patch.track_geojson).coordinates.length, 2);
eq('track union adds nothing the second time', trackUnion(trackUnion(trA, trB), trB), trackUnion(trA, trB));
const open = diffSides(sessionSide(S('甲', 2000, null, null)), sessionSide(S('甲', 2000, 9000, null)), null, COMBINERS.session);
eq('a record still open here stays open', open.length, 0);

// ── 8. GLORIA: different aspects merge silently; same quadrat+species conflicts ──
const unit = (code, v) => ({ code, uuid: `${code}-${Math.random()}`, unit_type: 'quadrat', cov_vascular: v, photo_paths: null, done_locked: 1, updated_at: Math.random() });
const gdoc = (units, species, taxa) => ({
  record_type: 'gloria', schema: 1,
  summit: { full_code: 'TW-DAS-SUN' },
  survey: { uuid: 'x', mocy: 5, year: 2026, start_ts: 1, stop_ts: null, recorded_by: null, project_name: null, grid_ok: { N: 0, E: 0, S: 0, W: 0 }, notes: null, created_at: 1, updated_at: 1 },
  points: [], units, taxa, species, photo_checks: [],
});
const taxon = (serial, taxon_id) => ({ serial, taxon_id, used_name_id: null, used_scientific_name: null, verbatim_identification: null, created_at: 1 });
const us = (unit, serial, occ, cover) => ({ unit, serial, occurrence_id: occ, cover_pct: cover, abundance: null, layer: null, cf: null, freq_cells: null, point_hits: null, legacy_hits: null, comments: null, created_at: 1, updated_at: 1 });
// Device 1 did N; device 2 did S. Each opened all 16 quadrats (blank ones identical).
const blankN = [unit('N11', 30), unit('S11', null)];
const blankS = [unit('N11', null), unit('S11', 40)];
const g1 = gloriaSide(gdoc(blankN, [us('N11', 1, 'o1', 30)], [taxon(1, 'tA')]));
const g2 = gloriaSide(gdoc(blankS, [us('S11', 7, 'o2', 40)], [taxon(7, 'tB')]));
const gd = diffSides(g1, g2, null, COMBINERS.gloria);
// Started apart (no ancestor): a unit filled on one side and blank on the
// other is that side's work — taken or kept without a question.
eq('GLORIA started apart: other aspect merged, no questions', kinds(gd), ['auto:S11', 'added:o2']);
const blankBase = baseOf(gloriaSide(gdoc([unit('N11', null), unit('S11', null)], [], [])));
const gridA = gloriaSide({ ...gdoc([], [], []), survey: { ...gdoc([], [], []).survey, grid_ok: { N: 1, E: 0, S: 0, W: 0 } } });
const gridB = gloriaSide({ ...gdoc([], [], []), survey: { ...gdoc([], [], []).survey, grid_ok: { N: 0, E: 0, S: 1, W: 0 } } });
const gi = diffSides(gridA, gridB, null, COMBINERS.gloria);
eq('GLORIA grid ticks combined, not asked', [kinds(gi), gi[0]?.patch?.grid_ok], [['auto:survey'], { N: 1, E: 0, S: 1, W: 0 }]);
eq('GLORIA from a shared start: no questions either', summarizeItems(diffSides(g1, g2, blankBase, COMBINERS.gloria)).conflict, 0);
eq('no ancestor: a value against a blank is not a conflict', kinds(diffSides({ u: [row('k', { v: null, w: 1 })] }, { u: [row('k', { v: 7, w: 1 })] }, null)), ['auto:k']);
eq('no ancestor: my value against their blank stays mine', diffSides({ u: [row('k', { v: 3 })] }, { u: [row('k', { v: null })] }, null).length, 0);
eq('GLORIA: locks, uuids and stamps are not compared', rowHash(g1.unit[0].data) === rowHash(gloriaSide(gdoc([{ ...blankN[0], uuid: 'other', done_locked: 0, updated_at: 5 }], [], [])).unit[0].data), true);
// Same quadrat, same species, different serials and occurrence ids, different cover.
const h1 = gloriaSide(gdoc([unit('N11', 30)], [us('N11', 1, 'o1', 30)], [taxon(1, 'tA')]));
const h2 = gloriaSide(gdoc([unit('N11', 30)], [us('N11', 4, 'o9', 25)], [taxon(4, 'tA')]));
const hd = diffSides(h1, h2, null, COMBINERS.gloria);
eq('GLORIA: same unit+taxon under another id → duplicate with the cover difference', [kinds(hd), hd[0]?.fields], [['duplicate:o9'], ['cover_pct']]);

// ── 9. the export's sync block ──
eq('sync block read', readSyncBlock({ sync: { exported_at: 5, base: [['sp', 'a', 'h'], ['bad']] } }), { exported_at: 5, base: [['sp', 'a', 'h']] });
eq('no sync block → no ancestor', readSyncBlock({}), null);
eq('sync block carries the sender\'s team name, trimmed', readSyncBlock({ sync: { exported_at: 5, base: [], author: '  林 ' } }).author, '林');
eq('no author → none', 'author' in readSyncBlock({ sync: { exported_at: 5, base: [] } }), false);
eq('blank and missing hash alike', rowHash({ a: 1, b: '' }) === rowHash({ a: 1 }), true);

if (failed) {
  console.error(`check:merge — ${failed} failed`);
  process.exit(1);
}
console.log('✓ merge: duplicates, ancestor-based auto/conflict/deletion, idempotence, round trip, combined fields, GLORIA');
