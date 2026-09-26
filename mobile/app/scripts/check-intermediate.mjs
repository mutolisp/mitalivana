#!/usr/bin/env node
/**
 * Intermediate ranks in the taxonomy tree (subfamily, tribe, superfamily …):
 * the arranging logic of `src/lib/intermediateRanks.ts`, run against the real
 * tw-taicol module (its `taxon_tree` / `rank_bridge`) plus an in-memory user
 * layer, the way `src/db/intermediateTaxa.ts` wires them in the app.
 *
 * What must hold:
 *   - TaiCOL's own placements show up (Hemiptera → Auchenorrhyncha →
 *     Membracoidea → Cicadellidae; Cicadellidae → Ledrinae → Ledra)
 *   - a user node + placement puts a genus TaiCOL leaves bare under it
 *     (竹亞科 Bambusoideae ← Bambusa), and the user wins over TaiCOL
 *   - the "below order" mode hides ranks above order, and a hidden level is
 *     skipped, not a dead end
 *   - export resolution ignores the mode
 *   - a module without the tables, and a re-parenting cycle, degrade instead
 *     of breaking the tree
 *
 * Module path: $TW_TAICOL_DB, else dist/datasets/tw-taicol.db. Skipped when the
 * file is absent; FAILS when it exists but predates the tables — shipping that
 * would silently drop every intermediate.
 *
 * Usage: npm run check:intermediate   (exit 1 on violation)
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  arrange,
  buildOverlay,
  childKeyOf,
  fullChainOfChild,
  parseBridgeRows,
  taicolRowToNode,
  userRowToNode,
  visibleChainOfChild,
} from '../src/lib/intermediateRanks.ts';

const DB_PATH =
  process.env.TW_TAICOL_DB ?? fileURLToPath(new URL('../../../dist/datasets/tw-taicol.db', import.meta.url));

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('check:intermediate');
if (!existsSync(DB_PATH)) {
  console.log(`  – skipped: ${DB_PATH} not built (run \`make datasets\`)`);
  process.exit(0);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const hasTables =
  db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('taxon_tree','rank_bridge')").get()
    .n === 2;
ok(hasTables, `${DB_PATH} carries taxon_tree + rank_bridge`, 'rebuild with `make taicol-tree && make datasets`');
if (!hasTables) process.exit(1);

const taicol = new Map(db.prepare('SELECT * FROM taxon_tree').all().map((r) => [r.taxon_id, taicolRowToNode(r)]));
const bridgeFor = (ctx) =>
  parseBridgeRows(
    db
      .prepare(
        'SELECT child_name, chain FROM rank_bridge WHERE kingdom=? AND anchor_rank=? AND anchor_name=? AND child_rank=?',
      )
      .all(ctx.kingdom, ctx.anchorRank, ctx.anchorName, ctx.childRank),
  );
const col = (r) => (r === 'order' || r === 'class' ? `"${r}"` : r);
/** Fixed-rank children the tree lists under an anchor (same filter as the app). */
const fixedChildren = (kingdom, anchorRank, anchorName, childRank) =>
  db
    .prepare(
      `SELECT DISTINCT ${col(childRank)} AS name FROM taicol_names
        WHERE kingdom=? AND ${col(anchorRank)}=? AND usage_status='accepted' AND is_in_taiwan LIKE '%true%'
          AND rank IN ('Species','Subspecies','Variety','Form') AND ${col(childRank)} != ''`,
    )
    .all(kingdom, anchorName)
    .map((r) => r.name);

const overlayOf = (users = [], overrides = [], hasTaicol = true) =>
  buildOverlay({ taicol: hasTaicol ? taicol : new Map(), hasTaicol, users, overrides });
const byName = (name) => [...taicol.values()].find((n) => n.name === name);
const list = (ov, mode, ctx, children, via = []) => arrange(ov, mode, bridgeFor(ctx), ctx, children, via, (n) => n);
const groupNames = (r) => r.groups.map((g) => g.node.name);

// ── 1. TaiCOL placements ───────────────────────────────────────────────────
console.log('\n[TaiCOL] 半翅目');
{
  const ov = overlayOf();
  const ctx = { kingdom: 'Animalia', anchorRank: 'order', anchorName: 'Hemiptera', childRank: 'family' };
  const fams = fixedChildren('Animalia', 'order', 'Hemiptera', 'family');
  ok(fams.includes('Cicadellidae'), `Hemiptera has ${fams.length} families in Taiwan, Cicadellidae among them`);
  const top = list(ov, 'below_order', ctx, fams);
  ok(groupNames(top).includes('Auchenorrhyncha'), 'Hemiptera → 頸喙亞目 Auchenorrhyncha', groupNames(top).join(','));
  ok(!top.direct.includes('Cicadellidae'), 'Cicadellidae is not directly under Hemiptera any more');
  const auch = byName('Auchenorrhyncha');
  const lvl2 = list(ov, 'below_order', ctx, fams, [auch.ref]);
  ok(groupNames(lvl2).includes('Membracoidea'), 'Auchenorrhyncha → 角蟬總科 Membracoidea', groupNames(lvl2).join(','));
  const memb = byName('Membracoidea');
  const lvl3 = list(ov, 'below_order', ctx, fams, [auch.ref, memb.ref]);
  ok(lvl3.direct.includes('Cicadellidae'), 'Membracoidea → Cicadellidae', lvl3.direct.join(','));
  const members = top.groups.find((g) => g.node.name === 'Auchenorrhyncha').members;
  ok(members.includes('Cicadellidae'), 'group members include every family below it (stats source)');
  const total = top.direct.length + top.groups.reduce((n, g) => n + g.members.length, 0);
  ok(total === fams.length, 'no family is lost or doubled by grouping', `${total} vs ${fams.length}`);

  const gctx = { kingdom: 'Animalia', anchorRank: 'family', anchorName: 'Cicadellidae', childRank: 'genus' };
  const gens = fixedChildren('Animalia', 'family', 'Cicadellidae', 'genus');
  const g = list(ov, 'below_order', gctx, gens);
  const ledrinae = g.groups.find((x) => x.node.name === 'Ledrinae');
  ok(!!ledrinae && ledrinae.members.includes('Ledra'), 'Cicadellidae → 耳葉蟬亞科 Ledrinae → Ledra');
  ok(ledrinae?.node.name_c === '耳葉蟬亞科', 'TaiCOL common name carried', ledrinae?.node.name_c);
  const trail = visibleChainOfChild(ov, 'below_order', bridgeFor(gctx), gctx, 'Ledra').map((n) => n.name);
  ok(trail.join('>') === 'Ledrinae', 'jump trail to Ledra = Ledrinae', trail.join('>'));
}

// ── 2. Display mode ────────────────────────────────────────────────────────
console.log('\n[顯示層級] 目以下 vs 全部');
{
  const ov = overlayOf();
  const ctx = { kingdom: 'Animalia', anchorRank: 'class', anchorName: 'Insecta', childRank: 'order' };
  const orders = fixedChildren('Animalia', 'class', 'Insecta', 'order');
  const below = list(ov, 'below_order', ctx, orders);
  ok(below.groups.length === 0 && below.direct.length === orders.length, 'below order: Insecta lists its orders directly');
  const all = list(ov, 'all', ctx, orders);
  ok(groupNames(all).includes('Pterygota'), 'all: Insecta → 有翅亞綱 Pterygota', groupNames(all).join(','));
  // Hidden level skipped: under "below order" Lepidoptera still reaches its
  // superfamily even though Holometabola (superorder) sits above it.
  const lctx = { kingdom: 'Animalia', anchorRank: 'order', anchorName: 'Lepidoptera', childRank: 'family' };
  const lfams = fixedChildren('Animalia', 'order', 'Lepidoptera', 'family');
  ok(groupNames(list(ov, 'below_order', lctx, lfams)).includes('Papilionoidea'), 'Lepidoptera → 鳳蝶總科 Papilionoidea');
  const full = fullChainOfChild(ov, bridgeFor(lctx), lctx, 'Papilionidae').map((n) => n.name);
  ok(full.includes('Papilionoidea'), 'export chain ignores the mode', full.join('>'));
}

// ── 3. User layer: 竹亞科 ──────────────────────────────────────────────────
console.log('\n[使用者] 竹亞科 Bambusoideae');
{
  const ctx = { kingdom: 'Plantae', anchorRank: 'family', anchorName: 'Poaceae', childRank: 'genus' };
  const gens = fixedChildren('Plantae', 'family', 'Poaceae', 'genus');
  ok(gens.includes('Bambusa') && gens.includes('Phyllostachys'), `Poaceae has ${gens.length} genera incl. Bambusa`);
  const bare = list(overlayOf(), 'below_order', ctx, gens);
  ok(bare.direct.includes('Bambusa'), 'TaiCOL leaves Bambusa directly under Poaceae');

  const node = (id, rank, name, parent, cname = '') =>
    userRowToNode({ id, rank, simple_name: name, common_name_c: cname, kingdom: 'Plantae', anchor_rank: 'family', anchor_name: 'Poaceae', parent_ref: parent });
  const users = [node('unBAMB', 'subfamily', 'Bambusoideae', null, '竹亞科'), node('unBAMT', 'tribe', 'Bambuseae', 'unBAMB')];
  const empty = list(overlayOf(users), 'below_order', ctx, gens);
  ok(groupNames(empty).includes('Bambusoideae'), 'a new user node shows while still empty');

  const ov = overlayOf(users, [
    { child_key: childKeyOf('Plantae', 'genus', 'Bambusa'), parent_ref: 'unBAMT' },
    { child_key: childKeyOf('Plantae', 'genus', 'Phyllostachys'), parent_ref: 'unBAMB' },
  ]);
  const top = list(ov, 'below_order', ctx, gens);
  const bamb = top.groups.find((g) => g.node.name === 'Bambusoideae');
  ok(!!bamb && bamb.node.user && bamb.node.name_c === '竹亞科', 'Poaceae → 竹亞科 (user)');
  ok(bamb?.members.includes('Bambusa') && bamb?.members.includes('Phyllostachys'), 'both placed genera counted under it');
  ok(!top.direct.includes('Bambusa'), 'Bambusa left the Poaceae level');
  const inner = list(ov, 'below_order', ctx, gens, ['unBAMB']);
  ok(groupNames(inner).join() === 'Bambuseae' && inner.direct.includes('Phyllostachys'), '竹亞科 → Bambuseae + Phyllostachys');
  const tribe = list(ov, 'below_order', ctx, gens, ['unBAMB', 'unBAMT']);
  ok(tribe.direct.join() === 'Bambusa', 'Bambuseae → Bambusa');
  // User beats TaiCOL: pull Ledra out of Ledrinae.
  const gctx = { kingdom: 'Animalia', anchorRank: 'family', anchorName: 'Cicadellidae', childRank: 'genus' };
  const gens2 = fixedChildren('Animalia', 'family', 'Cicadellidae', 'genus');
  const pulled = list(
    overlayOf([], [{ child_key: childKeyOf('Animalia', 'genus', 'Ledra'), parent_ref: null }]),
    'below_order',
    gctx,
    gens2,
  );
  ok(pulled.direct.includes('Ledra'), 'override NULL puts Ledra directly under Cicadellidae');
  // Cycle the user built by re-parenting: must terminate.
  const cyc = overlayOf(
    [node('unA', 'subfamily', 'A', 'unB'), node('unB', 'tribe', 'B', 'unA')],
    [{ child_key: childKeyOf('Plantae', 'genus', 'Bambusa'), parent_ref: 'unA' }],
  );
  const r = list(cyc, 'below_order', ctx, gens);
  ok(Array.isArray(r.groups), 'a re-parenting cycle terminates');
}

// ── 4. Module without the tables ───────────────────────────────────────────
console.log('\n[相容] 沒有 taxon_tree 的舊模組');
{
  const ctx = { kingdom: 'Animalia', anchorRank: 'family', anchorName: 'Cicadellidae', childRank: 'genus' };
  const gens = fixedChildren('Animalia', 'family', 'Cicadellidae', 'genus');
  const r = arrange(overlayOf([], [], false), 'below_order', new Map(), ctx, gens, [], (n) => n);
  ok(r.groups.length === 0 && r.direct.length === gens.length, 'everything stays directly under the family');
}

// ── 5. Subgenus / section (species under a genus) ─────────────────────────
console.log('\n[屬以下] 亞屬／節');
{
  const row = db.prepare("SELECT * FROM rank_bridge WHERE child_rank='species' LIMIT 1").get();
  ok(!!row, 'module carries species-level bridge rows');
  if (row) {
    const ctx = { kingdom: row.kingdom, anchorRank: 'genus', anchorName: row.anchor_name, childRank: 'species' };
    const r = arrange(overlayOf(), 'below_order', bridgeFor(ctx), ctx, [row.child_name], [], (n) => n);
    ok(r.groups.length === 1 && r.groups[0].members[0] === row.child_name, `${row.child_name} grouped under its ${r.groups[0]?.node.rank} ${r.groups[0]?.node.name}`);
  }
}

if (failed) {
  console.error(`\ncheck:intermediate — ${failed} failed`);
  process.exit(1);
}
console.log('\n✓ intermediate ranks: TaiCOL placements, user layer, display modes, fallbacks');
