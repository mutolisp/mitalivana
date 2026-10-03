/**
 * Status, vitality and validation of one tree in one census
 * (docs/planned/Modular_survey.md §8.5). The rules here are the app's; the
 * codes they read come from the two code sets in src/survey/codesets/.
 *
 * Final status (Condit 1998, book p.164–165, PDF p.175–176): A alive with a
 * stem at or over the threshold; D dead; F alive with no stem reaching it
 * (e.g. a resprout recorded with DBH 0); P not yet in the plot at that census.
 *
 * Pure: check:stemmap runs it under Node.
 */
import { censusCode } from '../codesets/forestgeoCensus1998';
import type { AmsSurvival } from '../codesets/forestgeoAms2021';

export type StemCensusInput = {
  /** Census codes on this stem (stem-level codes only). */
  censusCodes: readonly string[];
  /** AMS survival status, when the AMS code set is on. */
  amsSurvival?: AmsSurvival | null;
  /** The app's own "this stem died" field (for when only census codes are used). */
  stemDead?: boolean;
  dbhCm: number | null;
  pending?: 'big_tree' | null;
};

export type TreeCensusInput = {
  /** Tree-level census codes (DS / DC / DT / DN). */
  treeCodes: readonly string[];
  stems: readonly StemCensusInput[];
  /** False when the tree was first recorded after this census. */
  existed: boolean;
  thresholdCm: number;
};

export type TreeStatus = 'A' | 'D' | 'F' | 'P';
export type Vitality = 'alive' | 'dead' | 'uncertain';

const treeDeadByCode = (codes: readonly string[]) => codes.some((c) => censusCode(c)?.dead === true);

export function stemIsDead(stem: StemCensusInput, treeCodes: readonly string[]): boolean {
  return (
    treeDeadByCode(treeCodes) ||
    stem.stemDead === true ||
    stem.amsSurvival === 'X' ||
    stem.amsSurvival === 'D'
  );
}

/** A live stem that counts as reaching the threshold: measured at or over it,
 *  or still waiting for the big-tree team (big trees are over any threshold). */
function reachesThreshold(stem: StemCensusInput, thresholdCm: number): boolean {
  if (stem.pending === 'big_tree') return true;
  return stem.dbhCm != null && stem.dbhCm >= thresholdCm;
}

export function treeStatus(t: TreeCensusInput): TreeStatus {
  if (!t.existed) return 'P';
  const live = t.stems.filter((s) => !stemIsDead(s, t.treeCodes));
  if (t.stems.length === 0 || live.length === 0) return 'D';
  return live.some((s) => reachesThreshold(s, t.thresholdCm)) ? 'A' : 'F';
}

/** Census code M, derived: two or more live stems reaching the threshold
 *  (Condit: extra stems under 10 mm do not make a plant multiple, book p.53). */
export function isMultiStem(t: TreeCensusInput): boolean {
  return t.stems.filter((s) => !stemIsDead(s, t.treeCodes) && reachesThreshold(s, t.thresholdCm)).length >= 2;
}

/** dwc:vitality of the tree (app's mapping, Modular_survey.md §7.4).
 *  Null for P: the tree has no occurrence in that census. */
export function vitality(t: TreeCensusInput): Vitality | null {
  const status = treeStatus(t);
  if (status === 'P') return null;
  const notFound = t.stems.length > 0 && t.stems.every((s) => s.amsSurvival === 'NF');
  if (t.treeCodes.includes('DN') || notFound) return 'uncertain';
  return status === 'D' ? 'dead' : 'alive';
}

export type Conflict = 'tree_dead_but_stem_alive' | 'ams_dead_individual_but_stem_alive' | 'dead_stem_with_dbh' | 'stem_dead_but_ams_alive';

/** Combinations that contradict each other — listed by the automatic screening. */
export function conflicts(t: TreeCensusInput): Conflict[] {
  const out: Conflict[] = [];
  const amsAlive = (s: StemCensusInput) => s.amsSurvival === 'OK' || s.amsSurvival === 'A';
  if (treeDeadByCode(t.treeCodes) && t.stems.some(amsAlive)) out.push('tree_dead_but_stem_alive');
  // AMS D is "dead individual, which necessarily implies dead stem(s)" (p.3).
  if (t.stems.some((s) => s.amsSurvival === 'D') && t.stems.some(amsAlive)) out.push('ams_dead_individual_but_stem_alive');
  if (t.stems.some((s) => stemIsDead(s, t.treeCodes) && s.dbhCm != null && s.dbhCm > 0)) out.push('dead_stem_with_dbh');
  // When both code sets are on, survival follows AMS (§8.5): the app's stem-death switch set on a stem AMS calls alive.
  if (t.stems.some((s) => s.stemDead === true && amsAlive(s))) out.push('stem_dead_but_ams_alive');
  return out;
}

export type Issue = { field: 'dbh' | 'pom' | 'codes'; severity: 'error' | 'warning'; code: string };

/**
 * Validation of one stem's measurement — it depends on the stem's state, so a
 * dead stem, a resprout recorded at 0 or a big tree waiting for its ladder is
 * not blocked by "DBH required" (Modular_survey.md §8.5).
 */
export function validateStem(input: {
  stem: StemCensusInput;
  treeCodes: readonly string[];
  isNew: boolean;
  firstCensus: boolean;
  thresholdCm: number;
  pomM: number | null;
}): Issue[] {
  const { stem, treeCodes, isNew, firstCensus, thresholdCm, pomM } = input;
  const issues: Issue[] = [];
  for (const code of stem.censusCodes) {
    const def = censusCode(code);
    if (!def || def.level !== 'stem') issues.push({ field: 'codes', severity: 'error', code: 'unknown_code' });
    else if (firstCensus && def.recensusOnly) issues.push({ field: 'codes', severity: 'error', code: 'recensus_only' });
    else if (def.needsPomHeight && pomM == null) issues.push({ field: 'pom', severity: 'error', code: 'pom_required' });
  }
  if (stemIsDead(stem, treeCodes)) {
    if (stem.dbhCm != null && stem.dbhCm > 0) issues.push({ field: 'dbh', severity: 'warning', code: 'dead_has_dbh' });
    return issues;
  }
  if (stem.pending === 'big_tree') return issues;
  const resprout = stem.censusCodes.includes('R');
  if (stem.dbhCm == null) {
    issues.push({ field: 'dbh', severity: 'error', code: 'dbh_required' });
    return issues;
  }
  if (stem.dbhCm === 0) {
    // Condit Table 2.5.1: a resprout may carry DBH 0 when the new stem is under 10 mm.
    if (!resprout) issues.push({ field: 'dbh', severity: 'error', code: 'zero_needs_resprout' });
    return issues;
  }
  if (stem.dbhCm < thresholdCm) {
    issues.push(
      isNew
        ? { field: 'dbh', severity: 'error', code: 'new_below_threshold' }
        : { field: 'dbh', severity: 'warning', code: 'tagged_below_threshold' },
    );
  }
  return issues;
}
