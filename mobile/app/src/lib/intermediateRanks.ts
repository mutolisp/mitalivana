/**
 * Intermediate ranks (subfamily, tribe, superfamily, subgenus …) — the pure
 * half: rank vocabulary and how children are arranged under them.
 *
 * No DB or native import, so `npm run check:intermediate` runs it under Node
 * against the real tw-taicol module. The DB half (loading the overlay,
 * mutations) is `src/db/intermediateTaxa.ts`.
 *
 * Vocabulary: an **anchor** is the fixed-rank taxon whose children are being
 * listed (family Poaceae when listing genera). A child's **chain** is the list
 * of intermediate refs between the anchor and it, top-down. A **ref** is a
 * TaiCOL taxon_id or a user node id ('un…').
 */

/** Every rank the app places, top-down. Fixed ranks included so a new node's
 *  allowed ranks are "strictly between parent and children". */
export const RANK_LADDER = [
  'kingdom', 'subkingdom', 'infrakingdom', 'superphylum',
  'phylum', 'subphylum', 'infraphylum', 'superclass',
  'class', 'subclass', 'infraclass', 'superorder',
  'order', 'suborder', 'infraorder', 'parvorder', 'superfamily', 'epifamily',
  'family', 'subfamily', 'supertribe', 'tribe', 'subtribe',
  'genus', 'subgenus', 'section', 'subsection', 'series',
  'species',
] as const;
export type LadderRank = (typeof RANK_LADDER)[number];

const FIXED = new Set<string>(['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species']);

/** Ranks shown in the default "below order" mode. */
export const BELOW_ORDER: ReadonlySet<string> = new Set(
  RANK_LADDER.slice(RANK_LADDER.indexOf('order') + 1).filter((r) => !FIXED.has(r)),
);

export type IntermediateMode = 'below_order' | 'all';

/** Intermediate ranks allowed between `parentRank` and `childRank`. */
export function ranksBetween(parentRank: string, childRank: string): LadderRank[] {
  const lo = RANK_LADDER.indexOf(parentRank.toLowerCase() as LadderRank);
  const hi = RANK_LADDER.indexOf(childRank.toLowerCase() as LadderRank);
  if (lo < 0 || hi < 0 || hi - lo < 2) return [];
  return RANK_LADDER.slice(lo + 1, hi).filter((r) => !FIXED.has(r));
}

/** Rank suggested by a name's ending (same rules as the desktop AdminAddModal). */
export function guessRankFromSuffix(name: string): LadderRank | null {
  const n = name.trim();
  if (/oidea$/.test(n)) return 'superfamily';
  if (/oideae$/.test(n)) return 'subfamily'; // ICN
  if (/inae$/.test(n)) return 'subfamily'; // ICZN
  if (/ini$/.test(n)) return 'tribe'; // ICZN
  if (/eae$/.test(n)) return 'tribe'; // ICN
  if (/ina$/.test(n)) return 'subtribe'; // ICZN
  return null;
}

export type IntermediateNode = {
  ref: string;
  /** Lower-case rank key ('subfamily'). */
  rank: string;
  name: string;
  name_c: string;
  /** Intermediate parent ref; null = directly under the anchor. */
  parent: string | null;
  kingdom: string;
  anchorRank: string;
  anchorName: string;
  user: boolean;
  name_author?: string;
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** A `taxon_tree` row of the tw-taicol module. */
export function taicolRowToNode(r: Row): IntermediateNode {
  return {
    ref: str(r.taxon_id),
    rank: str(r.rank).toLowerCase(),
    name: str(r.simple_name),
    name_c: str(r.common_name_c),
    parent: r.parent_taxon_id ? str(r.parent_taxon_id) : null,
    kingdom: str(r.kingdom),
    anchorRank: str(r.anchor_rank),
    anchorName: str(r.anchor_name),
    user: false,
  };
}

/** A `user_taxon_node` row of user.db. */
export function userRowToNode(r: Row): IntermediateNode {
  return {
    ref: str(r.id),
    rank: str(r.rank).toLowerCase(),
    name: str(r.simple_name),
    name_c: str(r.common_name_c),
    name_author: str(r.name_author),
    parent: r.parent_ref ? str(r.parent_ref) : null,
    kingdom: str(r.kingdom),
    anchorRank: str(r.anchor_rank),
    anchorName: str(r.anchor_name),
    user: true,
  };
}

/** Both sources merged, user first. */
export type Overlay = {
  node: (ref: string) => IntermediateNode | undefined;
  /** Override for a child key: undefined = none, null = directly under anchor. */
  override: (childKey: string) => string | null | undefined;
  userNodesAt: (kingdom: string, anchorRank: string, anchorName: string) => IntermediateNode[];
  /** The checklist module carries TaiCOL's intermediates. */
  hasTaicol: boolean;
};

export function buildOverlay(opts: {
  taicol: ReadonlyMap<string, IntermediateNode>;
  hasTaicol: boolean;
  users: IntermediateNode[];
  overrides: Array<{ child_key: string; parent_ref: string | null }>;
}): Overlay {
  const users = new Map(opts.users.map((n) => [n.ref, n]));
  const overrides = new Map(opts.overrides.map((o) => [o.child_key, o.parent_ref || null]));
  return {
    node: (ref) => users.get(ref) ?? opts.taicol.get(ref),
    override: (k) => (overrides.has(k) ? (overrides.get(k) as string | null) : undefined),
    userNodesAt: (kingdom, anchorRank, anchorName) =>
      opts.users.filter((n) => n.kingdom === kingdom && n.anchorRank === anchorRank && n.anchorName === anchorName),
    hasTaicol: opts.hasTaicol,
  };
}

export function childKeyOf(kingdom: string, rank: string, name: string): string {
  return `${kingdom}|${rank}|${name}`;
}

export type AnchorCtx = {
  kingdom: string;
  anchorRank: string;
  anchorName: string;
  /** Lower-case rank of the children being listed ('genus', 'species' …). */
  childRank: string;
};

/** Effective parent of an intermediate: user override first, then its own. */
function parentOf(ov: Overlay, ref: string): string | null {
  const o = ov.override(ref);
  if (o !== undefined) return o;
  return ov.node(ref)?.parent ?? null;
}

/** Chain from the anchor down to and including `ref`. Cycle-safe: a loop the
 *  user built by re-parenting stops at the first repeat. */
export function chainTo(ov: Overlay, ref: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = ref;
  while (cur && !seen.has(cur) && ov.node(cur)) {
    seen.add(cur);
    out.unshift(cur);
    cur = parentOf(ov, cur);
  }
  return out;
}

export function isVisible(ov: Overlay, ref: string, mode: IntermediateMode): boolean {
  const n = ov.node(ref);
  if (!n) return false;
  // What the user created themselves is always shown.
  return n.user || mode === 'all' || BELOW_ORDER.has(n.rank);
}

export function visiblePath(ov: Overlay, ref: string, mode: IntermediateMode): IntermediateNode[] {
  return chainTo(ov, ref)
    .filter((r) => isVisible(ov, r, mode))
    .map((r) => ov.node(r)!);
}

/** The nearest intermediate parent of a child: the user's placement, else
 *  TaiCOL's (the last element of its bridge chain). */
export function parentOfChild(ov: Overlay, ctx: AnchorCtx, bridge: ReadonlyMap<string, string[]>, name: string): string | null {
  const o = ov.override(childKeyOf(ctx.kingdom, ctx.childRank, name));
  if (o !== undefined) return o;
  return bridge.get(name)?.at(-1) ?? null;
}

export type IntermediateGroup<T> = {
  node: IntermediateNode;
  /** Every child (at ctx.childRank) anywhere below this group. */
  members: T[];
};

/**
 * Arrange the children of an anchor into intermediate groups.
 *
 * `via` is the path of intermediate refs already descended into (empty when
 * listing the anchor itself). Returns the children that sit directly at this
 * level and the groups one step further down. `keyName` maps a child to the
 * name its chain is looked up by (a subspecies uses its species' binomial).
 */
export function arrange<T>(
  ov: Overlay,
  mode: IntermediateMode,
  bridge: ReadonlyMap<string, string[]>,
  ctx: AnchorCtx,
  children: T[],
  via: string[],
  keyName: (c: T) => string,
): { direct: T[]; groups: IntermediateGroup<T>[] } {
  const chainOf = (name: string): string[] => {
    const parent = parentOfChild(ov, ctx, bridge, name);
    if (!parent) return [];
    return chainTo(ov, parent).filter((r) => isVisible(ov, r, mode));
  };
  const startsWith = (chain: string[]) => via.every((r, i) => chain[i] === r);

  const direct: T[] = [];
  const groups = new Map<string, IntermediateGroup<T>>();
  const groupFor = (ref: string) => {
    let g = groups.get(ref);
    if (!g) {
      g = { node: ov.node(ref)!, members: [] };
      groups.set(ref, g);
    }
    return g;
  };

  for (const c of children) {
    const chain = chainOf(keyName(c));
    if (chain.length < via.length || !startsWith(chain)) continue;
    if (chain.length === via.length) direct.push(c);
    else groupFor(chain[via.length]).members.push(c);
  }
  // A user node shows up even while empty — right after creating it the user
  // needs somewhere to move children into.
  for (const n of ov.userNodesAt(ctx.kingdom, ctx.anchorRank, ctx.anchorName)) {
    const chain = chainTo(ov, n.ref).filter((r) => isVisible(ov, r, mode));
    if (chain.length > via.length && startsWith(chain)) groupFor(chain[via.length]);
  }
  const sorted = [...groups.values()].sort((a, b) => a.node.name.localeCompare(b.node.name));
  return { direct, groups: sorted };
}

/** The visible intermediates down to one child (outermost first), e.g. for a
 *  tree jump. Empty when the child sits directly under its anchor. */
export function visibleChainOfChild(
  ov: Overlay,
  mode: IntermediateMode,
  bridge: ReadonlyMap<string, string[]>,
  ctx: AnchorCtx,
  name: string,
): IntermediateNode[] {
  const parent = parentOfChild(ov, ctx, bridge, name);
  return parent ? visiblePath(ov, parent, mode) : [];
}

/** Every intermediate down to one child, display mode ignored (export). */
export function fullChainOfChild(
  ov: Overlay,
  bridge: ReadonlyMap<string, string[]>,
  ctx: AnchorCtx,
  name: string,
): IntermediateNode[] {
  const parent = parentOfChild(ov, ctx, bridge, name);
  return parent ? chainTo(ov, parent).map((r) => ov.node(r)!) : [];
}

/** Parse `rank_bridge` rows into child name → chain. A bad row is skipped. */
export function parseBridgeRows(rows: Row[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    try {
      const chain = JSON.parse(str(r.chain));
      if (Array.isArray(chain)) out.set(str(r.child_name), chain.map(String));
    } catch {
      // one bad row must not hide the rest
    }
  }
  return out;
}
