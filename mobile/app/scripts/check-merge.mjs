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
 *   - surveyors / time span combined, not asked;
 *   - a sender that uploaded before merging (empty base): this device's own
 *     base fills in, so the teammate's plain edit is taken, not a conflict.
 */
import {
  baseOf,
  countChanges,
  defaultDecision,
  describeMerge,
  diffSides,
  planOps,
  readSyncBlock,
  rowHash,
  summarizeItems,
} from '../src/lib/mergeEngine.ts';
import { askQuadratGeometry, COMBINERS, gloriaSide, plotSide, remoteFreqGridN, sessionSide, tieQuadratGeometry, trackUnion } from '../src/lib/mergeDocs.ts';

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

// ── 2b. the merge log reads back what was written ──
{
  const dec = decide(d2, (i) => (i.kind === 'conflict' ? { pick: 'local', fields: { cover: 'remote' } } : null));
  eq('log: auto and per-field conflict both show old → new', describeMerge(d2, dec).map((c) => [c.action, c.label, c.fields]),
    [['changed', 'x', [{ f: 'cover', from: 5, to: 20 }]], ['changed', 'y', [{ f: 'cover', from: 10, to: 15 }]]]);
  eq('log: keeping mine on a conflict logs nothing for it', describeMerge(d2, decide(d2, (i) => (i.kind === 'conflict' ? { pick: 'local' } : null))).map((c) => c.label), ['x']);
  const dm = describeMerge(first, decide(first, () => null));
  eq('log: 7 added, duplicates kept mine → not logged', countChanges(dm), { added: 7, changed: 0, deleted: 0 });
  eq('log: keep both → the duplicates are added too', countChanges(describeMerge(first, decide(first, (i) => (i.kind === 'duplicate' ? { pick: 'both' } : null)))).added, 10);
}

// ── 3. deletions through the ancestor ──
const base3 = baseOf({ sp: [row('p', { taxon_id: 't1', v: 1 }), row('q', { taxon_id: 't2', v: 1 }), row('s', { taxon_id: 't3', v: 1 })] });
const L3 = { sp: [row('p', { taxon_id: 't1', v: 1 }), row('q', { taxon_id: 't2', v: 2 })] }; // s deleted here
const R3 = { sp: [row('s', { taxon_id: 't3', v: 1 })] }; // p, q deleted there
eq('deleted there: unchanged here → asked; changed here → conflict; deleted here → nothing',
  kinds(diffSides(L3, R3, base3)), ['remoteDeleted:p', 'deleteConflict:q']);
const R3b = { sp: [row('s', { taxon_id: 't3', v: 9 })] };
eq('deleted here but changed there → delete conflict', kinds(diffSides(L3, R3b, base3)).includes('deleteConflict:s'), true);
eq('nothing is deleted by default', planOps(diffSides(L3, R3, base3), new Map()).filter((o) => o.op === 'delete').length, 0);

{
  const d3 = diffSides(L3, R3, base3);
  const all = decide(d3, () => ({ pick: 'remote' }));
  eq('log: nothing deleted by default; taken deletions match the written ones',
    [countChanges(describeMerge(d3, new Map())).deleted, countChanges(describeMerge(d3, all)).deleted],
    [0, planOps(d3, all).filter((o) => o.op === 'delete').length]);
}

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
eq('GLORIA: uuids and stamps are not compared', rowHash(g1.unit[0].data) === rowHash(gloriaSide(gdoc([{ ...blankN[0], uuid: 'other', updated_at: 5 }], [], [])).unit[0].data), true);
// 完成 locks are merged (a teammate's 完成 must arrive), as 1 / null: an
// unlocked unit hashes as it did before locks were merged, so old bases hold.
{
  const bare = (lock) => gloriaSide(gdoc([{ ...unit('N11', 30), done_locked: lock }], [], []));
  const { done_locked: _d, ...noLock } = bare(0).unit[0].data;
  eq('GLORIA: unlocked (0) hashes like a row from before locks were merged', rowHash(bare(0).unit[0].data) === rowHash(noLock), true);
  eq('GLORIA: locked and unlocked differ', rowHash(bare(1).unit[0].data) === rowHash(bare(0).unit[0].data), false);
  const oldBase = [['unit', 'N11', rowHash(noLock)]];
  eq('GLORIA: the leader\'s 完成 reaches the member automatically (Device_test 43-4)', kinds(diffSides(bare(0), bare(1), oldBase, COMBINERS.gloria)), ['auto:N11']);
  eq('GLORIA: the member\'s unlocked copy does not undo the leader\'s 完成', diffSides(bare(1), bare(0), oldBase, COMBINERS.gloria).length, 0);
}
// Same quadrat, same species, different serials and occurrence ids, different cover.
const h1 = gloriaSide(gdoc([unit('N11', 30)], [us('N11', 1, 'o1', 30)], [taxon(1, 'tA')]));
const h2 = gloriaSide(gdoc([unit('N11', 30)], [us('N11', 4, 'o9', 25)], [taxon(4, 'tA')]));
const hd = diffSides(h1, h2, null, COMBINERS.gloria);
eq('GLORIA: same unit+taxon under another id → duplicate with the cover difference', [kinds(hd), hd[0]?.fields], [['duplicate:o9'], ['cover_pct']]);

// ── 8b. GLORIA temperature-logger visits (v65) ──
{
  const lgr = (uuid, o = {}) => ({ uuid, role: 'install', direction: 'E', quadrat: 'E22', label: 'c', serial: '111', logger_type: 'Hobo', start_ts: 1, stop_ts: null, utc_diff_h: -8, dist11_m: 1, dist31_m: 2, photo_open: 0, photo_closed: null, photo_open_uri: null, photo_closed_uri: null, flags: null, researcher: null, comments: null, data_files: null, prev_uuid: null, sort_order: 0, updated_at: 1, ...o });
  const withVisits = (loggers, vo = {}) => ({ ...gdoc([], [], []), logger_visits: [{ uuid: 'v1', visit_ts: 5, researchers: '陳', comments: null, form4_files: null, locked: null, created_at: 1, updated_at: 1, ...vo, loggers }] });
  const A = gloriaSide(withVisits([lgr('l1')]));
  const baseA = baseOf(A);
  eq('GLORIA loggers: a teammate\'s new logger is added', kinds(diffSides(A, gloriaSide(withVisits([lgr('l1'), lgr('l2', { label: 'd', serial: '222' })])), baseA)), ['added:l2']);
  eq('GLORIA loggers: a teammate\'s read-out time is taken automatically', kinds(diffSides(A, gloriaSide(withVisits([lgr('l1', { stop_ts: 9 })])), baseA)), ['auto:l1']);
  eq('GLORIA loggers: photos and files are not compared; tick 0 is the same as none',
    diffSides(A, gloriaSide(withVisits([lgr('l1', { photo_open: null, photo_open_uri: 'ph://x', data_files: '[{"uri":"f","name":"a.csv"}]' })], { form4_files: '[]' })), baseA).length, 0);
  eq('GLORIA loggers: the same serial entered on two devices apart is a possible duplicate',
    kinds(diffSides(A, gloriaSide(withVisits([lgr('l9')])), null)), ['duplicate:l9']);
  eq('GLORIA loggers: a visit marked done arrives', kinds(diffSides(A, gloriaSide(withVisits([lgr('l1')], { locked: 1 })), baseA)), ['auto:v1']);
}

// ── 9. the export's sync block ──
eq('sync block read', readSyncBlock({ sync: { exported_at: 5, base: [['sp', 'a', 'h'], ['bad']] } }), { exported_at: 5, base: [['sp', 'a', 'h']] });
eq('no sync block → no ancestor', readSyncBlock({}), null);
eq('sync block carries the sender\'s team name, trimmed', readSyncBlock({ sync: { exported_at: 5, base: [], author: '  林 ' } }).author, '林');
eq('no author → none', 'author' in readSyncBlock({ sync: { exported_at: 5, base: [] } }), false);
eq('blank and missing hash alike', rowHash({ a: 1, b: '' }) === rowHash({ a: 1 }), true);

// ── 10. stale sender base (team sync uploads before it merges) ──
{
  const side = (rows) => ({ unit: Object.entries(rows).map(([k, d]) => row(k, d)) });
  const L0 = side({ N11: { cov: 10 }, N31: { cov: 20 } }); // leader's first upload, imported by the member
  const M1 = side({ N11: { cov: 10 }, N31: { cov: 25 } }); // member changed N31
  const L1 = side({ N11: { cov: 15 }, N31: { cov: 20 } }); // leader changed N11, uploaded with an empty base
  eq('empty sender base alone: the leader\'s edit is a conflict (the reported bug)',
    kinds(diffSides(M1, L1, [])), ['conflict:N11', 'conflict:N31']);
  eq('own base fills in: leader\'s edit taken, member\'s kept, nothing asked',
    kinds(diffSides(M1, L1, [], {}, baseOf(L0))), ['auto:N11']);
  const stale = baseOf(side({ N11: { cov: 99 }, N31: { cov: 20 } }));
  eq('the sender\'s base still wins where it has the row',
    kinds(diffSides(M1, L1, baseOf(L0), {}, stale)), ['auto:N11']);
  eq('the sender\'s base is not overridden by the fallback',
    kinds(diffSides(M1, L1, stale, {}, baseOf(L0))), ['conflict:N11']);
}

// ── 11. plot quadrats (v77) ──
{
  const M5 = '1'.repeat(3) + '0'.repeat(22);
  const quad = (idx, { dev = 'a', ...over } = {}, species = []) => ({
    idx, uuid: `u${idx}-${dev}`, label: `Q${idx}`, position: null, subplot: null, size_m: 1, grid_n: 5, top_edge: 'N',
    lat: null, lng: null, accuracy: null, cov_vascular: null, cov_solid_rock: null, cov_scree: null, cov_lichens: null,
    cov_bryophytes: null, cov_bare_ground: null, cov_litter: null, freq_mode: 'cells', locked: 0, started_at: 100, ended_at: null,
    notes: null, photo_files: [], species, ...over,
  });
  const sp = (taxon, over = {}) => ({ taxon_id: taxon, name: taxon, cname: null, cover_pct: null, freq_cells: null, freq_count: null, height_cm: null, notes: null, ...over });
  const plot = (quadrats, config) => ({ uuid: 'p', plotid: 'P', plot_type: 'fixed', species: [], quadrats, quadrat_config: config ?? null });
  const cfg = (o) => JSON.stringify({ enabled: true, layout: 'cornersCenter', recordCover: true, recordFreq: true, recordSurface: true, carryPrevious: false, sizeM: 1, gridN: 5, topEdge: 'N', ...o });

  eq('quadrats: a plot without them has no quadrat tables (old hashes stay)', Object.keys(plotSide(plot([]))).filter((k) => k.startsWith('q')), []);
  // Both devices switched the module on: their Q1 is the same quadrat, whatever its uuid.
  const A = plotSide(plot([quad(1, { dev: 'a' }, [sp('t1', { cover_pct: 20 })])], cfg({})));
  const B = plotSide(plot([quad(1, { dev: 'b' }, [sp('t2', { cover_pct: 5 })])], cfg({})));
  eq('quadrats keyed by number: no second Q1, the teammate\'s species is new', kinds(diffSides(A, B, null)), ['added:1:t2']);

  // Settings compared one by one: grid here, layout there — no conflict.
  const base = baseOf(plotSide(plot([quad(1)], cfg({}))));
  const cl = plotSide(plot([quad(1)], cfg({ gridN: 6 })));
  const cr = plotSide(plot([quad(1)], cfg({ layout: 'diagonal' })));
  const ci = diffSides(cl, cr, base);
  eq('config: different settings changed on each side → taken, not asked', kinds(ci), ['auto:layout']);
  eq('config: only the teammate\'s setting is written', planOps(ci, new Map()).map((o) => [o.key, o.data]), [['layout', { value: 'diagonal' }]]);

  // A lock is shared progress.
  const lk = diffSides(plotSide(plot([quad(1)])), plotSide(plot([quad(1, { locked: 1 })])), baseOf(plotSide(plot([quad(1)]))));
  eq('lock: the teammate\'s 完成 arrives', [kinds(lk), lk[0]?.fields], [['auto:1'], ['locked']]);

  // Masks: one value each, a conflict is one field, never a cell union.
  const b2 = baseOf(plotSide(plot([quad(1, {}, [sp('t1')])])));
  const mi = diffSides(
    plotSide(plot([quad(1, {}, [sp('t1', { freq_cells: M5 })])])),
    plotSide(plot([quad(1, {}, [sp('t1', { freq_cells: '0'.repeat(24) + '1' })])])),
    b2,
  );
  eq('mask: both painted → one conflict on the whole mask', [kinds(mi), mi[0]?.fields], [['conflict:1:t1'], ['freq_cells']]);

  // Geometry disagreement: the quadrat and its species follow one side.
  const g0 = plotSide(plot([quad(1, {}, [sp('t1')])]));
  const gl = plotSide(plot([quad(1, {}, [sp('t1', { freq_cells: M5 }), sp('t3', { cover_pct: 3 })])]));
  const gr = plotSide(plot([quad(1, { grid_n: 4 }, [sp('t1', { freq_cells: '1'.repeat(16) }), sp('t2', { cover_pct: 9 })])]));
  const raw = diffSides(gl, gr, baseOf(g0));
  eq('geometry: changed only there → would be taken automatically', raw.find((x) => x.tbl === 'quadrat')?.kind, 'auto');
  const gi = askQuadratGeometry(raw, gl);
  eq('geometry: cells painted here → asked instead', [gi.find((x) => x.tbl === 'quadrat')?.kind, gi.find((x) => x.tbl === 'quadrat')?.fields], ['conflict', ['grid_n']]);
  const unpainted = plotSide(plot([quad(1, {}, [sp('t1', { cover_pct: 4 })])]));
  eq('geometry: nothing painted here → still taken automatically', askQuadratGeometry(diffSides(unpainted, gr, baseOf(g0)), unpainted).find((x) => x.tbl === 'quadrat')?.kind, 'auto');
  const pickRemoteGrid = new Map([[gi.find((x) => x.tbl === 'quadrat').id, { pick: 'local', fields: { grid_n: 'remote' } }]]);
  const tied = tieQuadratGeometry(gi, pickRemoteGrid);
  eq('geometry: their grid chosen → every item of the quadrat takes theirs', gi.map((x) => `${x.key}:${tied.get(x.id)?.pick}`), ['1:remote', '1:t1:remote', '1:t2:remote']);
  const tiedLocal = tieQuadratGeometry(gi, new Map());
  eq('geometry: kept here → their new species of that quadrat are not added', gi.map((x) => `${x.key}:${tiedLocal.get(x.id)?.pick}`), ['1:local', '1:t1:local', '1:t2:local']);
  const ops = planOps(gi, tied);
  eq('geometry: their grid and mask are written together', ops.filter((o) => o.op === 'update').map((o) => [o.key, o.data.grid_n ?? null, o.data.freq_cells ?? null]), [['1', 4, null], ['1:t1', null, '1'.repeat(16)]]);
  eq('geometry: an unrelated quadrat is left to the reviewer', tieQuadratGeometry(mi, new Map()).size, 0);
  // The grid is the plot's: the gridN setting's side decides every quadrat.
  const cfgBase = plotSide(plot([quad(1, {}, [sp('t1')]), quad(2)], cfg({})));
  const gL = plotSide(plot([quad(1, {}, [sp('t1', { freq_cells: M5 })]), quad(2)], cfg({ gridN: 5 })));
  const gR = plotSide(plot([quad(1, { grid_n: 4 }, [sp('t1', { freq_cells: '1'.repeat(16) })]), quad(2, { grid_n: 4 })], cfg({ gridN: 4 })));
  const gItems = askQuadratGeometry(diffSides(gL, gR, baseOf(cfgBase)), gL);
  const gridItem = gItems.find((x) => x.tbl === 'qconfig' && x.key === 'gridN');
  eq('grid setting: their grid while cells are painted here → asked', gridItem?.kind, 'conflict');
  const gTied = tieQuadratGeometry(gItems, new Map([[gridItem.id, { pick: 'remote' }]]));
  eq('grid setting: their grid chosen → every quadrat with another grid takes theirs', gItems.filter((x) => x.tbl !== 'qconfig').map((x) => `${x.key}:${gTied.get(x.id)?.pick}`), ['1:remote', '2:remote', '1:t1:remote']);

  // The plot's own frequency grid (v78): taken quietly it would drop every mask here (code review H2).
  const psp = (o) => ({ occurrence_id: 'o1', taxon_id: 't1', name: 't1', freq_cells: null, freq_count: null, cover_pct: null, ...o });
  const pplot = (species, config) => ({ ...plot([], config), species });
  const pBase = plotSide(pplot([psp({})], cfg({ freqGridN: 5 })));
  const pLocal = plotSide(pplot([psp({ freq_cells: M5 })], cfg({ freqGridN: 5 })));
  const pRemote = plotSide(pplot([psp({ cover_pct: 8 })], cfg({ freqGridN: 4 })));
  eq('plot frequency grid: theirs while masks are painted here → asked', askQuadratGeometry(diffSides(pLocal, pRemote, baseOf(pBase)), pLocal).find((x) => x.key === 'freqGridN')?.kind, 'conflict');
  eq('plot frequency grid: nothing painted here → taken', askQuadratGeometry(diffSides(pBase, pRemote, baseOf(pBase)), pBase).find((x) => x.key === 'freqGridN')?.kind, 'auto');
  const pCount = plotSide(pplot([psp({ freq_count: 12 })], cfg({ freqGridN: 5, freqMode: 'cells' })));
  eq('plot frequency way: their switch while counts are here → asked', askQuadratGeometry(diffSides(pCount, plotSide(pplot([psp({})], cfg({ freqGridN: 5, freqMode: 'count' }))), baseOf(plotSide(pplot([psp({})], cfg({ freqGridN: 5, freqMode: 'cells' }))))), pCount).find((x) => x.key === 'freqMode')?.kind, 'conflict');
  const p2 = askQuadratGeometry(diffSides(pLocal, plotSide(pplot([psp({ freq_cells: '1'.repeat(16) })], cfg({ freqGridN: 4 }))), baseOf(pBase)), pLocal);
  const f2 = p2.find((x) => x.key === 'freqGridN');
  const spMasks = (d) => planOps(p2, d).filter((o) => o.tbl === 'sp' && o.data.freq_cells != null).map((o) => o.data.freq_cells);
  eq('plot frequency grid: theirs chosen → their masks come with it', spMasks(tieQuadratGeometry(p2, new Map([[f2.id, { pick: 'remote' }]]))), ['1'.repeat(16)]);
  eq('plot frequency grid: ours kept → ours stay', spMasks(tieQuadratGeometry(p2, new Map())), []);
  eq('plot frequency grid: their grid, for the counts made on it (code review M45)', remoteFreqGridN(p2), 4);
  eq('plot frequency grid: none when the two agree', remoteFreqGridN(diffSides(pLocal, pLocal, baseOf(pBase))), null);
  // The top edge the masks are drawn against: theirs alone while masks are here is asked (code review M46).
  // (A phone with masks cannot turn its edge: the screen locks it, so theirs has none.)
  // (Configs are stored whole by setQuadratConfig, so both copies name an edge.)
  const eBase = plotSide(pplot([psp({})], cfg({ freqGridN: 5, freqTopEdge: 'N' })));
  const eLocal = plotSide(pplot([psp({ freq_cells: M5 })], cfg({ freqGridN: 5, freqTopEdge: 'N' })));
  const pEdge = askQuadratGeometry(diffSides(eLocal, plotSide(pplot([psp({})], cfg({ freqGridN: 5, freqTopEdge: 'E' }))), baseOf(eBase)), eLocal);
  eq('plot frequency top edge: theirs while masks are painted here → asked', pEdge.find((x) => x.key === 'freqTopEdge')?.kind, 'conflict');
  // A quadrat that differs only in its way: its species follow the side picked (code review M47).
  const wBase = plotSide(plot([quad(1, {}, [sp('t1')])]));
  const wLocal = plotSide(plot([quad(1, {}, [sp('t1', { freq_cells: M5 })])]));
  const wRemote = plotSide(plot([quad(1, { freq_mode: 'count' }, [sp('t1', { freq_count: 7 }), sp('t3', { freq_count: 4 })])]));
  const wi = askQuadratGeometry(diffSides(wLocal, wRemote, baseOf(wBase)), wLocal);
  const wq = wi.find((x) => x.tbl === 'quadrat');
  eq('quadrat way: theirs while cells are painted here → asked', wq?.kind, 'conflict');
  const wTheirs = tieQuadratGeometry(wi, new Map([[wq.id, { pick: 'remote' }]]));
  eq('quadrat way: theirs chosen → every species of the quadrat takes theirs', wi.map((x) => `${x.key}:${wTheirs.get(x.id)?.pick}`), ['1:remote', '1:t1:remote', '1:t3:remote']);
  const wOurs = tieQuadratGeometry(wi, new Map());
  eq('quadrat way: ours kept → their counts are not added', wi.map((x) => `${x.key}:${wOurs.get(x.id)?.pick}`), ['1:local', '1:t1:local', '1:t3:local']);
}

// ── review titles: scientific names as parts the review italicises (rank looked up by taxon) ──
{
  const rec = (taxon_id, over = {}) => ({ occurrence_id: `o-${taxon_id}`, taxon_id, name: null, family: null, used_scientific_name: null, ...over });
  const ss = sessionSide({ ...S('甲', 1, null, null), records: [rec('t1', { name: 'Litsea' }), rec('t2', { name: 'Rubus', used_scientific_name: 'Rubus croceacanthus var. croceacanthus' }), rec('t3')] });
  eq('titles: a checklist row is its scientific name, with the taxon for its rank', ss.rec.map((r) => r.title), [
    [{ sci: 'Litsea', taxonId: 't1' }],
    [{ sci: 'Rubus croceacanthus var. croceacanthus', taxonId: 't2' }],
    ['t3'],
  ]);
  eq('titles: the label (merge log text) is unchanged', ss.rec.map((r) => r.label), ['Litsea', 'Rubus croceacanthus var. croceacanthus', 't3']);
  eq('titles: never part of a row\'s hash', baseOf(ss), baseOf({ ...ss, rec: ss.rec.map(({ title: _t, ...r }) => r) }));
  const ps = plotSide({ uuid: 'p', plotid: 'P', plot_type: 'fixed', species: [{ occurrence_id: 'o1', taxon_id: 't1', name: 'Litsea', layer: 1, subplot: 'A' }], quadrats: [
    { idx: 1, label: 'Q1', species: [{ taxon_id: 't1', name: 'Litsea', cname: null }, { taxon_id: 't2', name: 'Rubus', cname: '懸鉤子' }] },
  ] });
  eq('titles: a plot species row', ps.sp[0].title, [{ sci: 'Litsea', taxonId: 't1' }]);
  eq('titles: a quadrat species is its common name as text, else its scientific name', ps.qsp.map((r) => r.title), [[{ sci: 'Litsea', taxonId: 't1' }], ['懸鉤子']]);
  const gs = gloriaSide(gdoc([unit('N11', 30)], [us('N11', 1, 'o1', 30), us('N11', 2, 'o2', 30)], [
    { ...taxon(1, 'tC'), scientific_name: 'Carex' , verbatim_identification: 'sp1' },
    taxon(2, 'tD'),
  ]));
  eq('titles: a GLORIA species keeps its morphospecies label after the name', gs.sp.map((r) => r.title), [[{ sci: 'Carex', taxonId: 'tC' }, ' sp1'], ['tD']]);
  // The merge log keeps the parts, with the group in front as the label has it.
  const added = describeMerge(diffSides(plotSide({ ...ps, species: [] }), ps, null), new Map());
  const spAdded = added.find((x) => x.tbl === 'sp');
  eq('titles: the merge log carries them, group first', [spAdded.label, spAdded.title], ['A · Litsea', ['A · ', { sci: 'Litsea', taxonId: 't1' }]]);
  eq('titles: a row without names has none in the log', 'title' in added.find((x) => x.tbl === 'quadrat'), false);
}

if (failed) {
  console.error(`check:merge — ${failed} failed`);
  process.exit(1);
}
console.log('✓ merge: duplicates, ancestor-based auto/conflict/deletion, idempotence, round trip, combined fields, GLORIA, stale sender base');
