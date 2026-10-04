/**
 * What the 15A list sheet shows, and in which order (07-action-sheet.md §2):
 * search, filters, the 最近用過 group, groups by `section`, destructive
 * options last in a group of their own. Indices always point into the
 * caller's `options`, so moving a destructive option to the end never changes
 * what showActionSheet() resolves with.
 *
 * Pure: check:sheet-layer runs it under Node.
 */
import { fold, splitMatch } from './settingsIndex';

/** The fields of an option the layout reads (ActionSheetOption has these and more). */
export type SheetOptionLike = {
  label: string;
  destructive?: boolean;
  description?: string;
  section?: string;
  disabled?: boolean;
  keywords?: string;
  key?: string;
};

/** 'recent': the 最近用過 group; 'destructive': the last group, set apart. */
export type SheetSectionKind = 'recent' | 'plain' | 'destructive';
export type SheetSection = { key: string; kind: SheetSectionKind; title: string | null; rows: number[] };

/** How many recent picks a sheet remembers and shows. */
export const RECENT_MAX = 3;
/** More options than this: a search box (search: 'auto'). */
export const SEARCH_ABOVE = 8;

/** Full-width ASCII and the ideographic space to their half-width forms, one for one. */
function halfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0xff01 && c <= 0xff5e ? String.fromCodePoint(c - 0xfee0) : c === 0x3000 ? ' ' : ch;
  }
  return out;
}

/** Case- and width-folded (and 臺 → 台, as the settings search); index-preserving per code point. */
export function foldSearch(s: string): string {
  return fold(halfWidth(s));
}

/** [before, match, after] of `text` for `query`, for marking the match. */
export function markMatch(text: string, query: string): [string, string, string] | null {
  return splitMatch(text, query, foldSearch);
}

export function optionMatches(o: SheetOptionLike, query: string): boolean {
  const q = foldSearch(query.trim());
  if (!q) return true;
  return [o.label, o.description, o.keywords].some((x) => !!x && foldSearch(x).includes(q));
}

/** The search box: `true` / `false` as given; 'auto' (the default) above SEARCH_ABOVE options. */
export function searchShown(search: boolean | 'auto' | undefined, count: number): boolean {
  return search === undefined || search === 'auto' ? count > SEARCH_ABOVE : search;
}

/** What a recent pick is remembered by. */
export const optionKey = (o: SheetOptionLike): string => o.key ?? o.label;

/** `key` first, without repeats, at most RECENT_MAX. */
export function pushRecent(list: readonly string[], key: string): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, RECENT_MAX);
}

/**
 * The sheet's groups. `match`: the chosen filter chip; `query`: the search
 * text (results as one list, no groups); `recent`: keys of the last picks.
 */
export function layoutSheet(
  options: readonly SheetOptionLike[],
  opts: { query?: string; match?: (o: SheetOptionLike) => boolean; recent?: readonly string[] } = {},
): SheetSection[] {
  const shown = options.map((o, i) => ({ o, i })).filter(({ o }) => !opts.match || opts.match(o));
  const plain = shown.filter(({ o }) => !o.destructive);
  const destructive = shown.filter(({ o }) => o.destructive).map(({ i }) => i);
  const out: SheetSection[] = [];
  const last = () => (destructive.length ? [{ key: 'destructive', kind: 'destructive' as const, title: null, rows: destructive }] : []);

  const query = opts.query?.trim() ?? '';
  if (query) {
    const hits = plain.filter(({ o }) => optionMatches(o, query)).map(({ i }) => i);
    const lastHits = destructive.filter((i) => optionMatches(options[i], query));
    if (hits.length) out.push({ key: 'results', kind: 'plain', title: null, rows: hits });
    if (lastHits.length) out.push({ key: 'destructive', kind: 'destructive', title: null, rows: lastHits });
    return out;
  }

  // Recent picks that are still on offer (and could be picked again).
  const recent: number[] = [];
  for (const k of opts.recent ?? []) {
    const hit = plain.find(({ o }) => optionKey(o) === k && !o.disabled);
    if (hit && !recent.includes(hit.i)) recent.push(hit.i);
    if (recent.length === RECENT_MAX) break;
  }
  if (recent.length) out.push({ key: 'recent', kind: 'recent', title: null, rows: recent });

  // Consecutive options with the same section form one group.
  for (const { o, i } of plain) {
    const title = o.section ?? null;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'plain' && prev.title === title) prev.rows.push(i);
    else out.push({ key: `s${out.length}:${title ?? ''}`, kind: 'plain', title, rows: [i] });
  }
  return [...out, ...last()];
}

/** One destructive option and nothing else: shown as a confirmation (a title, its message, one button). */
export function isConfirmation(options: readonly SheetOptionLike[]): boolean {
  return options.length === 1 && !!options[0].destructive;
}
