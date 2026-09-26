/**
 * Intermediate ranks in the taxonomy tree (subfamily, tribe, superfamily,
 * suborder, subgenus, section …) — the DB half. The arranging logic itself is
 * pure and lives in `src/lib/intermediateRanks.ts` (checked under Node by
 * `npm run check:intermediate`).
 *
 * The tree only knows the six fixed ranks (`RANK_ORDER`, kingdom…genus),
 * grouped straight off the checklist columns. Intermediate ranks are an overlay
 * on top, from two sources:
 *
 *   - **TaiCOL** — the tw-taicol module's `taxon_tree` / `rank_bridge` tables,
 *     built from the API's parent links (backend/scripts/datasets). Older
 *     modules lack them; everything here then degrades to "no intermediates".
 *   - **The user** — user.db v56: `user_taxon_node` (intermediates they
 *     created, e.g. 竹亞科 Bambusoideae, which TaiCOL does not place) and
 *     `taxon_parent_override` (re-placing a child). The user wins.
 */
import type { DB } from '@op-engineering/op-sqlite';
import {
  arrange,
  buildOverlay,
  fullChainOfChild,
  isVisible,
  parseBridgeRows,
  taicolRowToNode,
  userRowToNode,
  visibleChainOfChild,
  visiblePath,
  type AnchorCtx,
  type IntermediateGroup,
  type IntermediateMode,
  type IntermediateNode,
  type Overlay,
} from '~/lib/intermediateRanks';
import { datasetScopeSig, getDatasetDb, onDatasetsChanged } from './datasets';
import { getUserDb, withTransaction } from './init';
import { generateUuid } from './uuid';

export {
  RANK_LADDER,
  childKeyOf,
  guessRankFromSuffix,
  ranksBetween,
  type AnchorCtx,
  type IntermediateGroup,
  type IntermediateMode,
  type IntermediateNode,
  type LadderRank,
} from '~/lib/intermediateRanks';

export const INTERMEDIATE_MODE_KEY = 'taxonomy_intermediate_ranks';

/** Read from the settings table like `getVernacularLangs`, so the DB layer
 *  needs no React store. */
export function getIntermediateMode(): IntermediateMode {
  try {
    const res = getUserDb().executeSync(`SELECT value FROM settings WHERE key=? LIMIT 1`, [
      INTERMEDIATE_MODE_KEY,
    ]);
    const raw = ((res.rows ?? [])[0] as { value?: string } | undefined)?.value;
    return raw === 'all' ? 'all' : 'below_order';
  } catch {
    return 'below_order';
  }
}

// ── TaiCOL half (read-only module) ──────────────────────────────────────────

type TaicolTree = { byRef: Map<string, IntermediateNode>; hasBridge: boolean };
let TAICOL: TaicolTree | null = null;
let TAICOL_SIG: string | null = null;

function tableExists(db: DB, name: string): boolean {
  try {
    const res = db.executeSync(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`, [name]);
    return (res.rows ?? []).length > 0;
  } catch {
    return false;
  }
}

/** TaiCOL's intermediates, loaded once per module version (a few thousand rows). */
function taicolTree(): TaicolTree {
  const sig = datasetScopeSig();
  if (TAICOL && TAICOL_SIG === sig) return TAICOL;
  const byRef = new Map<string, IntermediateNode>();
  let hasBridge = false;
  const db = getDatasetDb('tw-taicol');
  // An older module has neither table: the tree simply has no TaiCOL
  // intermediates. Never throw here — the whole tree goes through this.
  if (db && tableExists(db, 'taxon_tree') && tableExists(db, 'rank_bridge')) {
    try {
      const res = db.executeSync(
        `SELECT taxon_id, parent_taxon_id, rank, simple_name, common_name_c, kingdom, anchor_rank, anchor_name
           FROM taxon_tree`,
      );
      for (const r of (res.rows ?? []) as Record<string, unknown>[]) {
        const n = taicolRowToNode(r);
        byRef.set(n.ref, n);
      }
      hasBridge = true;
    } catch {
      byRef.clear();
    }
  }
  TAICOL = { byRef, hasBridge };
  TAICOL_SIG = sig;
  return TAICOL;
}
onDatasetsChanged(() => {
  TAICOL = null;
  TAICOL_SIG = null;
});

function bridgeChains(ctx: AnchorCtx): Map<string, string[]> {
  if (!taicolTree().hasBridge) return new Map();
  const db = getDatasetDb('tw-taicol');
  if (!db) return new Map();
  try {
    const res = db.executeSync(
      `SELECT child_name, chain FROM rank_bridge
        WHERE kingdom = ? AND anchor_rank = ? AND anchor_name = ? AND child_rank = ?`,
      [ctx.kingdom, ctx.anchorRank, ctx.anchorName, ctx.childRank],
    );
    return parseBridgeRows((res.rows ?? []) as Record<string, unknown>[]);
  } catch {
    // table present but unreadable — treat as no intermediates
    return new Map();
  }
}

// ── User half (user.db) ─────────────────────────────────────────────────────

function userRows(sql: string, params: (string | number | null)[] = []): Record<string, unknown>[] {
  try {
    return (getUserDb().executeSync(sql, params).rows ?? []) as Record<string, unknown>[];
  } catch {
    // Mid-migration or absent user DB: the overlay is a gap, not a crash.
    return [];
  }
}

/** Both sources, read fresh per call: the user tables are tiny, and a stale
 *  copy is exactly the bug `onManualTaxaChanged` exists to prevent. */
function loadOverlay(): Overlay {
  const tc = taicolTree();
  return buildOverlay({
    taicol: tc.byRef,
    hasTaicol: tc.hasBridge,
    users: userRows(`SELECT * FROM user_taxon_node`).map(userRowToNode),
    overrides: userRows(`SELECT child_key, parent_ref FROM taxon_parent_override`).map((r) => ({
      child_key: String(r.child_key),
      parent_ref: r.parent_ref ? String(r.parent_ref) : null,
    })),
  });
}

// ── Queries the tree uses ──────────────────────────────────────────────────

/**
 * Arrange the children of an anchor into intermediate groups; see `arrange`.
 * Passes everything through untouched when neither source has anything here.
 */
export function arrangeChildren<T>(
  ctx: AnchorCtx,
  children: T[],
  via: string[],
  keyName: (c: T) => string,
): { direct: T[]; groups: IntermediateGroup<T>[] } {
  const passthrough = { direct: via.length ? [] : children, groups: [] };
  if (!ctx.kingdom || !ctx.anchorName) return passthrough;
  const ov = loadOverlay();
  if (!ov.hasTaicol && ov.userNodesAt(ctx.kingdom, ctx.anchorRank, ctx.anchorName).length === 0) {
    // Overrides alone can only point at nodes, and there are none here.
    return passthrough;
  }
  return arrange(ov, getIntermediateMode(), bridgeChains(ctx), ctx, children, via, keyName);
}

/** The visible intermediate path down to one child, e.g. for a tree jump.
 *  Empty when the child sits directly under its anchor. */
export function chainForChild(ctx: AnchorCtx, childName: string): IntermediateNode[] {
  if (!ctx.kingdom || !ctx.anchorName) return [];
  return visibleChainOfChild(loadOverlay(), getIntermediateMode(), bridgeChains(ctx), ctx, childName);
}

/**
 * Resolver for every intermediate between a fixed-rank anchor and a child,
 * regardless of the display mode — for export (DwC subfamily / tribe / …).
 * Loads the user layer once and caches bridge lookups, so exporting a
 * thousand taxa does not re-read them a thousand times.
 */
export function createChainResolver(): (ctx: AnchorCtx, childName: string) => IntermediateNode[] {
  const ov = loadOverlay();
  const bridges = new Map<string, Map<string, string[]>>();
  return (ctx, childName) => {
    if (!ctx.kingdom || !ctx.anchorName || !childName) return [];
    const bk = `${ctx.kingdom}|${ctx.anchorRank}|${ctx.anchorName}|${ctx.childRank}`;
    let b = bridges.get(bk);
    if (!b) {
      b = bridgeChains(ctx);
      bridges.set(bk, b);
    }
    return fullChainOfChild(ov, b, ctx, childName);
  };
}

export function getIntermediateNode(ref: string): IntermediateNode | undefined {
  return loadOverlay().node(ref);
}

/** Visible intermediates from the anchor down to and including `ref`
 *  (overrides and the display mode applied). */
export function visiblePathOf(ref: string): IntermediateNode[] {
  return visiblePath(loadOverlay(), ref, getIntermediateMode());
}

/** Intermediates the tree search can offer, TaiCOL and user-created. */
export function searchIntermediate(q: string, limit = 20): IntermediateNode[] {
  const raw = q.trim();
  const needle = raw.toLowerCase();
  if (!needle) return [];
  const mode = getIntermediateMode();
  const ov = loadOverlay();
  const out: IntermediateNode[] = [];
  const pool = [
    ...userRows(`SELECT * FROM user_taxon_node`).map(userRowToNode),
    ...taicolTree().byRef.values(),
  ];
  for (const n of pool) {
    if (!isVisible(ov, n.ref, mode)) continue;
    if (n.name.toLowerCase().includes(needle) || (n.name_c && n.name_c.includes(raw))) {
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ── Scope signature & change notification ──────────────────────────────────

/** Folded into the tree's scope signature: any user edit or a mode switch
 *  must re-list the tree. */
export function intermediateScopeSig(): string {
  const a = userRows(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM user_taxon_node`)[0];
  const b = userRows(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM taxon_parent_override`)[0];
  return `i${Number(a?.n ?? 0)}.${Number(a?.t ?? 0)}.${Number(b?.n ?? 0)}.${Number(b?.t ?? 0)}.${getIntermediateMode()}`;
}

const listeners = new Set<() => void>();
/** Fires after any intermediate create / edit / delete / re-placement. */
export function onIntermediateChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notifyIntermediateChanged(): void {
  for (const fn of listeners) fn();
}

// ── Mutations ───────────────────────────────────────────────────────────────

export type NewIntermediate = {
  rank: string;
  simple_name: string;
  name_author?: string;
  common_name_c?: string;
  kingdom: string;
  anchorRank: string;
  anchorName: string;
  parentRef: string | null;
};

export function createIntermediateNode(input: NewIntermediate): string {
  const id = `un${generateUuid().replace(/-/g, '').slice(0, 12)}`;
  const now = Date.now();
  getUserDb().executeSync(
    `INSERT INTO user_taxon_node
       (id, rank, simple_name, name_author, common_name_c, kingdom, anchor_rank, anchor_name,
        parent_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.rank.toLowerCase(),
      input.simple_name.trim(),
      input.name_author?.trim() || null,
      input.common_name_c?.trim() || null,
      input.kingdom,
      input.anchorRank,
      input.anchorName,
      input.parentRef,
      now,
      now,
    ],
  );
  notifyIntermediateChanged();
  return id;
}

export function updateIntermediateNode(
  id: string,
  patch: { simple_name?: string; name_author?: string; common_name_c?: string; rank?: string },
): void {
  const cur = userRows(`SELECT * FROM user_taxon_node WHERE id = ?`, [id])[0];
  if (!cur) return;
  getUserDb().executeSync(
    `UPDATE user_taxon_node
        SET simple_name = ?, name_author = ?, common_name_c = ?, rank = ?, updated_at = ?
      WHERE id = ?`,
    [
      patch.simple_name?.trim() || String(cur.simple_name),
      patch.name_author !== undefined ? patch.name_author.trim() || null : (cur.name_author as string | null),
      patch.common_name_c !== undefined ? patch.common_name_c.trim() || null : (cur.common_name_c as string | null),
      (patch.rank ?? String(cur.rank)).toLowerCase(),
      Date.now(),
      id,
    ],
  );
  notifyIntermediateChanged();
}

/**
 * Delete a user node. Children placed under it return to TaiCOL's placement
 * (their override is removed); user nodes under it move up to its parent.
 */
export function deleteIntermediateNode(id: string): void {
  const db = getUserDb();
  const cur = userRows(`SELECT parent_ref FROM user_taxon_node WHERE id = ?`, [id])[0];
  const up = cur?.parent_ref ? String(cur.parent_ref) : null;
  const now = Date.now();
  withTransaction(() => {
    db.executeSync(`DELETE FROM taxon_parent_override WHERE parent_ref = ?`, [id]);
    db.executeSync(`UPDATE user_taxon_node SET parent_ref = ?, updated_at = ? WHERE parent_ref = ?`, [
      up,
      now,
      id,
    ]);
    db.executeSync(`DELETE FROM user_taxon_node WHERE id = ?`, [id]);
  });
  notifyIntermediateChanged();
}

/** Re-place children. `childKeys` are `childKeyOf(...)` keys or TaiCOL refs;
 *  a user node ('un…') is re-parented on its own row instead. */
export function placeChildren(childKeys: string[], parentRef: string | null): void {
  const db = getUserDb();
  const now = Date.now();
  withTransaction(() => {
    for (const k of childKeys) {
      if (k === parentRef) continue;
      if (k.startsWith('un')) {
        db.executeSync(`UPDATE user_taxon_node SET parent_ref = ?, updated_at = ? WHERE id = ?`, [
          parentRef,
          now,
          k,
        ]);
      } else {
        db.executeSync(
          `INSERT OR REPLACE INTO taxon_parent_override (child_key, parent_ref, updated_at) VALUES (?, ?, ?)`,
          [k, parentRef, now],
        );
      }
    }
  });
  notifyIntermediateChanged();
}

/** Back to TaiCOL's placement. */
export function clearPlacement(childKeys: string[]): void {
  const db = getUserDb();
  for (const k of childKeys) db.executeSync(`DELETE FROM taxon_parent_override WHERE child_key = ?`, [k]);
  notifyIntermediateChanged();
}

export function hasOverride(childKey: string): boolean {
  return userRows(`SELECT 1 FROM taxon_parent_override WHERE child_key = ? LIMIT 1`, [childKey]).length > 0;
}

/** Test hook: drop the cached TaiCOL tree. */
export function resetIntermediateCache(): void {
  TAICOL = null;
  TAICOL_SIG = null;
}
