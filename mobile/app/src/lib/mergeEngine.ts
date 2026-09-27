/**
 * Team merge: fold another surveyor's copy of a record into this device's copy,
 * row by row, with a review of what cannot be decided automatically.
 *
 * Pure (no RN / DB / i18n), so scripts/check-merge.mjs runs it in Node.
 *
 * ── Common ancestor ──
 * A three-way merge needs to know what both sides last agreed on. Each device
 * keeps, per record, the content hash of every row as of its last exchange
 * (table `sync_base`, written on import and after a merge), and every export
 * carries the sender's copy of it (`sync.base`). The receiver uses the
 * SENDER's base as the ancestor:
 *
 *   - this device changed a row  = hash(local)  ≠ base
 *   - the sender changed a row   = hash(remote) ≠ base
 *   - a row in the base but missing on one side was deleted there.
 *
 * Content hashes rather than updated_at: no write helper has to stamp times or
 * record deletions, an undo that puts a value back is correctly "unchanged",
 * and two devices' clocks are never compared.
 *
 * Without a recorded ancestor (copies started apart, or a file from before
 * this existed) fields both sides agree on stand in for it and the rest count
 * as blank: filling a blank is a change, so work done on one side only comes
 * across without a question, and nothing is ever deleted.
 *
 * A row missing from the sender's base falls back to the receiver's own base
 * (`fallback`): the sender may simply not have exchanged with anyone since it
 * last uploaded (team sync uploads before it merges), while this device's base
 * still holds what it last received from a teammate. Without the fallback, a
 * teammate's plain edit of a value both copies had was taken for a conflict
 * and the review kept the old value here by default.
 *
 * After a merge the receiver's base becomes the sender's rows (what the sender
 * has now), NOT the merged result: a row where the reviewer kept this device's
 * value must still look "changed here" to the sender next time, so the
 * reviewer's choice reaches them instead of being mistaken for their own.
 */

export type Row = Record<string, unknown>;

export type MergeRow = {
  key: string;
  /** Compared and hashed. Display names and media are kept out of it. */
  data: Row;
  /** Carried along for writing (media, sort order …), never compared. */
  extra?: Row;
  /** Same taxon in the same place under a different key → "possible duplicate". */
  dupKey?: string | null;
  label: string;
  /** Grouping for the review screen (unit code, subplot …). */
  group?: string;
};

export type MergeSide = Record<string, MergeRow[]>;

/** [table, row key, hash] — the shape stored in `sync_base` and in `sync.base`. */
export type BaseEntry = [string, string, string];

/**
 * `author`: the sender's name in the team (team sync). It travels inside the
 * sealed record, so the relay never sees it; absent in files exported by hand.
 */
export type SyncBlock = { exported_at: number | null; base: BaseEntry[]; author?: string | null };

export type ItemKind =
  /** Only the sender has it: new there. */
  | 'added'
  /** Only the sender changed it since the ancestor: take theirs. */
  | 'auto'
  /** Both changed it since the ancestor, to different values. */
  | 'conflict'
  /** New there, but this device has the same taxon in the same place. */
  | 'duplicate'
  /** The sender deleted it; unchanged here since. */
  | 'remoteDeleted'
  /** One side deleted it, the other changed it. */
  | 'deleteConflict';

export type MergeItem = {
  id: string;
  tbl: string;
  key: string;
  kind: ItemKind;
  local: MergeRow | null;
  remote: MergeRow | null;
  /** conflict: the fields whose values differ. */
  fields: string[];
  /** duplicate: this device's row it may duplicate. */
  dup?: MergeRow;
  /** Values combined automatically (e.g. surveyors, time span) to write here. */
  patch?: Row;
};

/** Fields combined instead of compared (they live in `extra`). */
export type Combiners = Record<string, Record<string, (local: unknown, remote: unknown) => unknown>>;

// ── hashing ────────────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Row;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** cyrb53 — a fast 53-bit string hash; collisions are irrelevant at row scale. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Blank string, null and a missing key hash the same: exports drop empties. */
export function rowHash(data: Row): string {
  return cyrb53(canonical(data));
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** A side's rows as base entries — what gets stored after an import or merge. */
export function baseOf(side: MergeSide): BaseEntry[] {
  return Object.entries(side).flatMap(([tbl, rows]) => rows.map((r) => [tbl, r.key, rowHash(r.data)] as BaseEntry));
}

/** `sync:` block of an export document; absent or malformed → no ancestor. */
export function readSyncBlock(doc: unknown): SyncBlock | null {
  const s = (doc as { sync?: unknown } | null)?.sync as { exported_at?: unknown; base?: unknown; author?: unknown } | undefined;
  if (!s || !Array.isArray(s.base)) return null;
  const base = s.base.filter(
    (e): e is BaseEntry => Array.isArray(e) && e.length === 3 && e.every((x) => typeof x === 'string'),
  );
  const author = typeof s.author === 'string' && s.author.trim() ? s.author.trim().slice(0, 60) : null;
  return { exported_at: typeof s.exported_at === 'number' ? s.exported_at : null, base, ...(author ? { author } : {}) };
}

// ── diff ───────────────────────────────────────────────────────────────────

const bkey = (tbl: string, key: string) => `${tbl}\u0000${key}`;

/**
 * Every row that needs a decision or an automatic write, in table order and,
 * within a table, the sender's order (new rows read in the order recorded).
 * Rows equal on both sides, and rows changed only here, produce nothing.
 */
export function diffSides(
  local: MergeSide,
  remote: MergeSide,
  base: BaseEntry[] | null,
  combiners: Combiners = {},
  fallback: BaseEntry[] | null = null,
): MergeItem[] {
  // The sender's base wins; this device's own base fills the rows it lacks.
  const baseMap = new Map([...(fallback ?? []), ...(base ?? [])].map(([t, k, h]) => [bkey(t, k), h]));
  const tables = [...new Set([...Object.keys(local), ...Object.keys(remote)])];
  const out: MergeItem[] = [];
  for (const tbl of tables) {
    const L = new Map((local[tbl] ?? []).map((r) => [r.key, r]));
    const R = new Map((remote[tbl] ?? []).map((r) => [r.key, r]));
    const baseKeys = (base ?? []).filter(([t]) => t === tbl).map(([, k]) => k);
    // Local rows the sender doesn't have and never saw deleted: candidates
    // for "same taxon, different key".
    const unmatched = new Map<string, MergeRow[]>();
    for (const l of L.values()) {
      if (R.has(l.key) || baseMap.has(bkey(tbl, l.key)) || !l.dupKey) continue;
      unmatched.set(l.dupKey, [...(unmatched.get(l.dupKey) ?? []), l]);
    }
    const order = [...R.keys(), ...[...L.keys()].filter((k) => !R.has(k)), ...baseKeys.filter((k) => !R.has(k) && !L.has(k))];
    for (const key of [...new Set(order)]) {
      const l = L.get(key) ?? null;
      const r = R.get(key) ?? null;
      const b = baseMap.get(bkey(tbl, key)) ?? null;
      const id = bkey(tbl, key);
      if (l && r) {
        const patch: Row = {};
        for (const [f, fn] of Object.entries(combiners[tbl] ?? {})) {
          const v = fn(l.extra?.[f], r.extra?.[f]);
          if (!sameValue(v, l.extra?.[f])) patch[f] = v;
        }
        const withPatch = Object.keys(patch).length ? { patch } : {};
        const hl = rowHash(l.data);
        const hr = rowHash(r.data);
        // No recorded ancestor (two copies started apart, or an older file):
        // take the fields both agree on as the ancestor and the rest as blank,
        // so a side "changed" a field only by having a value there. A quadrat
        // filled on one device and untouched on the other then merges without
        // a question; two different real values are still a conflict.
        const differing = b == null ? diffFields(l.data, r.data) : [];
        const remoteChanged = b == null ? differing.some((f) => !isBlank(r.data[f])) : hr !== b;
        const localChanged = b == null ? differing.some((f) => !isBlank(l.data[f])) : hl !== b;
        if (hl === hr || !remoteChanged) {
          if (Object.keys(patch).length) out.push({ id, tbl, key, kind: 'auto', local: l, remote: r, fields: [], ...withPatch });
          continue;
        }
        if (!localChanged) {
          out.push({ id, tbl, key, kind: 'auto', local: l, remote: r, fields: diffFields(l.data, r.data), ...withPatch });
          continue;
        }
        out.push({ id, tbl, key, kind: 'conflict', local: l, remote: r, fields: diffFields(l.data, r.data), ...withPatch });
      } else if (r) {
        if (b != null) {
          // Deleted here since the ancestor; only worth asking if they changed it.
          if (rowHash(r.data) !== b) out.push({ id, tbl, key, kind: 'deleteConflict', local: null, remote: r, fields: [] });
          continue;
        }
        const pool = r.dupKey ? unmatched.get(r.dupKey) : undefined;
        const dup = pool?.shift();
        if (dup) out.push({ id, tbl, key, kind: 'duplicate', local: null, remote: r, fields: diffFields(dup.data, r.data), dup });
        else out.push({ id, tbl, key, kind: 'added', local: null, remote: r, fields: [] });
      } else if (l && b != null) {
        // They deleted it. Changed here since → both sides have a claim.
        out.push({ id, tbl, key, kind: rowHash(l.data) !== b ? 'deleteConflict' : 'remoteDeleted', local: l, remote: null, fields: [] });
      }
    }
  }
  return out;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

function diffFields(a: Row, b: Row): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !sameValue(a[k], b[k]));
}

// ── decisions → writes ─────────────────────────────────────────────────────

/**
 * What the reviewer picked for one item:
 *   - 'remote' take the sender's (insert / overwrite / delete as they did);
 *   - 'local'  keep this device's;
 *   - 'both'   duplicate only: keep this device's row AND add theirs;
 *   - `fields` conflict only: per field, which side wins (unlisted = local).
 */
export type Decision = { pick: 'local' | 'remote' | 'both'; fields?: Record<string, 'local' | 'remote'> };

/** What the review screen starts from. Nothing is deleted without a tap. */
export function defaultDecision(item: MergeItem): Decision {
  switch (item.kind) {
    case 'added':
    case 'auto':
      return { pick: 'remote' };
    default:
      return { pick: 'local' };
  }
}

/** Whether the item needs the reviewer at all (the rest are listed read-only). */
export function needsReview(item: MergeItem): boolean {
  return item.kind !== 'added' && item.kind !== 'auto';
}

export type MergeOp =
  | { op: 'insert'; tbl: string; row: MergeRow }
  | { op: 'update'; tbl: string; key: string; data: Row; extra?: Row }
  | { op: 'delete'; tbl: string; key: string };

export function planOps(items: MergeItem[], decisions: Map<string, Decision>): MergeOp[] {
  const ops: MergeOp[] = [];
  for (const it of items) {
    const d = decisions.get(it.id) ?? defaultDecision(it);
    const combined = it.patch && Object.keys(it.patch).length ? it.patch : undefined;
    switch (it.kind) {
      case 'added':
        if (d.pick !== 'local') ops.push({ op: 'insert', tbl: it.tbl, row: it.remote! });
        break;
      case 'auto':
        if (d.pick === 'local') {
          if (combined) ops.push({ op: 'update', tbl: it.tbl, key: it.key, data: {}, extra: combined });
        } else ops.push({ op: 'update', tbl: it.tbl, key: it.key, data: pickFields(it.remote!.data, it.fields), extra: combined });
        break;
      case 'conflict': {
        const fields =
          d.pick === 'remote' ? it.fields : it.fields.filter((f) => (d.fields ?? {})[f] === 'remote');
        if (fields.length || combined) {
          ops.push({ op: 'update', tbl: it.tbl, key: it.key, data: pickFields(it.remote!.data, fields), extra: combined });
        }
        break;
      }
      case 'duplicate':
        if (d.pick === 'both') ops.push({ op: 'insert', tbl: it.tbl, row: it.remote! });
        else if (d.pick === 'remote') {
          // Their values onto this device's row: one row per taxon stays one row.
          ops.push({ op: 'update', tbl: it.tbl, key: it.dup!.key, data: it.remote!.data, extra: it.remote!.extra });
        }
        break;
      case 'remoteDeleted':
        if (d.pick === 'remote') ops.push({ op: 'delete', tbl: it.tbl, key: it.key });
        break;
      case 'deleteConflict':
        if (d.pick === 'remote') {
          // Theirs: they deleted → delete here; they changed → bring it back.
          if (it.remote) ops.push({ op: 'insert', tbl: it.tbl, row: it.remote });
          else ops.push({ op: 'delete', tbl: it.tbl, key: it.key });
        }
        break;
    }
  }
  return ops;
}

function pickFields(data: Row, fields: string[]): Row {
  return Object.fromEntries(fields.map((f) => [f, data[f] ?? null]));
}

/** Counts per kind, for the review screen's summary and the done toast. */
export function summarizeItems(items: MergeItem[]): Record<ItemKind, number> {
  const out: Record<ItemKind, number> = { added: 0, auto: 0, conflict: 0, duplicate: 0, remoteDeleted: 0, deleteConflict: 0 };
  for (const it of items) out[it.kind] += 1;
  return out;
}
