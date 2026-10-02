/**
 * The 1E stress test's pieces that must hold under Node (the timings
 * themselves are taken on devices, app/settings/survey-stress.tsx):
 *
 *   - the test plot is deterministic: one seed, one plot, on every device;
 *   - a census slice does not hit SQLite's parameter limit (32 766 per
 *     statement), however many trees it covers — a whole-census export or a
 *     merge from a file of a large plot reads them all;
 *   - BYTES_PER_STEM (src/survey/stemmap/syncBlocks.ts) is at least what one
 *     stem of a real sealed 1 ha block takes, merge base included, so the
 *     block-size choice never under-estimates an upload.
 *
 * Run: npm run check:census-stress
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { runUserMigrations } from '../src/db/migrations.ts';
import * as s from '../src/survey/db/stemmapCore.ts';
import * as sl from '../src/survey/db/sliceCore.ts';
import * as cs from '../src/survey/db/censusSyncCore.ts';
import * as st from '../src/survey/stress/stressCore.ts';
import { BYTES_PER_STEM } from '../src/survey/stemmap/syncBlocks.ts';
import { aadFor, b64u, NONCE_BYTES, sealRecord } from '../src/lib/teamCrypto.ts';
import { baseOf } from '../src/lib/mergeEngine.ts';
import { STEMMAP_TEMPLATE } from '../src/survey/templates/stemmap.ts';

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};

// The app's SQLite is op-sqlite's own copy, compiled with SQLITE_MAX_VARIABLE_NUMBER
// 32766 (node_modules/@op-engineering/op-sqlite/cpp/sqlite3.c); Node's allows more,
// so the harness holds every statement to the app's limit.
const APP_MAX_PARAMS = 32_766;
const sqlite = new DatabaseSync(':memory:');
const db = {
  executeSync(sql, params = []) {
    if (params.length > APP_MAX_PARAMS) throw new Error(`too many SQL variables (${params.length})`);
    const stmt = sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params) };
    const res = stmt.run(...params);
    return { rows: [], insertId: Number(res.lastInsertRowid), rowsAffected: res.changes };
  },
};
await runUserMigrations(db);
sqlite.exec('PRAGMA foreign_keys = ON;');
let clock = 1;
// Real random uuids: short sequential ones compress far better and made a block look three times smaller (1E).
const ctx = { db, now: () => ++clock, uuid: () => crypto.randomUUID() };
const tx = (fn) => {
  sqlite.exec('BEGIN');
  try {
    const r = fn();
    sqlite.exec('COMMIT');
    return r;
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }
};

// ── the plan ─────────────────────────────────────────────────────────────
const plan = st.buildStressPlan('20k');
const again = st.buildStressPlan('20k');
ok(plan.trees.length === 20_000 && plan.recruits.length === 600, `plan: 20 000 trees and 600 recruits (${plan.trees.length}, ${plan.recruits.length})`);
ok(JSON.stringify(plan.trees.slice(0, 50)) === JSON.stringify(again.trees.slice(0, 50)) && plan.trees[19_999].x === again.trees[19_999].x, 'plan: the same seed gives the same plot');
const stems = plan.trees.reduce((a, t) => a + t.stems.length, 0);
ok(stems > 24_000 && stems < 28_000, `plan: about 1.3 stems a tree (${stems})`);
ok(plan.trees.every((t) => t.x > 0 && t.x < 500 && t.y > 0 && t.y < 500), 'plan: inside the 25 ha plot');
const big = st.buildStressPlan('50k');
ok(big.trees.length === 50_000 && big.trees.every((t) => t.x < 1000 && t.y < 500), 'plan: the 50 ha option');

// ── the parameter limit ──────────────────────────────────────────────────
let limitHit = false;
try {
  db.executeSync(`SELECT 1 WHERE 'x' IN (${Array.from({ length: 40_000 }, () => '?').join(',')})`, Array.from({ length: 40_000 }, (_, i) => `v${i}`));
} catch {
  limitHit = true;
}
ok(limitHit, '(the harness refuses 40 000 parameters in one statement, as the app does)');

// The 1 ha in the plot's south-west corner, censused twice (census 2 covers the west half).
const corner = { ...plan, trees: plan.trees.filter((t) => t.x < 100 && t.y < 100), recruits: plan.recruits.filter((t) => t.x < 100 && t.y < 100) };
const made = tx(() => st.createStressPlot(ctx, '20k', STEMMAP_TEMPLATE));
const ids = new Map();
tx(() => st.writeCensus1(ctx, made.census1, corner, 0, corner.trees.length, ids));
s.finishCensus(ctx, made.census1);
const census2 = s.startCensus(ctx, { frameId: made.frameId, template: STEMMAP_TEMPLATE });
tx(() => st.writeCensus2(ctx, census2, corner, 0, corner.trees.length, ids, true));
const fakeExtras = Array.from({ length: 40_000 }, (_, i) => `not-a-tree-${i}`);
let slice = null;
try {
  slice = sl.buildSlice(ctx, census2, ['0000'], fakeExtras);
} catch (e) {
  ok(false, `slice: 40 000 extra trees refused (${e.message})`);
}
ok(slice && slice.trees.length > 0, 'slice: 40 000 extra trees go through a temp table, not parameters');

// ── per-tree work does not walk the whole census ─────────────────────────
// Saving, correcting, opening a quadrat, its version slice and a tag
// suggestion run per tree, many times a day: a statement whose plan walks a
// whole census table makes each of them slower as the plot fills (1E found
// two). The plan of every distinct statement they run is checked.
const BIG = new Set(['fw_individuals', 'fw_stems', 'fw_stem_measures', 'fw_stem_values', 'fw_individual_values', 'fw_media']);
const seen = new Set();
const orig = db.executeSync;
db.executeSync = (sql, params = []) => {
  // INSERT … SELECT too: buildSlice's tree scope is one, and it walked the plot unseen (1E).
  if (/^\s*SELECT\b/i.test(sql) || /^\s*INSERT\b[\s\S]*\bSELECT\b/i.test(sql)) seen.add(sql);
  return orig(sql, params);
};
const someTree = ids.get(corner.trees[5].tag);
const view = s.loadTree(ctx, census2, someTree);
tx(() =>
  s.saveTreeDraft(ctx, census2, {
    individualId: someTree, tag: null, taxon: null, location: null, notes: 'x', heightM: null, treeCodes: [],
    mainStemNo: view.stems[0].stem.stem_no,
    stems: view.stems.map((x) => ({ stemNo: x.stem.stem_no, dbhCm: 9.9, pomM: 1.3, stemDead: false, codes: [], notes: null })),
    recordedBy: null,
  }),
);
tx(() => st.writeCensus1(ctx, census2, { ...corner, trees: [{ ...corner.trees[0], tag: '99999', x: 50, y: 50 }] }, 0, 1, new Map()));
tx(() => s.correctIndividual(ctx, someTree, { tag: '88888' }, { surveyId: census2, reason: null, by: null }));
s.suggestTag(ctx, s.getFrame(ctx, made.frameId), { x: 10, y: 10 });
s.suggestTag(ctx, s.getFrame(ctx, made.frameId), { x: 10, y: 10 }, 70001);
s.loadFgQuadrat(ctx, census2, '0000');
s.loadCensusQuadrats(ctx, census2, ['0000', '0001']);
sl.buildSlice(ctx, census2, ['0000']);
db.executeSync = orig;
const walks = [];
for (const sql of seen) {
  const n = (sql.match(/\?/g) ?? []).length;
  let plan;
  try {
    plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, () => 1));
  } catch {
    continue;
  }
  // Plans name a table by its alias (`SEARCH m USING …`): map aliases back.
  const alias = new Map();
  for (const m of sql.matchAll(/(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    alias.set(m[1], m[1]);
    if (m[2] && !/^(ON|WHERE|JOIN|LEFT|CROSS|INNER|ORDER|GROUP|LIMIT)$/i.test(m[2])) alias.set(m[2], m[1]);
  }
  for (const { detail } of plan) {
    const scan = /^SCAN (\w+)/.exec(detail);
    const byPrefix = /^SEARCH (\w+) USING (?:COVERING )?INDEX \S+ \((?:frame_id|survey_id)=\?\)$/.exec(detail);
    const name = (scan ?? byPrefix)?.[1];
    const t = name ? (alias.get(name) ?? name) : null;
    if (t && BIG.has(t)) walks.push(`${detail}  ←  ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
}
ok(seen.size > 20, `plans: the per-tree paths ran (${seen.size} statements)`);

// ── a census read in pieces is the census ────────────────────────────────
// The checks list reads 25 quadrats at a time to show how far it is.
{
  const whole = s.loadCensus(ctx, census2);
  const codes = s.treeQuadratCodes(ctx, census2);
  const pieces = [];
  for (let i = 0; i < codes.length; i += 3) pieces.push(...s.loadCensusQuadrats(ctx, census2, codes.slice(i, i + 3)));
  pieces.sort(s.TAG_ORDER);
  ok(whole.length > 500 && JSON.stringify(pieces) === JSON.stringify(whole), `pieces: quadrats read in pieces give loadCensus (${pieces.length} of ${whole.length} trees)`);
}
ok(walks.length === 0, `plans: no per-tree statement walks a whole census table\n    ${walks.join('\n    ')}`);

// ── bytes per stem ───────────────────────────────────────────────────────
tx(() => cs.setBlockSize(ctx, census2, 5));
const doc = cs.buildBlockDoc(ctx, census2, 'b0_0');
const stemCount = doc.slice.stems.length;
// The merge base a teammate's copy brings is as large as the rows themselves: the worst case.
const base = baseOf(cs.blockSide(doc.slice));
const text = JSON.stringify({ ...doc, sync: { exported_at: Date.now(), base, author: 'A teammate with a long name' } });
const key = new Uint8Array(randomBytes(32));
// Before base64: chooseSyncBlock adds BASE64_FACTOR itself (§7.9's formula).
const sealed = sealRecord(key, new Uint8Array(randomBytes(NONCE_BYTES)), text, aadFor('t'.repeat(32), 'r'.repeat(43), 'd'.repeat(43)));
const perStem = sealed.length / stemCount;
console.log(`  1 ha block: ${doc.slice.trees.length} trees, ${stemCount} stems, ${(text.length / 1024).toFixed(0)} KB JSON → ${(sealed.length / 1024).toFixed(0)} KB sealed (${(b64u(sealed).length / 1024).toFixed(0)} KB as base64), ${perStem.toFixed(0)} B a stem`);
ok(stemCount > 1000, `bytes: a real 1 ha block (${stemCount} stems)`);
ok(perStem <= BYTES_PER_STEM, `bytes: BYTES_PER_STEM ${BYTES_PER_STEM} is at least the measured ${perStem.toFixed(0)} B a stem`);

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ census-stress: the test plot is reproducible, slices take any size, and the bytes-per-stem constant holds');
