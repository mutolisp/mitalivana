/**
 * What the census screens show about a tree (Modular_survey.md §8.4–§8.5):
 * its flags, the list chip, the problems to confirm, and the two field
 * worklists — extreme growth (Condit 1998 book p.86, PDF p.97) and the
 * automatic screening.
 *
 * treeFlags() follows the same rules as censusTreeStates() in SQL;
 * check:survey-db compares the two on every tree.
 *
 * Pure: runs under Node.
 */
import type { MeasureRow, StemView, TreeView } from '../db/stemmapCore';
import { conflicts, validateStem, type StemCensusInput } from './status';
import { entryHints, extremeList, growth, type Measure } from './growth';
import { locate, type FrameGeometry } from './coords';
import { sortByWalk } from './walkOrder';

/** A stem is handled once it has a DBH, is dead, or waits for the big-tree team. */
export const isHandled = (m: MeasureRow | null): boolean => m != null && (m.dbh_cm != null || m.stem_dead === 1 || m.pending != null);

export type PrevState = 'alive' | 'dead' | 'missing' | null;

export type TreeFlags = {
  isNew: boolean;
  done: boolean;
  deadNow: boolean;
  pending: boolean;
  /** Some stems handled, not all. */
  partial: boolean;
  prev: PrevState;
};

export function treeFlags(v: TreeView, surveyId: number, hasPrevious: boolean): TreeFlags {
  const isNew = v.individual.first_survey_id === surveyId;
  const handled = v.stems.filter((s) => isHandled(s.measure)).length;
  const treeDead = v.treeCodes.length > 0;
  let prev: PrevState = null;
  if (hasPrevious && !isNew) {
    const withRow = v.stems.filter((s) => s.previous != null);
    if (v.previousTreeCodes.length > 0 || (withRow.length > 0 && withRow.every((s) => s.previous!.stem_dead === 1))) prev = 'dead';
    else if (!v.stems.some((s) => isHandled(s.previous))) prev = 'missing';
    else prev = 'alive';
  }
  const all = v.stems.length > 0 && handled === v.stems.length;
  return {
    isNew,
    done: treeDead || all,
    deadNow: treeDead || (v.stems.length > 0 && v.stems.every((s) => s.measure?.stem_dead === 1)),
    pending: v.stems.some((s) => s.measure?.pending != null),
    partial: !treeDead && handled > 0 && !all,
    prev,
  };
}

const measureOf = (m: MeasureRow | null): Measure | null => (m ? { dbhCm: m.dbh_cm, pomSeq: m.pom_seq, measuredAt: m.measured_at } : null);

function stemInput(s: StemView): StemCensusInput {
  return { censusCodes: s.codes, stemDead: s.measure?.stem_dead === 1, dbhCm: s.measure?.dbh_cm ?? null, pending: s.measure?.pending ?? null };
}

export type TreeIssue = {
  /** null for the whole tree. */
  stemNo: number | null;
  code: string;
  /** error: must be fixed; warning: to confirm; hint: shown while typing, also "to confirm". */
  severity: 'error' | 'warning' | 'hint';
};

/**
 * Problems of the stems handled so far and of the tree as a whole. A stem not
 * yet handled is work to do, not a problem. Code A is "POM at alternative
 * height, not breast height" (Table 2.2.1), so A with the default 1.3 m counts
 * as a missing POM; Y may sit at 1.3 m along the stem.
 */
export function treeIssues(v: TreeView, opts: { surveyId: number; firstCensus: boolean; thresholdCm: number }): TreeIssue[] {
  const out: TreeIssue[] = [];
  for (const s of v.stems) {
    if (!isHandled(s.measure) && s.codes.length === 0) continue;
    const m = s.measure;
    const pomM = m == null || (s.codes.includes('A') && m.pom_m === 1.3) ? null : m.pom_m;
    for (const issue of validateStem({
      stem: stemInput(s),
      treeCodes: v.treeCodes,
      isNew: s.stem.first_survey_id === opts.surveyId,
      firstCensus: opts.firstCensus,
      thresholdCm: opts.thresholdCm,
      pomM,
    })) {
      out.push({ stemNo: s.stem.stem_no, code: issue.code, severity: issue.severity });
    }
    if (s.codes.includes('P')) out.push({ stemNo: s.stem.stem_no, code: 'problem', severity: 'warning' });
    const cur = measureOf(m);
    if (cur) for (const h of entryHints(measureOf(s.previous), cur)) if (h !== 'pom_changed') out.push({ stemNo: s.stem.stem_no, code: h, severity: 'hint' });
  }
  const tree = { treeCodes: v.treeCodes, stems: v.stems.map(stemInput), existed: true, thresholdCm: opts.thresholdCm };
  for (const c of conflicts(tree)) out.push({ stemNo: null, code: c, severity: 'error' });
  return out;
}

export type TreeChip = 'warn' | 'pending' | 'fresh' | 'dead' | 'done' | 'partial' | 'prevDead' | 'prevMissing' | 'todo';

/** The list chip: problems first, then the tree's state. */
export function treeChip(flags: TreeFlags, issues: readonly TreeIssue[]): TreeChip {
  if (issues.length > 0) return 'warn';
  if (flags.pending) return 'pending';
  if (flags.isNew) return 'fresh';
  if (flags.done) return flags.deadNow ? 'dead' : 'done';
  if (flags.partial) return 'partial';
  if (flags.prev === 'dead') return 'prevDead';
  if (flags.prev === 'missing') return 'prevMissing';
  return 'todo';
}

/** Chips counted as work still to do (the progress denominator leaves out
 *  trees dead or not recorded last census, §8.4). */
export const isOpenWork = (chip: TreeChip): boolean => chip === 'todo' || chip === 'partial';

export type WorkItem = {
  individualId: number;
  tag: string;
  quadratCode: string;
  stemNo: number | null;
  /** Issue code, 'not_handled', or 'extreme_high' / 'extreme_low'. */
  code: string;
  localX: number;
  localY: number;
};

function walkSorted(items: WorkItem[], f: FrameGeometry): WorkItem[] {
  const byQuadrat = new Map<string, WorkItem[]>();
  for (const it of items) (byQuadrat.get(it.quadratCode) ?? byQuadrat.set(it.quadratCode, []).get(it.quadratCode)!).push(it);
  return [...byQuadrat.keys()].sort().flatMap((q) => sortByWalk(byQuadrat.get(q)!, f));
}

/**
 * The automatic screening (§8.4 item 5): problems of every tree, and stems
 * handled last census but not in this one (unless the tree is dead now).
 * Duplicate tags cannot happen on one device (UNIQUE per frame); they come
 * with team merges.
 */
export function screening(trees: readonly TreeView[], opts: { surveyId: number; firstCensus: boolean; thresholdCm: number; geometry: FrameGeometry }): WorkItem[] {
  const out: WorkItem[] = [];
  for (const v of trees) {
    const at = locate({ x: v.individual.x_m, y: v.individual.y_m }, opts.geometry);
    const base = { individualId: v.individual.id, tag: v.individual.tag, quadratCode: v.individual.quadrat_code, localX: at.localX, localY: at.localY };
    for (const i of treeIssues(v, opts)) out.push({ ...base, stemNo: i.stemNo, code: i.code });
    if (v.treeCodes.length > 0) continue;
    for (const s of v.stems) {
      if (isHandled(s.previous) && s.previous!.stem_dead === 0 && !isHandled(s.measure)) out.push({ ...base, stemNo: s.stem.stem_no, code: 'not_handled' });
    }
  }
  return walkSorted(out, opts.geometry);
}

/**
 * Stems to re-measure in the field: both ends of the growth rate in each of
 * Condit's six dbh classes (pct and min from the frame, decided 2026-10-01).
 * Only growth between measurements at the same POM number counts.
 */
export function extremeWorklist(trees: readonly TreeView[], opts: { pct: number; min: number; geometry: FrameGeometry }): WorkItem[] {
  const index = new Map<string, WorkItem>();
  const items: { id: string; dbhCm: number; annualCm: number }[] = [];
  for (const v of trees) {
    const at = locate({ x: v.individual.x_m, y: v.individual.y_m }, opts.geometry);
    for (const s of v.stems) {
      const cur = measureOf(s.measure);
      const prev = measureOf(s.previous);
      if (!cur || !prev || s.measure!.stem_dead === 1) continue;
      const g = growth(prev, cur);
      if (!g.valid) continue;
      const id = `${v.individual.id}:${s.stem.stem_no}`;
      items.push({ id, dbhCm: cur.dbhCm!, annualCm: g.annualCm });
      index.set(id, { individualId: v.individual.id, tag: v.individual.tag, quadratCode: v.individual.quadrat_code, stemNo: s.stem.stem_no, code: '', localX: at.localX, localY: at.localY });
    }
  }
  const picks = extremeList(items, opts.pct, opts.min).map((p) => ({ ...index.get(p.id)!, code: p.end === 'high' ? 'extreme_high' : 'extreme_low' }));
  return walkSorted(picks, opts.geometry);
}
