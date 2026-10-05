/**
 * Team sync of a tree census, the part that touches no network
 * (docs/planned/Modular_survey.md §7.2, §7.9, §9 1C-b). The relay, keys and
 * screens are in src/survey/censusSync.ts.
 *
 * What travels:
 * - a census HEADER per device: plot, series, census, the sync block size and
 *   the blocks this device claims. A census is known across phones by
 *   plot uuid + series uuid + census number, so two phones that each started
 *   census 2 of a plot meet (like GLORIA's summit + cycle);
 * - a BLOCK per block per device: the census slice of the block's quadrats
 *   (sliceCore.ts), with the merge base. In both, this census's own uuid is
 *   written as THIS_CENSUS, since the two phones' census rows may differ.
 *
 * Receiving a teammate's block, in order:
 * 1. openBlock: their `merge` history rows (two trees found to be one) are
 *    carried out here first, and the trees this device folded are folded in
 *    their copy too; then their new trees are checked against this device's:
 *    - same tag, ≤ 1 m apart and same species → the same tree (§5.4);
 *    - same tag otherwise → a clash for a person: renumber one, or one tree;
 *    - both new, ≤ 0.5 m apart, same species, different tags → a possible
 *      duplicate: one tree, or keep both.
 * 2. settleCollisions: those decisions are written (renumbering and folding
 *    are corrections with history rows, so a teammate's phone does the same).
 *    When two trees fold, the smaller uuid stays, so both phones agree.
 * 3. blockItems → the review (or none) → applyBlockItems. A merge never
 *    deletes a tree or stem: a tree missing from their block may have moved
 *    to another block. Measurements, codes and photos they removed go only
 *    if their tree is in their block.
 *
 * Takes a context (db, clock, uuid) like stemmapCore; check:census-sync runs it
 * on two node:sqlite databases.
 */
import type { Scalar } from '@op-engineering/op-sqlite';
import { unionSurveyors } from '../../db/merge';
import { baseOf, diffSides, planOps, type BaseEntry, type Decision, type MergeItem, type MergeOp, type MergeSide, type Row } from '../../lib/mergeEngine';
import { fgQuadratCounts, parseFgQuadratCode } from '../stemmap/coords';
import { tagConflict } from '../stemmap/tags';
import {
  applySliceOps,
  buildSlice,
  censusSide,
  CENSUS_COMBINERS,
  FRAME_COLS,
  insertCensusFromDoc,
  joinStems,
  pick,
  SURVEY_COLS,
  type CensusSlice,
} from './sliceCore';
import { frameGeometry, getFrame, getSurvey, retiredTags, SurveyError, touchFgQuadrat, type Ctx, type SurveyDb } from './stemmapCore';

const rows = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => (ctx.db.executeSync(sql, params).rows ?? []) as T[];
const one = <T>(ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => rows<T>(ctx, sql, params)[0];
const run = (ctx: { db: SurveyDb }, sql: string, params: Scalar[] = []) => ctx.db.executeSync(sql, params);

/** This census's uuid inside sync documents. */
export const THIS_CENSUS = '@census';

/** Two new trees closer than this, of one species, under different tags: possibly one tree (decided 2026-10-01). */
export const POSSIBLE_DUPLICATE_M = 0.5;

export type CensusSyncErrorCode =
  /** A census after the first, and this device lacks the one before it (import it first, 1D). */
  | 'previous_missing'
  /** Another plot here already uses this plot's code. */
  | 'frame_code_taken'
  /** The teammates chose another block size for this census. */
  | 'block_size_differs'
  /** The teammate's census of this plot, series and number uses another template (decided 2026-10-03): not merged. */
  | 'template_differs'
  /** Not a census document this build reads. */
  | 'unreadable'
  /** A tag clash has no decision yet: one tag cannot sit on two trees. */
  | 'undecided';

export class CensusSyncError extends Error {
  code: CensusSyncErrorCode;
  constructor(code: CensusSyncErrorCode, detail?: string) {
    super(`census sync: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
  }
}

// ── blocks ──────────────────────────────────────────────────────────────────

/** Block of a quadrat: `b<column>_<row>`, counted in blocks of k × k quadrats from the lower left. */
export function blockOf(quadratCode: string, k: number): string {
  const p = parseFgQuadratCode(quadratCode);
  if (!p) throw new Error(`bad quadrat code ${quadratCode}`);
  return `b${Math.floor(p.col / k)}_${Math.floor(p.row / k)}`;
}

export function parseBlock(id: string): { bc: number; br: number } | null {
  const m = /^b(\d+)_(\d+)$/.exec(id);
  return m ? { bc: Number(m[1]), br: Number(m[2]) } : null;
}

/** Every block of a plot, column by column. */
export function allBlocks(cols: number, rows: number, k: number): string[] {
  const out: string[] = [];
  for (let bc = 0; bc < Math.ceil(cols / k); bc++) for (let br = 0; br < Math.ceil(rows / k); br++) out.push(`b${bc}_${br}`);
  return out;
}

/** The quadrat codes of a block (clipped at the plot's edge). */
export function blockQuadratCodes(cols: number, rows: number, k: number, id: string): string[] {
  const b = parseBlock(id);
  if (!b) return [];
  const out: string[] = [];
  for (let c = b.bc * k; c < Math.min(cols, (b.bc + 1) * k); c++) {
    for (let r = b.br * k; r < Math.min(rows, (b.br + 1) * k); r++) out.push(`${String(c).padStart(2, '0')}${String(r).padStart(2, '0')}`);
  }
  return out;
}

function gridOf(ctx: { db: SurveyDb }, surveyId: number): { cols: number; rows: number; frameId: number } {
  const s = getSurvey(ctx, surveyId);
  if (!s) throw new Error(`no census ${surveyId}`);
  const { cols, rows: r } = fgQuadratCounts(frameGeometry(getFrame(ctx, s.frame_id)!));
  return { cols, rows: r, frameId: s.frame_id };
}

/** The whole census as one "block" (a census merged from a file, censusExportCore.ts). */
export const ALL_QUADRATS = '*';

/** Quadrat codes of one block of a census (ALL_QUADRATS: every quadrat, whatever k). */
export function censusBlockCodes(ctx: { db: SurveyDb }, surveyId: number, k: number | null, block: string): string[] {
  const g = gridOf(ctx, surveyId);
  if (block === ALL_QUADRATS) return blockQuadratCodes(g.cols, g.rows, Math.max(g.cols, g.rows), 'b0_0');
  return k == null ? [] : blockQuadratCodes(g.cols, g.rows, k, block);
}

/** Newest write per block (ms), from the quadrats' stamps: which blocks changed since a time. */
export function blockStamps(ctx: { db: SurveyDb }, surveyId: number, k: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of rows<{ c: string; t: number }>(ctx, `SELECT quadrat_code AS c, updated_at AS t FROM fw_survey_quadrats WHERE survey_id = ?`, [surveyId])) {
    const b = blockOf(q.c, k);
    out.set(b, Math.max(out.get(b) ?? 0, q.t));
  }
  return out;
}

// ── who is this census ──────────────────────────────────────────────────────

export const censusIdent = (frameUuid: string, seriesUuid: string, censusNo: number) => `${frameUuid}|${seriesUuid}|${censusNo}`;

export function identOfCensus(ctx: { db: SurveyDb }, surveyId: number): string | null {
  const r = one<{ f: string; s: string; n: number }>(
    ctx,
    `SELECT f.uuid AS f, se.uuid AS s, sv.census_no AS n FROM fw_surveys sv JOIN fw_frames f ON f.id = sv.frame_id JOIN fw_frame_series se ON se.id = sv.series_id WHERE sv.id = ?`,
    [surveyId],
  );
  return r ? censusIdent(r.f, r.s, r.n) : null;
}

export function censusByIdent(ctx: { db: SurveyDb }, ident: string): number | null {
  const [f, s, n] = ident.split('|');
  return (
    one<{ id: number }>(
      ctx,
      `SELECT sv.id FROM fw_surveys sv JOIN fw_frames f ON f.id = sv.frame_id JOIN fw_frame_series se ON se.id = sv.series_id
        WHERE f.uuid = ? AND se.uuid = ? AND sv.census_no = ?`,
      [f, s, Number(n)],
    )?.id ?? null
  );
}

// ── the header ──────────────────────────────────────────────────────────────

export type CensusTeamHeader = {
  record_type: 'census_team_header';
  schema: 1;
  ident: string;
  frame: Row;
  series: Row;
  survey: Row;
  block_quadrats: number;
  /** Blocks this device's group works on (only a hint to the others). */
  claims: string[];
  author?: string | null;
};

export function buildTeamHeader(ctx: { db: SurveyDb }, surveyId: number, claims: readonly string[], author: string | null): CensusTeamHeader {
  const s = getSurvey(ctx, surveyId);
  if (!s) throw new Error(`no census ${surveyId}`);
  if (s.sync_block_quadrats == null) throw new Error('block size not decided');
  const frame = one<Row>(ctx, `SELECT * FROM fw_frames WHERE id = ?`, [s.frame_id])!;
  const series = one<Row>(ctx, `SELECT uuid, template_id, series_code FROM fw_frame_series WHERE id = ?`, [s.series_id])!;
  return {
    record_type: 'census_team_header',
    schema: 1,
    ident: identOfCensus(ctx, surveyId)!,
    frame: pick(frame, FRAME_COLS),
    series,
    survey: pick(s as unknown as Row, SURVEY_COLS),
    block_quadrats: s.sync_block_quadrats,
    claims: [...claims].sort(),
    ...(author ? { author } : {}),
  };
}

export function isTeamHeader(doc: unknown): doc is CensusTeamHeader {
  const d = doc as CensusTeamHeader | null;
  return !!d && d.record_type === 'census_team_header' && typeof d.ident === 'string' && !!d.frame && !!d.series && !!d.survey && Number.isInteger(d.block_quadrats);
}

/**
 * The census a teammate's header names, here: found by plot + series + number,
 * or created (with its plot and series when missing). A census after the first
 * needs the one before it on this device (its trees and measurements), which
 * only an imported file brings (decided 2026-10-01). Adopts the block size when
 * this device has none yet. The caller runs it in a transaction.
 */
export function ensureCensus(ctx: Ctx, h: CensusTeamHeader): { surveyId: number; created: boolean } {
  const found = censusByIdent(ctx, h.ident);
  if (found != null) {
    const s = getSurvey(ctx, found)!;
    if (templateDiffers(s.template_id, h.survey)) throw new CensusSyncError('template_differs');
    // Another block size here: the census sync settles it (teamBlockSize; code review M1).
    if (s.sync_block_quadrats == null) setBlockSize(ctx, found, h.block_quadrats);
    mergeCensusHeader(ctx, found, h.survey);
    return { surveyId: found, created: false };
  }
  const censusNo = Number(h.survey.census_no);
  if (censusNo > 1) {
    const prev = one(
      ctx,
      `SELECT sv.id FROM fw_surveys sv JOIN fw_frame_series se ON se.id = sv.series_id WHERE se.uuid = ? AND sv.census_no = ?`,
      [h.series.uuid as string, censusNo - 1],
    );
    if (!prev) throw new CensusSyncError('previous_missing');
  }
  const frameHere = one<{ id: number }>(ctx, `SELECT id FROM fw_frames WHERE uuid = ?`, [h.frame.uuid as string]);
  if (!frameHere && one(ctx, `SELECT id FROM fw_frames WHERE code = ?`, [h.frame.code as string])) throw new CensusSyncError('frame_code_taken');
  const status = h.survey.status === 'done' ? 'done' : 'active';
  const surveyId = insertCensusFromDoc(ctx, { frame: h.frame, series: h.series, survey: { ...h.survey, sync_block_quadrats: h.block_quadrats } }, { status, projectId: 0 });
  return { surveyId, created: true };
}

/** Lines of `theirs` that `here` does not have yet, added after it (trimmed comparison). */
function unionLines(here: string | null, theirs: string | null): string | null {
  if (!theirs?.trim()) return here;
  if (!here?.trim()) return theirs;
  const have = new Set(here.split('\n').map((l) => l.trim()));
  const added = theirs.split('\n').filter((l) => {
    const k = l.trim();
    if (!k || have.has(k)) return false;
    have.add(k);
    return true;
  });
  return added.length ? `${here}\n${added.join('\n')}` : here;
}

/**
 * A teammate's census header into the census here (code review V12): what
 * the round itself records, combined as team merge combines a survey and
 * never asked about. Investigators pooled, the earlier start, the later end
 * (still open here stays open), and the teammate's note lines added to the
 * ones here (a line deleted on one phone comes back from the other). The
 * status stays this phone's own. Returns whether anything changed.
 */
export function mergeCensusHeader(ctx: Ctx, surveyId: number, theirs: Row): boolean {
  const s = getSurvey(ctx, surveyId);
  if (!s) return false;
  const nums = (a: unknown, b: unknown) => [a, b].filter((v): v is number => typeof v === 'number');
  const starts = nums(s.start_ts, theirs.start_ts);
  const stops = nums(s.stop_ts, theirs.stop_ts);
  const next: Record<'investigators' | 'start_ts' | 'stop_ts' | 'notes', Scalar> = {
    investigators: unionSurveyors([s.investigators, (theirs.investigators as string | null) ?? null]),
    start_ts: starts.length ? Math.min(...starts) : null,
    stop_ts: s.stop_ts == null ? null : Math.max(...stops),
    notes: unionLines(s.notes, (theirs.notes as string | null) ?? null),
  };
  const here = s as unknown as Row;
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== (here[k] ?? null));
  if (!changed.length) return false;
  run(ctx, `UPDATE fw_surveys SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...changed.map((k) => next[k]), ctx.now(), surveyId]);
  return true;
}

/**
 * Whether a teammate's census (its header's or file's survey row) uses
 * another template than this census here. The same template at another
 * version is the same (an additive upgrade); another template id would put
 * fields this phone's form does not show into its census.
 */
export function templateDiffers(hereTemplateId: string, theirs: Row): boolean {
  return typeof theirs.template_id === 'string' && theirs.template_id !== hereTemplateId;
}

/**
 * The team's block size: the smallest any phone has. Two phones that chose
 * apart before either saw the other's header settle on it (code review M1);
 * every block that fitted the relay at the larger size fits at the smaller.
 */
export function teamBlockSize(here: number | null, others: readonly (number | null | undefined)[]): number | null {
  const ks = [here, ...others].filter((k): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 1);
  return ks.length ? Math.min(...ks) : null;
}

/** Block ids at block size `fromK` as the blocks at `toK` they overlap (claims across a change of size, M1). */
export function regroupBlocks(ids: readonly string[], cols: number, rows: number, fromK: number, toK: number): string[] {
  const out = new Set<string>();
  for (const id of ids) for (const q of blockQuadratCodes(cols, rows, fromK, id)) out.add(blockOf(q, toK));
  return [...out].sort();
}

/** Change a census's block size to the team's (M1); the caller resends its blocks. */
export function changeBlockSize(ctx: Ctx, surveyId: number, k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new Error(`bad block size ${k}`);
  run(ctx, `UPDATE fw_surveys SET sync_block_quadrats = ?, updated_at = ? WHERE id = ?`, [k, ctx.now(), surveyId]);
}

/** Fix a census's block size (first team sync, §7.9). */
export function setBlockSize(ctx: Ctx, surveyId: number, k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new Error(`bad block size ${k}`);
  run(ctx, `UPDATE fw_surveys SET sync_block_quadrats = ?, updated_at = ? WHERE id = ? AND sync_block_quadrats IS NULL`, [k, ctx.now(), surveyId]);
}

// ── a block as sent ─────────────────────────────────────────────────────────

export type CensusBlockDoc = {
  record_type: 'census_block';
  schema: 1;
  ident: string;
  block: string;
  block_quadrats: number;
  slice: CensusSlice;
};

const swapCensus = (sl: CensusSlice, from: string, to: string): CensusSlice => {
  const sw = (v: unknown) => (v === from ? to : v);
  return {
    ...sl,
    survey: { ...sl.survey, uuid: sw(sl.survey.uuid) },
    trees: sl.trees.map((t) => ({ ...t, first_survey_uuid: sw(t.first_survey_uuid) })),
    stems: sl.stems.map((st) => ({ ...st, first_survey_uuid: sw(st.first_survey_uuid) })),
    history: sl.history.map((h) => ({ ...h, survey_uuid: sw(h.survey_uuid) })),
  };
};

const censusUuidOf = (ctx: { db: SurveyDb }, surveyId: number) => getSurvey(ctx, surveyId)!.uuid;

/** One block of this census, as the merge compares it (own census → THIS_CENSUS). */
export function blockSlice(ctx: Ctx, surveyId: number, k: number | null, block: string, extraTrees: readonly string[] = []): CensusSlice {
  const sl = buildSlice(ctx, surveyId, censusBlockCodes(ctx, surveyId, k, block), extraTrees);
  return swapCensus(sl, censusUuidOf(ctx, surveyId), THIS_CENSUS);
}

export function buildBlockDoc(ctx: Ctx, surveyId: number, block: string): CensusBlockDoc {
  const s = getSurvey(ctx, surveyId)!;
  const k = s.sync_block_quadrats;
  if (k == null) throw new Error('block size not decided');
  return { record_type: 'census_block', schema: 1, ident: identOfCensus(ctx, surveyId)!, block, block_quadrats: k, slice: blockSlice(ctx, surveyId, k, block) };
}

export function isBlockDoc(doc: unknown): doc is CensusBlockDoc {
  const d = doc as CensusBlockDoc | null;
  return !!d && d.record_type === 'census_block' && typeof d.ident === 'string' && typeof d.block === 'string' && d.slice?.record_type === 'census_slice';
}

/**
 * The merge rows of a block. Photo rows stay out: their path is the sender's
 * phone's; a teammate's photos come through the file manifest and are only
 * ever added (mediaSync.ts), as for other records.
 */
export const blockSide = (sl: CensusSlice): MergeSide => ({ ...censusSide(sl), media: [] });

// ── the merge base: one per census ──────────────────────────────────────────
//
// A census is one record cut into blocks for travel, and a tree can move from
// one block to another; so the base (the rows last merged from teammates,
// Team_merge.md) is kept for the whole census, and a block carries the part
// of it about its own rows.

/** Base entries about the rows of a block slice: its quadrats, trees, their stems, measurements, values and history. */
export function baseForSlice(base: readonly BaseEntry[], sl: CensusSlice): BaseEntry[] {
  const quadrats = new Set(sl.scope);
  const trees = new Set(sl.trees.map((t) => t.uuid as string));
  const stems = new Set(sl.stems.map((st) => st.uuid as string));
  const history = new Set(sl.history.map((h) => h.uuid as string));
  return base.filter(([tbl, key]) => {
    switch (tbl) {
      case 'fgquadrat':
        return quadrats.has(key);
      case 'tree':
        return trees.has(key);
      case 'stem':
      case 'measure':
        return stems.has(key);
      case 'sval':
        return stems.has(key.split('|')[0]);
      case 'ival':
        return trees.has(key.split('|')[0]);
      case 'history':
        return history.has(key);
      default:
        return false;
    }
  });
}

/**
 * The base after merging their block: their rows as they sent them replace
 * the entries about the same rows, and rows of their trees that they no longer
 * have leave it (so a removal is not offered again).
 */
export function baseAfterMerge(base: readonly BaseEntry[], sent: CensusSlice): BaseEntry[] {
  const about = new Set(baseForSlice(base, sent).map(([t, k]) => `${t}\u0000${k}`));
  return [...base.filter(([t, k]) => !about.has(`${t}\u0000${k}`)), ...baseOf(blockSide(sent))];
}

/**
 * baseAfterMerge as a change: the entries about the block go, the block's
 * rows come. Stored as such (syncBase.patchSyncBase), a block writes its own
 * rows instead of the whole census's base again (code review M6, 2026-10-04:
 * 100 000 rows a block at 25 ha).
 */
export function baseChangeAfterMerge(base: readonly BaseEntry[], sent: CensusSlice): { drop: BaseEntry[]; put: BaseEntry[] } {
  return { drop: baseForSlice(base, sent), put: baseOf(blockSide(sent)) };
}

// ── receiving a block: folds and clashes ────────────────────────────────────

export type TreeBrief = { uuid: string; tag: string; taxonId: string; name: string | null; x: number; y: number; quadrat: string; dbh: number | null };

export type Collision = {
  id: string;
  /** 'tag': one tag on two different-looking trees; 'possible': two new tags on what may be one tree. */
  kind: 'tag' | 'possible';
  local: TreeBrief;
  remote: TreeBrief;
};

export type CollisionDecision =
  /** One tree: keep this tag (the smaller uuid stays). */
  | { kind: 'same'; tag: string }
  /** Two trees: give `which` one a new tag. */
  | { kind: 'renumber'; which: 'local' | 'remote'; tag: string }
  /** Two trees, tags as they are (possible duplicates only). */
  | { kind: 'both' };

type Fold = { loser: string; winner: string; tag: string };

export type OpenedBlock = {
  /** Their block in this device's terms (folds this device made applied to it). */
  remote: CensusSlice;
  /** Their block as sent: what the merge base records afterwards. */
  sent: CensusSlice;
  /** Same tag, same place, same species: folded without asking. */
  sameTree: Fold[];
  collisions: Collision[];
  /** How many of their folds were carried out here (written already). */
  folded: number;
  /** Stems both phones added to a tree under one number, made one (M9); a stem renamed here is written already. */
  stemsJoined: number;
};

type LocalTree = { id: number; uuid: string; tag: string; taxon_id: string; used_scientific_name: string | null; x_m: number; y_m: number; quadrat_code: string; first_survey_id: number | null };

const localTree = (ctx: { db: SurveyDb }, uuid: string) => one<LocalTree>(ctx, `SELECT * FROM fw_individuals WHERE uuid = ?`, [uuid]) ?? null;

const parseJson = (v: unknown): Record<string, unknown> | null => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** `merge` history rows as loser → winner (and the tag kept). */
function foldsIn(history: readonly Row[]): Fold[] {
  const out: Fold[] = [];
  for (const h of history) {
    if (h.field !== 'merge') continue;
    const from = parseJson(h.old_value);
    const into = parseJson(h.new_value);
    if (typeof from?.uuid === 'string' && typeof into?.uuid === 'string') out.push({ loser: from.uuid, winner: into.uuid, tag: String(into.tag ?? '') });
  }
  return out;
}

/**
 * Codes of this phone's quadrats holding a tree their folds take (the tree
 * folded away here, and the one kept): openBlock folds before anything is
 * asked, so the version before the merge is kept from these first (code
 * review M10, 2026-10-04). Empty exactly when openBlock folds nothing.
 */
export function quadratsTheirFoldsTake(ctx: { db: SurveyDb }, sent: CensusSlice): string[] {
  const out = new Set<string>();
  for (const f of foldsIn(sent.history)) {
    const loser = localTree(ctx, f.loser);
    if (!loser) continue;
    out.add(loser.quadrat_code);
    const winner = localTree(ctx, f.winner);
    if (winner) out.add(winner.quadrat_code);
  }
  return [...out];
}

function localFolds(ctx: { db: SurveyDb }, frameId: number): Fold[] {
  return foldsIn(
    rows<Row>(ctx, `SELECT h.field, h.old_value, h.new_value FROM fw_individual_history h JOIN fw_individuals i ON i.id = h.individual_id WHERE i.frame_id = ? AND h.field = 'merge'`, [frameId]),
  );
}

/**
 * Their copy with tree `loser` folded into `winner`: its stems join the
 * winner's by stem number (`winnerStems`: stem number → uuid of the
 * winner's stem), and everything that pointed at the loser points at the
 * winner. The loser's own row goes.
 */
export function foldInSlice(sl: CensusSlice, f: Fold, winnerStems: Map<number, string>): CensusSlice {
  const stemMap = new Map<string, string>();
  for (const st of sl.stems) {
    if (st.tree_uuid !== f.loser) continue;
    const to = winnerStems.get(Number(st.stem_no));
    if (to && to !== st.uuid) stemMap.set(st.uuid as string, to);
  }
  const tr = (v: unknown) => (v === f.loser ? f.winner : v);
  const sm = (v: unknown) => (typeof v === 'string' ? (stemMap.get(v) ?? v) : v);
  const hasWinner = sl.trees.some((t) => t.uuid === f.winner);
  const trees = sl.trees
    .filter((t) => t.uuid !== f.loser || !hasWinner)
    .map((t) => (t.uuid === f.loser ? { ...t, uuid: f.winner, tag: f.tag } : t.uuid === f.winner ? { ...t, tag: f.tag } : t));
  // A stem mapped onto one already in the copy is the same stem: one row.
  const seenStem = new Set<string>();
  const stems = sl.stems
    .map((st) => ({ ...st, uuid: sm(st.uuid), tree_uuid: tr(st.tree_uuid) }))
    .filter((st) => {
      if (seenStem.has(st.uuid as string)) return false;
      seenStem.add(st.uuid as string);
      return true;
    });
  const seenMeasure = new Set<string>();
  const measures = sl.measures
    .map((m) => ({ ...m, stem_uuid: sm(m.stem_uuid) }))
    .filter((m) => {
      if (seenMeasure.has(m.stem_uuid as string)) return false;
      seenMeasure.add(m.stem_uuid as string);
      return true;
    });
  return {
    ...sl,
    trees,
    stems,
    measures,
    stemValues: sl.stemValues.map((v) => ({ ...v, stem_uuid: sm(v.stem_uuid) })),
    treeValues: sl.treeValues.map((v) => ({ ...v, tree_uuid: tr(v.tree_uuid) })),
    history: sl.history.map((h) => ({ ...h, tree_uuid: tr(h.tree_uuid) })),
    media: sl.media.map((md) => ({ ...md, tree_uuid: tr(md.tree_uuid), stem_uuid: sm(md.stem_uuid) })),
  };
}

const stemsByNo = (ctx: { db: SurveyDb }, treeUuid: string) =>
  new Map(
    rows<{ n: number; u: string }>(ctx, `SELECT st.stem_no AS n, st.uuid AS u FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.uuid = ?`, [treeUuid]).map((r) => [r.n, r.u]),
  );
const sliceStemsByNo = (sl: CensusSlice, treeUuid: string) =>
  new Map(sl.stems.filter((st) => st.tree_uuid === treeUuid).map((st) => [Number(st.stem_no), st.uuid as string]));

/**
 * Fold tree `f.loser` into `f.winner` on this device. When the winner is not
 * here yet (it comes in their block), the loser simply takes the winner's
 * uuid, and its stems the uuids of the winner's stems with the same number
 * (`winnerStems`); otherwise the loser's stems, measurements, values, photos
 * and history move to the winner and the loser goes. A measurement both have
 * for one stem in one census keeps the winner's. Returns the quadrats touched.
 */
function foldLocally(ctx: Ctx, surveyId: number, f: Fold, winnerStems: Map<number, string>): string[] {
  const loser = localTree(ctx, f.loser);
  if (!loser) return [];
  const touched = new Set<string>([loser.quadrat_code]);
  const winner = localTree(ctx, f.winner);
  const now = ctx.now();
  if (!winner) {
    for (const [no, uuid] of stemsByNo(ctx, f.loser)) {
      const to = winnerStems.get(no);
      if (to && to !== uuid && !one(ctx, `SELECT id FROM fw_stems WHERE uuid = ?`, [to])) run(ctx, `UPDATE fw_stems SET uuid = ?, updated_at = ? WHERE uuid = ?`, [to, now, uuid]);
    }
    run(ctx, `UPDATE fw_individuals SET uuid = ?, tag = ?, updated_at = ? WHERE id = ?`, [f.winner, f.tag, now, loser.id]);
  } else {
    touched.add(winner.quadrat_code);
    for (const st of rows<{ id: number; stem_no: number }>(ctx, `SELECT id, stem_no FROM fw_stems WHERE individual_id = ?`, [loser.id])) {
      const twin = one<{ id: number }>(ctx, `SELECT id FROM fw_stems WHERE individual_id = ? AND stem_no = ?`, [winner.id, st.stem_no]);
      if (!twin) {
        run(ctx, `UPDATE fw_stems SET individual_id = ?, updated_at = ? WHERE id = ?`, [winner.id, now, st.id]);
        continue;
      }
      for (const m of rows<{ id: number; survey_id: number }>(ctx, `SELECT id, survey_id FROM fw_stem_measures WHERE stem_id = ?`, [st.id])) {
        if (one(ctx, `SELECT id FROM fw_stem_measures WHERE stem_id = ? AND survey_id = ?`, [twin.id, m.survey_id])) continue;
        run(ctx, `UPDATE fw_stem_measures SET stem_id = ?, updated_at = ? WHERE id = ?`, [twin.id, now, m.id]);
      }
      run(ctx, `DELETE FROM fw_stems WHERE id = ?`, [st.id]);
    }
    for (const tbl of ['fw_individual_history', 'fw_media']) run(ctx, `UPDATE ${tbl} SET individual_id = ? WHERE individual_id = ?`, [winner.id, loser.id]);
    run(ctx, `UPDATE OR IGNORE fw_individual_values SET individual_id = ? WHERE individual_id = ?`, [winner.id, loser.id]);
    run(ctx, `DELETE FROM fw_individuals WHERE id = ?`, [loser.id]);
    run(ctx, `UPDATE fw_individuals SET tag = ?, updated_at = ? WHERE id = ?`, [f.tag, now, winner.id]);
  }
  for (const q of touched) touchFgQuadrat(ctx, surveyId, q);
  return [...touched];
}

function briefOfLocal(ctx: { db: SurveyDb }, surveyId: number, t: LocalTree): TreeBrief {
  const dbh =
    one<{ d: number | null }>(
      ctx,
      `SELECT m.dbh_cm AS d FROM fw_stem_measures m JOIN fw_stems st ON st.id = m.stem_id WHERE st.individual_id = ? AND m.survey_id = ? ORDER BY m.is_main DESC, st.stem_no LIMIT 1`,
      [t.id, surveyId],
    )?.d ?? null;
  return { uuid: t.uuid, tag: t.tag, taxonId: t.taxon_id, name: t.used_scientific_name, x: t.x_m, y: t.y_m, quadrat: t.quadrat_code, dbh };
}

function briefOfRemote(sl: CensusSlice, t: Row): TreeBrief {
  const stems = sl.stems.filter((st) => st.tree_uuid === t.uuid).map((st) => st.uuid);
  const ms = sl.measures.filter((m) => stems.includes(m.stem_uuid)).sort((a, b) => Number(b.is_main ?? 0) - Number(a.is_main ?? 0));
  return {
    uuid: t.uuid as string,
    tag: t.tag as string,
    taxonId: t.taxon_id as string,
    name: (t.used_scientific_name as string) ?? null,
    x: Number(t.x_m),
    y: Number(t.y_m),
    quadrat: t.quadrat_code as string,
    dbh: (ms[0]?.dbh_cm as number | undefined) ?? null,
  };
}

/**
 * Step 1 of receiving a teammate's block (`doc.slice`, with THIS_CENSUS):
 * carry out their folds here, apply this device's folds to their copy, and
 * find the clashes. Writes (their folds); the caller runs it in a transaction.
 */
export function openBlock(ctx: Ctx, surveyId: number, sent: CensusSlice): OpenedBlock {
  const s = getSurvey(ctx, surveyId)!;
  // A tree first recorded in a census this phone does not have comes in
  // without one (first_survey_id NULL, as fillSlice does). This series'
  // earlier censuses are always here (ensureCensus, startCensus); the others
  // are another series' — the plot's trees are shared, but a file carries
  // only its own series (1D) — and refusing them stopped the census for good
  // (code review M1, 2026-10-04).
  // Their decisions first: a tree they folded into another is folded here too.
  let folded = 0;
  for (const f of foldsIn(sent.history)) {
    if (!localTree(ctx, f.loser)) continue;
    foldLocally(ctx, surveyId, f, sliceStemsByNo(sent, f.winner));
    folded += 1;
  }
  // This device's decisions on their copy: trees folded here are folded there.
  let remote = sent;
  for (const f of localFolds(ctx, s.frame_id)) {
    if (remote.trees.some((t) => t.uuid === f.loser) || remote.stems.some((st) => st.tree_uuid === f.loser)) {
      remote = foldInSlice(remote, f, stemsByNo(ctx, f.winner));
    }
  }
  // Both phones added a stem to one tree under one number: one stem (code review M9).
  const joined = joinStems(ctx, surveyId, remote);
  remote = joined.slice;
  const stemsJoined = joined.joined;
  const sameTree: Fold[] = [];
  const collisions: Collision[] = [];
  const inRemote = new Map(remote.trees.map((t) => [t.uuid as string, t]));
  for (const t of remote.trees) {
    // A tree known here clashes only when they gave it a number another tree here holds.
    const known = localTree(ctx, t.uuid as string);
    if (known && known.tag === t.tag) continue;
    const sameTag = one<LocalTree>(ctx, `SELECT * FROM fw_individuals WHERE frame_id = ? AND tag = ? AND uuid <> ?`, [s.frame_id, t.tag as string, t.uuid as string]);
    // Their copy renumbers that tree of ours: no clash.
    const renumbered = sameTag && inRemote.has(sameTag.uuid) && inRemote.get(sameTag.uuid)!.tag !== t.tag;
    if (sameTag && !renumbered) {
      const a = { x: sameTag.x_m, y: sameTag.y_m, taxonId: sameTag.taxon_id };
      const b = { x: Number(t.x_m), y: Number(t.y_m), taxonId: t.taxon_id as string };
      if (!tagConflict(a, b)) sameTree.push(orderFold(sameTag.uuid, t.uuid as string, t.tag as string));
      else collisions.push({ id: `tag:${t.uuid}`, kind: 'tag', local: briefOfLocal(ctx, surveyId, sameTag), remote: briefOfRemote(remote, t) });
      continue;
    }
    if (known || t.first_survey_uuid !== THIS_CENSUS) continue;
    // Any recruit of ours nearby, even one they already had: they may have tagged it again without noticing.
    const near = rows<LocalTree>(
      ctx,
      `SELECT * FROM fw_individuals WHERE frame_id = ? AND first_survey_id = ? AND taxon_id = ? AND tag <> ?
         AND x_m BETWEEN ? AND ? AND y_m BETWEEN ? AND ?`,
      [s.frame_id, surveyId, t.taxon_id as string, t.tag as string, Number(t.x_m) - POSSIBLE_DUPLICATE_M, Number(t.x_m) + POSSIBLE_DUPLICATE_M, Number(t.y_m) - POSSIBLE_DUPLICATE_M, Number(t.y_m) + POSSIBLE_DUPLICATE_M],
    ).filter((l) => Math.hypot(l.x_m - Number(t.x_m), l.y_m - Number(t.y_m)) <= POSSIBLE_DUPLICATE_M);
    if (near[0]) collisions.push({ id: `possible:${t.uuid}`, kind: 'possible', local: briefOfLocal(ctx, surveyId, near[0]), remote: briefOfRemote(remote, t) });
  }
  return { remote, sent, sameTree, collisions, folded, stemsJoined };
}

/** The smaller uuid stays, so both phones keep the same one. */
const orderFold = (a: string, b: string, tag: string): Fold => (a < b ? { loser: b, winner: a, tag } : { loser: a, winner: b, tag });

/**
 * Step 2: write the folds and the decisions on the clashes (`decisions` by
 * collision id). Every tag clash needs one (one tag cannot sit on two trees);
 * a possible duplicate without one keeps both. A new number must be free and
 * not retired. Renumbering is a tag correction with a history row; folding
 * leaves a `merge` row on the tree kept. Both travel with this device's
 * block. Returns their block in this device's terms. In a transaction.
 */
export function settleCollisions(ctx: Ctx, surveyId: number, opened: OpenedBlock, decisions: Map<string, CollisionDecision>, by: string | null): CensusSlice {
  let remote = opened.remote;
  const now = ctx.now();
  const history = (treeUuid: string, field: 'tag' | 'merge', oldValue: unknown, newValue: unknown) => {
    const t = localTree(ctx, treeUuid);
    if (!t) return;
    run(ctx, `INSERT INTO fw_individual_history (uuid, individual_id, survey_id, field, old_value, new_value, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`, [
      ctx.uuid(),
      t.id,
      surveyId,
      field,
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      by,
      now,
    ]);
    touchFgQuadrat(ctx, surveyId, t.quadrat_code);
  };
  const fold = (f: Fold) => {
    const winnerHere = !!localTree(ctx, f.winner);
    const loserTag = winnerHere ? (remote.trees.find((t) => t.uuid === f.loser)?.tag ?? localTree(ctx, f.loser)?.tag) : localTree(ctx, f.loser)?.tag;
    const winnerTag = winnerHere ? localTree(ctx, f.winner)!.tag : (remote.trees.find((t) => t.uuid === f.winner)?.tag as string | undefined);
    if (winnerHere) {
      // Ours stays: their tree joins it in their copy (and here, if it came before).
      if (localTree(ctx, f.loser)) foldLocally(ctx, surveyId, f, stemsByNo(ctx, f.winner));
      remote = foldInSlice(remote, f, stemsByNo(ctx, f.winner));
      if (winnerTag !== f.tag) run(ctx, `UPDATE fw_individuals SET tag = ?, updated_at = ? WHERE uuid = ?`, [f.tag, now, f.winner]);
    } else {
      // Theirs stays: ours takes its uuid (and stems), and the tag kept.
      foldLocally(ctx, surveyId, f, sliceStemsByNo(remote, f.winner));
      remote = { ...remote, trees: remote.trees.map((t) => (t.uuid === f.winner ? { ...t, tag: f.tag } : t)) };
    }
    history(f.winner, 'merge', { uuid: f.loser, tag: loserTag ?? null }, { uuid: f.winner, tag: f.tag, ...(winnerTag && winnerTag !== f.tag ? { was: winnerTag } : {}) });
  };
  const frameId = getSurvey(ctx, surveyId)!.frame_id;
  const assertFree = (tag: string) => {
    if (!tag.trim() || one(ctx, `SELECT id FROM fw_individuals WHERE frame_id = ? AND tag = ?`, [frameId, tag])) throw new SurveyError('tag_taken', tag);
    if (remote.trees.some((t) => t.tag === tag)) throw new SurveyError('tag_taken', tag);
    if (retiredTags(ctx, frameId).has(tag)) throw new SurveyError('tag_retired', tag);
  };
  for (const c of opened.collisions) {
    const d = decisions.get(c.id);
    if (c.kind === 'tag' && (!d || d.kind === 'both')) throw new CensusSyncError('undecided', c.id);
    if (d?.kind === 'renumber') assertFree(d.tag);
  }
  for (const f of opened.sameTree) fold(f);
  for (const c of opened.collisions) {
    const d = decisions.get(c.id);
    if (!d || d.kind === 'both') continue;
    if (d.kind === 'same') {
      fold(orderFold(c.local.uuid, c.remote.uuid, d.tag));
      continue;
    }
    if (d.which === 'local') {
      run(ctx, `UPDATE fw_individuals SET tag = ?, updated_at = ? WHERE uuid = ?`, [d.tag, now, c.local.uuid]);
      history(c.local.uuid, 'tag', c.local.tag, d.tag);
    } else {
      // Their tree gets the new tag here; the correction goes back in this device's block.
      remote = { ...remote, trees: remote.trees.map((t) => (t.uuid === c.remote.uuid ? { ...t, tag: d.tag } : t)) };
      remote = {
        ...remote,
        history: [
          ...remote.history,
          { uuid: ctx.uuid(), tree_uuid: c.remote.uuid, survey_uuid: THIS_CENSUS, field: 'tag', old_value: JSON.stringify(c.remote.tag), new_value: JSON.stringify(d.tag), reason: null, by, at: now },
        ],
      };
    }
  }
  return remote;
}

/**
 * Whether the clash decisions change their copy of the block: their tree takes
 * a new number, or two trees become one. Their phone learns that only from
 * this phone's copy of the block, so the block goes back even when this phone
 * does not work on it; else the next time they meet the clash they may decide
 * otherwise, and the tags part for good (code review M8, 2026-10-04). A number
 * for this phone's own tree, or a fold found without a person (both phones
 * find the same), travels anyway: the tree's own block is stamped.
 */
export function decisionsCorrectTheirs(opened: OpenedBlock, decisions: ReadonlyMap<string, CollisionDecision>): boolean {
  return opened.collisions.some((c) => {
    const d = decisions.get(c.id);
    return d?.kind === 'same' || (d?.kind === 'renumber' && d.which === 'remote');
  });
}

/**
 * Rows a merge may delete: never a tree, stem, quadrat row or history row (a
 * tree missing from their block may have moved to another block); a
 * measurement or value only when its tree is in their block.
 */
function deletableIn(ctx: { db: SurveyDb }, surveyId: number, remote: CensusSlice): (tbl: string, key: string) => boolean {
  const theirTrees = new Set(remote.trees.map((t) => t.uuid as string));
  const stemTree = new Map(
    rows<{ s: string; t: string }>(ctx, `SELECT st.uuid AS s, i.uuid AS t FROM fw_stems st JOIN fw_individuals i ON i.id = st.individual_id WHERE i.frame_id = ?`, [
      getSurvey(ctx, surveyId)!.frame_id,
    ]).map((r) => [r.s, r.t]),
  );
  for (const st of remote.stems) stemTree.set(st.uuid as string, st.tree_uuid as string);
  return (tbl, key) => {
    switch (tbl) {
      case 'measure':
        return theirTrees.has(stemTree.get(key) ?? '');
      case 'sval':
        return theirTrees.has(stemTree.get(key.split('|')[0]) ?? '');
      case 'ival':
        return theirTrees.has(key.split('|')[0]);
      default:
        return false;
    }
  };
}

/**
 * Step 3: the field-level merge items of their block against this device's.
 * `senderBase`: the base their block carried; `localBase`: this device's base
 * for the census. Removals a merge would not carry out are not offered.
 */
export function blockItems(ctx: Ctx, surveyId: number, block: string, remote: CensusSlice, senderBase: BaseEntry[] | null, localBase: BaseEntry[] | null): MergeItem[] {
  const k = getSurvey(ctx, surveyId)!.sync_block_quadrats;
  const local = blockSlice(ctx, surveyId, k, block, remote.trees.map((t) => t.uuid as string));
  const deletable = deletableIn(ctx, surveyId, remote);
  return diffSides(blockSide(local), blockSide(remote), senderBase, CENSUS_COMBINERS, localBase).filter(
    (it) => !((it.kind === 'remoteDeleted' || it.kind === 'deleteConflict') && it.remote == null) || deletable(it.tbl, it.key),
  );
}

const localizeRow = (r: Row, censusUuid: string): Row => {
  const out: Row = { ...r };
  for (const f of ['first_survey_uuid', 'survey_uuid']) if (out[f] === THIS_CENSUS) out[f] = censusUuid;
  return out;
};

/** THIS_CENSUS in the operations → this device's census uuid. */
export function localizeOps(ops: readonly MergeOp[], censusUuid: string): MergeOp[] {
  return ops.map((o) => {
    if (o.op === 'insert') return { ...o, row: { ...o.row, data: localizeRow(o.row.data, censusUuid) } };
    if (o.op === 'update') return { ...o, data: localizeRow(o.data, censusUuid) };
    return o;
  });
}

/**
 * Step 4: write the decisions. Trees, stems and quadrat rows are never
 * deleted by a merge; a measurement, value or photo only when its tree is in
 * their block. Returns the quadrats touched. In a transaction.
 */
export function applyBlockItems(ctx: Ctx, surveyId: number, items: MergeItem[], decisions: Map<string, Decision>, remote: CensusSlice): string[] {
  const ops = withParents(ctx, localizeOps(planOps(items, decisions), censusUuidOf(ctx, surveyId)));
  return applySliceOps(ctx, surveyId, ops, { mayDelete: deletableIn(ctx, surveyId, remote) });
}

/**
 * Their rows whose tree or stem neither is here nor comes in with this merge
 * (a decision kept it out) stay out with it: inserted, they failed the whole
 * merge (code review M9, 2026-10-04).
 */
export function withParents(ctx: { db: SurveyDb }, ops: readonly MergeOp[]): MergeOp[] {
  const inserted = (tbl: string, list: readonly MergeOp[]) => new Set(list.flatMap((o) => (o.op === 'insert' && o.tbl === tbl ? [o.row.key] : [])));
  const here = (table: 'fw_individuals' | 'fw_stems', uuid: unknown) => typeof uuid === 'string' && !!one(ctx, `SELECT id FROM ${table} WHERE uuid = ?`, [uuid]);
  const trees = inserted('tree', ops);
  const hasTree = (u: unknown) => trees.has(u as string) || here('fw_individuals', u);
  const withTrees = ops.filter((o) => !(o.op === 'insert' && (o.tbl === 'stem' || o.tbl === 'ival') && !hasTree(o.row.data.tree_uuid)));
  const stems = inserted('stem', withTrees);
  const hasStem = (u: unknown) => stems.has(u as string) || here('fw_stems', u);
  return withTrees.filter((o) => !(o.op === 'insert' && ((o.tbl === 'measure' && !hasStem(o.row.key)) || (o.tbl === 'sval' && !hasStem(o.row.data.stem_uuid)))));
}
